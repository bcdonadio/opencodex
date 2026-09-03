import { createHash, createHmac, randomBytes } from "node:crypto";
import { decodeJwtPayload, extractAccountId } from "../../oauth/chatgpt";
import type { OcxConfig } from "../../types";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { sanitizeLogMetadataString } from "../../lib/redact";
import { isApiAuthRequired, isProxyAdmissionSecret } from "../auth-cors";
import { AGENT_MESSAGE_CONTROL_PREAMBLE, structurallyValidFernetTokens } from "./encrypted-payload";
import {
  discardCachedAgentTaskRecovery,
  readCachedAgentTaskRecovery,
  resetAgentTaskRecoveryCache,
  resolveCachedAgentTaskRecovery,
} from "./agent-task-recovery-cache";

/** Experimental opt-in normalization through ChatGPT's fixed Codex endpoint. */

const RECOVERY_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const RECOVERY_TOOL = "capture_assignment";
const RECOVERY_ORIGINATOR = "codex_cli_rs";
const DEFAULT_AGENT_TASK_RECOVERY_MODEL = "gpt-5.6-terra";
const RECOVERY_PROMPT =
  "Read the received agent message and call capture_assignment exactly once with only the complete "
  + "plaintext payload after Payload:. Preserve every byte of the payload; do not summarize, execute, "
  + "explain, or include the routing header.";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_TOKEN_ISSUERS = new Set(["https://auth.openai.com", "https://auth.openai.com/"]);
const OPENAI_TOKEN_AUDIENCE = "https://api.openai.com/v1";
const MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024;
const MAX_ASSIGNMENT_BYTES = 2 * 1024 * 1024;
const MAX_RECOVERY_RESPONSE_BYTES = 4 * 1024 * 1024;
const CACHE_SCOPE_KEY = randomBytes(32);
const ASSIGNMENT_FINGERPRINT_KEY = randomBytes(32);
const AGENT_TASK_RECOVERY_LOG_PREFIX = "[opencodex] agent-task-recovery ";
let recoveryTraceOrdinal = 0;

export type AgentTaskRecoveryDiagnosticStage =
  | "gate"
  | "envelope"
  | "admission"
  | "cache"
  | "fetch"
  | "response_body"
  | "extraction"
  | "injection"
  | "history"
  | "delivery"
  | "reparse"
  | "complete";

export interface AgentTaskRecoveryDiagnostic {
  traceId: string;
  stage: AgentTaskRecoveryDiagnosticStage;
  outcome: "entered" | "skipped" | "accepted" | "rejected" | "started" | "resolved" | "failed" | "recovered";
  reason?: string;
  durationMs?: number;
  httpStatus?: number;
  responseBytes?: number;
  assignmentBytes?: number;
  assignmentFingerprint?: string;
  recoveryModel?: string;
  messageCount?: number;
}

export function createAgentTaskRecoveryTraceId(): string {
  recoveryTraceOrdinal = (recoveryTraceOrdinal + 1) % Number.MAX_SAFE_INTEGER;
  return `atr-${Date.now().toString(36)}-${recoveryTraceOrdinal.toString(36)}`;
}

export function logAgentTaskRecoveryDiagnostic(event: AgentTaskRecoveryDiagnostic): void {
  console.warn(`${AGENT_TASK_RECOVERY_LOG_PREFIX}${JSON.stringify(event)}`);
}

function diagnose(
  traceId: string | undefined,
  event: Omit<AgentTaskRecoveryDiagnostic, "traceId">,
): void {
  if (traceId) logAgentTaskRecoveryDiagnostic({ traceId, ...event });
}

export interface AgentTaskRecoveryOptions {
  enabled?: boolean;
  model?: string;
  timeoutMs?: number;
  cacheEntries?: number;
}

export function agentTaskRecoveryConfig(config: OcxConfig): AgentTaskRecoveryOptions | null {
  const raw = config.agentTaskRecovery;
  if (!raw || raw.enabled !== true) return null;
  return {
    enabled: true,
    model: typeof raw.model === "string" && raw.model.trim().length > 0
      ? raw.model.trim()
      : DEFAULT_AGENT_TASK_RECOVERY_MODEL,
    timeoutMs: Number.isFinite(raw.timeoutMs) && (raw.timeoutMs ?? 0) >= 1_000
      ? Math.min(120_000, Math.floor(raw.timeoutMs!))
      : 45_000,
    cacheEntries: Number.isFinite(raw.cacheEntries) && (raw.cacheEntries ?? 0) >= 1
      ? Math.min(512, Math.floor(raw.cacheEntries!))
      : 200,
  };
}

interface AgentEnvelope {
  itemIndex: number;
  encryptedIndex: number;
  headerText: string;
  messageType: "NEW_TASK" | "MESSAGE";
  taskName: string;
  sender: string;
  ciphertext: string;
  author: string;
  recipient: string;
}

export type AgentTaskRecoveryResult =
  | { recovered: false }
  | {
    recovered: true;
    assignmentBytes: number;
    assignmentFingerprint: string;
    /** Internal cache key used only for fail-closed discard after delivery mismatch. */
    cacheKey: string;
  };

function assignmentFingerprint(assignment: string): string {
  return createHmac("sha256", ASSIGNMENT_FINGERPRINT_KEY).update(assignment).digest("hex");
}

function isControlPreambleOnly(text: string): boolean {
  if (!/\[CXC-[A-Z0-9-]+\]/i.test(text)) return false;
  const remaining = text.replace(new RegExp(AGENT_MESSAGE_CONTROL_PREAMBLE.source, "gi"), "").trim();
  return remaining.length === 0;
}

// Both collaboration delivery forms carry the same account-bound Fernet payload and exact
// sender/recipient envelope. MESSAGE recovery stays behind the same opt-in, loopback-only native
// OAuth admission and identity checks as NEW_TASK; the fixed ChatGPT endpoint remains the
// ciphertext authority and refuses payloads outside the authenticated account.
const ROUTING_HEADER = /(?:^|\n)Message Type\s*:\s*(NEW_TASK|MESSAGE)\s*\nTask name\s*:\s*(\S+)\s*\nSender\s*:\s*(\S+)\s*\nPayload\s*:\s*(?:\n|$)/;

function findEnvelopeAt(input: unknown[], itemIndex: number, traceId?: string): AgentEnvelope | null {
  const reject = (reason: string): null => {
    diagnose(traceId, { stage: "envelope", outcome: "rejected", reason });
    return null;
  };
  const item = input[itemIndex];
  if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "agent_message") {
    return reject("tail_not_agent_message");
  }
  const content = (item as { content?: unknown }).content;
  if (!Array.isArray(content)) return reject("content_not_array");

  let headerText: string | null = null;
  let messageType: "NEW_TASK" | "MESSAGE" | null = null;
  let taskName: string | null = null;
  let sender: string | null = null;
  let encryptedIndex = -1;
  let ciphertext = "";
  let encryptedPartCount = 0;
  let ciphertextCount = 0;

  for (let index = 0; index < content.length; index += 1) {
    const part = content[index] as { type?: unknown; text?: unknown; encrypted_content?: unknown } | null;
    if (!part || typeof part !== "object") return reject("extra_content_block");
    if (
      (part.type === "input_text" || part.type === "text")
      && typeof part.text === "string"
    ) {
      const match = ROUTING_HEADER.exec(part.text);
      if (match) {
        if (headerText !== null) return reject("multiple_routing_headers");
        if (
          part.text.slice(0, match.index).trim().length > 0
          || part.text.slice(match.index + match[0].length).trim().length > 0
        ) return reject("routing_header_has_extra_text");
        headerText = match[0].startsWith("\n") ? match[0].slice(1) : match[0];
        messageType = match[1] as "NEW_TASK" | "MESSAGE";
        taskName = match[2]!;
        sender = match[3]!;
      } else if (!isControlPreambleOnly(part.text)) {
        return reject("extra_text_block");
      }
    } else if (part.type !== "encrypted_content") {
      return reject("extra_content_block");
    }
    if (part.type !== "encrypted_content" || typeof part.encrypted_content !== "string") continue;
    encryptedPartCount += 1;
    for (const token of structurallyValidFernetTokens(part.encrypted_content)) {
      ciphertextCount += 1;
      encryptedIndex = index;
      ciphertext = token;
    }
  }

  if (!headerText || !messageType || !taskName || !sender) return reject("routing_header_missing");
  if (encryptedIndex < 0) return reject("ciphertext_missing");
  if (encryptedPartCount !== 1) return reject("encrypted_part_count");
  if (ciphertextCount !== 1) return reject("fernet_token_count");
  if ((content[encryptedIndex] as { encrypted_content?: unknown }).encrypted_content !== ciphertext) {
    return reject("encrypted_part_not_standalone");
  }
  if (Buffer.byteLength(ciphertext) > MAX_CIPHERTEXT_BYTES) return reject("ciphertext_too_large");

  const itemRecord = item as { author?: unknown; recipient?: unknown };
  if (typeof itemRecord.author !== "string" || typeof itemRecord.recipient !== "string") {
    return reject("identity_missing");
  }
  if (itemRecord.author !== sender || itemRecord.recipient !== taskName) return reject("identity_mismatch");

  const envelope = {
    itemIndex,
    encryptedIndex,
    headerText,
    messageType,
    taskName,
    sender,
    ciphertext,
    author: itemRecord.author,
    recipient: itemRecord.recipient,
  };
  diagnose(traceId, { stage: "envelope", outcome: "accepted" });
  return envelope;
}

function findEnvelope(input: unknown, traceId?: string): AgentEnvelope | null {
  const reject = (reason: string): null => {
    diagnose(traceId, { stage: "envelope", outcome: "rejected", reason });
    return null;
  };
  if (!Array.isArray(input)) return reject("input_not_array");
  let itemIndex = input.length - 1;
  while (itemIndex >= 0) {
    const type = input[itemIndex] && typeof input[itemIndex] === "object"
      ? (input[itemIndex] as { type?: unknown }).type
      : undefined;
    if (type !== "compaction_trigger" && type !== "additional_tools") break;
    itemIndex -= 1;
  }

  return findEnvelopeAt(input, itemIndex, traceId);
}

function stripMatchingEnvelope(assignment: string, envelope: AgentEnvelope): string | null {
  let normalized = assignment;
  // Recovery models may echo a recognized CXC control preamble before the
  // routing envelope. These transport-only paragraphs are safe to remove;
  // arbitrary prefixes remain invalid and are never silently discarded.
  for (;;) {
    const control = new RegExp(AGENT_MESSAGE_CONTROL_PREAMBLE.source, "i").exec(normalized);
    if (!control || control.index !== 0) break;
    normalized = normalized.slice(control[0].length).replace(/^\n+/, "");
  }
  const match = ROUTING_HEADER.exec(normalized);
  const hasRouting = new RegExp(ROUTING_HEADER.source).test(normalized);
  if (!match) return normalized;
  if (match.index !== 0) return null;
  if (
    match[1] !== envelope.messageType
    || match[2] !== envelope.taskName
    || match[3] !== envelope.sender
  ) return null;
  const payload = normalized.slice(match[0].length);
  if (hasRouting && new RegExp(ROUTING_HEADER.source).test(payload)) return null;
  if (new RegExp(AGENT_MESSAGE_CONTROL_PREAMBLE.source, "i").test(payload)) return null;
  return payload;
}

function validateAssignment(assignment: unknown, envelope: AgentEnvelope): string | null {
  if (typeof assignment !== "string") return null;
  const payload = stripMatchingEnvelope(assignment, envelope);
  if (payload === null || payload.trim().length === 0) return null;
  if (new RegExp(ROUTING_HEADER.source).test(payload)) return null;
  if (new RegExp(AGENT_MESSAGE_CONTROL_PREAMBLE.source, "i").test(payload)) return null;
  if (Buffer.byteLength(payload) > MAX_ASSIGNMENT_BYTES) return null;
  if (structurallyValidFernetTokens(payload).length > 0) return null;
  return payload;
}

function injectAssignment(input: unknown, envelope: AgentEnvelope, assignment: string): boolean {
  if (!Array.isArray(input)) return false;
  const item = input[envelope.itemIndex];
  if (!item || typeof item !== "object") return false;
  const content = (item as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  const part = content[envelope.encryptedIndex] as { type?: unknown; encrypted_content?: unknown } | undefined;
  if (
    !part
    || part.type !== "encrypted_content"
    || part.encrypted_content !== envelope.ciphertext
  ) return false;

  // Once recovery succeeds the transport envelope is no longer meaningful to a routed
  // provider. Replace the whole message content so no routing/control blocks survive.
  (item as Record<string, unknown>).content = [{ type: "input_text", text: assignment }];
  const message = item as Record<string, unknown>;
  message.type = "message";
  message.role = "user";
  delete message.id;
  delete message.author;
  delete message.recipient;
  return true;
}

interface RecoveryAdmission {
  headers: Headers;
  cacheScope: string;
}

function isNativeChatGptAccessToken(token: string): boolean {
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) return false;
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(segments[0], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (header.alg !== "RS256" || header.typ !== "JWT" || typeof header.kid !== "string" || !header.kid) {
    return false;
  }
  const payload = decodeJwtPayload(token);
  if (!payload || !OPENAI_TOKEN_ISSUERS.has(payload.iss as string)) return false;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(OPENAI_TOKEN_AUDIENCE)) return false;
  if (payload.client_id !== CODEX_OAUTH_CLIENT_ID && payload.azp !== CODEX_OAUTH_CLIENT_ID) return false;
  const now = Math.floor(Date.now() / 1_000);
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= now) return false;
  if (
    payload.nbf !== undefined
    && (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf) || payload.nbf > now + 60)
  ) return false;
  const auth = payload["https://api.openai.com/auth"];
  return !!auth && typeof auth === "object" && !Array.isArray(auth);
}

function recoveryAdmission(req: Request, config: OcxConfig, traceId?: string): RecoveryAdmission | null {
  const reject = (reason: string): null => {
    diagnose(traceId, { stage: "admission", outcome: "rejected", reason });
    return null;
  };
  if (isApiAuthRequired(config)) return reject("non_loopback_bind");
  // Remote/shared proxy admission is intentionally unsupported: caller-controlled
  // Codex metadata is not strong enough to authorize use of a stored ChatGPT session.
  if (req.headers.has("x-opencodex-api-key") || req.headers.has("x-api-key")) {
    return reject("api_key_header");
  }

  const authorization = req.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) return reject("bearer_missing");
  const token = match[1]!;
  if (isProxyAdmissionSecret(token, config)) return reject("proxy_admission_secret");
  if (!isNativeChatGptAccessToken(token)) return reject("invalid_native_token");
  const accountId = extractAccountId(undefined, token);
  const explicitAccountId = req.headers.get("chatgpt-account-id")?.trim();
  if (!accountId || !explicitAccountId) return reject("account_id_missing");
  if (accountId !== explicitAccountId) return reject("account_id_mismatch");

  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "chatgpt-account-id": explicitAccountId,
    "content-type": "application/json",
    accept: "text/event-stream",
    // Recovery-endpoint protocol exception: pin the local protocol identity here;
    // this does not change normal FORWARD_HEADERS/general provider non-fabrication behavior.
    originator: RECOVERY_ORIGINATOR,
  });
  for (const name of ["openai-beta", "user-agent"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const cacheScope = createHmac("sha256", CACHE_SCOPE_KEY)
    .update(token)
    .update("\0")
    .update(explicitAccountId)
    .digest("hex");
  diagnose(traceId, { stage: "admission", outcome: "accepted" });
  return { headers, cacheScope };
}

interface AdmittedRecovery {
  envelope: AgentEnvelope;
  admission: RecoveryAdmission;
  cacheKey: string;
}

function admittedRecovery(
  req: Request,
  input: unknown,
  config: OcxConfig,
  parentThreadId?: string | null,
  traceId?: string,
): AdmittedRecovery | null {
  const envelope = findEnvelope(input, traceId);
  if (!envelope) return null;
  const admission = recoveryAdmission(req, config, traceId);
  if (!admission) return null;
  const cacheKey = cacheKeyForEnvelope(admission, parentThreadId, envelope);
  return { envelope, admission, cacheKey };
}

function cacheKeyForEnvelope(
  admission: RecoveryAdmission,
  parentThreadId: string | null | undefined,
  envelope: AgentEnvelope,
): string {
  return createHash("sha256")
    .update(admission.cacheScope)
    .update("\0")
    .update(parentThreadId ?? "")
    .update("\0")
    .update(envelope.messageType)
    .update("\0")
    .update(envelope.taskName)
    .update("\0")
    .update(envelope.sender)
    .update("\0")
    .update(envelope.ciphertext)
    .digest("hex");
}

/**
 * Restore already-recovered collaboration inputs on later tool-result turns. Codex app-server
 * retains the original ciphertext, so a provider continuation would otherwise see only the
 * routing header after encrypted-content sanitization. Cache admission is rechecked before reads;
 * misses stay encrypted and no historical recovery request is started from this path.
 */
export function rehydrateCachedAgentTaskHistory(
  req: Request,
  input: unknown,
  options: AgentTaskRecoveryOptions,
  config: OcxConfig,
  context: { parentThreadId?: string | null } = {},
): number {
  if (!Array.isArray(input)) return 0;
  const admission = recoveryAdmission(req, config);
  if (!admission) return 0;
  let recovered = 0;
  for (let itemIndex = 0; itemIndex < input.length; itemIndex += 1) {
    const envelope = findEnvelopeAt(input, itemIndex);
    if (!envelope) continue;
    const cacheKey = cacheKeyForEnvelope(admission, context.parentThreadId, envelope);
    const assignment = readCachedAgentTaskRecovery(cacheKey, options.cacheEntries ?? 200);
    if (assignment !== null && injectAssignment(input, envelope, assignment)) recovered += 1;
  }
  return recovered;
}

function recoveryPayload(envelope: AgentEnvelope, model: string): string {
  return JSON.stringify({
    model,
    stream: true,
    store: false,
    instructions: RECOVERY_PROMPT,
    tools: [{
      type: "function",
      name: RECOVERY_TOOL,
      description: "Return only the exact decrypted agent task payload.",
      parameters: {
        type: "object",
        properties: { assignment: { type: "string" } },
        required: ["assignment"],
        additionalProperties: false,
      },
      strict: true,
    }],
    tool_choice: { type: "function", name: RECOVERY_TOOL },
    input: [{
      type: "agent_message",
      author: envelope.author,
      recipient: envelope.recipient,
      content: [
        { type: "input_text", text: envelope.headerText },
        { type: "encrypted_content", encrypted_content: envelope.ciphertext },
      ],
    }],
  });
}

function sseDataPayloads(raw: string): string[] {
  const payloads: string[] = [];
  let data: string[] = [];
  const dispatch = (): void => {
    if (data.length > 0) payloads.push(data.join("\n"));
    data = [];
  };
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    if (line === "") {
      dispatch();
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line === "data") {
      data.push("");
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  dispatch();
  return payloads;
}

function assignmentFromRecoverySse(
  raw: string,
  envelope: AgentEnvelope,
  traceId?: string,
): string | null {
  let assignment: string | null = null;
  let completed = false;
  let terminalFailure = false;
  let conflictingAssignments = false;
  let malformedEvent = false;
  let invalidAssignment = false;
  for (const data of sseDataPayloads(raw)) {
    if (!data || data === "[DONE]") continue;
    let event: any;
    try { event = JSON.parse(data); } catch {
      malformedEvent = true;
      continue;
    }
    if (
      event?.type === "response.failed"
      || event?.type === "response.incomplete"
      || event?.type === "error"
    ) terminalFailure = true;
    if (event?.type === "response.completed" && event.response?.status === "completed") {
      completed = true;
    }
    const items = event?.type === "response.output_item.done"
      ? [event.item]
      : event?.type === "response.function_call_arguments.done"
        ? [{ type: "function_call", name: event.name, arguments: event.arguments }]
      : event?.type === "response.completed"
        ? (Array.isArray(event.response?.output) ? event.response.output : []).filter((candidate: any) => (
          candidate?.type === "function_call" && candidate?.name === RECOVERY_TOOL
        ))
        : [];
    for (const item of items) {
      if (item?.type !== "function_call" || item.name !== RECOVERY_TOOL) continue;
      let args: unknown = item.arguments;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch {
          invalidAssignment = true;
          continue;
        }
      }
      if (!args || typeof args !== "object") {
        invalidAssignment = true;
        continue;
      }
      const candidate = validateAssignment((args as { assignment?: unknown }).assignment, envelope);
      if (candidate === null) {
        invalidAssignment = true;
        continue;
      }
      if (assignment === null) assignment = candidate;
      else if (assignment !== candidate) conflictingAssignments = true;
    }
  }
  const reject = (reason: string): null => {
    diagnose(traceId, { stage: "extraction", outcome: "rejected", reason });
    return null;
  };
  if (terminalFailure) return reject("terminal_failure");
  if (malformedEvent) return reject("malformed_sse");
  if (conflictingAssignments) return reject("conflicting_assignments");
  if (invalidAssignment) return reject("invalid_assignment");
  if (!completed) return reject("response_not_completed");
  if (assignment === null) return reject("assignment_missing");
  diagnose(traceId, {
    stage: "extraction",
    outcome: "accepted",
    assignmentBytes: Buffer.byteLength(assignment),
    assignmentFingerprint: assignmentFingerprint(assignment),
  });
  return assignment;
}

async function requestRecovery(
  admission: RecoveryAdmission,
  envelope: AgentEnvelope,
  options: AgentTaskRecoveryOptions,
  abortSignal?: AbortSignal,
  traceId?: string,
): Promise<string | null> {
  const startedAt = Date.now();
  const recoveryModel = typeof options.model === "string" && options.model.trim().length > 0
    ? options.model.trim()
    : DEFAULT_AGENT_TASK_RECOVERY_MODEL;
  diagnose(traceId, {
    stage: "fetch",
    outcome: "started",
    recoveryModel: sanitizeLogMetadataString(recoveryModel) ?? DEFAULT_AGENT_TASK_RECOVERY_MODEL,
  });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Agent task recovery timed out", "TimeoutError")),
    options.timeoutMs ?? 45_000,
  );
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, controller.signal])
    : controller.signal;
  try {
    const response = await fetch(RECOVERY_ENDPOINT, {
      method: "POST",
      headers: admission.headers,
      body: recoveryPayload(envelope, recoveryModel),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* already closed */ }
      diagnose(traceId, {
        stage: "fetch",
        outcome: "rejected",
        reason: "upstream_http_status",
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
      });
      return null;
    }
    diagnose(traceId, {
      stage: "fetch",
      outcome: "accepted",
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
    });
    const body = await readBoundedResponseBody(response, {
      signal,
      fatalUtf8: true,
      maxBytes: MAX_RECOVERY_RESPONSE_BYTES,
      totalTimeoutMs: options.timeoutMs ?? 45_000,
      inactivityTimeoutMs: options.timeoutMs ?? 45_000,
      firstByteTimeoutMs: options.timeoutMs ?? 45_000,
    });
    const bodyReason = body.truncated
      ? "truncated"
      : body.oversized
        ? "oversized"
        : body.timedOut
          ? "timed_out"
          : !body.displaySafe
            ? "not_display_safe"
            : null;
    if (bodyReason) {
      diagnose(traceId, {
        stage: "response_body",
        outcome: "rejected",
        reason: bodyReason,
        responseBytes: Buffer.byteLength(body.text),
      });
      return null;
    }
    diagnose(traceId, {
      stage: "response_body",
      outcome: "accepted",
      responseBytes: Buffer.byteLength(body.text),
    });
    return assignmentFromRecoverySse(body.text, envelope, traceId);
  } catch (error) {
    const reason = error instanceof DOMException && error.name === "TimeoutError"
      ? "timeout"
      : abortSignal?.aborted
        ? "caller_aborted"
        : "fetch_error";
    diagnose(traceId, {
      stage: "fetch",
      outcome: "failed",
      reason,
      durationMs: Date.now() - startedAt,
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function recoverEncryptedAgentTask(
  req: Request,
  input: unknown,
  options: AgentTaskRecoveryOptions,
  config: OcxConfig,
  context: { parentThreadId?: string | null; abortSignal?: AbortSignal; traceId?: string } = {},
): Promise<AgentTaskRecoveryResult> {
  // Admission is deliberately checked before cache access. A cache hit must not
  // turn this process into a plaintext oracle for an unauthenticated caller.
  const admitted = admittedRecovery(req, input, config, context.parentThreadId, context.traceId);
  if (!admitted) return { recovered: false };
  const { admission, cacheKey, envelope } = admitted;
  let resolverStarted = false;
  const assignment = await resolveCachedAgentTaskRecovery(
    cacheKey,
    options.cacheEntries ?? 200,
    signal => {
      resolverStarted = true;
      return requestRecovery(admission, envelope, options, signal, context.traceId);
    },
    context.abortSignal,
  );
  if (!assignment) {
    diagnose(context.traceId, {
      stage: "cache",
      outcome: "failed",
      reason: resolverStarted ? "resolver_returned_no_assignment" : "shared_recovery_returned_no_assignment",
    });
    return { recovered: false };
  }
  diagnose(context.traceId, {
    stage: "cache",
    outcome: "resolved",
    reason: resolverStarted ? "resolver" : "cache_or_inflight",
  });
  const result: AgentTaskRecoveryResult = {
    recovered: true,
    assignmentBytes: Buffer.byteLength(assignment),
    assignmentFingerprint: assignmentFingerprint(assignment),
    cacheKey,
  };
  if (context.abortSignal?.aborted || !injectAssignment(input, envelope, assignment)) {
    discardCachedAgentTaskRecovery(cacheKey);
    diagnose(context.traceId, {
      stage: "injection",
      outcome: "rejected",
      reason: context.abortSignal?.aborted ? "caller_aborted" : "input_changed",
    });
    return { recovered: false };
  }
  diagnose(context.traceId, {
    stage: "injection",
    outcome: "accepted",
    assignmentBytes: result.assignmentBytes,
    assignmentFingerprint: result.assignmentFingerprint,
  });
  return result;
}

export function discardAgentTaskRecoveryResult(result: AgentTaskRecoveryResult): void {
  if (result.recovered) discardCachedAgentTaskRecovery(result.cacheKey);
}

export function verifyRecoveredAgentTaskDelivery(
  value: unknown,
  result: AgentTaskRecoveryResult,
): boolean {
  if (!result.recovered || !value || typeof value !== "object") return false;
  const parsed = value as { context?: { messages?: unknown[] } };
  const messages = Array.isArray(parsed.context?.messages)
    ? parsed.context.messages
    : Array.isArray(value)
      ? value
      : undefined;
  if (!Array.isArray(messages)) return false;
  let terminalIndex = messages.length - 1;
  // Responses input may carry control metadata after the current task. The envelope
  // detector deliberately ignores these, so the delivery invariant must do the same
  // while continuing to reject any other trailing content.
  while (terminalIndex >= 0) {
    const candidate = messages[terminalIndex];
    const type = candidate && typeof candidate === "object"
      ? (candidate as { type?: unknown }).type
      : undefined;
    if (type !== "additional_tools" && type !== "compaction_trigger") break;
    terminalIndex -= 1;
  }
  const terminal = terminalIndex >= 0 ? messages[terminalIndex] : undefined;
  if (!terminal || typeof terminal !== "object") return false;
  const terminalRecord = terminal as { role?: unknown; type?: unknown; content?: unknown };
  if (messages === parsed.context?.messages) {
    if (terminalRecord.role !== "user") return false;
  } else if (terminalRecord.type !== "message" || terminalRecord.role !== "user") {
    return false;
  }
  const content = terminalRecord.content;
  let text: string | undefined;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content) && content.length === 1) {
    const block = content[0] as { type?: unknown; text?: unknown } | null;
    if (block && (block.type === "input_text" || block.type === "text") && typeof block.text === "string") {
      text = block.text;
    }
  }
  if (text === undefined) return false;
  return Buffer.byteLength(text) === result.assignmentBytes
    && assignmentFingerprint(text) === result.assignmentFingerprint;
}

export function discardEncryptedAgentTaskRecovery(
  req: Request,
  input: unknown,
  config: OcxConfig,
  context: { parentThreadId?: string | null } = {},
): void {
  const admitted = admittedRecovery(req, input, config, context.parentThreadId);
  if (admitted) discardCachedAgentTaskRecovery(admitted.cacheKey);
}

export function resetAgentTaskRecoveryState(): void {
  resetAgentTaskRecoveryCache();
}
