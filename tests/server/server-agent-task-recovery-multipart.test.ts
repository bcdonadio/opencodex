import { hasUnreadableEncryptedAgentTask, sanitizeEncryptedContentInPlace } from "../../src/server/responses/encrypted-payload";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  discardEncryptedAgentTaskRecovery,
  recoverEncryptedAgentTaskWithResult,
  resetAgentTaskRecoveryState,
  restoreCachedEncryptedAgentTasks,
} from "../../src/server/responses/agent-task-recovery";
import {
  agentMessage,
  codexHeaders,
  FERNET_TASK,
  FINAL_ANSWER_ENVELOPE,
  FINAL_ANSWER_TASK_ENVELOPE,
  encryptedInput,
  originalFetch,
  post,
  providerResponse,
  recoverySse,
  routedConfig,
  ROUTING_ENVELOPE,
  SECOND_FERNET_TASK,
} from "../helpers/agent-task-recovery";

describe("bounded multipart encrypted task recovery", () => {
  beforeEach(() => resetAgentTaskRecoveryState());
  afterEach(() => { globalThis.fetch = originalFetch; resetAgentTaskRecoveryState(); });
  const multipart = (tokens: string[] = [FERNET_TASK, SECOND_FERNET_TASK]) => agentMessage([
    { type: "input_text", text: ROUTING_ENVELOPE },
    ...tokens.map(encrypted_content => ({ type: "encrypted_content", encrypted_content })),
  ]);

  test.each(["NEW_TASK", "MESSAGE", "FOLLOWUP_TASK"] as const)("recovers ordered %s parts in one request and isolates sequence caches", async messageType => {
    let sends = 0;
    const sent: Array<{ input: Array<{ content: Array<{ encrypted_content?: string }> }> }> = [];
    globalThis.fetch = (async (_url, init) => {
      sends++;
      sent.push(JSON.parse(String(init?.body)));
      return new Response(recoverySse("Complete multipart assignment."));
    }) as typeof fetch;
    const input = () => {
      const value = multipart();
      const item = value[0] as { content: Array<Record<string, unknown>> };
      item.content[0]!.text = ROUTING_ENVELOPE.replace("NEW_TASK", messageType);
      return value;
    };
    const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
    const current = input();
    expect(await recoverEncryptedAgentTaskWithResult(req, current, {}, routedConfig())).toEqual({ recovered: true });
    expect(sent[0]!.input[0]!.content.slice(1).map(part => part.encrypted_content)).toEqual([FERNET_TASK, SECOND_FERNET_TASK]);
    expect(current).toEqual([{ type: "message", role: "user", content: [
      { type: "input_text", text: "Complete multipart assignment." },
    ] }]);
    expect(restoreCachedEncryptedAgentTasks(req, input(), routedConfig())).toBe(1);
    const reversed = input();
    (reversed[0] as { content: unknown[] }).content.splice(1, 2,
      { type: "encrypted_content", encrypted_content: SECOND_FERNET_TASK },
      { type: "encrypted_content", encrypted_content: FERNET_TASK });
    expect(restoreCachedEncryptedAgentTasks(req, reversed, routedConfig())).toBe(0);
    expect(await recoverEncryptedAgentTaskWithResult(req, reversed, {}, routedConfig())).toEqual({ recovered: true });
    expect(sends).toBe(2);
    discardEncryptedAgentTaskRecovery(req, input(), routedConfig());
    expect(restoreCachedEncryptedAgentTasks(req, input(), routedConfig())).toBe(0);
  });

  test("accepts exactly 32 whole parts without deduplicating ciphertext", async () => {
    let sends = 0;
    let forwarded: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      sends++;
      const body = JSON.parse(String(init?.body));
      forwarded = body.input[0].content.slice(1).map((part: { encrypted_content: string }) => part.encrypted_content);
      return new Response(recoverySse("All repeated parts retained."));
    }) as typeof fetch;
    const tokens = Array.from({ length: 32 }, () => FERNET_TASK);
    expect(await recoverEncryptedAgentTaskWithResult(new Request("http://localhost/v1/responses", { headers: codexHeaders() }), multipart(tokens), {}, routedConfig())).toEqual({ recovered: true });
    expect(forwarded).toEqual(tokens);
    expect(sends).toBe(1);
  });

  test("refuses malformed slots, nonconsecutive runs, and count/byte overflow without a fetch", async () => {
    let sends = 0;
    globalThis.fetch = (async () => { sends++; return new Response(recoverySse("must not run")); }) as typeof fetch;
    const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
    const tooLargeRaw = Buffer.alloc(57 + 16 * 131072, 0x5a);
    tooLargeRaw[0] = 0x80;
    const token = tooLargeRaw.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
    const boundedRaw = Buffer.alloc(57 + 16 * 50000, 0x5a);
    boundedRaw[0] = 0x80;
    const boundedToken = boundedRaw.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
    const cases = [multipart(Array.from({ length: 33 }, () => FERNET_TASK)), multipart([token]), multipart([boundedToken, boundedToken]),
      agentMessage([{ type: "input_text", text: ROUTING_ENVELOPE }, { type: "encrypted_content", encrypted_content: FERNET_TASK }, { type: "encrypted_content", encrypted_content: 123 }]),
      agentMessage([{ type: "input_text", text: ROUTING_ENVELOPE }, { type: "encrypted_content", encrypted_content: FERNET_TASK }, { type: "input_text", text: "" }, { type: "encrypted_content", encrypted_content: SECOND_FERNET_TASK }]),
    ];
    for (const input of cases) {
      const before = structuredClone(input);
      expect(await recoverEncryptedAgentTaskWithResult(req, input, {}, routedConfig())).toEqual({ recovered: false, reason: "unsupported_envelope" });
      expect(input).toEqual(before);
    }
    expect(sends).toBe(0);
  });

  test.each(["author", "header", "later-token"] as const)("revalidates %s after asynchronous recovery", async mutation => {
    let release!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = (() => { started(); return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch;
    const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
    const input = multipart();
    const pending = recoverEncryptedAgentTaskWithResult(req, input, {}, routedConfig());
    await ready;
    const item = input[0] as { author: string; content: Array<Record<string, unknown>> };
    if (mutation === "author") item.author = "changed-author";
    else if (mutation === "header") item.content[0]!.text = ROUTING_ENVELOPE.replace("NEW_TASK", "MESSAGE");
    else item.content[2]!.encrypted_content = FERNET_TASK;
    release(new Response(recoverySse("Must not replace changed task.")));
    expect(await pending).toEqual({ recovered: false, reason: "input_changed" });
    expect((input[0] as { type: string }).type).toBe("agent_message");
    expect(restoreCachedEncryptedAgentTasks(req, multipart(), routedConfig())).toBe(0);
  });

  test("split tokens remain unreadable through sanitization and never trigger recovery", async () => {
    const input = multipart([FERNET_TASK.slice(0, 50), FERNET_TASK.slice(50)]);
    const before = structuredClone(input);
    expect(hasUnreadableEncryptedAgentTask(input)).toBe(true);
    expect(sanitizeEncryptedContentInPlace(input)).toBe(0);
    expect(input).toEqual(before);
    expect(hasUnreadableEncryptedAgentTask(input)).toBe(true);
    let sends = 0;
    globalThis.fetch = (async () => { sends++; return providerResponse(); }) as typeof fetch;
    const response = await post(routedConfig(), "xai/grok-4.5", input, codexHeaders());
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unreadable_encrypted_agent_task");
    expect(sends).toBe(0);
  });

  test("identified fragments do not prevent independent plaintext-slot normalization", () => {
    const input = multipart([FERNET_TASK.slice(0, 50), FERNET_TASK.slice(50)]);
    const content = (input[0] as { content: Array<Record<string, unknown>> }).content;
    content.push({ type: "input_text", text: "Readable task." }, { type: "encrypted_content", encrypted_content: "Independent plaintext." });
    const fragments = structuredClone(content.slice(1, 3));
    expect(hasUnreadableEncryptedAgentTask(input)).toBe(false);
    expect(sanitizeEncryptedContentInPlace(input)).toBe(1);
    expect(content.slice(1, 3)).toEqual(fragments);
    expect(content.at(-1)).toEqual({ type: "input_text", text: "Independent plaintext." });
  });

  test("multipart backend 503 is still one attempt with bounded diagnostics", async () => {
    let sends = 0;
    globalThis.fetch = (async () => { sends++; return new Response("private failure", { status: 503 }); }) as typeof fetch;
    const result = await recoverEncryptedAgentTaskWithResult(new Request("http://localhost/v1/responses", { headers: codexHeaders() }), multipart(), {}, routedConfig());
    expect(result).toEqual({ recovered: false, reason: "recovery_http_rejected" });
    expect(sends).toBe(1);
  });
});

describe("FINAL_ANSWER encrypted task recovery", () => {
  beforeEach(() => resetAgentTaskRecoveryState());
  afterEach(() => { globalThis.fetch = originalFetch; resetAgentTaskRecoveryState(); });

  test("recovers a FINAL_ANSWER without a Task name line and replays it from cache", async () => {
    const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(recoverySse("Recovered final answer."));
    }) as typeof fetch;
    const input = () => agentMessage([
      { type: "input_text", text: FINAL_ANSWER_ENVELOPE },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]);
    const typedInput = input();
    expect(await recoverEncryptedAgentTaskWithResult(req, typedInput, {}, routedConfig())).toEqual({ recovered: true });
    expect(typedInput).toEqual([{
      type: "message", role: "user", content: [
        { type: "input_text", text: "Recovered final answer." },
      ],
    }]);
    expect(restoreCachedEncryptedAgentTasks(req, input(), routedConfig())).toBe(1);
    expect(fetches).toBe(1);
    discardEncryptedAgentTaskRecovery(req, input(), routedConfig());
    expect(restoreCachedEncryptedAgentTasks(req, input(), routedConfig())).toBe(0);
  });

  test("does not share a cache entry when a NUL byte moves between recipient and sender", async () => {
    // Both envelopes below carry the same admission scope, parent thread, message type, absent
    // Task name and ciphertext, and their recipient/sender fields concatenate to the same bytes
    // once a separator is placed between them. Moving where the NUL sits must not move the key.
    const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(recoverySse("Recovered final answer."));
    }) as typeof fetch;
    const input = (recipient: string, sender: string) => [{
      type: "agent_message",
      author: sender,
      recipient,
      content: [
        {
          type: "input_text",
          text: ["Message Type: FINAL_ANSWER", `Sender: ${sender}`, "Payload:", ""].join("\n"),
        },
        { type: "encrypted_content", encrypted_content: FERNET_TASK },
      ],
    }];
    expect(await recoverEncryptedAgentTaskWithResult(req, input("r", "s\0t"), {}, routedConfig()))
      .toEqual({ recovered: true });
    expect(fetches).toBe(1);
    // A different split of the same concatenation is a different envelope, not a cache hit.
    expect(restoreCachedEncryptedAgentTasks(req, input("r\0s", "t"), routedConfig())).toBe(0);
    // The envelope the cache was actually filled from still replays, so the line above is not
    // passing because nothing was cached at all.
    expect(restoreCachedEncryptedAgentTasks(req, input("r", "s\0t"), routedConfig())).toBe(1);
  });

  test("recovers a FINAL_ANSWER whose Task name matches the structured recipient", async () => {
    const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(recoverySse("Recovered final answer."));
    }) as typeof fetch;
    const input = agentMessage([
      { type: "input_text", text: FINAL_ANSWER_TASK_ENVELOPE },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]);
    expect(await recoverEncryptedAgentTaskWithResult(req, input, {}, routedConfig())).toEqual({ recovered: true });
    expect(fetches).toBe(1);
  });

  test("accepts a FINAL_ANSWER assignment that echoes its own header", async () => {
    const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(recoverySse(`${FINAL_ANSWER_ENVELOPE}Recovered final answer.`));
    }) as typeof fetch;
    const input = agentMessage([
      { type: "input_text", text: FINAL_ANSWER_ENVELOPE },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]);
    expect(await recoverEncryptedAgentTaskWithResult(req, input, {}, routedConfig())).toEqual({ recovered: true });
    expect(input).toEqual([{
      type: "message", role: "user", content: [
        { type: "input_text", text: "Recovered final answer." },
      ],
    }]);
    expect(fetches).toBe(1);
  });

  test.each([
    ["sender mismatch", () => [{
      type: "agent_message",
      author: "/other",
      recipient: "/root/worker",
      content: [
        { type: "input_text", text: FINAL_ANSWER_ENVELOPE },
        { type: "encrypted_content", encrypted_content: FERNET_TASK },
      ],
    }]],
    ["recipient mismatch against the Task name line", () => agentMessage([
      { type: "input_text", text: FINAL_ANSWER_TASK_ENVELOPE.replace("/root/worker", "/root/other-worker") },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ])],
  ] as const)("refuses %s FINAL_ANSWER without a recovery dispatch", async (_label, makeInput) => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(recoverySse("must not run"));
    }) as typeof fetch;
    const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
    const input = makeInput();
    const before = structuredClone(input);
    expect(await recoverEncryptedAgentTaskWithResult(req, input, {}, routedConfig())).toEqual({ recovered: false, reason: "unsupported_envelope" });
    expect(input).toEqual(before);
    expect(fetches).toBe(0);
  });
});

describe("recovery refuses a wrong-family echoed routing header", () => {
  beforeEach(() => resetAgentTaskRecoveryState());
  afterEach(() => { globalThis.fetch = originalFetch; resetAgentTaskRecoveryState(); });

  const echoCases: Array<[string, string, string]> = [
    ["FINAL_ANSWER envelope echoing a NEW_TASK header", FINAL_ANSWER_ENVELOPE, `${ROUTING_ENVELOPE}Recovered final answer.`],
    ["FINAL_ANSWER envelope echoing a NEW_TASK header mid-assignment", FINAL_ANSWER_ENVELOPE, `Recovered final answer.\n\n${ROUTING_ENVELOPE}`],
    ["FINAL_ANSWER echo followed by a NEW_TASK header", FINAL_ANSWER_ENVELOPE, `${FINAL_ANSWER_ENVELOPE}${ROUTING_ENVELOPE}Recovered final answer.`],
    ["NEW_TASK envelope echoing a FINAL_ANSWER header", ROUTING_ENVELOPE, `${FINAL_ANSWER_ENVELOPE}Recovered final answer.`],
    ["NEW_TASK echo followed by a FINAL_ANSWER header", ROUTING_ENVELOPE, `${ROUTING_ENVELOPE}${FINAL_ANSWER_ENVELOPE}Recovered task.`],
    ["MESSAGE envelope echoing a FINAL_ANSWER header", ROUTING_ENVELOPE.replace("NEW_TASK", "MESSAGE"), `${FINAL_ANSWER_ENVELOPE}Recovered final answer.`],
  ];

  test.each(echoCases)("refuses %s", async (_label, envelopeText, assignment) => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(recoverySse(assignment));
    }) as typeof fetch;
    const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
    const input = agentMessage([
      { type: "input_text", text: envelopeText },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]);
    const before = structuredClone(input);
    expect(await recoverEncryptedAgentTaskWithResult(req, input, {}, routedConfig())).toEqual({ recovered: false, reason: "recovery_invalid_output" });
    expect(input).toEqual(before);
    expect(fetches).toBe(1);
  });
});

describe("agent task recovery transient retry (#3661)", () => {
  beforeEach(() => resetAgentTaskRecoveryState());
  afterEach(() => { globalThis.fetch = originalFetch; resetAgentTaskRecoveryState(); });

  const req = () => new Request("http://localhost/v1/responses", { headers: codexHeaders() });

  test.each([500, 502, 503, 504, 520] as const)("a transient %d refusal retries within the configured budget and recovers", async status => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return fetches === 1
        ? new Response("private failure", { status })
        : new Response(recoverySse("Recovered after outage."));
    }) as typeof fetch;
    const input = encryptedInput();
    expect(await recoverEncryptedAgentTaskWithResult(req(), input, { retries: 1 }, routedConfig()))
      .toEqual({ recovered: true });
    expect(fetches).toBe(2);
    expect((input[0] as { content: unknown[] }).content.at(-1))
      .toEqual({ type: "input_text", text: "Recovered after outage." });
  });

  test.each([400, 401, 403, 404, 429] as const)("a %d refusal stays terminal under a configured retry budget", async status => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response("private failure", { status });
    }) as typeof fetch;
    expect(await recoverEncryptedAgentTaskWithResult(req(), encryptedInput(), { retries: 2 }, routedConfig()))
      .toEqual({ recovered: false, reason: "recovery_http_rejected" });
    expect(fetches).toBe(1);
  });

  test("persistent transient rejections exhaust the bounded retry budget", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response("private failure", { status: 503 });
    }) as typeof fetch;
    expect(await recoverEncryptedAgentTaskWithResult(req(), encryptedInput(), { retries: 2 }, routedConfig()))
      .toEqual({ recovered: false, reason: "recovery_http_rejected" });
    expect(fetches).toBe(3); // 1 initial + 2 retries
  });

  test("an over-budget retries value is clamped to the same bound", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response("private failure", { status: 503 });
    }) as typeof fetch;
    expect(await recoverEncryptedAgentTaskWithResult(req(), encryptedInput(), { retries: 99 }, routedConfig()))
      .toEqual({ recovered: false, reason: "recovery_http_rejected" });
    expect(fetches).toBe(3);
  });

  test("transport failures retry while invalid recovery output stays terminal", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      if (fetches === 1) throw new TypeError("private transport failure");
      return new Response("data: {not-json}\n\n");
    }) as typeof fetch;
    expect(await recoverEncryptedAgentTaskWithResult(req(), encryptedInput(), { retries: 2 }, routedConfig()))
      .toEqual({ recovered: false, reason: "recovery_invalid_output" });
    expect(fetches).toBe(2);
  });

  test("persistent transport failures exhaust the same bounded budget", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new TypeError("private transport failure");
    }) as typeof fetch;
    expect(await recoverEncryptedAgentTaskWithResult(req(), encryptedInput(), { retries: 2 }, routedConfig()))
      .toEqual({ recovered: false, reason: "recovery_transport_error" });
    expect(fetches).toBe(3);
  });

  test("caller cancellation during retry backoff reports caller_cancelled without another send", async () => {
    const caller = new AbortController();
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response("private failure", { status: 503 });
    }) as typeof fetch;
    const pending = recoverEncryptedAgentTaskWithResult(
      req(), encryptedInput(), { retries: 2 }, routedConfig(), { abortSignal: caller.signal },
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    caller.abort();
    expect(await pending).toEqual({ recovered: false, reason: "caller_cancelled" });
    expect(fetches).toBe(1);
  });

  test("a Retry-After past the recovery deadline ends with the failure instead of resending early", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response("private failure", { status: 503, headers: { "retry-after": "30" } });
    }) as typeof fetch;
    const started = Date.now();
    expect(await recoverEncryptedAgentTaskWithResult(req(), encryptedInput(), { retries: 2, timeoutMs: 5_000 }, routedConfig()))
      .toEqual({ recovered: false, reason: "recovery_http_rejected" });
    // Before the fix the 30 s instruction was clamped to the 2 s backoff cap and resent.
    expect(fetches).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a Retry-After inside the deadline is honoured as a floor, not capped", async () => {
    let fetches = 0;
    let firstAt = 0;
    let secondAt = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      if (fetches === 1) {
        firstAt = Date.now();
        return new Response("private failure", { status: 503, headers: { "retry-after": "2.5" } });
      }
      secondAt = Date.now();
      return new Response(recoverySse("Recovered after outage."));
    }) as typeof fetch;
    expect(await recoverEncryptedAgentTaskWithResult(req(), encryptedInput(), { retries: 1 }, routedConfig()))
      .toEqual({ recovered: true });
    expect(fetches).toBe(2);
    // 2.5 s exceeds RECOVERY_RETRY_MAX_DELAY_MS (2 s), so a capped wait would resend sooner.
    expect(secondAt - firstAt).toBeGreaterThanOrEqual(2_400);
  }, 10_000);
});
