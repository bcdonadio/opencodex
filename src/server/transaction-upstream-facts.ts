import { observeDiagnosticIdentifier, type TransactionDiagnosticsV1 } from "../diagnostics/transaction";

// Provider text is not a diagnostic enum, even when it looks like a safe token.
const ERROR_LABELS = new Set([
  "cyber_policy", "invalid_request_error", "authentication_error", "permission_error",
  "rate_limit_error", "rate_limit_exceeded", "insufficient_quota", "server_error",
  "upstream_error", "upstream_server_error", "overloaded_error", "server_is_overloaded",
  "context_length_exceeded", "previous_response_not_found", "invalid_api_key",
  "permission_denied", "unauthorized", "forbidden", "subscription_required",
  "resource_exhausted", "unavailable", "timeout", "invalid_argument", "not_found_error",
  "api_error", "billing_error", "content_filter", "content_policy_violation",
]);
const ERROR_PARAMS = new Set([
  "model", "input", "messages", "tools", "tool_choice", "previous_response_id",
  "max_tokens", "max_output_tokens", "temperature", "top_p", "stream", "store",
  "reasoning", "reasoning.effort", "service_tier", "response_format",
]);
const ERROR_KEYS = new Set([
  "code", "type", "param", "message", "retryable", "retry_after", "retry_after_ms",
  "request_id", "event_id", "request_limit", "token_limit",
]);
const REQUEST_HEADERS = ["x-request-id", "openai-request-id", "request-id"] as const;
const INCOMPLETE_REASONS = new Set(["max_output_tokens", "content_filter"]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

// Only JSON-like own data properties are facts. Do not execute provider getters.
function own(value: Record<string, unknown> | undefined, key: string): unknown {
  return value ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

function set(d: TransactionDiagnosticsV1, field: string, value: unknown, derived = false): void {
  d[field] = value;
  d.fieldAvailability[field] = { status: derived ? "derived" : "observed", source: derived ? "derived" : "upstream" };
}

function numeric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function identifier(d: TransactionDiagnosticsV1, field: string, raw: unknown): void {
  const result = observeDiagnosticIdentifier(raw);
  if (result.state === "excluded") return;
  d.fieldAvailability[field] = { status: result.state, source: "upstream" };
  if (result.value) d[field] = result.value;
  else delete d[field];
  if (result.state === "redacted") d.redactionApplied = true;
  if (result.state === "truncated") d.captureTruncated = true;
}

function label(d: TransactionDiagnosticsV1, field: string, raw: unknown, allowed: Set<string>): void {
  if (typeof raw === "string" && allowed.has(raw)) set(d, field, raw);
  else if (raw !== undefined && raw !== null) {
    delete d[field];
    d.fieldAvailability[field] = { status: "redacted", source: "upstream" };
    d.redactionApplied = true;
  }
}

/** Observe a fixed header set. Trace header lists contain names only, never values. */
export function captureUpstreamHeaders(d: TransactionDiagnosticsV1, headers: Headers): void {
  for (const header of REQUEST_HEADERS) {
    const value = headers.get(header);
    if (value === null) continue;
    set(d, "requestIdHeader", header);
    identifier(d, "upstreamRequestId", value);
    break;
  }
  const names: string[] = [];
  for (const [header, field] of [["x-trace-id", "traceId"], ["x-span-id", "spanId"]] as const) {
    const raw = headers.get(header);
    if (raw !== null) { names.push(header); identifier(d, field, raw); }
  }
  const traceparent = headers.get("traceparent");
  if (traceparent !== null) {
    names.push("traceparent");
    const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(traceparent);
    if (match && !/^0+$/.test(match[1]!) && !/^0+$/.test(match[2]!)) {
      identifier(d, "traceId", match[1]); identifier(d, "spanId", match[2]);
    }
  }
  if (names.length) set(d, "upstreamTraceHeaders", names);
  for (const [header, field, multiplier] of [
    ["x-ratelimit-limit-requests", "requestLimit", 1],
    ["x-ratelimit-limit-tokens", "tokenLimit", 1],
    ["retry-after", "retryAfterMs", 1000],
    ["retry-after-ms", "retryAfterMs", 1],
  ] as const) {
    const raw = headers.get(header);
    if (raw === null || raw.length > 32 || !/^\d+(?:\.\d+)?$/.test(raw)) continue;
    const value = Number(raw) * multiplier;
    if (numeric(value)) set(d, field, value);
  }
}

/** Bounded structural error/usage capture; no body text, policy guesses, or billing. */
export function captureUpstreamPayloadFacts(d: TransactionDiagnosticsV1, payload: unknown): void {
  const p = object(payload);
  if (!p) return;
  const nested = object(own(p, "response"));
  const response = nested ?? p;
  const error = object(own(response, "error")) ?? object(own(p, "error"));
  if (error) {
    set(d, "errorOrigin", "upstream");
    set(d, "errorEnvelopeSchema", nested ? "response.error" : "error");
    label(d, "upstreamErrorCode", own(error, "code"), ERROR_LABELS);
    label(d, "errorType", own(error, "type"), ERROR_LABELS);
    label(d, "errorParam", own(error, "param"), ERROR_PARAMS);
    const message = own(error, "message");
    if (typeof message === "string") {
      // Measure only the bounded prefix; content itself never enters diagnostics.
      set(d, "errorMessageTruncated", message.length > 500 || Buffer.byteLength(message) > 500);
      d.fieldAvailability.errorMessage = { status: "redacted", source: "upstream" };
      d.redactionApplied = true;
    }
    const retryable = own(error, "retryable");
    if (typeof retryable === "boolean") set(d, "retryable", retryable);
    for (const [key, field, multiplier] of [
      ["retry_after", "retryAfterMs", 1000], ["retry_after_ms", "retryAfterMs", 1],
      ["request_limit", "requestLimit", 1], ["token_limit", "tokenLimit", 1],
    ] as const) {
      const value = own(error, key);
      if (numeric(value) && numeric(value * multiplier)) set(d, field, value * multiplier);
    }
    identifier(d, "upstreamRequestId", own(error, "request_id"));
    identifier(d, "upstreamEventId", own(error, "event_id"));
    const names: string[] = [];
    let inspected = 0;
    for (const key in error) {
      if (++inspected > 64) {
        d.captureTruncated = true;
        d.fieldAvailability.unknownErrorFieldNames = { status: "truncated", source: "upstream" };
        break;
      }
      if (!Object.hasOwn(error, key) || ERROR_KEYS.has(key)) continue;
      if (key.length <= 64 && /^[a-z][a-z0-9_]*$/.test(key)
        && observeDiagnosticIdentifier(key).state === "observed") names.push(key);
      else d.redactionApplied = true;
    }
    d.unknownErrorFieldNames = names;
  }
  label(d, "incompleteReason", own(object(own(response, "incomplete_details")), "reason"),
    INCOMPLETE_REASONS);

  const usageValue = own(response, "usage") ?? own(object(own(p, "message")), "usage");
  const usage = object(usageValue);
  const eventType = own(p, "type");
  const terminal = typeof eventType === "string"
    && ["response.completed", "response.failed", "response.incomplete", "error"].includes(eventType);
  if (usageValue === undefined && !terminal) return;
  const input = own(usage, "input_tokens") ?? own(usage, "prompt_tokens");
  const output = own(usage, "output_tokens") ?? own(usage, "completion_tokens");
  const validCount = Number(numeric(input) && Number.isInteger(input))
    + Number(numeric(output) && Number.isInteger(output));
  set(d, "usageMissingCount", 2 - validCount, true);
  set(d, "usagePartial", validCount === 1, true);
  if (validCount > 0) set(d, "usageSource", "upstream");
  if (validCount < 2) set(d, "usageMissingReason", usageValue === undefined ? "not_reported" : "missing_token_counters", true);
  else { delete d.usageMissingReason; delete d.fieldAvailability.usageMissingReason; }
}
