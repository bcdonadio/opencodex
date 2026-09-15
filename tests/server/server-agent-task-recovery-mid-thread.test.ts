import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import { resetAgentTaskRecoveryState } from "../../src/server/responses/agent-task-recovery";
import {
  codexHeaders,
  encryptedInput,
  FERNET_TASK,
  originalFetch,
  post,
  providerResponse,
  recoverySse,
  routedConfig,
} from "../helpers/agent-task-recovery";

/**
 * #4089. A live Codex thread switched from a native ChatGPT model to a routed provider replays a
 * backend-minted encrypted agent message on every later turn. That turn is not a thread spawn, so
 * the direct recovery gate skipped it entirely and the thread was unusable on that provider
 * forever -- the workaround in the report was "start a new thread".
 *
 * `recovery_reason` is the discriminator. `unreadableEncryptedAgentTaskResponse` attaches the
 * field only when a recovery attempt produced a refusal reason, so its absence proves recovery
 * never ran. The first test is the reporter's loopback pair: identical bodies, one differing
 * header.
 */
describe("mid-thread encrypted agent task recovery (#4089)", () => {
  beforeEach(() => {
    resetAgentTaskRecoveryState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAgentTaskRecoveryState();
  });

  /** A mid-thread model switch: same Codex caller, same credentials, no spawn markers. */
  const midThreadHeaders = (accountId = "acct-caller"): Headers => {
    const headers = codexHeaders(accountId);
    headers.delete("x-openai-subagent");
    return headers;
  };

  test("a mid-thread switch attempts recovery exactly like the spawn it is not", async () => {
    const attempts: string[] = [];
    globalThis.fetch = (async (input) => {
      attempts.push(String(input));
      return new Response("event: error\ndata: {}\n\n", { status: 200 });
    }) as typeof fetch;

    const errors: Array<Record<string, unknown>> = [];
    for (const headers of [midThreadHeaders(), codexHeaders()]) {
      const response = await post(routedConfig(), "xai/grok-4.5", encryptedInput(), headers);
      expect(response.status).toBe(400);
      errors.push((await response.json() as { error?: Record<string, unknown> }).error ?? {});
      resetAgentTaskRecoveryState();
    }

    // Before the gate change the mid-thread body carried no `recovery_reason` key at all.
    expect(errors[0]).toMatchObject({
      code: "unreadable_encrypted_agent_task",
      recovery_reason: "recovery_invalid_output",
    });
    expect(errors[0]).toEqual(errors[1]!);
    expect(attempts).toHaveLength(2);
    for (const url of attempts) expect(url).toContain("chatgpt.com/backend-api/codex");
  });

  test("a recovered mid-thread turn reaches the routed provider as plaintext", async () => {
    const urls: string[] = [];
    let providerBody = "";
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("chatgpt.com")) return new Response(recoverySse("Continue the migration."));
      providerBody = typeof init?.body === "string" ? init.body : "";
      return providerResponse();
    }) as typeof fetch;

    const response = await post(routedConfig(), "xai/grok-4.5", encryptedInput(), midThreadHeaders());

    expect(response.status).toBe(200);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("chatgpt.com/backend-api/codex");
    expect(urls[1]).toContain("api.x.ai");
    expect(providerBody).toContain("Continue the migration.");
    expect(providerBody).not.toContain(FERNET_TASK);
  });

  test("a mid-thread replay reuses the cached plaintext instead of recovering again", async () => {
    // The report's third observation: the cache restore sits inside the same gate, so a
    // mid-thread turn could never reuse a plaintext this proxy had already paid for.
    const headers = midThreadHeaders();
    let recoveries = 0;
    let providerCalls = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        recoveries += 1;
        return new Response(recoverySse("Continue the migration."));
      }
      providerCalls += 1;
      return providerResponse();
    }) as typeof fetch;

    expect((await post(routedConfig(), "xai/grok-4.5", encryptedInput(), headers)).status).toBe(200);
    expect((await post(routedConfig(), "xai/grok-4.5", [
      ...encryptedInput(),
      { type: "message", role: "user", content: "And now the follow-up turn." },
    ], headers)).status).toBe(200);

    expect(recoveries).toBe(1);
    expect(providerCalls).toBe(2);
  });

  test("a mid-thread switch without matching native credentials never spends a session", async () => {
    // The widened entry point is still bounded by recoveryAdmission(): the account id inside the
    // bearer must equal the chatgpt-account-id header, so this one is refused before any I/O.
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("recovery must not dispatch for a denied caller");
    }) as typeof fetch;

    const headers = midThreadHeaders();
    headers.set("chatgpt-account-id", "mismatched-account-sentinel");
    const response = await post(routedConfig(), "xai/grok-4.5", encryptedInput(), headers);
    const raw = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(raw)).toMatchObject({
      error: { code: "unreadable_encrypted_agent_task", recovery_reason: "admission_denied" },
    });
    expect(fetches).toBe(0);
    expect(raw).not.toContain(FERNET_TASK);
  });

  test("a loopback-listener admission recovers under a separately authenticated public bind", async () => {
    const config = routedConfig();
    config.hostname = "127.0.0.2";
    const urls: string[] = [];
    let providerBody = "";
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("chatgpt.com")) {
        return new Response(recoverySse("Review the frozen candidate."));
      }
      providerBody = typeof init?.body === "string" ? init.body : "";
      return providerResponse();
    }) as typeof fetch;
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...Object.fromEntries(codexHeaders()) },
      body: JSON.stringify({ model: "xai/grok-4.5", input: encryptedInput(), stream: false }),
    });

    const response = await handleResponses(req, config, { model: "", provider: "" }, {
      admission: { kind: "loopback", source: "loopback" },
    });

    expect(response.status).toBe(200);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("chatgpt.com/backend-api/codex");
    expect(urls[1]).toContain("api.x.ai");
    expect(providerBody).toContain("Review the frozen candidate.");
    expect(providerBody).not.toContain(FERNET_TASK);
  });

  test.each([
    ["x-api-key", false],
    ["x-api-key", true],
    ["x-opencodex-api-key", false],
    ["x-opencodex-api-key", true],
  ] as const)(
    "a WebSocket replay keeps the %s recovery veto after header filtering (cached=%s)",
    async (_headerName, cached) => {
      const config = routedConfig();
      config.hostname = "127.0.0.2";
      let fetches = 0;
      const request = () => new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", ...Object.fromEntries(codexHeaders()) },
        body: JSON.stringify({ model: "xai/grok-4.5", input: encryptedInput(), stream: false }),
      });
      if (cached) {
        globalThis.fetch = (async input => {
          fetches += 1;
          return String(input).includes("chatgpt.com")
            ? new Response(recoverySse("Cached private assignment."))
            : providerResponse();
        }) as typeof fetch;
        expect((await handleResponses(request(), config, { model: "", provider: "" }, {
          admission: { kind: "loopback", source: "loopback" },
        })).status).toBe(200);
        fetches = 0;
      }
      globalThis.fetch = (async () => {
        fetches += 1;
        throw new Error("a forbidden WebSocket recovery must not reach any upstream");
      }) as typeof fetch;

      const response = await handleResponses(request(), config, { model: "", provider: "" }, {
        admission: { kind: "loopback", source: "loopback" },
        agentTaskRecoveryApiKeyHeaderPresent: true,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "unreadable_encrypted_agent_task", recovery_reason: "admission_denied" },
      });
      expect(fetches).toBe(0);
    },
  );
});
