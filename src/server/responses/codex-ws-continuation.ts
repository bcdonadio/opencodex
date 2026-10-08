import { createHmac, randomBytes } from "node:crypto";
import { CODEX_WS_ID_MAX_BYTES } from "./codex-ws-correlation";

export type CodexWsContinuationDecisionReason = "disabled" | "cold-connection" | "context-mismatch"
  | "settings-changed" | "incremental" | "upstream-state-missing" | "unsupported-shape";
export interface CodexWsContinuationProof {
  responseId: string;
  count: number;
  inputDigest: string;
  codexInputDigest?: string;
  settingsDigest: string;
}
interface Decision { reason: CodexWsContinuationDecisionReason; skippedItems: number; frameText: string }
const fingerprintKey = randomBytes(32);
const MAX_NODES = 100_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ITEMS = 10_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
    && Buffer.byteLength(value) <= CODEX_WS_ID_MAX_BYTES;
}
function supported(body: unknown): body is Record<string, unknown> & { input: unknown[] } {
  return record(body) && body.store === false && Array.isArray(body.input)
    && body.input.length <= MAX_ITEMS
    && !["previous_response_id", "stream_id", "generate", "conversation", "multi_agent", "context_management"].some(key => Object.hasOwn(body, key))
    && body.background !== true
    && !body.input.some(item => record(item) && typeof item.type === "string" && /compaction|compact_trigger/.test(item.type));
}

/** Canonical object keys, exact array order and scalar values; bounded work, no retained content. */
function fingerprint(value: unknown): string | undefined {
  const hash = createHmac("sha256", fingerprintKey);
  let nodes = 0;
  let bytes = 0;
  const append = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_BYTES) throw new RangeError("continuation fingerprint byte bound");
    hash.update(text);
  };
  const visit = (current: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > 64) throw new RangeError("continuation fingerprint node bound");
    if (Array.isArray(current)) {
      if (current.length > MAX_NODES - nodes) throw new RangeError("continuation fingerprint array bound");
      append("[");
      for (const item of current) { visit(item, depth + 1); append(","); }
      append("]");
    } else if (record(current)) {
      const keys = Object.keys(current);
      if (keys.length > MAX_NODES - nodes) throw new RangeError("continuation fingerprint key bound");
      append("{");
      for (const key of keys.sort()) {
        append(JSON.stringify(key)); append(":"); visit(current[key], depth + 1); append(",");
      }
      append("}");
    } else {
      const scalar = JSON.stringify(current);
      if (scalar === undefined) throw new TypeError("continuation fingerprint requires JSON");
      append(scalar);
    }
  };
  try { visit(value, 0); return hash.digest("hex"); } catch { return undefined; }
}
function settings(body: Record<string, unknown>): string | undefined {
  const { input: _input, previous_response_id: _previous, client_metadata: _metadata, ...rest } = body;
  return fingerprint(rest);
}
function replayOutputItem(item: unknown): unknown {
  if (!record(item) || !Object.hasOwn(item, "id")) return item;
  const { id: _id, ...rest } = item;
  return rest;
}

/** Output-only projection of Codex's typed replay; the original sent input stays exact. */
function codexReplayOutput(output: unknown[], body: Record<string, unknown>): unknown[] | undefined {
  const turnId = record(body.client_metadata) ? body.client_metadata.turn_id : undefined;
  if (!validId(turnId) || !turnId.trim()) return undefined;
  return output.map(item => {
    const raw = replayOutputItem(item);
    if (!record(raw) || !["message", "function_call", "custom_tool_call", "reasoning"].includes(String(raw.type))) return raw;
    const next: Record<string, unknown> = { ...raw };
    // protocol/models.rs ResponseItem: these variants have no output status field.
    if (next.status === "completed" && next.type !== "custom_tool_call") delete next.status;
    if ((next.type === "function_call" || next.type === "custom_tool_call") && next.namespace === null) delete next.namespace;
    if (next.type === "message") {
      if (next.phase === null) delete next.phase;
      if (Array.isArray(next.content)) next.content = next.content.map(part => {
        if (!record(part) || part.type !== "output_text") return part;
        const projected = { ...part };
        // ContentItem::OutputText contains text only; retain nonempty ancillary data conservatively.
        for (const field of ["annotations", "logprobs"] as const) {
          if (Array.isArray(projected[field]) && (projected[field] as unknown[]).length === 0) delete projected[field];
        }
        return projected;
      });
    } else if (next.type === "reasoning") {
      // The Rust Option serializer retains None as null and omits Some(empty content).
      if (next.content == null) next.content = null;
      else if (Array.isArray(next.content) && next.content.length === 0) delete next.content;
      if (next.encrypted_content === undefined) next.encrypted_content = null;
    }
    // session/mod.rs stamps a missing turn id at the durable history boundary. This variant
    // requires the directly declared, pool-validated turn id; nested-only callers stay raw.
    const metadata = next.internal_chat_message_metadata_passthrough;
    if (metadata == null || record(metadata)) {
      const stamped = metadata == null ? {} : { ...metadata };
      if (stamped.turn_id == null) stamped.turn_id = turnId;
      next.internal_chat_message_metadata_passthrough = stamped;
    }
    return next;
  });
}

/** Index/identity/content digests prove the terminal covers every completed wire item. */
export class CodexWsOutputEvidence {
  private readonly items = new Map<number, { identity: string; done?: string }>();
  private readonly identities = new Set<string>();
  private observed = false;
  private invalid = false;
  private bytes = 0;

  observe(event: Record<string, unknown>, bytes: number): void {
    if (event.type !== "response.output_item.added" && event.type !== "response.output_item.done") return;
    this.observed = true;
    if (this.invalid) return;
    try {
      this.bytes += bytes;
      const index = event.output_index;
      const item = event.item;
      if (this.bytes > MAX_BYTES || !Number.isSafeInteger(index) || (index as number) < 0
        || (index as number) >= MAX_ITEMS || !record(item) || !validId(item.id)) {
        this.invalid = true; return;
      }
      const identity = fingerprint(item.id);
      if (!identity) { this.invalid = true; return; }
      if (event.type === "response.output_item.added") {
        if (index !== this.items.size || this.identities.has(identity)) { this.invalid = true; return; }
        this.items.set(index as number, { identity });
        this.identities.add(identity);
      } else {
        const added = this.items.get(index as number);
        const done = fingerprint(replayOutputItem(item));
        if (!added || added.identity !== identity || added.done !== undefined || !done) {
          this.invalid = true; return;
        }
        added.done = done;
      }
    } catch { this.invalid = true; }
  }

  matches(output: unknown[]): boolean {
    if (this.invalid) return false;
    if (!this.observed) return true;
    if (output.length !== this.items.size) return false;
    return output.every((item, index) => {
      const observed = this.items.get(index);
      return observed?.done !== undefined && record(item) && validId(item.id)
        && fingerprint(item.id) === observed.identity && fingerprint(replayOutputItem(item)) === observed.done;
    });
  }

  dispose(): void { this.invalid = true; this.items.clear(); this.identities.clear(); }
}

/** Only a correlated completed response can publish evidence for its physical socket. */
export function completedCodexWsContinuation(frameText: string, response: unknown, evidence?: CodexWsOutputEvidence): CodexWsContinuationProof | undefined {
  let body: unknown;
  try { body = JSON.parse(frameText); } catch { return undefined; }
  if (!supported(body) || !record(response) || response.status !== "completed" || !validId(response.id)
    || !Array.isArray(response.output) || body.input.length + response.output.length > MAX_ITEMS
    || (evidence && !evidence.matches(response.output))
    || !response.output.some(item => record(item)
      && (item.type === "function_call" || item.type === "custom_tool_call") && validId(item.call_id))) return undefined;
  // Canonical store:false input serialization drops only top-level item ids, preserving call_id.
  const output = response.output.map(replayOutputItem);
  const inputDigest = fingerprint([...body.input, ...output]);
  const codexOutput = codexReplayOutput(response.output, body);
  const codexInputDigest = codexOutput ? fingerprint([...body.input, ...codexOutput]) : undefined;
  const settingsDigest = settings(body);
  return inputDigest && settingsDigest
    ? { responseId: response.id, count: body.input.length + output.length, inputDigest,
        ...(codexInputDigest ? { codexInputDigest } : {}), settingsDigest } : undefined;
}

export function planCodexWsContinuation(frameText: string, proof: CodexWsContinuationProof | undefined): Decision {
  const full = (reason: CodexWsContinuationDecisionReason): Decision => ({ reason, frameText, skippedItems: 0 });
  let body: unknown;
  try { body = JSON.parse(frameText); } catch { return full("unsupported-shape"); }
  if (!supported(body)) return full("unsupported-shape");
  if (!proof) return full("cold-connection");
  if (settings(body) !== proof.settingsDigest) return full("settings-changed");
  if (body.input.length <= proof.count) return full("context-mismatch");
  const prefixDigest = fingerprint(body.input.slice(0, proof.count));
  if (!prefixDigest || (prefixDigest !== proof.inputDigest && prefixDigest !== proof.codexInputDigest)) return full("context-mismatch");
  return { reason: "incremental", skippedItems: proof.count,
    frameText: JSON.stringify({ ...body, input: body.input.slice(proof.count), previous_response_id: proof.responseId }) };
}
