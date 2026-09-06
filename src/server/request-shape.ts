/** Parsed JSON only. No payload values escape this bounded structural observer. */
const MAX_NODES = 4096;
const MAX_BYTES = 1024 * 1024;
const COUNT_FIELDS = ["messageCount", "toolCallCount", "toolResultCount", "reasoningItemCount",
  "imageCount", "audioCount", "fileCount", "encryptedItemCount"] as const;

function base64Bytes(data: string): number | undefined {
  if (data.length % 4) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  for (let i = 0; i < data.length - padding; i++) {
    const c = data.charCodeAt(i);
    if (!(c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 43 || c === 47)) return undefined;
  }
  return data.length / 4 * 3 - padding;
}

function inlineBase64(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_BYTES || !value.startsWith("data:")) return undefined;
  const comma = value.indexOf(",");
  if (comma < 5 || comma > 128 || !value.slice(0, comma).endsWith(";base64")) return undefined;
  return value.slice(comma + 1);
}

/** Count JSON UTF-8 bytes without invoking toJSON or allocating a serialized body. */
function jsonBytes(value: unknown, budget: { nodes: number; bytes: number }, depth = 0): number | undefined {
  if (--budget.nodes < 0 || depth > 32) return undefined;
  const spend = (n: number) => { budget.bytes -= n; return budget.bytes >= 0 ? n : undefined; };
  if (value === null) return spend(4);
  if (typeof value === "boolean") return spend(value ? 4 : 5);
  if (typeof value === "number") return Number.isFinite(value) ? spend(String(value).length) : undefined;
  if (typeof value === "string") {
    if (value.length > budget.bytes) return undefined;
    let n = 2;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) n += 2;
      else if (c < 32) n += 6;
      else if (c < 128) n++;
      else if (c < 2048) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { n += 4; i++; }
      else n += c >= 0xd800 && c <= 0xdfff ? 6 : 3;
      if (n > budget.bytes) return undefined;
    }
    return spend(n);
  }
  if (!value || typeof value !== "object") return undefined;
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined;
  let total = spend(2);
  if (total === undefined) return undefined;
  let count = 0;
  const visit = (key: string): boolean => {
    if (count++ && spend(1) === undefined) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return false;
    if (!array) {
      const keySize = jsonBytes(key, budget, depth + 1);
      if (keySize === undefined || spend(1) === undefined) return false;
      total! += keySize + 1;
    }
    const n = jsonBytes(descriptor.value, budget, depth + 1);
    if (n === undefined) return false;
    total! += n + (count > 1 ? 1 : 0);
    return true;
  };
  if (array) {
    if (value.length > budget.nodes) return undefined;
    for (let i = 0; i < value.length; i++) if (!visit(String(i))) return undefined;
  } else {
    for (const key in value) if (Object.hasOwn(value, key) && !visit(key)) return undefined;
  }
  return total;
}

export function summarizeRequestShape(body: Record<string, unknown>): {
  values: Record<string, number>; truncated: string[]; unavailable: string[];
} {
  const items = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [];
  const values: Record<string, number> = {
    inputItemCount: typeof body.input === "string" ? 1 : items.length,
    toolDefinitionCount: Array.isArray(body.tools) ? body.tools.length : 0,
  };
  values.conversationItemCount = values.inputItemCount!;
  for (const field of COUNT_FIELDS) values[field] = 0;
  if (typeof body.input === "string") values.messageCount = 1;
  const budget = { nodes: MAX_NODES, bytes: MAX_BYTES };
  let remaining = 2048, limited = false, resultsKnown = true, attachmentsKnown = true;
  let resultBytes = 0, largest = 0, attachmentBytes = 0, attachmentChars = MAX_BYTES;
  const walk = (raw: unknown, depth = 0): void => {
    if (--remaining < 0 || depth > 32) { limited = true; return; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const item = raw as Record<string, unknown>;
    const type = item.type;
    if (type === "additional_tools" && Array.isArray(item.tools)) values.toolDefinitionCount! += item.tools.length;
    if (type === "message" || typeof item.role === "string") values.messageCount!++;
    if (typeof type === "string" && ["function_call", "custom_tool_call", "tool_use", "server_tool_use", "web_search_call", "file_search_call",
      "computer_call", "local_shell_call", "shell_call", "mcp_call", "image_generation_call", "code_interpreter_call"].includes(type)) values.toolCallCount!++;
    if (Array.isArray(item.tool_calls)) values.toolCallCount! += item.tool_calls.length;
    if (type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_result"
      || type === "computer_call_output" || type === "local_shell_call_output" || type === "shell_call_output"
      || item.role === "tool" || item.role === "function") {
      values.toolResultCount!++;
      const output = Object.hasOwn(item, "output") ? item.output : item.content;
      let size: number | undefined;
      if (typeof output === "string") {
        if (output.length <= budget.bytes) {
          size = Buffer.byteLength(output);
          budget.bytes -= size;
          if (budget.bytes < 0) size = undefined;
        }
      } else size = jsonBytes(output, budget);
      if (size === undefined) resultsKnown = false;
      else { resultBytes += size; largest = Math.max(largest, size); }
    }
    if (type === "reasoning" || type === "thinking" || type === "redacted_thinking") values.reasoningItemCount!++;
    if (item.encrypted_content !== undefined || type === "redacted_thinking") values.encryptedItemCount!++;
    const image = type === "input_image" || type === "image_url" || type === "image";
    const audio = type === "input_audio" || type === "audio";
    const file = type === "input_file" || type === "file" || type === "document";
    if (image) values.imageCount!++;
    if (audio) values.audioCount!++;
    if (file) values.fileCount!++;
    if (image || audio || file) {
      const source = item.source as Record<string, unknown> | undefined;
      const audioData = item.input_audio as Record<string, unknown> | undefined;
      const imageUrl = typeof item.image_url === "object" && item.image_url !== null
        ? (item.image_url as Record<string, unknown>).url : item.image_url;
      const fileBody = item.file as Record<string, unknown> | undefined;
      const data = source?.type === "base64" ? source.data : audioData?.data
        ?? inlineBase64(imageUrl) ?? inlineBase64(item.file_data ?? fileBody?.file_data);
      if (typeof data === "string" && data.length <= attachmentChars) {
        attachmentChars -= data.length;
        const size = base64Bytes(data);
        if (size !== undefined) attachmentBytes += size;
        else attachmentsKnown = false;
      } else attachmentsKnown = false;
    }
    if (Array.isArray(item.content)) {
      for (const part of item.content) { if (remaining <= 0) { limited = true; break; } walk(part, depth + 1); }
    }
  };
  for (const item of items) { if (remaining <= 0) { limited = true; break; } walk(item); }
  const unavailable: string[] = [];
  if (resultsKnown && !limited) { values.toolResultBytes = resultBytes; values.largestToolResultBytes = largest; }
  else unavailable.push("toolResultBytes", "largestToolResultBytes");
  if (attachmentsKnown && !limited) values.attachmentBytes = attachmentBytes;
  else unavailable.push("attachmentBytes");
  return { values, truncated: limited ? [...COUNT_FIELDS] : [], unavailable };
}
