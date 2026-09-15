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

  test.each(["NEW_TASK", "MESSAGE"] as const)("recovers ordered %s parts in one request and isolates sequence caches", async messageType => {
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
