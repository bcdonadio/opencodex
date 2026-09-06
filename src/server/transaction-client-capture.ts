import { observeDiagnosticIdentifier, type TransactionDiagnosticsV1 } from "../diagnostics/transaction";

// These names already belong to the Codex request boundary. Never inspect message
// content, turn-state, arbitrary metadata, or interpret a grouping digest as an ID.
const METADATA_IDS = [["thread_id", "codexThreadId"], ["turn_id", "codexTurnId"],
  ["session_id", "codexSessionId"], ["parent_thread_id", "parentThreadId"]] as const;

function observe(d: TransactionDiagnosticsV1, field: string, value: unknown): void {
  if (value === undefined || value === null) return;
  const result = observeDiagnosticIdentifier(value);
  if (result.state === "excluded") return;
  // First boundary wins, including redaction: malformed lower-priority aliases
  // must not replace an explicit header or conceal its privacy disposition.
  if (d.fieldAvailability[field]?.status !== "not_observed" && d.fieldAvailability[field] !== undefined) return;
  d.fieldAvailability[field] = { status: result.state, source: "client" };
  if (result.value) {
    d[field] = result.value;
    d.correlationSource = "mixed";
    d.correlationConfidence = "direct";
  }
  if (result.state === "redacted") d.redactionApplied = true;
  if (result.state === "truncated") d.captureTruncated = true;
}

function turnMetadata(d: TransactionDiagnosticsV1, raw: unknown): void {
  if (typeof raw !== "string" || raw.length > 16 * 1024) return;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, field] of METADATA_IDS) observe(d, field, (value as Record<string, unknown>)[key]);
    }
  } catch { /* Malformed optional metadata never affects dispatch. */ }
}

export function captureClientHeaders(d: TransactionDiagnosticsV1, headers: Headers): void {
  for (const field of ["parentRequestId", "retryOfRequestId", "replayOfRequestId", "rootThreadId", "rootTurnId",
    "agentId", "parentAgentId", "agentRole", "clientResponseId", "codexCoreVersion", "desktopVersion"]) {
    d.fieldAvailability[field] ??= { status: "unsupported", source: "client" };
  }
  for (const field of ["parentThreadId", "clientProduct", "clientVersion"]) {
    d.fieldAvailability[field] ??= { status: "not_observed", source: "client" };
  }
  for (const [header, field] of [["x-client-request-id", "clientRequestId"], ["x-request-id", "clientRequestId"],
    ["x-codex-turn-id", "codexTurnId"], ["thread-id", "codexThreadId"], ["x-codex-thread-id", "codexThreadId"],
    ["session_id", "codexSessionId"], ["session-id", "codexSessionId"], ["x-codex-parent-thread-id", "parentThreadId"]]) {
    observe(d, field!, headers.get(header!));
  }
  turnMetadata(d, headers.get("x-codex-turn-metadata"));
  // Only product/version tokens; OS, hostnames, paths and arbitrary UA suffixes
  // are discarded. A Codex product version does not prove a Desktop/core build.
  const ua = headers.get("user-agent");
  const match = ua && ua.length <= 2048
    ? /^(codex_cli_rs|codex_vscode|claude-code)\/([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)/.exec(ua) : null;
  if (match && match[2]!.length <= 64) {
    d.clientProduct = match[1];
    d.clientVersion = match[2];
    d.fieldAvailability.clientProduct = { status: "observed", source: "client" };
    d.fieldAvailability.clientVersion = { status: "observed", source: "client" };
  }
}

export function captureClientMetadata(d: TransactionDiagnosticsV1, metadata: unknown): void {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
  const record = metadata as Record<string, unknown>;
  for (const [key, field] of METADATA_IDS) observe(d, field, record[key]);
  // Native WebSocket frames transport the same compatibility JSON as a string.
  turnMetadata(d, record["x-codex-turn-metadata"]);
}
