import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  rememberResponseState,
} from "../src/responses/state";
import { warnAgentTaskRecoveryStartup } from "../src/server";
import { handleResponses } from "../src/server/responses";
import {
  agentTaskRecoveryConfig,
  recoverEncryptedAgentTask,
  recoverAgentTaskHistory,
  resetAgentTaskRecoveryState,
  verifyRecoveredAgentTaskDelivery,
  type AgentTaskRecoveryResult,
} from "../src/server/responses/agent-task-recovery";
import { agentTaskRecoveryWaiterCountForTests } from "../src/server/responses/agent-task-recovery-cache";
import {
  agentMessage,
  codexHeaders,
  encryptedInput,
  FERNET_TASK,
  originalFetch,
  post,
  providerResponse,
  recoveryArgumentsDoneSse,
  recoveryCompletedSse,
  recoverySse,
  routedConfig,
  ROUTING_ENVELOPE,
  SECOND_FERNET_TASK,
} from "./helpers/agent-task-recovery";

const AGENT_TASK_RECOVERY_LOG_PREFIX = "[opencodex] agent-task-recovery ";

function indexedFernetTask(index: number): string {
  const raw = Buffer.alloc(73, 0x5a);
  raw[0] = 0x80;
  raw.writeBigUInt64BE(1_720_000_000n, 1);
  raw.writeUInt32BE(index, 25);
  const unpadded = raw.toString("base64url");
  return `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
}

async function captureAgentTaskRecoveryDiagnostics(
  run: () => Promise<void>,
): Promise<{ events: Array<Record<string, unknown>>; raw: string }> {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    await run();
  } finally {
    console.warn = originalWarn;
  }
  const matching = warnings.filter(line => line.startsWith(AGENT_TASK_RECOVERY_LOG_PREFIX));
  return {
    events: matching.map(line => JSON.parse(line.slice(AGENT_TASK_RECOVERY_LOG_PREFIX.length))),
    raw: matching.join("\n"),
  };
}

describe("agent task recovery (opt-in, default off)", () => {
  beforeEach(() => {
    clearResponseStateMemoryForTests();
    resetAgentTaskRecoveryState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAgentTaskRecoveryState();
    clearResponseStateForTests();
  });

  test("keeps the disabled fail-fast response byte-identical to the absent feature", async () => {
    const snapshot = async (config: ReturnType<typeof routedConfig>) => {
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("recovery and provider dispatch must stay unreachable");
      }) as typeof fetch;
      const response = await post(config, "xai/grok-4.5", encryptedInput(), codexHeaders());
      return {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()].sort(),
        body: Buffer.from(await response.arrayBuffer()).toString("hex"),
        fetchCalls,
      };
    };

    const absent = await snapshot(routedConfig(null));
    const disabled = await snapshot(routedConfig({ enabled: false }));

    expect(disabled).toEqual(absent);
    expect(absent.status).toBe(400);
    const raw = Buffer.from(absent.body, "hex").toString("utf8");
    expect(JSON.parse(raw)).toMatchObject({
      error: { code: "unreadable_encrypted_agent_task" },
    });
    expect(absent.fetchCalls).toBe(0);
    expect(raw).not.toContain(FERNET_TASK);
    expect(raw).not.toContain("acct-caller");
  });

  test("rejects a post-reparse delivery whose bytes or keyed fingerprint do not match recovery", () => {
    const result: AgentTaskRecoveryResult = {
      recovered: true,
      assignmentBytes: Buffer.byteLength("expected assignment"),
      assignmentFingerprint: "not-the-process-keyed-fingerprint",
      cacheKey: "opaque-cache-key",
    };
    const reparsed = {
      context: { messages: [{ role: "user", content: "different assignment" }] },
    };
    expect(verifyRecoveredAgentTaskDelivery(reparsed, result)).toBe(false);
  });

  test("fails closed on a forced post-reparse mismatch and discards the recovery cache", async () => {
    const assignment = "Mismatch-sensitive assignment.";
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response(recoverySse(assignment), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;
    const request = () => new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...Object.fromEntries(codexHeaders()) },
      body: JSON.stringify({ model: "xai/grok-4.5", input: encryptedInput(), stream: false }),
    });
    let hookRuns = 0;
    const first = await captureAgentTaskRecoveryDiagnostics(async () => {
      const response = await handleResponses(request(), routedConfig(), { model: "", provider: "" }, {
        recoveryDeliveryTestHook: input => {
          hookRuns += 1;
          const terminal = (input as Array<Record<string, unknown>>).at(-1)!;
          terminal.content = [{ type: "input_text", text: "tampered assignment" }];
        },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "unreadable_encrypted_agent_task" } });
    });
    expect(hookRuns).toBe(1);
    expect(providerFetches).toBe(0);
    expect(first.events).toContainEqual(expect.objectContaining({ stage: "delivery", outcome: "rejected" }));

    const retry = await handleResponses(request(), routedConfig(), { model: "", provider: "" });
    expect(retry.status).toBe(200);
    expect(recoveryFetches).toBe(2);
    expect(providerFetches).toBe(1);
  });

  test("discards recovery when the caller cancels before provider handoff", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async input => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response(recoverySse("Cancellation-sensitive assignment."), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;
    const request = () => new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...Object.fromEntries(codexHeaders()) },
      body: JSON.stringify({ model: "xai/grok-4.5", input: encryptedInput(), stream: false }),
    });
    const controller = new AbortController();
    const cancelled = await handleResponses(request(), routedConfig(), { model: "", provider: "" }, {
      abortSignal: controller.signal,
      recoveryDeliveryTestHook: () => controller.abort(),
    });
    expect(cancelled.status).toBe(499);
    expect(providerFetches).toBe(0);

    const retry = await handleResponses(request(), routedConfig(), { model: "", provider: "" });
    expect(retry.status).toBe(200);
    expect(recoveryFetches).toBe(2);
    expect(providerFetches).toBe(1);
  });

  test("keeps disabled normal routed requests behaviorally identical to the absent feature", async () => {
    const snapshot = async (config: ReturnType<typeof routedConfig>) => {
      let request: unknown = null;
      globalThis.fetch = (async (input, init) => {
        request = {
          url: String(input),
          method: init?.method,
          headers: [...new Headers(init?.headers).entries()]
            .filter(([name]) => name !== "x-grok-req-id")
            .sort(),
          body: typeof init?.body === "string"
            ? Buffer.from(init.body).toString("hex")
            : null,
        };
        return providerResponse();
      }) as typeof fetch;
      const response = await post(
        config,
        "xai/grok-4.5",
        agentMessage([{ type: "input_text", text: "Ordinary routed request." }]),
        codexHeaders(),
      );
      const responseBody = await response.json() as Record<string, unknown>;
      delete responseBody.id;
      delete responseBody.created_at;
      return {
        request,
        response: {
          status: response.status,
          headers: [...response.headers.entries()].sort(),
          body: responseBody,
        },
      };
    };

    expect(await snapshot(routedConfig({ enabled: false }))).toEqual(await snapshot(routedConfig(null)));
  });

  test("warns at startup only for an explicit recovery opt-in without exposing credentials", () => {
    const config = routedConfig(null);
    const secret = "startup-secret-sentinel";
    config.providers.xai!.apiKey = secret;
    const originalWarn = console.warn;
    const capture = (recovery: typeof config.agentTaskRecovery): string[] => {
      const warnings: string[] = [];
      config.agentTaskRecovery = recovery;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
      warnAgentTaskRecoveryStartup(config);
      return warnings;
    };

    try {
      expect(capture(undefined)).toEqual([]);
      expect(capture({ enabled: false })).toEqual([]);
      const warnings = capture({ enabled: true });
      expect(warnings).toHaveLength(3);
      expect(warnings.join("\n")).toContain("Experimental encrypted V2 task recovery is enabled");
      expect(warnings.join("\n")).toContain("Recovered plaintext assignment data");
      expect(warnings.join("\n")).toContain("process-local in-memory cache");
      expect(warnings.join("\n")).not.toContain(secret);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("logs the exact stage that prevents encrypted task recovery", async () => {
    const noSpawnHeaders = codexHeaders();
    noSpawnHeaders.delete("x-openai-subagent");
    globalThis.fetch = (async () => {
      throw new Error("a rejected recovery path must not reach any upstream");
    }) as typeof fetch;
    const skipped = await captureAgentTaskRecoveryDiagnostics(async () => {
      const response = await post(routedConfig(), "xai/grok-4.5", encryptedInput(), noSpawnHeaders);
      expect(response.status).toBe(400);
    });
    expect(skipped.events).toContainEqual(expect.objectContaining({
      stage: "gate",
      outcome: "skipped",
      reason: "not_thread_spawn",
    }));

    resetAgentTaskRecoveryState();
    const proxyHeaders = codexHeaders("acct-proxy-log", { "x-api-key": "proxy-secret-log" });
    const rejected = await captureAgentTaskRecoveryDiagnostics(async () => {
      const response = await post(
        routedConfig(),
        "xai/grok-4.5",
        encryptedInput({ ciphertext: SECOND_FERNET_TASK }),
        proxyHeaders,
      );
      expect(response.status).toBe(400);
    });
    expect(rejected.events).toContainEqual(expect.objectContaining({
      stage: "admission",
      outcome: "rejected",
      reason: "api_key_header",
    }));

    resetAgentTaskRecoveryState();
    let recoveryFetches = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response("data: {not-json}\n\ndata: [DONE]\n\n", { status: 200 });
      }
      throw new Error("malformed recovery must not reach the routed provider");
    }) as typeof fetch;
    const failedMidway = await captureAgentTaskRecoveryDiagnostics(async () => {
      const response = await post(routedConfig(), "xai/grok-4.5", encryptedInput(), codexHeaders());
      expect(response.status).toBe(400);
    });
    expect(recoveryFetches).toBe(1);
    expect(failedMidway.events).toContainEqual(expect.objectContaining({
      stage: "fetch",
      outcome: "started",
    }));
    expect(failedMidway.events).toContainEqual(expect.objectContaining({
      stage: "extraction",
      outcome: "rejected",
      reason: "malformed_sse",
    }));

    const raw = [skipped.raw, rejected.raw, failedMidway.raw].join("\n");
    expect(raw).not.toContain(FERNET_TASK);
    expect(raw).not.toContain(SECOND_FERNET_TASK);
    expect(raw).not.toContain("acct-proxy-log");
    expect(raw).not.toContain("proxy-secret-log");
    expect(raw).not.toContain("Bearer");
  });

  test("baseline: encrypted routed task still fails when recovery returns no assignment", async () => {
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      fetchedUrls.push(String(input));
      return new Response("event: error\ndata: {}\n\n", { status: 200 });
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
    );
    const json = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(400);
    expect(json.error?.code).toBe("unreadable_encrypted_agent_task");
    expect(fetchedUrls.length).toBeGreaterThan(0);
    expect(fetchedUrls[0]).toContain("chatgpt.com/backend-api/codex");
  });

  test("uses the Terra default recovery model and logs a sanitized fetch-start diagnostic", async () => {
    let recoveryModel = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryModel = JSON.parse(typeof init?.body === "string" ? init.body : "{}").model;
        return new Response(recoverySse("Recover with the Terra default."), { status: 200 });
      }
      return providerResponse();
    }) as typeof fetch;

    const diagnostics = await captureAgentTaskRecoveryDiagnostics(async () => {
      const response = await post(routedConfig({ enabled: true }), "xai/grok-4.5", encryptedInput(), codexHeaders());
      expect(response.status).toBe(200);
    });

    expect(recoveryModel).toBe("gpt-5.6-terra");
    expect(diagnostics.events).toContainEqual(expect.objectContaining({
      stage: "fetch",
      outcome: "started",
      recoveryModel: "gpt-5.6-terra",
    }));
    expect(diagnostics.raw).not.toContain(FERNET_TASK);
    expect(diagnostics.raw).not.toContain("acct-caller");
  });

  test("uses Terra defensively when direct recovery receives a blank model", async () => {
    let recoveryModel = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryModel = JSON.parse(typeof init?.body === "string" ? init.body : "{}").model;
        return new Response(recoverySse("Recover with the defensive Terra default."), { status: 200 });
      }
      throw new Error("direct recovery must not dispatch to the routed provider");
    }) as typeof fetch;

    const input = encryptedInput();
    const result = await recoverEncryptedAgentTask(
      new Request("http://localhost/v1/responses", { headers: codexHeaders() }),
      input,
      { enabled: true, model: " \t " },
      routedConfig(),
    );

    expect(result.recovered).toBe(true);
    expect(recoveryModel).toBe("gpt-5.6-terra");
  });

  test("honors an explicit Sol recovery model override", async () => {
    let recoveryModel = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryModel = JSON.parse(typeof init?.body === "string" ? init.body : "{}").model;
        return new Response(recoverySse("Recover with the Sol override."), { status: 200 });
      }
      return providerResponse();
    }) as typeof fetch;

    const diagnostics = await captureAgentTaskRecoveryDiagnostics(async () => {
      const response = await post(
        routedConfig({ enabled: true, model: "gpt-5.6-sol" }),
        "xai/grok-4.5",
        encryptedInput({ taskName: "/root/sol-override" }),
        codexHeaders("acct-sol-override"),
      );
      expect(response.status).toBe(200);
    });

    expect(recoveryModel).toBe("gpt-5.6-sol");
    expect(diagnostics.events).toContainEqual(expect.objectContaining({
      stage: "fetch",
      outcome: "started",
      recoveryModel: "gpt-5.6-sol",
    }));
  });

  test("authenticated ChatGPT recovery accepts the decrypted payload without a duplicated routing envelope", async () => {
    const assignment = "Implement the focused regression test.";
    const fetchedUrls: string[] = [];
    const forwardedBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      fetchedUrls.push(String(input));
      const raw = typeof init?.body === "string" ? init.body : "";
      forwardedBodies.push(raw);
      if (String(input).includes("chatgpt.com")) {
        return new Response(recoverySse(assignment), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(fetchedUrls).toHaveLength(2);
    expect(fetchedUrls[0]).toContain("chatgpt.com/backend-api/codex");
    expect(forwardedBodies[0]).toContain("capture_assignment");
    expect(forwardedBodies[1]).toContain("Implement the focused regression test.");
    expect(forwardedBodies[1]).not.toContain(FERNET_TASK);
    expect(forwardedBodies[1].match(/Message Type: NEW_TASK/g) ?? []).toHaveLength(0);
    const routedBody = JSON.parse(forwardedBodies[1]!) as { messages?: Array<{ role?: string; content?: unknown }> };
    const terminal = routedBody.messages?.at(-1);
    expect(terminal?.role).toBe("user");
    expect(terminal?.content === assignment || JSON.stringify(terminal?.content) === JSON.stringify([{ type: "text", text: assignment }])).toBe(true);
  });

  test("recovers an encrypted MESSAGE follow-up before routed-provider dispatch", async () => {
    const assignment = "Continue the exact-head review and report the remaining findings.";
    const fetchedUrls: string[] = [];
    const forwardedBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      fetchedUrls.push(String(input));
      const raw = typeof init?.body === "string" ? init.body : "";
      if (String(input).includes("chatgpt.com")) {
        return new Response(recoverySse(assignment), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      forwardedBodies.push(raw);
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput({ messageType: "MESSAGE" }),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(fetchedUrls).toHaveLength(2);
    expect(fetchedUrls[0]).toContain("chatgpt.com/backend-api/codex");
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).toContain(assignment);
    expect(forwardedBodies[0]).not.toContain(FERNET_TASK);
    expect(forwardedBodies[0]).not.toContain("Message Type: MESSAGE");
  });

  test("rehydrates recovered task and MESSAGE history on a tool-result continuation", async () => {
    const task = "Inspect the checkout, then wait for the follow-up.";
    const message = "After the tool call, return the exact acknowledgement.";
    let recoveryFetches = 0;
    const providerBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response(recoverySse(raw.includes("Message Type: MESSAGE") ? message : task), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      providerBodies.push(raw);
      return providerResponse();
    }) as typeof fetch;
    const headers = codexHeaders("acct-tool-continuation", {
      "x-codex-parent-thread-id": "parent-tool-continuation",
    });
    const taskInput = encryptedInput({ ciphertext: FERNET_TASK });
    const messageInput = encryptedInput({
      ciphertext: SECOND_FERNET_TASK,
      messageType: "MESSAGE",
    });

    expect((await post(routedConfig(), "xai/grok-4.5", structuredClone(taskInput), headers)).status).toBe(200);
    expect((await post(routedConfig(), "xai/grok-4.5", structuredClone(messageInput), headers)).status).toBe(200);

    const continuation = [
      structuredClone(taskInput[0]),
      structuredClone(messageInput[0]),
      {
        type: "function_call",
        id: "fc_recovered_history",
        call_id: "call_recovered_history",
        name: "exec",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_recovered_history",
        output: "013e3c355",
      },
    ];
    const response = await post(routedConfig(), "xai/grok-4.5", continuation, headers);

    expect(response.status).toBe(200);
    expect(recoveryFetches).toBe(2);
    const finalProviderBody = providerBodies.at(-1)!;
    expect(finalProviderBody).toContain(task);
    expect(finalProviderBody).toContain(message);
    expect(finalProviderBody).not.toContain(FERNET_TASK);
    expect(finalProviderBody).not.toContain(SECOND_FERNET_TASK);
    expect(finalProviderBody).not.toContain("Message Type: NEW_TASK");
    expect(finalProviderBody).not.toContain("Message Type: MESSAGE");
  });

  test("detaches rehydrated history from the continuation source items", async () => {
    const assignment = "Detached cached assignment.";
    globalThis.fetch = (async input => {
      if (String(input).includes("chatgpt.com")) {
        return new Response(recoverySse(assignment), { status: 200 });
      }
      return providerResponse();
    }) as typeof fetch;
    const config = routedConfig();
    const options = agentTaskRecoveryConfig(config)!;
    const headers = codexHeaders("acct-detached-history", {
      "x-codex-parent-thread-id": "parent-detached-history",
    });
    const request = new Request("http://localhost/v1/responses", { headers });
    const seeded = encryptedInput();
    expect((await recoverEncryptedAgentTask(
      request,
      seeded,
      options,
      config,
      { parentThreadId: "parent-detached-history" },
    )).recovered).toBe(true);

    const sourceItem = encryptedInput()[0] as Record<string, unknown>;
    const input = [
      sourceItem,
      { type: "function_call_output", call_id: "call_detached_history", output: "done" },
    ];
    expect(await recoverAgentTaskHistory(
      request,
      input,
      options,
      config,
      { parentThreadId: "parent-detached-history" },
    )).toEqual({ matched: 1, recovered: 1, recoveryCount: 0, complete: true });

    expect(input[0]).not.toBe(sourceItem);
    expect(JSON.stringify(input[0])).toContain(assignment);
    expect(JSON.stringify(sourceItem)).toContain(FERNET_TASK);
    expect(JSON.stringify(sourceItem)).not.toContain(assignment);
  });

  test("leaves cached encrypted history untouched for native fallback", async () => {
    const assignment = "Routed-only cached history.";
    const nativeBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const raw = typeof init?.body === "string" ? init.body : "";
      if (url.includes("chatgpt.com") && raw.includes("capture_assignment")) {
        return new Response(recoverySse(assignment), { status: 200 });
      }
      if (url.includes("chatgpt.com")) nativeBodies.push(raw);
      return providerResponse();
    }) as typeof fetch;
    const headers = codexHeaders("acct-native-history", {
      "x-codex-parent-thread-id": "parent-native-history",
    });
    const taskInput = encryptedInput();
    expect((await post(
      routedConfig(),
      "xai/grok-4.5",
      structuredClone(taskInput),
      headers,
    )).status).toBe(200);

    const response = await post(routedConfig(), "gpt-5.5", [
      structuredClone(taskInput[0]),
      { type: "function_call_output", call_id: "call_native_history", output: "done" },
    ], headers);

    expect(response.status).toBe(200);
    expect(nativeBodies).toHaveLength(1);
    expect(nativeBodies[0]).toContain(FERNET_TASK);
    expect(nativeBodies[0]).not.toContain(assignment);
  });

  test("recovers missing routed history entries before provider dispatch", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async (input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response(recoverySse(
          raw.includes("Message Type: MESSAGE") ? "Cached follow-up." : "Evicted task.",
        ), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;
    const config = routedConfig({ enabled: true, cacheEntries: 1 });
    const headers = codexHeaders("acct-partial-history", {
      "x-codex-parent-thread-id": "parent-partial-history",
    });
    const taskInput = encryptedInput();
    const messageInput = encryptedInput({
      ciphertext: SECOND_FERNET_TASK,
      messageType: "MESSAGE",
    });
    expect((await post(config, "xai/grok-4.5", structuredClone(taskInput), headers)).status).toBe(200);
    expect((await post(config, "xai/grok-4.5", structuredClone(messageInput), headers)).status).toBe(200);

    const response = await post(config, "xai/grok-4.5", [
      structuredClone(taskInput[0]),
      structuredClone(messageInput[0]),
      { type: "function_call_output", call_id: "call_partial_history", output: "done" },
    ], headers);

    expect(response.status).toBe(200);
    expect(recoveryFetches).toBe(3);
    expect(providerFetches).toBe(3);
  });

  test("recovers more than thirty-two uncached historical envelopes without a hard cap failure", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async input => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response(recoverySse("Recovered historical message."), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;
    const history = Array.from({ length: 33 }, (_, index) => encryptedInput({
      ciphertext: indexedFernetTask(index),
      taskName: `/root/worker-${index}`,
    })[0]);
    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      [...history, { type: "function_call_output", call_id: "call_large_history", output: "done" }],
      codexHeaders("acct-large-history", { "x-codex-parent-thread-id": "parent-large-history" }),
    );

    expect(response.status).toBe(200);
    expect(recoveryFetches).toBe(33);
    expect(providerFetches).toBe(1);
  });

  test("rejects an excessive historical envelope count before recovery fetch", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async (input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (String(input).includes("chatgpt.com") && raw.includes("capture_assignment")) {
        recoveryFetches += 1;
        return new Response(recoverySse("Must not recover."), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;
    const history = Array.from({ length: 129 }, (_, index) => encryptedInput({
      ciphertext: indexedFernetTask(index),
      taskName: `/root/excess-${index}`,
    })[0]);

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      [...history, encryptedInput({
        ciphertext: SECOND_FERNET_TASK,
        messageType: "MESSAGE",
      })[0]],
      codexHeaders("acct-excess-history", { "x-codex-parent-thread-id": "parent-excess-history" }),
    );

    expect(response.status).toBe(400);
    expect(recoveryFetches).toBe(0);
    expect(providerFetches).toBe(0);
  });

  test("rejects malformed historical Fernet collaboration before recovery fetch", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async (input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (String(input).includes("chatgpt.com") && raw.includes("capture_assignment")) {
        recoveryFetches += 1;
        return new Response(recoverySse("Must not recover."), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;
    const malformed = encryptedInput()[0] as Record<string, unknown>;
    (malformed.content as Array<Record<string, unknown>>)[0] = {
      type: "input_text",
      text: "Message Type: MESSAGE\nTask name: /root/other\nSender: /root\nPayload:\n",
    };

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      [malformed, { type: "function_call_output", call_id: "call_malformed_history", output: "done" }],
      codexHeaders("acct-malformed-history", { "x-codex-parent-thread-id": "parent-malformed-history" }),
    );

    expect(response.status).toBe(400);
    expect(recoveryFetches).toBe(0);
    expect(providerFetches).toBe(0);
  });

  test("rejects excessive aggregate recovered history before provider dispatch", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    const largeAssignment = "x".repeat(2 * 1024 * 1024 - 1);
    globalThis.fetch = (async (input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (String(input).includes("chatgpt.com") && raw.includes("capture_assignment")) {
        recoveryFetches += 1;
        return new Response(recoverySse(largeAssignment), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;
    const history = Array.from({ length: 5 }, (_, index) => encryptedInput({
      ciphertext: indexedFernetTask(index),
      taskName: `/root/large-${index}`,
    })[0]);

    const response = await post(
      routedConfig({ enabled: true, cacheEntries: 10 }),
      "xai/grok-4.5",
      [...history, { type: "function_call_output", call_id: "call_large_plaintext", output: "done" }],
      codexHeaders("acct-large-plaintext", { "x-codex-parent-thread-id": "parent-large-plaintext" }),
    );

    expect(response.status).toBe(400);
    expect(recoveryFetches).toBe(5);
    expect(providerFetches).toBe(0);
  });

  test.each([
    { label: "translated Anthropic wire", options: { inboundWire: "anthropic" as const } },
    { label: "synthetic combo child", options: { comboAttempt: true } },
  ])("does not recover encrypted history for a $label", async ({ options }) => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async (input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (String(input).includes("chatgpt.com") && raw.includes("capture_assignment")) {
        recoveryFetches += 1;
        return new Response(recoverySse("Out-of-scope historical payload."), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;
    const headers = codexHeaders("acct-history-scope", {
      "x-codex-parent-thread-id": "parent-history-scope",
    });
    const request = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...Object.fromEntries(headers) },
      body: JSON.stringify({
        model: "xai/grok-4.5",
        input: [
          encryptedInput()[0],
          { type: "function_call_output", call_id: "call_history_scope", output: "done" },
        ],
        stream: false,
      }),
    });

    const response = await handleResponses(
      request,
      routedConfig(),
      { model: "", provider: "" },
      options,
    );

    expect(response.status).toBe(200);
    expect(recoveryFetches).toBe(0);
    expect(providerFetches).toBe(1);
  });

  test("fails closed without provider dispatch when historical recovery fails", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async (input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        if (recoveryFetches === 3) return new Response("unavailable", { status: 503 });
        return new Response(recoverySse(
          raw.includes("Message Type: MESSAGE") ? "Cached follow-up." : "Evicted task.",
        ), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;
    const config = routedConfig({ enabled: true, cacheEntries: 1 });
    const headers = codexHeaders("acct-history-failure", {
      "x-codex-parent-thread-id": "parent-history-failure",
    });
    const taskInput = encryptedInput();
    const messageInput = encryptedInput({
      ciphertext: SECOND_FERNET_TASK,
      messageType: "MESSAGE",
    });
    expect((await post(config, "xai/grok-4.5", structuredClone(taskInput), headers)).status).toBe(200);
    expect((await post(config, "xai/grok-4.5", structuredClone(messageInput), headers)).status).toBe(200);

    const response = await post(config, "xai/grok-4.5", [
      structuredClone(taskInput[0]),
      structuredClone(messageInput[0]),
      { type: "function_call_output", call_id: "call_history_failure", output: "done" },
    ], headers);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "unreadable_encrypted_agent_task" },
    });
    expect(recoveryFetches).toBe(3);
    expect(providerFetches).toBe(2);
  });

  test("recovers missing history before current-item recovery", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async (input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response(recoverySse(
          raw.includes(SECOND_FERNET_TASK) ? "Current cached message." : "Evicted prior task.",
        ), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;
    const config = routedConfig({ enabled: true, cacheEntries: 1 });
    const headers = codexHeaders("acct-current-after-miss", {
      "x-codex-parent-thread-id": "parent-current-after-miss",
    });
    const prior = encryptedInput();
    const current = encryptedInput({
      ciphertext: SECOND_FERNET_TASK,
      messageType: "MESSAGE",
    });
    expect((await post(config, "xai/grok-4.5", structuredClone(prior), headers)).status).toBe(200);
    expect((await post(config, "xai/grok-4.5", structuredClone(current), headers)).status).toBe(200);

    const response = await post(config, "xai/grok-4.5", [
      structuredClone(prior[0]),
      structuredClone(current[0]),
    ], headers);

    expect(response.status).toBe(200);
    expect(recoveryFetches).toBe(4);
    expect(providerFetches).toBe(3);
  });

  test.each([
    { type: "additional_tools", role: "developer", tools: [] },
    { type: "compaction_trigger" },
  ])("recovers the current encrypted item before trailing $type metadata", async (trailer) => {
    const assignment = `Current task before ${trailer.type}.`;
    let recoveryFetches = 0;
    let providerFetches = 0;
    let providerBody = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response(recoverySse(assignment), { status: 200 });
      }
      providerFetches += 1;
      providerBody = typeof init?.body === "string" ? init.body : "";
      return providerResponse();
    }) as typeof fetch;

    const headers = codexHeaders("acct-trailing-metadata", {
      "x-codex-parent-thread-id": `parent-${trailer.type}`,
    });
    expect((await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      headers,
    )).status).toBe(200);

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      [...encryptedInput(), trailer],
      headers,
    );

    expect(response.status).toBe(200);
    expect(recoveryFetches).toBe(1);
    expect(providerFetches).toBe(2);
    expect(providerBody).toContain(assignment);
    expect(providerBody).not.toContain(FERNET_TASK);
  });

  test("emits matching keyed assignment metadata for extraction and delivery", async () => {
    const assignment = "Metadata-safe assignment payload.";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        return new Response(recoverySse(assignment), { status: 200 });
      }
      return providerResponse();
    }) as typeof fetch;
    const diagnostics = await captureAgentTaskRecoveryDiagnostics(async () => {
      expect((await post(routedConfig(), "xai/grok-4.5", encryptedInput(), codexHeaders())).status).toBe(200);
    });
    const extraction = diagnostics.events.find(event => event.stage === "extraction" && event.outcome === "accepted");
    const delivery = diagnostics.events.find(event => event.stage === "delivery" && event.outcome === "accepted");
    expect(extraction?.assignmentBytes).toBe(Buffer.byteLength(assignment));
    expect(delivery?.assignmentBytes).toBe(Buffer.byteLength(assignment));
    expect(typeof extraction?.assignmentFingerprint).toBe("string");
    expect(delivery?.assignmentFingerprint).toBe(extraction?.assignmentFingerprint);
    expect(diagnostics.raw).not.toContain(assignment);
    expect(diagnostics.raw).not.toContain(FERNET_TASK);
  });

  test.each([
    {
      label: "leading recognized CXC control preamble",
      assignment: `[CXC-LEAF-GUARD] obey the worker boundary.\n\n${ROUTING_ENVELOPE}Payload-only task.`,
      expectedStatus: 200,
    },
    {
      label: "arbitrary prefix before routing envelope",
      assignment: `Unrecognized prefix.\n${ROUTING_ENVELOPE}Payload-only task.`,
      expectedStatus: 400,
    },
    {
      label: "mismatched routing envelope",
      assignment: "Message Type: NEW_TASK\nTask name: /root/other\nSender: /root\nPayload:\n\nPayload-only task.",
      expectedStatus: 400,
    },
    {
      label: "mismatched MESSAGE routing envelope",
      assignment: "Message Type: MESSAGE\nTask name: /root/other\nSender: /root\nPayload:\n\nPayload-only task.",
      expectedStatus: 400,
    },
    {
      label: "repeated routing envelope",
      assignment: `${ROUTING_ENVELOPE}Payload-only task.\n${ROUTING_ENVELOPE}`,
      expectedStatus: 400,
    },
  ])("normalizes or rejects recovered transport metadata: $label", async ({ assignment, expectedStatus }) => {
    let providerFetches = 0;
    let providerBody = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) return new Response(recoverySse(assignment), { status: 200 });
      providerFetches += 1;
      providerBody = typeof init?.body === "string" ? init.body : "";
      return providerResponse();
    }) as typeof fetch;
    const response = await post(routedConfig(), "xai/grok-4.5", encryptedInput(), codexHeaders());
    expect(response.status).toBe(expectedStatus);
    if (expectedStatus === 200) {
      expect(providerFetches).toBe(1);
      expect(providerBody).toContain("Payload-only task.");
      expect(providerBody).not.toContain("Message Type: NEW_TASK");
      expect(providerBody).not.toContain("CXC-LEAF-GUARD");
    } else {
      expect(providerFetches).toBe(0);
    }
  });

  test("rejects unsupported encrypted agent message types before recovery", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("unsupported message types must not reach recovery or provider dispatch");
    }) as typeof fetch;
    const input = encryptedInput() as Array<Record<string, any>>;
    input[0].content[0].text = String(input[0].content[0].text)
      .replace("Message Type: NEW_TASK", "Message Type: FINAL_ANSWER");

    const response = await post(routedConfig(), "xai/grok-4.5", input, codexHeaders());

    expect(response.status).toBe(400);
    expect(fetchCalls).toBe(0);
    expect(await response.json()).toMatchObject({
      error: { code: "unreadable_encrypted_agent_task" },
    });
  });

  test("recovers an encrypted routed task materialized from previous_response_id", async () => {
    const assignment = "Recover the continued GPT child assignment.";
    rememberResponseState(
      { model: "xai/grok-4.5", input: encryptedInput() },
      { id: "resp_encrypted_parent", status: "completed", output: [] },
      undefined,
      { force: true },
    );

    const fetchedUrls: string[] = [];
    const forwardedBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("chatgpt.com")) {
        return new Response(recoverySse(assignment), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      forwardedBodies.push(typeof init?.body === "string" ? init.body : "");
      return providerResponse();
    }) as typeof fetch;

    const headers = codexHeaders();
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...Object.fromEntries(headers),
      },
      body: JSON.stringify({
        model: "xai/grok-4.5",
        previous_response_id: "resp_encrypted_parent",
        input: [],
        stream: false,
      }),
    }), routedConfig(), { model: "", provider: "" });

    expect(response.status).toBe(200);
    expect(fetchedUrls).toHaveLength(2);
    expect(fetchedUrls[0]).toContain("chatgpt.com/backend-api/codex/responses");
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).toContain(assignment);
    expect(forwardedBodies[0]).not.toContain(FERNET_TASK);
    expect(forwardedBodies[0].match(/Message Type: NEW_TASK/g) ?? []).toHaveLength(0);
  });

  test("charges namespaced tool bridge maps only once across recovery reparse", async () => {
    const recoveryRequests: Request[] = [];
    const providerRequests: Request[] = [];
    const requestHeaders = codexHeaders();
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("chatgpt.com")) {
        recoveryRequests.push(request);
        return new Response(recoverySse("Use the advertised tool."), { status: 200 });
      }
      providerRequests.push(request);
      return providerResponse();
    }) as typeof fetch;
    const namespace = "mcp__review";
    const name = "read_file";
    const wireName = `${namespace}__${name}`;
    const mappingBytes = new TextEncoder().encode(JSON.stringify([wireName, namespace, name])).byteLength;
    const budget = createTranslatorBudget();
    const originalCharge = budget.chargeRetained.bind(budget);
    const mappingCharges: number[] = [];
    budget.chargeRetained = (bytes, scope) => {
      if (scope.kind === "retained_collectors" && bytes === mappingBytes) mappingCharges.push(bytes);
      originalCharge(bytes, scope);
    };

    try {
      const response = await post(
        routedConfig(),
        "xai/grok-4.5",
        encryptedInput(),
        requestHeaders,
        undefined,
        {
          translatorBudget: budget,
          tools: [{
            type: "namespace",
            name: namespace,
            tools: [{ type: "function", name, parameters: { type: "object" } }],
          }],
        },
      );

      expect(response.status).toBe(200);
      expect(recoveryRequests).toHaveLength(1);
      expect(recoveryRequests[0]?.headers.get("authorization"))
        .toBe(requestHeaders.get("authorization"));
      expect(recoveryRequests[0]?.headers.get("chatgpt-account-id")).toBe("acct-caller");
      expect(providerRequests).toHaveLength(1);
      expect(mappingCharges).toHaveLength(1);
    } finally {
      budget.dispose();
    }
  });

  test("accepts function-call-arguments SSE events", async () => {
    const assignment = "Handle the recovered task.";
    let providerBody = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        return new Response(recoveryArgumentsDoneSse(assignment), { status: 200 });
      }
      providerBody = typeof init?.body === "string" ? init.body : "";
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(providerBody).not.toContain("Message Type: NEW_TASK");
    expect(providerBody).toContain(assignment);
    expect(providerBody).not.toContain(FERNET_TASK);
  });

  test("accepts an assignment carried only by the completed response snapshot", async () => {
    const assignment = "Read the completed response output.";
    let providerBody = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        return new Response(recoveryCompletedSse(assignment), { status: 200 });
      }
      providerBody = typeof init?.body === "string" ? init.body : "";
      return providerResponse();
    }) as typeof fetch;

    const response = await post(routedConfig(), "xai/grok-4.5", encryptedInput(), codexHeaders());

    expect(response.status).toBe(200);
    expect(providerBody).toContain(assignment);
  });

  test("fails closed when completed recovery events disagree", async () => {
    let providerFetches = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        const first = recoverySse("First assignment.").split("data: {\"type\":\"response.completed\"")[0]!;
        return new Response(`${first}${recoveryCompletedSse("Second assignment.")}`, { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;

    const response = await post(routedConfig(), "xai/grok-4.5", encryptedInput(), codexHeaders());

    expect(response.status).toBe(400);
    expect(providerFetches).toBe(0);
  });

  test("fails closed on malformed recovery SSE without retrying or dispatching", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response("data: {not-json}\n\ndata: [DONE]\n\n", { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
    );
    const raw = await response.text();

    expect(response.status).toBe(400);
    expect(recoveryFetches).toBe(1);
    expect(providerFetches).toBe(0);
    expect(raw).not.toContain(FERNET_TASK);
    expect(raw).not.toContain("acct-caller");
  });

  test("rejects a plausible tool call when the recovery stream never completes", async () => {
    let providerFetches = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        const partial = recoverySse("Never dispatch this partial result.")
          .split("data: {\"type\":\"response.completed\"")[0]!;
        return new Response(partial, { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(400);
    expect(providerFetches).toBe(0);
  });

  test("times out recovery without dispatching the encrypted task", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = ((input, init) => {
      if (!String(input).includes("chatgpt.com")) {
        providerFetches += 1;
        return Promise.resolve(providerResponse());
      }
      recoveryFetches += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (signal?.aborted) rejectAbort();
        else signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true, timeoutMs: 1_000 }),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(400);
    expect(recoveryFetches).toBe(1);
    expect(providerFetches).toBe(0);
  });

  test("cancels recovery with the client and never reaches the routed provider", async () => {
    const controller = new AbortController();
    let markRecoveryStarted: (() => void) | undefined;
    const recoveryStarted = new Promise<void>((resolve) => {
      markRecoveryStarted = resolve;
    });
    let providerFetches = 0;
    globalThis.fetch = ((input, init) => {
      if (!String(input).includes("chatgpt.com")) {
        providerFetches += 1;
        return Promise.resolve(providerResponse());
      }
      markRecoveryStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (signal?.aborted) rejectAbort();
        else signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    }) as typeof fetch;

    const pending = post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
      controller.signal,
    );
    await recoveryStarted;
    controller.abort(new DOMException("client disconnected", "AbortError"));
    const response = await pending;

    expect(response.status).toBe(499);
    expect(providerFetches).toBe(0);
    expect(await response.json()).toMatchObject({
      error: { code: "client_cancelled" },
    });
  });

  test("scopes cache entries by parent thread and authenticated account", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response(recoverySse("Scoped cached assignment."), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;

    const headers = codexHeaders("acct-one", { "x-codex-parent-thread-id": "parent-one" });
    expect((await post(routedConfig(), "xai/grok-4.5", encryptedInput(), headers)).status).toBe(200);
    expect((await post(routedConfig(), "xai/grok-4.5", encryptedInput(), headers)).status).toBe(200);
    expect((await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders("acct-one", { "x-codex-parent-thread-id": "parent-two" }),
    )).status).toBe(200);
    expect((await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders("acct-two", { "x-codex-parent-thread-id": "parent-one" }),
    )).status).toBe(200);

    expect(recoveryFetches).toBe(3);
    expect(providerFetches).toBe(4);
  });

  test("deduplicates concurrent recovery for the same scoped task", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    let releaseRecovery: (() => void) | undefined;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        await recoveryGate;
        return new Response(recoverySse("Shared recovery assignment."), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;
    const headers = codexHeaders("acct-flight", { "x-codex-parent-thread-id": "parent-flight" });

    const first = post(routedConfig(), "xai/grok-4.5", encryptedInput(), headers);
    const second = post(routedConfig(), "xai/grok-4.5", encryptedInput(), headers);
    for (let turn = 0; turn < 200 && agentTaskRecoveryWaiterCountForTests() < 2; turn += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(agentTaskRecoveryWaiterCountForTests()).toBe(2);
    releaseRecovery?.();
    const responses = await Promise.all([first, second]);

    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(recoveryFetches).toBe(1);
    expect(providerFetches).toBe(2);
  });

  test("enforces the configured cache entry bound", async () => {
    let recoveryFetches = 0;
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        const body = typeof init?.body === "string" ? init.body : "";
        const assignment = body.includes(SECOND_FERNET_TASK) ? "Task B." : "Task A.";
        return new Response(recoverySse(assignment), { status: 200 });
      }
      return providerResponse();
    }) as typeof fetch;
    const config = routedConfig({ enabled: true, cacheEntries: 1 });
    const headers = codexHeaders("acct-cache", { "x-codex-parent-thread-id": "parent-cache" });

    expect((await post(config, "xai/grok-4.5", encryptedInput(), headers)).status).toBe(200);
    expect((await post(
      config,
      "xai/grok-4.5",
      encryptedInput({ ciphertext: SECOND_FERNET_TASK }),
      headers,
    )).status).toBe(200);
    expect((await post(config, "xai/grok-4.5", encryptedInput(), headers)).status).toBe(200);

    expect(recoveryFetches).toBe(3);
  });

  test("keeps plaintext v1-style tasks on the normal routed path", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    let providerBody = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        throw new Error("recovery must stay unreachable");
      }
      providerFetches += 1;
      providerBody = typeof init?.body === "string" ? init.body : "";
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      agentMessage([
        { type: "input_text", text: ROUTING_ENVELOPE },
        { type: "encrypted_content", encrypted_content: "Readable task payload." },
      ]),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(recoveryFetches).toBe(0);
    expect(providerFetches).toBe(1);
    expect(providerBody).toContain("Readable task payload.");
  });

  test("leaves native encrypted passthrough unchanged", async () => {
    let fetchedUrl = "";
    let forwardedBody = "";
    globalThis.fetch = (async (input, init) => {
      fetchedUrl = String(input);
      forwardedBody = typeof init?.body === "string" ? init.body : "";
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "gpt-5.5",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(fetchedUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(forwardedBody).toContain(FERNET_TASK);
    expect(forwardedBody).not.toContain("capture_assignment");
  });

  test("fails closed after a single failed combo recovery pass", async () => {
    const config = routedConfig();
    config.combos = {
      routed: {
        strategy: "failover",
        targets: [{ provider: "xai", model: "grok-4.5" }],
      },
    };
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      fetchedUrls.push(String(input));
      throw new Error("every upstream call must fail");
    }) as typeof fetch;

    const response = await post(
      config,
      "combo/routed",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(400);
    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain("chatgpt.com/backend-api/codex/responses");
    expect(await response.json()).toMatchObject({
      error: { code: "unreadable_encrypted_agent_task" },
    });
  });
});
