import { afterEach, beforeEach, expect, test } from "bun:test";
import { codexWsUpstreamFetch } from "../../src/server/responses/ws-upstream";
import { codexWsPool } from "../../src/server/responses/codex-ws-pool";
import { NativeSteeringChannel } from "../../src/server/responses/native-steering";
import { NativeSteeringReplay } from "../../src/server/responses/native-steering-replay";
import { registerUpstreamRewriter } from "../../src/plugins/upstream-hooks";
import { recordReconstructedContext, transportObserver } from "../../src/server/transaction-capture";
import type { RequestLogContext } from "../../src/server/request-log";

const URL = "https://chatgpt.com/backend-api/codex/responses";
const realWebSocket = globalThis.WebSocket;
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let savedProxyEnv: Record<string, string | undefined>;
let sequence = 0;
type Frame = Record<string, unknown>;

class Socket extends EventTarget {
  static readonly OPEN = 1;
  static all: Socket[] = [];
  static onSend: (socket: Socket, frame: Frame) => void = socket => socket.complete();
  readyState = 0;
  frames: Frame[] = [];
  constructor() {
    super(); Socket.all.push(this);
    queueMicrotask(() => { if (!this.readyState) { this.readyState = 1; this.dispatchEvent(new Event("open")); } });
  }
  send(text: string) { const frame = JSON.parse(text); this.frames.push(frame); Socket.onSend(this, frame); }
  emit(payload: Frame) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) })); }
  complete(output: unknown[] = [call(++sequence)]) {
    const id = `resp_${sequence}`;
    queueMicrotask(() => {
      this.emit({ type: "response.created", response: { id } });
      this.emit({ type: "response.completed", response: { id, status: "completed", output } });
    });
  }
  close() { if (this.readyState !== 3) { this.readyState = 3; this.dispatchEvent(new Event("close")); } }
  ref() {} unref() {}
}
const call = (id: number) => ({ type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: "work", arguments: "{}", status: "completed" });
const replayCall = (id: number) => ({ type: "function_call", call_id: `call_${id}`, name: "work", arguments: "{}", status: "completed" });
const first = { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] };
const result = (id: number) => ({ type: "function_call_output", call_id: `call_${id}`, output: "done" });
function init(input: unknown[] = [first], extra: Frame = {}, headers: Record<string, string> = {}): RequestInit {
  return { method: "POST", headers: { authorization: "Bearer fixture-token", "chatgpt-account-id": "fixture-account", "thread-id": "fixture-thread", ...headers },
    body: JSON.stringify({ model: "fixture-model", stream: true, store: false, input, instructions: "fixture", tools: [{ type: "function", name: "work", parameters: { type: "object" } }],
      client_metadata: { thread_id: "fixture-thread", turn_id: "fixture-turn" }, ...extra }) };
}
const fallback = (async () => { throw new Error("unexpected HTTP fallback"); }) as typeof fetch;
const request = (options = init(), enabled = true, control?: NativeSteeringChannel, guard?: (headers: Headers) => void, pace?: () => Promise<void>, http = fallback) =>
  codexWsUpstreamFetch(URL, options, http, "1.4.0", undefined, guard, undefined, undefined, control, pace, enabled);
const drain = async (options = init(), enabled = true) => (await request(options, enabled)).text();

beforeEach(() => {
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  savedProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
});
afterEach(() => {
  codexWsPool.dispose();
  for (const socket of Socket.all) socket.close();
  Socket.all = []; Socket.onSend = socket => socket.complete(); sequence = 0;
  globalThis.WebSocket = realWebSocket;
  for (const key of proxyKeys) { delete process.env[key]; if (savedProxyEnv[key] !== undefined) process.env[key] = savedProxyEnv[key]; }
});

test("incremental opt-in sends only newly appended tool results on the retained exact context", async () => {
  await drain();
  const second = [first, replayCall(1), result(1)];
  await drain(init(second));
  await drain(init([...second, replayCall(2), result(2)]));
  expect(Socket.all).toHaveLength(1);
  expect(Socket.all[0]!.frames.map(frame => frame.input)).toEqual([[first], [result(1)], [result(2)]]);
  expect(Socket.all[0]!.frames.map(frame => frame.previous_response_id)).toEqual([undefined, "resp_1", "resp_2"]);
});

test("disabled optimization keeps every full input", async () => {
  await drain(init(), false);
  const input = [first, replayCall(1), result(1)];
  await drain(init(input), false);
  expect(Socket.all[0]!.frames[1]!.input).toEqual(input);
  expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
});

test.each([
  { instructions: "changed" }, { tools: [] }, { reasoning: { effort: "high" } }, { text: { verbosity: "low" } },
  { store: true }, { conversation: "other" }, { multi_agent: { enabled: true } }, { context_management: [{ type: "compaction" }] },
])("changed settings or unsupported shapes keep the full input: %j", async extra => {
  await drain(); const input = [first, replayCall(1), result(1)];
  await drain(init(input, extra));
  expect(Socket.all.at(-1)!.frames.at(-1)!.input).toEqual(input);
  expect(Socket.all.at(-1)!.frames.at(-1)!.previous_response_id).toBeUndefined();
});

test.each([
  [{ ...first, role: "developer" }, replayCall(1), result(1)],
  [first, { ...replayCall(1), call_id: "call_other" }, result(1)],
  [first, { ...replayCall(1), arguments: "changed" }, result(1)],
  [first, result(1)],
])("context or occurrence mismatch keeps the full input: %j", async input => {
  await drain(); await drain(init(input));
  expect(Socket.all[0]!.frames[1]!.input).toEqual(input);
  expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
});

test("content equality without a provider occurrence anchor never authorizes a delta", async () => {
  Socket.onSend = socket => { ++sequence; socket.complete([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "same" }] }]); };
  await drain(); const input = [first, { type: "message", role: "assistant", content: [{ type: "output_text", text: "same" }] }, first];
  await drain(init(input));
  expect(Socket.all[0]!.frames[1]!.input).toEqual(input);
});

test.each([{ model: "other-model" }, { service_tier: "priority" }, { client_metadata: { thread_id: "fixture-thread", turn_id: "another-turn" } }])(
  "a cold identity cannot borrow the previous socket context: %j", async extra => {
    await drain(); const input = [first, replayCall(1), result(1)]; await drain(init(input, extra));
    expect(Socket.all).toHaveLength(2); expect(Socket.all[1]!.frames[0]!.input).toEqual(input);
  });

test.each([{ authorization: "Bearer changed" }, { "chatgpt-account-id": "another-account" }])(
  "credential changes send complete input: %j", async headers => {
    await drain(); const input = [first, replayCall(1), result(1)]; await drain(init(input, {}, headers));
    expect(Socket.all).toHaveLength(2); expect(Socket.all[1]!.frames[0]!.input).toEqual(input);
  });

test.each(["previous_response_not_found", "unsupported_persisted_item_context"])("explicit parent rejection retries once with full input and fresh ownership: %s", async code => {
  await drain(); const input = [first, replayCall(1), result(1)]; let paced = 0; let guarded = 0;
  Socket.onSend = (socket, frame) => frame.previous_response_id
    ? queueMicrotask(() => socket.emit({ type: "error", status: 400, error: { code, param: "previous_response_id" } })) : socket.complete();
  const options = init(input); const control = new NativeSteeringChannel(JSON.parse(options.body as string));
  const response = await request(options, true, control, () => { guarded++; }, async () => { paced++; });
  expect(await response.text()).toContain("response.completed");
  expect(Socket.all).toHaveLength(2); expect(Socket.all[0]!.readyState).toBe(3);
  expect(Socket.all[0]!.frames[1]!.input).toEqual([result(1)]);
  expect(Socket.all[1]!.frames[0]!.input).toEqual(input);
  expect(Socket.all[1]!.frames[0]!.previous_response_id).toBeUndefined();
  expect(paced).toBe(1); expect(guarded).toBeGreaterThanOrEqual(3);
});

test.each(["other_error", "server_error", "unsupported_persisted_item_context"])("other precommit errors do not replay without a matching parent parameter: %s", async code => {
  await drain(); Socket.onSend = socket => queueMicrotask(() => socket.emit({ type: "error", status: code === "server_error" ? 500 : 400, error: { code } }));
  await (await request(init([first, replayCall(1), result(1)]))).text();
  expect(Socket.all).toHaveLength(1); expect(Socket.all[0]!.frames).toHaveLength(2);
});

test.each(["previous_response_not_found", "unsupported_persisted_item_context"])("parent rejection after acceptance never replays: %s", async code => {
  await drain(); Socket.onSend = socket => queueMicrotask(() => {
    socket.emit({ type: "response.created", response: { id: "resp_accepted" } });
    socket.emit({ type: "error", status: 400, error: { code, param: "previous_response_id" } });
  });
  await (await request(init([first, replayCall(1), result(1)]))).text();
  expect(Socket.all).toHaveLength(1); expect(Socket.all[0]!.frames).toHaveLength(2);
});

test("known pre-send failure falls back with the original full HTTP body", async () => {
  await drain(); const input = [first, replayCall(1), result(1)];
  Socket.onSend = () => { throw new Error("not sent"); };
  let observed: unknown;
  const http = (async (_url: unknown, options: RequestInit) => { observed = JSON.parse(options.body as string).input; return new Response("fallback"); }) as typeof fetch;
  expect(await (await request(init(input), true, undefined, undefined, undefined, http)).text()).toBe("fallback");
  expect(observed).toEqual(input);
});

test("object key ordering and per-frame metadata preserve exact JSON context", async () => {
  await drain();
  const reordered = { content: first.content, role: first.role, type: first.type };
  const output = { status: "completed", arguments: "{}", name: "work", call_id: "call_1", type: "function_call" };
  await drain(init([reordered, output, result(1)], { client_metadata: { thread_id: "fixture-thread", turn_id: "fixture-turn", trace: "current" } }));
  expect(Socket.all[0]!.frames[1]!.input).toEqual([result(1)]);
  expect(Socket.all[0]!.frames[1]!.client_metadata).toMatchObject({ trace: "current" });
});

test("additional response-field normalization fails closed instead of dropping historical fields", async () => {
  Socket.onSend = socket => { ++sequence; socket.complete([{ ...call(sequence), nested: { id: "keep_nested_id" } }]); };
  await drain(); const input = [first, { ...replayCall(1), nested: {} }, result(1)];
  await drain(init(input));
  expect(Socket.all[0]!.frames[1]!.input).toEqual(input);
  expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
});

test("a completed create without an occurrence anchor invalidates the older context proof", async () => {
  await drain();
  Socket.onSend = socket => { ++sequence; socket.complete([]); };
  await drain(init([first, replayCall(1), result(1)]));
  await drain(init([first, replayCall(1), result(1)]));
  expect(Socket.all[0]!.frames[2]!.input).toEqual([first, replayCall(1), result(1)]);
  expect(Socket.all[0]!.frames[2]!.previous_response_id).toBeUndefined();
});

test("deep response context cannot create an unbounded fingerprint traversal", async () => {
  let nested: unknown = "deep";
  for (let index = 0; index < 70; index++) nested = [nested];
  Socket.onSend = socket => { ++sequence; socket.complete([{ ...call(sequence), nested }]); };
  await drain(); const input = [first, { ...replayCall(1), nested }, result(1)];
  await drain(init(input));
  expect(Socket.all[0]!.frames[1]!.input).toEqual(input);
  expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
});

test("recovery refuses dispatch when the captured credential guard changes after pacing", async () => {
  await drain(); let valid = true;
  Socket.onSend = socket => queueMicrotask(() => socket.emit({ type: "error", status: 400, error: { code: "previous_response_not_found" } }));
  const options = init([first, replayCall(1), result(1)]);
  await expect(request(options, true, undefined, () => { if (!valid) throw new Error("credential changed"); }, async () => { valid = false; })).rejects.toThrow("credential changed");
  expect(Socket.all).toHaveLength(1); expect(Socket.all[0]!.frames).toHaveLength(2);
  expect(Socket.all[0]!.readyState).toBe(3);
});

test("a repeated state miss after cold full recovery cannot replay a third time", async () => {
  await drain(); Socket.onSend = socket => queueMicrotask(() => socket.emit({ type: "error", status: 400, error: { code: "previous_response_not_found" } }));
  const response = await request(init([first, replayCall(1), result(1)]));
  expect(response.status).toBe(400); await response.text();
  expect(Socket.all).toHaveLength(2); expect(Socket.all[1]!.frames).toHaveLength(1);
});

test("abort during state-miss pacing prevents full recovery", async () => {
  await drain(); const controller = new AbortController();
  Socket.onSend = socket => queueMicrotask(() => socket.emit({ type: "error", status: 400, error: { code: "previous_response_not_found" } }));
  await expect(request({ ...init([first, replayCall(1), result(1)]), signal: controller.signal }, true, undefined, undefined,
    async () => { controller.abort(new Error("cancelled")); })).rejects.toThrow("cancelled");
  expect(Socket.all).toHaveLength(1); expect(Socket.all[0]!.frames).toHaveLength(2);
});

test("a plugin gateway cannot inherit canonical backend incremental assumptions", async () => {
  const unregister = registerUpstreamRewriter("continuation-test", target => { target.url = "ws://127.0.0.1:9999/responses"; });
  try {
    await drain(); const input = [first, replayCall(1), result(1)]; await drain(init(input));
    expect(Socket.all).toHaveLength(1);
    expect(Socket.all[0]!.frames[1]!.input).toEqual(input);
    expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
  } finally { unregister(); }
});

test("excessive input item counts keep the full serialized create", async () => {
  await drain(); const input = [first, replayCall(1), ...Array.from({ length: 10_001 }, () => result(1))];
  await drain(init(input));
  expect(Socket.all[0]!.frames[1]!.input).toEqual(input);
  expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
});

test("transport diagnostics observe the actual smaller create while preserving local reconstruction", async () => {
  await drain();
  const ctx: RequestLogContext = { provider: "test", model: "fixture-model" };
  const input = [first, replayCall(1), result(1)];
  recordReconstructedContext(ctx, { input }, 2);
  await (await codexWsUpstreamFetch(URL, init(input), fallback, "1.4.0", undefined, undefined, undefined,
    transportObserver(ctx), undefined, undefined, true)).text();
  expect(ctx.diagnostics?.continuationMode).toBe("websocket_incremental");
  expect(ctx.diagnostics?.continuationDecisionReason).toBe("incremental");
  expect(ctx.diagnostics?.forwardedInputItemCount).toBe(1);
  expect(ctx.diagnostics?.replayedItemCount).toBe(2);
  expect(ctx.diagnostics?.upstreamReplayedItemCount).toBe(0);
});

test("sparse terminal output cannot duplicate an omitted completed stream item on a continuation", async () => {
  const assistant = { type: "message", id: "msg_extra", role: "assistant", content: [{ type: "output_text", text: "extra", annotations: [] }], status: "completed" };
  Socket.onSend = socket => {
    const id = `resp_${++sequence}`;
    queueMicrotask(() => {
      socket.emit({ type: "response.created", response: { id } });
      for (const [output_index, item] of [call(sequence), assistant].entries()) {
        socket.emit({ type: "response.output_item.added", output_index, item });
        socket.emit({ type: "response.output_item.done", output_index, item });
      }
      socket.emit({ type: "response.completed", response: { id, status: "completed", output: [call(sequence)] } });
    });
  };
  let saved: unknown[] = [];
  const options = init(); const control = new NativeSteeringChannel(JSON.parse(options.body as string));
  control.replayFactory = () => new NativeSteeringReplay([first], (input, response) => { saved = [...input, ...(response.output as unknown[])]; });
  await (await request(options, true, control)).text();
  const full = [...saved.map(item => { const { id: _id, ...rest } = item as Frame; return rest; }), result(1)];
  expect(full).toHaveLength(4);
  Socket.onSend = socket => socket.complete();
  await drain(init(full));
  expect(Socket.all[0]!.frames[1]!.input).toEqual(full);
  expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
});

test.each(["content", "order", "duplicate", "unfinished", "index"])("terminal inconsistency %s prevents context omission", async mode => {
  const second = { ...call(2), id: "fc_second" };
  Socket.onSend = socket => {
    const id = `resp_${++sequence}`;
    queueMicrotask(() => {
      socket.emit({ type: "response.created", response: { id } });
      for (const [output_index, item] of [call(1), second].entries()) {
        socket.emit({ type: "response.output_item.added", output_index: mode === "index" ? output_index + 1 : output_index, item });
        if (mode !== "unfinished") socket.emit({ type: "response.output_item.done", output_index, item });
      }
      const output = mode === "content" ? [{ ...call(1), arguments: "changed" }, second]
        : mode === "order" ? [second, call(1)] : mode === "duplicate" ? [call(1), call(1)] : [call(1), second];
      socket.emit({ type: "response.completed", response: { id, status: "completed", output } });
    });
  };
  await drain();
  const firstOutput = mode === "content" ? [{ ...replayCall(1), arguments: "changed" }, replayCall(2)]
    : mode === "order" ? [replayCall(2), replayCall(1)] : mode === "duplicate" ? [replayCall(1), replayCall(1)] : [replayCall(1), replayCall(2)];
  const input = [first, ...firstOutput, result(1)]; Socket.onSend = socket => socket.complete();
  await drain(init(input));
  expect(Socket.all[0]!.frames[1]!.input).toEqual(input);
  expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
});

test("complete consistent observed output preserves safe incremental continuation", async () => {
  Socket.onSend = socket => {
    const id = `resp_${++sequence}`;
    queueMicrotask(() => {
      socket.emit({ type: "response.created", response: { id } });
      socket.emit({ type: "response.output_item.added", output_index: 0, item: call(sequence) });
      socket.emit({ type: "response.output_item.done", output_index: 0, item: call(sequence) });
      socket.emit({ type: "response.completed", response: { id, status: "completed", output: [call(sequence)] } });
    });
  };
  await drain(); await drain(init([first, replayCall(1), result(1)]));
  expect(Socket.all[0]!.frames[1]!.input).toEqual([result(1)]);
});

const codexRawReasoning = { type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "summary" }], encrypted_content: "fixture_ciphertext" };
const codexRawCall = { ...call(1), namespace: null };
const codexRawMessage = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", phase: null,
  content: [{ type: "output_text", text: "fixture reply", annotations: [], logprobs: [] }] };
const stamped = { turn_id: "fixture-turn" };
const codexReplayReasoning = { type: "reasoning", summary: [{ type: "summary_text", text: "summary" }], encrypted_content: "fixture_ciphertext", content: null,
  internal_chat_message_metadata_passthrough: stamped };
const codexReplayCall = { type: "function_call", call_id: "call_1", name: "work", arguments: "{}", internal_chat_message_metadata_passthrough: stamped };
const codexReplayMessage = { type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture reply" }],
  internal_chat_message_metadata_passthrough: stamped };
function emitCodexOutput(socket: Socket) { ++sequence; socket.complete([codexRawReasoning, codexRawCall, codexRawMessage]); }

test("Codex typed replay preserves the same context after output projection and history turn stamping", async () => {
  Socket.onSend = emitCodexOutput;
  await drain(); Socket.onSend = socket => socket.complete();
  await drain(init([first, codexReplayReasoning, codexReplayCall, codexReplayMessage, result(1)]));
  expect(Socket.all[0]!.frames[1]!.input).toEqual([result(1)]);
  expect(Socket.all[0]!.frames[1]!.previous_response_id).toBe("resp_1");
});

test.each(["arguments", "name", "call_id", "text", "namespace", "phase", "ciphertext", "summary", "foreign-turn"])(
  "Codex typed projection preserves meaningful %s differences", async field => {
    Socket.onSend = emitCodexOutput; await drain(); Socket.onSend = socket => socket.complete();
    const reasoning = structuredClone(codexReplayReasoning) as Frame;
    const functionCall = structuredClone(codexReplayCall) as Frame;
    const message = structuredClone(codexReplayMessage) as Frame;
    if (["arguments", "name", "call_id", "namespace"].includes(field)) functionCall[field] = "changed";
    if (field === "text") message.content = [{ type: "output_text", text: "changed" }];
    if (field === "phase") message.phase = "commentary";
    if (field === "ciphertext") reasoning.encrypted_content = "changed";
    if (field === "summary") reasoning.summary = [{ type: "summary_text", text: "changed" }];
    if (field === "foreign-turn") functionCall.internal_chat_message_metadata_passthrough = { turn_id: "another-turn" };
    const input = [first, reasoning, functionCall, message, result(1)]; await drain(init(input));
    expect(Socket.all[0]!.frames[1]!.input).toEqual(input);
    expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
  });

test("typed replay projection cannot normalize away changes to the originally sent input", async () => {
  Socket.onSend = emitCodexOutput; await drain(init([{ ...first, status: "completed" }]));
  Socket.onSend = socket => socket.complete();
  const input = [first, codexReplayReasoning, codexReplayCall, codexReplayMessage, result(1)]; await drain(init(input));
  expect(Socket.all[0]!.frames[1]!.input).toEqual(input);
  expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
});

test("typed projection never weakens raw completed-item versus terminal coverage evidence", async () => {
  Socket.onSend = socket => {
    const id = `resp_${++sequence}`;
    queueMicrotask(() => {
      socket.emit({ type: "response.created", response: { id } });
      socket.emit({ type: "response.output_item.added", output_index: 0, item: codexRawCall });
      socket.emit({ type: "response.output_item.done", output_index: 0, item: codexRawCall });
      const { status: _status, ...differentTerminal } = codexRawCall;
      socket.emit({ type: "response.completed", response: { id, status: "completed", output: [differentTerminal] } });
    });
  };
  await drain(); Socket.onSend = socket => socket.complete();
  const input = [first, codexReplayCall, result(1)]; await drain(init(input));
  expect(Socket.all[0]!.frames[1]!.input).toEqual(input);
  expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
});

test("typed custom calls retain their completed status and namespace", async () => {
  Socket.onSend = socket => { ++sequence; socket.complete([{ type: "custom_tool_call", id: "ctc_fixture", status: "completed", call_id: "call_1", name: "work", namespace: "tools", input: "fixture" }]); };
  await drain(); Socket.onSend = socket => socket.complete();
  const custom = { type: "custom_tool_call", status: "completed", call_id: "call_1", name: "work", namespace: "tools", input: "fixture",
    internal_chat_message_metadata_passthrough: stamped };
  await drain(init([first, custom, result(1)]));
  expect(Socket.all[0]!.frames[1]!.input).toEqual([result(1)]);
});

test("typed custom-call status removal cannot acquire a different context", async () => {
  Socket.onSend = socket => { ++sequence; socket.complete([{ type: "custom_tool_call", id: "ctc_fixture", status: "completed", call_id: "call_1", name: "work", input: "fixture" }]); };
  await drain(); Socket.onSend = socket => socket.complete();
  const input = [first, { type: "custom_tool_call", call_id: "call_1", name: "work", input: "fixture", internal_chat_message_metadata_passthrough: stamped }, result(1)];
  await drain(init(input));
  expect(Socket.all[0]!.frames[1]!.input).toEqual(input);
  expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
});

test("empty reasoning content is omitted and a missing encrypted channel replays as null", async () => {
  Socket.onSend = socket => { ++sequence; socket.complete([{ type: "reasoning", id: "rs_fixture", summary: [], content: [] }, codexRawCall]); };
  await drain(); Socket.onSend = socket => socket.complete();
  const reasoning = { type: "reasoning", summary: [], encrypted_content: null, internal_chat_message_metadata_passthrough: stamped };
  await drain(init([first, reasoning, codexReplayCall, result(1)]));
  expect(Socket.all[0]!.frames[1]!.input).toEqual([result(1)]);
});

test("existing metadata and nonempty output annotations remain meaningful proof fields", async () => {
  Socket.onSend = socket => { ++sequence; socket.complete([{ ...codexRawCall, internal_chat_message_metadata_passthrough: { turn_id: "fixture-turn", unknown: "preserve" } },
    { ...codexRawMessage, content: [{ type: "output_text", text: "fixture reply", annotations: [{ type: "citation", value: "fixture" }] }] }]); };
  await drain(); Socket.onSend = socket => socket.complete();
  const input = [first, codexReplayCall, codexReplayMessage, result(1)]; await drain(init(input));
  expect(Socket.all[0]!.frames[1]!.input).toEqual(input);
  expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
});

test("nested-only turn metadata cannot authorize typed output stamping", async () => {
  const metadata = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "fixture-thread", turn_id: "fixture-turn" }) };
  Socket.onSend = emitCodexOutput; await drain(init([first], { client_metadata: metadata }));
  Socket.onSend = socket => socket.complete();
  const input = [first, codexReplayReasoning, codexReplayCall, codexReplayMessage, result(1)];
  await drain(init(input, { client_metadata: metadata }));
  expect(Socket.all[0]!.frames[1]!.input).toEqual(input);
  expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
});
