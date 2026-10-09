import { afterEach, beforeEach, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { parseRequest } from "../../src/responses/parser";
import { codexWsPool } from "../../src/server/responses/codex-ws-pool";
import { prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import { codexWsUpstreamFetch } from "../../src/server/responses/ws-upstream";

type Item = Record<string, unknown>;
type Frame = Item & { input: Item[]; previous_response_id?: string };
const realWebSocket = globalThis.WebSocket;
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let savedProxyEnv: Record<string, string | undefined>;
let responseNumber = 0;

class Socket extends EventTarget {
  static readonly OPEN = 1;
  static all: Socket[] = [];
  static output: Item[] = [];
  readyState = 0;
  frames: Frame[] = [];
  bytes: number[] = [];
  constructor() {
    super(); Socket.all.push(this);
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
  }
  send(text: string) {
    this.frames.push(JSON.parse(text)); this.bytes.push(Buffer.byteLength(text));
    const id = `resp_long_${++responseNumber}`;
    const output = Socket.output;
    queueMicrotask(() => {
      this.emit({ type: "response.created", response: { id } });
      output.forEach((item, output_index) => {
        this.emit({ type: "response.output_item.added", output_index, item });
        this.emit({ type: "response.output_item.done", output_index, item });
      });
      this.emit({ type: "response.completed", response: { id, status: "completed", output } });
    });
  }
  emit(payload: Item) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) })); }
  close() { if (this.readyState !== 3) { this.readyState = 3; this.dispatchEvent(new Event("close")); } }
  ref() {} unref() {}
}

const metadata = { turn_id: "fixture-long-turn", create_time: 1_700_000_000 };
const payload = "generated fixture text ".repeat(240);
const replay = (item: Item): Item => { const { id: _id, ...rest } = item; return rest; };
const reasoning = (id: string): Item => ({ type: "reasoning", id, summary: [{ type: "summary_text", text: "generated summary" }],
  encrypted_content: "fixture_not_real_ciphertext", internal_chat_message_metadata_passthrough: { turn_id: metadata.turn_id } });
const call = (id: string, custom = false): Item => custom
  ? { type: "custom_tool_call", id: `ct_${id}`, call_id: id, name: "fixture_custom", input: "generated input", status: "completed", internal_chat_message_metadata_passthrough: metadata }
  : { type: "function_call", id: `fc_${id}`, call_id: id, name: "fixture_work", arguments: "{}", internal_chat_message_metadata_passthrough: metadata };
const result = (id: string, custom = false): Item => ({ type: custom ? "custom_tool_call_output" : "function_call_output", call_id: id,
  output: payload, internal_chat_message_metadata_passthrough: metadata });

/** Generated values with the mixed durable-item shapes observed in long Codex histories. */
function longHistory(): Item[] {
  return Array.from({ length: 170 }, (_, index) => [
    { type: "message", role: index % 2 ? "developer" : "user", content: [{ type: "input_text", text: payload }],
      internal_chat_message_metadata_passthrough: { ...metadata, content_item_kinds: ["user.text"] } },
    reasoning(`rs_old_${index}`), call(`old_function_${index}`), result(`old_function_${index}`),
    call(`old_custom_${index}`, true), result(`old_custom_${index}`, true),
  ]).flat();
}

const firstOutput: Item[] = [reasoning("rs_first"),
  { type: "message", id: "msg_first", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "generated commentary" }],
    internal_chat_message_metadata_passthrough: { ...metadata, content_item_kinds: ["assistant.text"] } },
  call("next_custom", true)];
const secondOutput: Item[] = [reasoning("rs_second"), call("next_function")];

async function send(history: Item[], output: Item[], reasons?: string[]): Promise<number> {
  const raw = { model: "fixture-long-model", input: history, stream: true, store: false, instructions: "generated instructions",
    tools: [{ type: "function", name: "fixture_work", parameters: { type: "object", properties: {} } },
      { type: "custom", name: "fixture_custom", format: { type: "text" } }],
    client_metadata: { thread_id: "fixture-long-thread", turn_id: metadata.turn_id } };
  const before = JSON.stringify(raw);
  const budget = createTranslatorBudget();
  let release: (() => void) | undefined;
  try {
    const built = createResponsesPassthroughAdapter({ adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" })
      .buildRequest(parseRequest(raw), { headers: new Headers({ authorization: "Bearer fixture-token", "chatgpt-account-id": "fixture-account", "thread-id": "fixture-long-thread" }), translatorBudget: budget });
    release = built.releaseBodyObservation;
    const init = { method: "POST", headers: built.headers, body: built.body };
    const prepared = prepareCodexWsRequest(built.url, init)!;
    expect(JSON.parse(prepared.frameText).input).toHaveLength(history.length);
    Socket.output = output;
    const fallback = (async () => { throw new Error("unexpected HTTP fallback"); }) as typeof fetch;
    const response = await codexWsUpstreamFetch(built.url, init, fallback, "1.4.0", undefined, undefined, undefined,
      event => { if (event.kind === "continuation") reasons?.push(event.reason); }, undefined, undefined, true);
    expect(await response.text()).toContain("response.completed");
    expect(JSON.stringify(raw)).toBe(before);
    return Buffer.byteLength(prepared.frameText);
  } finally { release?.(); budget.dispose(); }
}

beforeEach(() => {
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  savedProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
});
afterEach(() => {
  codexWsPool.dispose();
  for (const socket of Socket.all) socket.close();
  Socket.all = []; Socket.output = []; responseNumber = 0;
  globalThis.WebSocket = realWebSocket;
  for (const key of proxyKeys) { delete process.env[key]; if (savedProxyEnv[key] !== undefined) process.env[key] = savedProxyEnv[key]; }
});

test("mixed long histories send two successive tool-result deltas through the real adapter", async () => {
  const history = longHistory();
  expect(history.length).toBeGreaterThanOrEqual(1_000);
  const firstBytes = await send(history, firstOutput);
  const secondHistory = [...history, ...firstOutput.map(replay), result("next_custom", true)];
  const secondBytes = await send(secondHistory, secondOutput);
  const thirdHistory = [...secondHistory, ...secondOutput.map(replay), result("next_function")];
  const thirdBytes = await send(thirdHistory, [call("next_terminal")]);
  expect(firstBytes).toBeGreaterThanOrEqual(2 * 1024 * 1024);
  expect(Socket.all).toHaveLength(1);
  const socket = Socket.all[0]!;
  expect(socket.frames.map(frame => frame.input.length)).toEqual([1_020, 1, 1]);
  expect(socket.frames.map(frame => frame.previous_response_id)).toEqual([undefined, "resp_long_1", "resp_long_2"]);
  expect(socket.frames[1]!.input).toEqual([result("next_custom", true)]);
  expect(socket.frames[2]!.input).toEqual([result("next_function")]);
  expect(socket.bytes[1]!).toBeLessThanOrEqual(secondBytes * 0.05);
  expect(socket.bytes[2]!).toBeLessThanOrEqual(thirdBytes * 0.05);
  expect(history).toHaveLength(1_020);
  console.info("long continuation fixture bytes", JSON.stringify({ full: [firstBytes, secondBytes, thirdBytes], sent: socket.bytes }));
});

test("a changed old message in a long history forces full replay", async () => {
  const history = longHistory();
  await send(history, firstOutput);
  const changed = structuredClone(history);
  changed[0]!.content = [{ type: "input_text", text: "changed semantic content" }];
  const next = [...changed, ...firstOutput.map(replay), result("next_custom", true)];
  await send(next, secondOutput);
  expect(Socket.all).toHaveLength(1);
  expect(Socket.all[0]!.frames[1]!.input).toHaveLength(next.length);
  expect(Socket.all[0]!.frames[1]!.previous_response_id).toBeUndefined();
});

test("long typed replays omit raw output metadata without resending the known history", async () => {
  const history = longHistory();
  const rawOutput: Item[] = [
    { ...reasoning("rs_metadata_first"), content: [], status: "completed", metadata: { fixture: "server-only" } },
    { ...firstOutput[1], phase: null, status: "completed", metadata: { fixture: "server-only" },
      content: [{ type: "output_text", text: "generated commentary", annotations: [], logprobs: [] }] },
    { ...call("metadata_function"), namespace: null, status: "completed", metadata: { fixture: "server-only" } },
    { ...call("metadata_custom", true), namespace: null, metadata: { fixture: "server-only" } },
  ];
  const typedReplay = (item: Item): Item => {
    const next = replay(item);
    delete next.metadata;
    if (next.type !== "custom_tool_call") delete next.status;
    if (next.namespace === null) delete next.namespace;
    if (next.phase === null) delete next.phase;
    if (next.type === "reasoning" && Array.isArray(next.content) && next.content.length === 0) delete next.content;
    if (next.type === "message") next.content = [{ type: "output_text", text: "generated commentary" }];
    return next;
  };
  await send(history, rawOutput);
  const secondHistory = [...history, ...rawOutput.map(typedReplay), result("metadata_function"), result("metadata_custom", true)];
  const rawSecondOutput = [{ ...reasoning("rs_metadata_second"), content: [], metadata: { fixture: "server-only" } },
    { ...call("metadata_next"), namespace: null, status: "completed", metadata: { fixture: "server-only" } }];
  const secondBytes = await send(secondHistory, rawSecondOutput);
  const thirdHistory = [...secondHistory, ...rawSecondOutput.map(typedReplay), result("metadata_next")];
  const thirdBytes = await send(thirdHistory, [call("metadata_final")]);
  expect(Socket.all).toHaveLength(1);
  const socket = Socket.all[0]!;
  expect(socket.frames.map(frame => frame.input.length)).toEqual([1_020, 2, 1]);
  expect(socket.frames.map(frame => frame.previous_response_id)).toEqual([undefined, "resp_long_1", "resp_long_2"]);
  expect(socket.bytes[1]!).toBeLessThanOrEqual(secondBytes * 0.05);
  expect(socket.bytes[2]!).toBeLessThanOrEqual(thirdBytes * 0.05);
  const changedHistory = structuredClone(thirdHistory);
  const oldMetadata = changedHistory[0]!.internal_chat_message_metadata_passthrough as Item;
  oldMetadata.create_time = 1_700_000_001;
  await send([...changedHistory, replay(call("metadata_final")), result("metadata_final")], [call("metadata_after_change")]);
  expect(socket.frames[3]!.input).toHaveLength(changedHistory.length + 2);
  expect(socket.frames[3]!.previous_response_id).toBeUndefined();
});

test("stable compacted long histories resume deltas while new compaction boundaries stay full", async () => {
  const compaction = { type: "compaction", encrypted_content: "generated_compaction_ciphertext" };
  const history = [compaction, ...longHistory()];
  const reasons: string[] = [];
  await send(history, [call("window_first")], reasons);
  const next = [...history, replay(call("window_first")), result("window_first")];
  const nextBytes = await send(next, [call("window_second")], reasons);
  expect(Socket.all).toHaveLength(1);
  const socket = Socket.all[0]!;
  expect(socket.frames[1]!.input.length).toBe(1);
  expect(socket.frames[1]!.input).toEqual([result("window_first")]);
  expect(socket.frames[1]!.previous_response_id).toBe("resp_long_1");
  expect(socket.bytes[1]!).toBeLessThanOrEqual(nextBytes * 0.05);

  const changed = [...structuredClone(next), replay(call("window_second")), result("window_second")];
  changed[0]!.encrypted_content = "generated_changed_compaction_ciphertext";
  await send(changed, [call("window_changed")], reasons);
  expect(socket.frames[2]!.input).toHaveLength(changed.length);
  expect(socket.frames[2]!.previous_response_id).toBeUndefined();

  const stable = [...changed, replay(call("window_changed")), result("window_changed")];
  await send(stable, [call("window_stable")], reasons);
  expect(socket.frames[3]!.input).toEqual([result("window_changed")]);
  expect(socket.frames[3]!.previous_response_id).toBe("resp_long_3");

  const newBoundary = [...stable, replay(call("window_stable")), result("window_stable"),
    { type: "compaction", encrypted_content: "generated_new_compaction_ciphertext" }];
  await send(newBoundary, [call("window_new_boundary")], reasons);
  expect(socket.frames[4]!.input).toHaveLength(newBoundary.length);
  expect(socket.frames[4]!.previous_response_id).toBeUndefined();

  const triggered = [...newBoundary, replay(call("window_new_boundary")), result("window_new_boundary"), { type: "compaction_trigger" }];
  await send(triggered, [call("window_triggered")], reasons);
  expect(socket.frames[5]!.input).toHaveLength(triggered.length);
  expect(socket.frames[5]!.previous_response_id).toBeUndefined();
  expect(reasons.at(-1)).toBe("unsupported-shape");
});
