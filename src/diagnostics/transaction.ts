import { randomUUID } from "node:crypto";
import { redactSecretString } from "../lib/redact";

export const TRANSACTION_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;
export const DIAGNOSTIC_CAPTURE_VERSION = 1 as const;
export const MAX_DIAGNOSTIC_EVENTS = 64;
export const MAX_DIAGNOSTIC_SENDS = 16;
export const MAX_DIAGNOSTIC_ID_BYTES = 256;
export const MAX_DIAGNOSTIC_ERROR_BYTES = 500;

const MAX_DIAGNOSTIC_METADATA_BYTES = 64;
const MAX_DIAGNOSTIC_LIST_MEMBERS = 64;
const DIAGNOSTIC_COLLECTION_LOOKAHEAD = 1;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export type DiagnosticTransportV1 = "http" | "websocket" | "mixed";
export type DiagnosticProtocolV1 = "responses" | "chat" | "messages";
export type DiagnosticCorrelationSourceV1 = "proxy" | "client" | "upstream" | "mixed";
export type DiagnosticCorrelationConfidenceV1 = "direct" | "derived" | "unknown";
export type DiagnosticAvailabilityStatusV1 =
  | "observed"
  | "derived"
  | "unsupported"
  | "not_observed"
  | "redacted"
  | "truncated"
  | "unknown";
export type DiagnosticAvailabilitySourceV1 =
  | "client"
  | "proxy"
  | "route"
  | "adapter"
  | "transport"
  | "upstream"
  | "derived"
  | "persistence";

export interface DiagnosticAvailabilityV1 {
  status: DiagnosticAvailabilityStatusV1;
  source?: DiagnosticAvailabilitySourceV1;
}

export type DiagnosticEventSourceV1 = "client" | "proxy" | "transport" | "upstream" | "downstream";
export type DiagnosticEventTypeV1 =
  | "request.received"
  | "request.admitted"
  | "route.selected"
  | "upstream.connect.started"
  | "upstream.connected"
  | "upstream.handshake.completed"
  | "upstream.request.sent"
  | "upstream.headers.received"
  | "response.created"
  | "response.output_item.added"
  | "response.output_text.delta"
  | "response.completed"
  | "response.failed"
  | "response.incomplete"
  | "upstream.error"
  | "upstream.closed"
  | "downstream.terminal.sent"
  | "downstream.closed"
  | "request.finalized"
  | "request.persisted"
  | "context.compacted";

export interface DiagnosticEventV1 {
  eventSequence: number;
  type: DiagnosticEventTypeV1;
  at: number;
  source: DiagnosticEventSourceV1;
  elapsedMs?: number;
  responseId?: string;
  eventId?: string;
}

export interface DiagnosticSendV1 {
  sendId: string;
  sendOrdinal: number;
  startedAt: number;
  endedAt?: number;
  upstreamTransport?: DiagnosticTransportV1;
  endpointClass?: string;
  provider?: string;
  model?: string;
  adapter?: string;
  accountLogLabel?: string;
  forwardedModel?: string;
  requestedEffort?: string;
  callerEffort?: string;
  configuredEffort?: string;
  callerServiceTier?: string;
  configuredServiceTier?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number | boolean;
  serviceTier?: string;
  recoveryReason?: string;
  retryReason?: string;
  status?: number;
  httpStatus?: number;
  websocketHandshakeStatus?: number;
  upstreamRequestId?: string;
  upstreamResponseId?: string;
  upstreamEventId?: string;
  bytesForwarded?: number;
  bytesReceived?: number;
  upstreamRequestAccepted?: boolean;
  streamAborted?: boolean;
  connectionReused?: boolean;
}

export interface TransactionDiagnosticsV1 {
  schemaVersion: 1;
  diagnosticCaptureVersion: 1;
  transactionId: string;
  recordKind: "request";
  correlationSource: DiagnosticCorrelationSourceV1;
  correlationConfidence: DiagnosticCorrelationConfidenceV1;
  receivedAt: number;
  timestampSource: "proxy_wall_clock";
  events: DiagnosticEventV1[];
  fieldAvailability: Record<string, DiagnosticAvailabilityV1>;
  droppedDiagnosticEventCount: number;
  captureTruncated: boolean;
  redactionApplied: boolean;
  redactionVersion: 1;
  retentionClass: "usage_ledger";
  [supportedOptionalField: string]: unknown;
}

export interface CreateTransactionDiagnosticsInput {
  requestId: string;
  receivedAt: number;
  correlationSource?: DiagnosticCorrelationSourceV1;
  correlationConfidence?: DiagnosticCorrelationConfidenceV1;
  proxyVersion?: string;
  inboundProtocol?: DiagnosticProtocolV1;
  inboundTransport?: DiagnosticTransportV1;
  fieldAvailability?: Record<string, DiagnosticAvailabilityV1>;
}

export interface DiagnosticEventInput {
  type: DiagnosticEventTypeV1;
  at: number;
  source: DiagnosticEventSourceV1;
  elapsedMs?: number;
  responseId?: string;
  eventId?: string;
}

export interface DiagnosticSendStart {
  startedAt: number;
  upstreamTransport?: DiagnosticTransportV1;
  endpointClass?: string;
  provider?: string;
  model?: string;
  adapter?: string;
  accountLogLabel?: string;
  forwardedModel?: string;
  requestedEffort?: string;
  callerEffort?: string;
  configuredEffort?: string;
  callerServiceTier?: string;
  configuredServiceTier?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number | boolean;
  serviceTier?: string;
  recoveryReason?: string;
  retryReason?: string;
}

export interface DiagnosticSendFinish {
  endedAt: number;
  status?: number;
  httpStatus?: number;
  websocketHandshakeStatus?: number;
  upstreamRequestId?: string;
  upstreamResponseId?: string;
  upstreamEventId?: string;
  bytesForwarded?: number;
  bytesReceived?: number;
  upstreamRequestAccepted?: boolean;
  streamAborted?: boolean;
  connectionReused?: boolean;
}

interface DiagnosticSendOwner {
  sendCount: number;
  sends?: DiagnosticSendV1[];
}

const CORRELATION_SOURCES = new Set<DiagnosticCorrelationSourceV1>(["proxy", "client", "upstream", "mixed"]);
const CORRELATION_CONFIDENCES = new Set<DiagnosticCorrelationConfidenceV1>(["direct", "derived", "unknown"]);
const TRANSPORTS = new Set<DiagnosticTransportV1>(["http", "websocket", "mixed"]);
const PROTOCOLS = new Set<DiagnosticProtocolV1>(["responses", "chat", "messages"]);
const EVENT_SOURCES = new Set<DiagnosticEventSourceV1>(["client", "proxy", "transport", "upstream", "downstream"]);
const EVENT_TYPES = new Set<DiagnosticEventTypeV1>([
  "context.compacted",
  "request.received",
  "request.admitted",
  "route.selected",
  "upstream.connect.started",
  "upstream.connected",
  "upstream.handshake.completed",
  "upstream.request.sent",
  "upstream.headers.received",
  "response.created",
  "response.output_item.added",
  "response.output_text.delta",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "upstream.error",
  "upstream.closed",
  "downstream.terminal.sent",
  "downstream.closed",
  "request.finalized",
  "request.persisted",
]);
const TERMINAL_EVENT_TYPES = new Set<DiagnosticEventTypeV1>([
  "response.completed",
  "response.failed",
  "response.incomplete",
  "upstream.error",
  "upstream.closed",
  "downstream.terminal.sent",
  "downstream.closed",
  "request.finalized",
  "request.persisted",
]);
const AVAILABILITY_STATUSES = new Set<DiagnosticAvailabilityStatusV1>([
  "observed",
  "derived",
  "unsupported",
  "not_observed",
  "redacted",
  "truncated",
  "unknown",
]);
const AVAILABILITY_SOURCES = new Set<DiagnosticAvailabilitySourceV1>([
  "client",
  "proxy",
  "route",
  "adapter",
  "transport",
  "upstream",
  "derived",
  "persistence",
]);
const DIAGNOSTIC_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const DIAGNOSTIC_SERVICE_TIERS = new Set(["auto", "default", "standard", "priority", "flex", "fast", "ultrafast"]);
const DIAGNOSTIC_SUBSCRIPTION_PLANS = new Set(["free", "plus", "pro", "team", "business", "enterprise", "edu", "unknown"]);
const DIAGNOSTIC_RECOVERY_REASONS = new Set([
  "transient-5xx", "connection-reset", "oauth-401", "key-401", "key-429", "rate-limit-429",
  "anthropic-oauth-429", "oauth-account-429", "image-413", "opaque-blob-rejection",
  "empty-completion", "fallback", "retry", "resume", "unknown",
]);
const DIAGNOSTIC_CANCELLATION_REASONS = new Set([
  "client_cancel", "client_disconnect", "abort_signal", "timeout", "downstream_closed", "unknown",
]);
const DIAGNOSTIC_ENDPOINT_CLASSES = new Set(["responses", "chat", "messages", "images", "search", "live", "compact"]);
const DIAGNOSTIC_REASONING_FIELDS = new Set([
  "reasoning_effort", "reasoning.effort", "reasoning.enabled", "reasoning.max_tokens",
  "thinking.budget_tokens", "thinking.type",
]);
const SAFE_DIAGNOSTIC_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;
const SAFE_DIAGNOSTIC_FIELD = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const DIAGNOSTIC_HOST_CLASSES = new Set(["api_openai", "chatgpt", "api_anthropic", "google_api", "loopback", "custom", "unknown"]);
const SAFE_ACCOUNT_LABEL = /^(?:main|[po][0-9a-f]{6})$/;
const UNSAFE_DIAGNOSTIC_TEXT = /(?:\b(?:https?|file):\/\/|\bwww\.|(?:^|[\s"'(])(?:\/(?:home|Users|etc|var|tmp|mnt|opt|usr)\/|[A-Za-z]:\\|\\\\)|(?:^|[\s,{])(?:HOME|PATH|PWD|USER|SHELL|TOKEN|SECRET|API_KEY|AUTHORIZATION)\s*=|[A-Z][A-Z0-9_]{2,}\s*=|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|<\/?(?:thinking|reasoning|analysis)>|\b(?:chain[ -]of[ -]thought|hidden reasoning|private reasoning)\b|(?:^|[\s,{])(?:analysis|reasoning)\s*:)/i;
const FILE_URI = /\bfile:(?:[\\/]+|[A-Za-z]:[\\/])/i;
const WINDOWS_OR_UNC_PATH = /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|[\\/]{2}(?=[^\\/\s]))/;
// Recognize filesystem syntax rather than specific directory names. Bare slash
// namespaces (provider/model) remain valid metadata, but roots, home expansions,
// dot segments and hidden directories cannot masquerade as diagnostic IDs.
const FILESYSTEM_PATH_SYNTAX = /(?:\\|(?:^|[\s"'(])(?:\/|~[^/\s]*\/|[A-Za-z]:)|(?:^|\/)\.[^/\s]*(?:\/|$))/;

type DiagnosticSanitizationState = "observed" | "redacted" | "truncated" | "excluded";

interface SanitizedDiagnosticString {
  value?: string;
  state: DiagnosticSanitizationState;
}

function containsUnsafeDiagnosticText(value: string): boolean {
  return UNSAFE_DIAGNOSTIC_TEXT.test(value)
    || FILE_URI.test(value)
    || WINDOWS_OR_UNC_PATH.test(value)
    || FILESYSTEM_PATH_SYNTAX.test(value);
}

const IDENTIFIER_FIELDS = [
  "parentRequestId", "retryOfRequestId", "replayOfRequestId", "codexThreadId", "codexTurnId",
  "codexSessionId", "rootThreadId", "rootTurnId", "parentThreadId", "agentId", "parentAgentId",
  "clientRequestId", "clientResponseId", "upstreamResponseId", "previousResponseId",
  "originalPreviousResponseId", "forwardedPreviousResponseId", "upstreamRequestId",
  "upstreamConversationId", "upstreamSessionId", "upstreamEventId", "policyEventId", "traceId",
  "spanId", "parentSpanId", "connectionId", "upstreamConnectionId", "proxyCommit", "proxyBuildId",
  "proxyInstanceId", "configRevision", "routeConfigRevision", "modelCatalogRevision", "routeDecisionId",
  "selectedCandidate", "settingsRevision", "requestSettingsRevision", "modelSwitchEffectiveFromRequestId",
  "lastKnownUsageResponseId",
] as const;

const METADATA_FIELDS = [
  "callerEffort", "configuredEffort", "configuredEffortSource",
  "agentRole", "clientProduct", "clientVersion", "codexCoreVersion", "desktopVersion", "originator",
  "upstreamProtocol", "adapterName", "protocolVersion", "proxyVersion", "runtimeName", "runtimeVersion",
  "osPlatform", "architecture", "osVersion", "adapterVersion", "diagnosticMode", "forwardedModel",
  "responseModel", "responseEffort", "routeKind", "fallbackReason", "rewriteReason", "authMode",
  "accountPseudonym", "accountSelectionSource", "accountAffinity", "accountPoolSelectionReason",
  "subscriptionPlan", "entitlementSource", "cyberAccessStatus", "cyberAccessProgram", "modelAccessStatus",
  "authRefreshResult", "tokenEstimateMethod", "continuationMode", "toolChoiceMode", "truncationMode",
  "endpointClass", "upstreamHostname", "method", "upstreamContentType", "protocolEventType",
  "terminalEventType", "lastEventType", "lastOutputKind", "closedBy", "upstreamErrorCode", "errorType",
  "errorParam", "incompleteReason", "contentFilterResult", "errorEnvelopeSchema", "refusalCategory",
  "policyRuleId", "policyStage", "policyDecisionSource", "errorOrigin", "requestIdHeader",
  "truncationReason", "logSink", "persistenceErrorCode", "usageSource", "usageMissingReason",
  "billedUsageSource", "rateLimitReachedType", "quotaErrorCode", "retryDecision", "recoveryReason",
  "resumeMode", "stateRestoreSource", "cancellationSource", "cancellationReason",
] as const;

const ERROR_FIELDS = ["errorMessage", "websocketCloseReason"] as const;
const TIMESTAMP_FIELDS = [
  "admittedAt", "routeSelectedAt", "queuedAt", "upstreamConnectStartedAt", "upstreamConnectedAt",
  "handshakeCompletedAt", "upstreamRequestSentAt", "upstreamHeadersAt", "responseCreatedAt", "firstEventAt",
  "lastEventAt", "upstreamTerminalAt", "downstreamTerminalSentAt", "downstreamClosedAt", "finalizedAt",
  "persistedAt", "settingsUpdatedAt", "settingsAppliedAt", "entitlementObservedAt", "usageReportedAt",
  "modelSwitchAppliedAt", "lastCompactionAt", "expiresAt",
] as const;
const NON_NEGATIVE_NUMBER_FIELDS = [
  ...TIMESTAMP_FIELDS, "queueMs", "connectMs", "handshakeMs", "upstreamTimeToFirstEventMs", "firstOutputMs",
  "upstreamDurationMs", "downstreamDeliveryLagMs", "finalizationLagMs", "persistenceLagMs",
  "idleBeforeFailureMs", "requestBytes", "forwardedRequestBytes", "inputItemCount", "messageCount",
  "toolDefinitionCount", "toolCallCount", "toolResultCount", "imageCount", "audioCount", "fileCount",
  "encryptedItemCount", "reasoningItemCount", "conversationItemCount", "attachmentBytes", "toolResultBytes",
  "largestToolResultBytes", "contextWindowTokens", "contextUsageRatioEstimate", "maxOutputTokens", "deltaInputCount",
  "forwardedInputItemCount", "forwardedConversationItemCount", "forwardedMessageCount", "forwardedToolDefinitionCount",
  "forwardedToolCallCount", "forwardedToolResultCount", "forwardedReasoningItemCount", "forwardedEncryptedItemCount",
  "forwardedImageCount", "forwardedAudioCount", "forwardedFileCount", "forwardedAttachmentBytes",
  "forwardedToolResultBytes", "forwardedLargestToolResultBytes",
  "reconstructedInputCount", "replayedItemCount", "compactionCount", "httpStatus",
  "websocketHandshakeStatus", "terminalMappedStatus", "lastEventSequence", "streamEventCount", "bytesReceived",
  "bytesForwarded", "websocketCloseCode", "connectionAgeMs", "reconnectCount", "idleTimeoutMs", "bodyStallMs",
  "bodyOverflowBytes", "retryAfterMs", "connectionGeneration", "requestSequenceOnConnection", "upstreamRequestSequenceOnConnection", "retryDelayMs",
  "retryBudgetRemaining", "usageMissingCount", "requestLimit", "tokenLimit", "accountWindowLimit",
  "accountWindowRemaining", "accountWindowResetAt",
] as const;
const BOOLEAN_FIELDS = [
  "clockAnomaly", "modelSwitchRequested", "modelSwitchApplied", "accountChangedBetweenAttempts",
  "authRefreshOccurred", "previousResponseUsed", "parallelToolCalls", "streamingRequested", "storeRequested",
  "compactionOccurred", "outputDeliveredBeforeFailure", "upstreamRequestAccepted", "streamAborted",
  "connectionReused", "heartbeatTimeout", "errorMessageTruncated", "retryable", "policyFallbackAttempted",
  "previousResponseRewriteApplied", "stateRestored", "upstreamCallMade", "correlationMismatch",
  "responseIdMismatch", "duplicateTerminalSuppressed", "usagePartial", "spendControlReached", "recordPersisted",
] as const;
const STRING_LIST_FIELDS = [
  "derivedFields", "relevantFeatureFlags", "contextTransformationKinds", "unknownErrorFieldNames",
  "upstreamTraceHeaders",
] as const;
const COUNTER_MAP_FIELDS = ["outputItemCountsByType", "locallyInjectedItemCounts", "droppedItemCounts", "truncatedItemCounts"] as const;

const KNOWN_DIAGNOSTIC_FIELDS = new Set<string>([
  ...IDENTIFIER_FIELDS,
  ...METADATA_FIELDS,
  ...ERROR_FIELDS,
  ...NON_NEGATIVE_NUMBER_FIELDS,
  ...BOOLEAN_FIELDS,
  ...STRING_LIST_FIELDS,
  ...COUNTER_MAP_FIELDS,
  "schemaVersion", "diagnosticCaptureVersion", "transactionId", "recordKind", "correlationSource",
  "correlationConfidence", "receivedAt", "timestampSource", "events", "fieldAvailability",
  "droppedDiagnosticEventCount", "captureTruncated", "redactionApplied", "redactionVersion", "retentionClass",
  "inboundProtocol", "inboundTransport", "upstreamTransport", "terminalSource", "transportPhase", "closeReason",
  "policyFallbackOutcome", "requestId", "sends",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function sanitizedStringResult(
  value: unknown,
  maxBytes: number,
  rejectUnsafe = false,
): SanitizedDiagnosticString {
  if (typeof value !== "string") return { state: "excluded" };
  // Remove record/control boundaries before redaction so a credential label cannot use
  // a newline to limit the redactor's range and expose a suffix when this is normalized again.
  const controlsRemoved = value.replace(CONTROL_CHARACTERS, "");
  if (rejectUnsafe && containsUnsafeDiagnosticText(controlsRemoved)) return { state: "redacted" };
  const redacted = redactSecretString(controlsRemoved);
  const withoutControls = redacted
    .replace(CONTROL_CHARACTERS, "")
    .trim();
  if (!withoutControls) return { state: "excluded" };
  const wasRedacted = controlsRemoved !== value || redacted !== controlsRemoved;
  let bytes = 0;
  let retained = "";
  let wasTruncated = false;
  for (const character of withoutControls) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) {
      wasTruncated = true;
      break;
    }
    retained += character;
    bytes += characterBytes;
  }
  if (!retained) return { state: wasRedacted ? "redacted" : "excluded" };
  return {
    value: retained,
    state: wasRedacted ? "redacted" : wasTruncated ? "truncated" : "observed",
  };
}

function sanitizedString(value: unknown, maxBytes: number, rejectUnsafe = false): string | undefined {
  return sanitizedStringResult(value, maxBytes, rejectUnsafe).value;
}

export function sanitizeDiagnosticIdentifier(value: unknown): string | undefined {
  return sanitizedString(value, MAX_DIAGNOSTIC_ID_BYTES);
}

/** Capture callers need transformation provenance, not a prefix usable as a direct key. */
export function observeDiagnosticIdentifier(value: unknown): SanitizedDiagnosticString {
  const result = sanitizedStringResult(value, MAX_DIAGNOSTIC_ID_BYTES, true);
  if (result.state === "observed" && result.value !== value) return { state: "redacted" };
  return result.state === "observed" ? result : { state: result.state };
}

export function sanitizeDiagnosticError(value: unknown): string | undefined {
  const sanitized = sanitizedStringResult(value, MAX_DIAGNOSTIC_ERROR_BYTES, true);
  return sanitized.state === "redacted" && sanitized.value === undefined ? undefined : sanitized.value;
}

/** Preserve existing public URL guidance in display errors without exporting URL queries.
 * Diagnostic error copies deliberately use the stricter sanitizer above. */
export function sanitizeUpstreamDisplayError(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const publicGuidance = "https://ollama.com/upgrade";
  const masked = value.slice(0, MAX_DIAGNOSTIC_ERROR_BYTES * 2).replace(/https?:\/\/[^\s<>"']+/gi, raw => {
    return raw === publicGuidance ? "PUBLIC_UPGRADE_GUIDANCE" : "[REDACTED]";
  });
  // Continue rejecting local paths, environment dumps and other excluded context.
  const safe = sanitizeDiagnosticError(masked);
  if (!safe) return undefined;
  const restored = safe.replaceAll("PUBLIC_UPGRADE_GUIDANCE", publicGuidance);
  return sanitizedStringResult(restored, MAX_DIAGNOSTIC_ERROR_BYTES, false).value;
}

function sanitizeDiagnosticMetadata(value: unknown): string | undefined {
  return sanitizedString(value, MAX_DIAGNOSTIC_METADATA_BYTES, true);
}

function diagnosticMetadataResult(field: string, value: unknown): SanitizedDiagnosticString {
  const base = sanitizedStringResult(value, MAX_DIAGNOSTIC_METADATA_BYTES, true);
  const sanitized = base.value;
  if (!sanitized) return base;
  let accepted: boolean;
  switch (field) {
    case "accountPseudonym":
    case "accountAffinity":
    case "accountLogLabel":
      accepted = SAFE_ACCOUNT_LABEL.test(sanitized);
      break;
    case "subscriptionPlan":
      accepted = DIAGNOSTIC_SUBSCRIPTION_PLANS.has(sanitized);
      break;
    case "upstreamHostname":
      accepted = DIAGNOSTIC_HOST_CLASSES.has(sanitized);
      break;
    case "errorParam":
      accepted = SAFE_DIAGNOSTIC_FIELD.test(sanitized);
      break;
    case "cancellationReason":
      accepted = DIAGNOSTIC_CANCELLATION_REASONS.has(sanitized);
      break;
    case "recoveryReason":
    case "retryReason":
    case "fallbackReason":
      accepted = DIAGNOSTIC_RECOVERY_REASONS.has(sanitized);
      break;
    case "requestedEffort":
    case "callerEffort":
    case "configuredEffort":
    case "effectiveEffort":
    case "responseEffort":
      accepted = DIAGNOSTIC_EFFORTS.has(sanitized);
      break;
    case "serviceTier":
    case "callerServiceTier":
    case "configuredServiceTier":
      accepted = DIAGNOSTIC_SERVICE_TIERS.has(sanitized);
      break;
    case "endpointClass":
      accepted = DIAGNOSTIC_ENDPOINT_CLASSES.has(sanitized);
      break;
    case "reasoningWireField":
      accepted = DIAGNOSTIC_REASONING_FIELDS.has(sanitized);
      break;
    default:
      accepted = SAFE_DIAGNOSTIC_TOKEN.test(sanitized)
        && !sanitized.includes("..")
        && !sanitized.startsWith("/")
        && !sanitized.includes("\\");
      break;
  }
  return accepted ? base : { state: "redacted" };
}

function availabilitySourceForField(field: string): DiagnosticAvailabilitySourceV1 {
  if (field.startsWith("client") || field.startsWith("codex") || field.startsWith("root")
    || field.startsWith("parent") || field === "agentId" || field === "parentAgentId") return "client";
  if (field.startsWith("upstream") || field.startsWith("response") || field.startsWith("policy")) return "upstream";
  return "proxy";
}

function recordSanitizationAvailability(
  availability: Record<string, DiagnosticAvailabilityV1>,
  field: string,
  state: DiagnosticSanitizationState,
  source = availabilitySourceForField(field),
): void {
  if (state === "redacted" || state === "excluded") availability[field] = { status: "redacted", source };
  else if (state === "truncated") availability[field] = { status: "truncated", source };
}

function proxyId(kind: "txn" | "attempt" | "send"): string {
  return `ocx-${kind}-${randomUUID()}`;
}

export function createDiagnosticAttemptId(): string {
  return proxyId("attempt");
}

interface NormalizedAvailability {
  values: Record<string, DiagnosticAvailabilityV1>;
  truncated: boolean;
}

function normalizeAvailability(raw: unknown): NormalizedAvailability {
  if (!isPlainObject(raw)) return { values: {}, truncated: false };
  const candidates: [string, DiagnosticAvailabilityV1][] = [];
  // Iterate the fixed schema instead of caller keys. Work is bounded even when
  // an input has a million unknown properties, and late observed evidence cannot
  // be displaced by the defaults contributed by earlier capture owners.
  for (const name of KNOWN_DIAGNOSTIC_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, name)) continue;
    let rawValue: unknown;
    try {
      rawValue = raw[name];
    } catch {
      continue;
    }
    if (!isPlainObject(rawValue)) continue;
    if (typeof rawValue.status !== "string"
      || !AVAILABILITY_STATUSES.has(rawValue.status as DiagnosticAvailabilityStatusV1)) continue;
    if (rawValue.source !== undefined
      && (typeof rawValue.source !== "string"
        || !AVAILABILITY_SOURCES.has(rawValue.source as DiagnosticAvailabilitySourceV1))) continue;
    candidates.push([name, {
      status: rawValue.status as DiagnosticAvailabilityStatusV1,
      ...(rawValue.source === undefined
        ? {}
        : { source: rawValue.source as DiagnosticAvailabilitySourceV1 }),
    }]);
  }
  const priority = (value: DiagnosticAvailabilityV1): number => {
    if (value.status === "redacted" || value.status === "truncated") return 0;
    if (value.status === "observed") return 1;
    if (value.status === "derived") return 2;
    if (value.source === "persistence") return 3;
    if (value.status === "unknown") return 4;
    return 5;
  };
  candidates.sort((left, right) => priority(left[1]) - priority(right[1]));
  const overflowed = candidates.length > MAX_DIAGNOSTIC_LIST_MEMBERS;
  const normalized = Object.fromEntries(candidates.slice(0, MAX_DIAGNOSTIC_LIST_MEMBERS));
  if (overflowed) {
    if (!("fieldAvailability" in normalized)
      && Object.keys(normalized).length === MAX_DIAGNOSTIC_LIST_MEMBERS) {
      delete normalized[Object.keys(normalized).at(-1)!];
    }
    normalized.fieldAvailability = { status: "truncated", source: "persistence" };
  }
  return { values: normalized, truncated: overflowed };
}

interface NormalizedEvent {
  event?: DiagnosticEventV1;
  responseIdState?: DiagnosticSanitizationState;
  eventIdState?: DiagnosticSanitizationState;
}

function normalizeEvent(raw: unknown): NormalizedEvent {
  if (!isPlainObject(raw)
    || !isPositiveInteger(raw.eventSequence)
    || typeof raw.type !== "string"
    || !EVENT_TYPES.has(raw.type as DiagnosticEventTypeV1)
    || !isNonNegativeFiniteNumber(raw.at)
    || typeof raw.source !== "string"
    || !EVENT_SOURCES.has(raw.source as DiagnosticEventSourceV1)) return {};
  const responseId = sanitizedStringResult(raw.responseId, MAX_DIAGNOSTIC_ID_BYTES, true);
  const eventId = sanitizedStringResult(raw.eventId, MAX_DIAGNOSTIC_ID_BYTES, true);
  return {
    event: {
      eventSequence: raw.eventSequence,
      type: raw.type as DiagnosticEventTypeV1,
      at: raw.at,
      source: raw.source as DiagnosticEventSourceV1,
      ...(isNonNegativeFiniteNumber(raw.elapsedMs) ? { elapsedMs: raw.elapsedMs } : {}),
      ...(responseId.state === "observed" && responseId.value ? { responseId: responseId.value } : {}),
      ...(eventId.state === "observed" && eventId.value ? { eventId: eventId.value } : {}),
    },
    ...(raw.responseId === undefined ? {} : { responseIdState: responseId.state }),
    ...(raw.eventId === undefined ? {} : { eventIdState: eventId.state }),
  };
}

interface BoundedEvents {
  events: DiagnosticEventV1[];
  dropped: number;
  responseIdState?: DiagnosticSanitizationState;
  eventIdState?: DiagnosticSanitizationState;
}

// Inspect a bounded head and tail, even for sparse or hostile arrays. The tail
// carries late terminal observations without walking all omitted stream deltas.
function boundedCollectionIndices(length: number, limit: number): number[] {
  const indices = Array.from({ length: Math.min(length, limit) }, (_, index) => index);
  for (let index = Math.max(limit, length - limit); index < length; index += 1) indices.push(index);
  return indices;
}

function terminalEventPhase(event: DiagnosticEventV1): string {
  if (event.type.startsWith("request.")) return event.type;
  if (event.type.startsWith("downstream.")) return "downstream";
  return event.source === "upstream" ? "upstream" : "transport";
}

function retainDiagnosticEvent(events: DiagnosticEventV1[], event: DiagnosticEventV1): void {
  if (events.length < MAX_DIAGNOSTIC_EVENTS) {
    events.push(event);
    return;
  }
  if (!TERMINAL_EVENT_TYPES.has(event.type)) return;
  // Keep the latest upstream, downstream and persistence transitions separately:
  // finalization must not erase the stream failure that made the row interesting.
  let replace = events.findIndex(candidate => TERMINAL_EVENT_TYPES.has(candidate.type)
    && terminalEventPhase(candidate) === terminalEventPhase(event));
  if (replace < 0) replace = events.findLastIndex(candidate => !TERMINAL_EVENT_TYPES.has(candidate.type));
  if (replace < 0) replace = 0;
  events.splice(replace, 1);
  events.push(event);
}

function boundedEvents(raw: unknown): BoundedEvents {
  if (!Array.isArray(raw)) return { events: [], dropped: 0 };
  const valid: DiagnosticEventV1[] = [];
  let responseIdState: DiagnosticSanitizationState | undefined;
  let eventIdState: DiagnosticSanitizationState | undefined;
  for (const index of boundedCollectionIndices(raw.length, MAX_DIAGNOSTIC_EVENTS)) {
    let candidate: unknown;
    try {
      candidate = raw[index];
    } catch {
      continue;
    }
    const normalized = normalizeEvent(candidate);
    if (normalized.event) retainDiagnosticEvent(valid, normalized.event);
    if (normalized.responseIdState && normalized.responseIdState !== "observed") {
      responseIdState = normalized.responseIdState;
    }
    if (normalized.eventIdState && normalized.eventIdState !== "observed") eventIdState = normalized.eventIdState;
  }
  const dropped = Math.max(0, raw.length - valid.length);
  return { events: valid, dropped, responseIdState, eventIdState };
}

function normalizedStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values: string[] = [];
  const scanLimit = Math.min(raw.length, MAX_DIAGNOSTIC_LIST_MEMBERS + DIAGNOSTIC_COLLECTION_LOOKAHEAD);
  for (let index = 0; index < scanLimit; index += 1) {
    const value = raw[index];
    const normalized = sanitizeDiagnosticMetadata(value);
    if (normalized
      && SAFE_DIAGNOSTIC_FIELD.test(normalized)
      && !values.includes(normalized)) values.push(normalized);
    if (values.length === MAX_DIAGNOSTIC_LIST_MEMBERS) break;
  }
  return values;
}

function normalizedCounterMap(raw: unknown): Record<string, number> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const result: Record<string, number> = {};
  let inspected = 0;
  for (const rawName in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, rawName)) continue;
    inspected += 1;
    if (inspected > MAX_DIAGNOSTIC_LIST_MEMBERS) break;
    let value: unknown;
    try {
      value = raw[rawName];
    } catch {
      continue;
    }
    const name = sanitizeDiagnosticMetadata(rawName);
    if (name && SAFE_DIAGNOSTIC_FIELD.test(name)
      && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[name] = value;
  }
  return result;
}

function assignOptionalDiagnostics(raw: Record<string, unknown>, result: TransactionDiagnosticsV1): void {
  for (const field of IDENTIFIER_FIELDS) {
    if (raw[field] === undefined) continue;
    const sanitized = sanitizedStringResult(raw[field], MAX_DIAGNOSTIC_ID_BYTES, true);
    if (sanitized.value && sanitized.state !== "redacted") result[field] = sanitized.value;
    recordSanitizationAvailability(result.fieldAvailability, field, sanitized.state);
  }
  for (const field of METADATA_FIELDS) {
    if (raw[field] === undefined) continue;
    const sanitized = diagnosticMetadataResult(field, raw[field]);
    if (sanitized.value && sanitized.state !== "redacted") result[field] = sanitized.value;
    recordSanitizationAvailability(result.fieldAvailability, field, sanitized.state);
  }
  for (const field of ERROR_FIELDS) {
    if (raw[field] === undefined) continue;
    const sanitized = sanitizedStringResult(raw[field], MAX_DIAGNOSTIC_ERROR_BYTES, true);
    if (sanitized.value) result[field] = sanitized.value;
    recordSanitizationAvailability(result.fieldAvailability, field, sanitized.state);
  }
  for (const field of NON_NEGATIVE_NUMBER_FIELDS) {
    if (isNonNegativeFiniteNumber(raw[field])) result[field] = raw[field];
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof raw[field] === "boolean") result[field] = raw[field];
  }
  for (const field of STRING_LIST_FIELDS) {
    const value = normalizedStringList(raw[field]);
    if (value) result[field] = value;
  }
  for (const field of COUNTER_MAP_FIELDS) {
    const value = normalizedCounterMap(raw[field]);
    if (value) result[field] = value;
  }

  if (typeof raw.inboundProtocol === "string" && PROTOCOLS.has(raw.inboundProtocol as DiagnosticProtocolV1)) {
    result.inboundProtocol = raw.inboundProtocol;
  }
  for (const field of ["inboundTransport", "upstreamTransport"] as const) {
    if (typeof raw[field] === "string" && TRANSPORTS.has(raw[field] as DiagnosticTransportV1)) {
      result[field] = raw[field];
    }
  }
  if (raw.terminalSource === "upstream" || raw.terminalSource === "synthetic") {
    result.terminalSource = raw.terminalSource;
  }
  if (raw.transportPhase === "pre_headers" || raw.transportPhase === "mid_stream" || raw.transportPhase === "terminal_sse") {
    result.transportPhase = raw.transportPhase;
  }
  if (raw.closeReason === "terminal" || raw.closeReason === "client_cancel" || raw.closeReason === "non_stream"
    || raw.closeReason === "body_stall" || raw.closeReason === "body_overflow") {
    result.closeReason = raw.closeReason;
  }
  if (raw.policyFallbackOutcome === "succeeded" || raw.policyFallbackOutcome === "failed"
    || raw.policyFallbackOutcome === "not_attempted") {
    result.policyFallbackOutcome = raw.policyFallbackOutcome;
  }
}

export function normalizeTransactionDiagnostics(raw: unknown): TransactionDiagnosticsV1 | undefined {
  if (!isPlainObject(raw)
    || raw.schemaVersion !== TRANSACTION_DIAGNOSTICS_SCHEMA_VERSION
    || raw.diagnosticCaptureVersion !== DIAGNOSTIC_CAPTURE_VERSION
    || raw.recordKind !== "request"
    || typeof raw.correlationSource !== "string"
    || !CORRELATION_SOURCES.has(raw.correlationSource as DiagnosticCorrelationSourceV1)
    || typeof raw.correlationConfidence !== "string"
    || !CORRELATION_CONFIDENCES.has(raw.correlationConfidence as DiagnosticCorrelationConfidenceV1)
    || !isNonNegativeFiniteNumber(raw.receivedAt)
    || raw.timestampSource !== "proxy_wall_clock"
    || typeof raw.captureTruncated !== "boolean"
    || typeof raw.redactionApplied !== "boolean"
    || raw.redactionVersion !== 1
    || raw.retentionClass !== "usage_ledger") return undefined;

  const transactionId = sanitizeDiagnosticIdentifier(raw.transactionId);
  if (!transactionId) return undefined;
  const bounded = boundedEvents(raw.events);
  const availability = normalizeAvailability(raw.fieldAvailability);
  const priorDropped = typeof raw.droppedDiagnosticEventCount === "number"
    && Number.isInteger(raw.droppedDiagnosticEventCount)
    && raw.droppedDiagnosticEventCount >= 0
    ? raw.droppedDiagnosticEventCount
    : 0;
  const result: TransactionDiagnosticsV1 = {
    schemaVersion: TRANSACTION_DIAGNOSTICS_SCHEMA_VERSION,
    diagnosticCaptureVersion: DIAGNOSTIC_CAPTURE_VERSION,
    transactionId,
    recordKind: "request",
    correlationSource: raw.correlationSource as DiagnosticCorrelationSourceV1,
    correlationConfidence: raw.correlationConfidence as DiagnosticCorrelationConfidenceV1,
    receivedAt: raw.receivedAt,
    timestampSource: "proxy_wall_clock",
    events: bounded.events,
    fieldAvailability: availability.values,
    droppedDiagnosticEventCount: priorDropped + bounded.dropped,
    captureTruncated: raw.captureTruncated || bounded.dropped > 0 || availability.truncated,
    redactionApplied: raw.redactionApplied,
    redactionVersion: 1,
    retentionClass: "usage_ledger",
  };
  if (bounded.responseIdState && bounded.responseIdState !== "observed") {
    recordSanitizationAvailability(result.fieldAvailability, "upstreamResponseId", bounded.responseIdState, "upstream");
    result.correlationConfidence = "unknown";
  }
  if (bounded.eventIdState && bounded.eventIdState !== "observed") {
    recordSanitizationAvailability(result.fieldAvailability, "upstreamEventId", bounded.eventIdState, "upstream");
  }
  assignOptionalDiagnostics(raw, result);
  const upstreamAvailability = result.fieldAvailability.upstreamResponseId?.status;
  if (upstreamAvailability === "redacted" || upstreamAvailability === "truncated") {
    delete result.upstreamResponseId;
    result.correlationConfidence = "unknown";
  }
  const boundedAvailability = normalizeAvailability(result.fieldAvailability);
  result.fieldAvailability = boundedAvailability.values;
  const availabilityStates = Object.values(result.fieldAvailability).map(value => value.status);
  if (boundedAvailability.truncated || availabilityStates.includes("truncated")) result.captureTruncated = true;
  if (availabilityStates.includes("redacted")) result.redactionApplied = true;
  return result;
}

export function createTransactionDiagnostics(input: CreateTransactionDiagnosticsInput): TransactionDiagnosticsV1 {
  const availability = normalizeAvailability(input.fieldAvailability);
  const diagnostics: TransactionDiagnosticsV1 = {
    schemaVersion: TRANSACTION_DIAGNOSTICS_SCHEMA_VERSION,
    diagnosticCaptureVersion: DIAGNOSTIC_CAPTURE_VERSION,
    transactionId: proxyId("txn"),
    recordKind: "request",
    correlationSource: input.correlationSource ?? "proxy",
    correlationConfidence: input.correlationConfidence ?? "direct",
    receivedAt: isNonNegativeFiniteNumber(input.receivedAt) ? input.receivedAt : Date.now(),
    timestampSource: "proxy_wall_clock",
    events: [],
    fieldAvailability: availability.values,
    droppedDiagnosticEventCount: 0,
    captureTruncated: availability.truncated,
    redactionApplied: true,
    redactionVersion: 1,
    retentionClass: "usage_ledger",
  };
  const requestId = sanitizeDiagnosticIdentifier(input.requestId);
  if (!requestId) diagnostics.fieldAvailability.requestId = { status: "redacted", source: "proxy" };
  if (input.proxyVersion !== undefined) diagnostics.proxyVersion = input.proxyVersion;
  if (input.inboundProtocol !== undefined) diagnostics.inboundProtocol = input.inboundProtocol;
  if (input.inboundTransport !== undefined) diagnostics.inboundTransport = input.inboundTransport;
  return normalizeTransactionDiagnostics(diagnostics)!;
}

/** A canonical append cannot attest to its own completion, including on reuse. */
export function clearDiagnosticPersistenceOutcome(diagnostics: TransactionDiagnosticsV1): void {
  diagnostics.logSink = "usage.jsonl";
  delete diagnostics.recordPersisted;
  delete diagnostics.persistedAt;
  delete diagnostics.persistenceLagMs;
  delete diagnostics.persistenceErrorCode;
  diagnostics.events = diagnostics.events.filter(event => event.type !== "request.persisted");
  if (Array.isArray(diagnostics.derivedFields)) {
    diagnostics.derivedFields = diagnostics.derivedFields.filter(field => field !== "persistenceLagMs");
  }
  diagnostics.fieldAvailability.recordPersisted = { status: "not_observed", source: "persistence" };
  diagnostics.fieldAvailability.persistedAt = { status: "not_observed", source: "persistence" };
  delete diagnostics.fieldAvailability.persistenceLagMs;
  delete diagnostics.fieldAvailability.persistenceErrorCode;
  const availability = normalizeAvailability(diagnostics.fieldAvailability);
  diagnostics.fieldAvailability = availability.values;
  diagnostics.captureTruncated ||= availability.truncated;
}

export function recordDiagnosticEvent(
  diagnostics: TransactionDiagnosticsV1,
  input: DiagnosticEventInput,
): void {
  const normalized = normalizeEvent({
    ...input,
    eventSequence: diagnostics.events.length + diagnostics.droppedDiagnosticEventCount + 1,
  });
  const event = normalized.event;
  if (!event) {
    diagnostics.droppedDiagnosticEventCount += 1;
    diagnostics.captureTruncated = true;
    return;
  }

  if (normalized.responseIdState && normalized.responseIdState !== "observed") {
    recordSanitizationAvailability(
      diagnostics.fieldAvailability,
      "upstreamResponseId",
      normalized.responseIdState,
      "upstream",
    );
    diagnostics.correlationConfidence = "unknown";
    if (normalized.responseIdState === "truncated") diagnostics.captureTruncated = true;
  }
  if (normalized.eventIdState && normalized.eventIdState !== "observed") {
    recordSanitizationAvailability(
      diagnostics.fieldAvailability,
      "upstreamEventId",
      normalized.eventIdState,
      "upstream",
    );
    if (normalized.eventIdState === "truncated") diagnostics.captureTruncated = true;
  }

  if (diagnostics.events.length >= MAX_DIAGNOSTIC_EVENTS) {
    diagnostics.droppedDiagnosticEventCount += 1;
    diagnostics.captureTruncated = true;
  }
  retainDiagnosticEvent(diagnostics.events, event);

  if (event.type === "response.created") {
    if (diagnostics.responseCreatedAt === undefined) diagnostics.responseCreatedAt = event.at;
    if (event.responseId && diagnostics.upstreamResponseId === undefined) {
      diagnostics.upstreamResponseId = event.responseId;
      diagnostics.fieldAvailability.upstreamResponseId = { status: "observed", source: "upstream" };
      diagnostics.correlationSource = diagnostics.correlationSource === "proxy"
        ? "mixed"
        : diagnostics.correlationSource === "client"
          ? "mixed"
          : diagnostics.correlationSource;
      diagnostics.correlationConfidence = "direct";
    }
  }
  // Request/route/persistence bookkeeping is not an upstream stream event.
  if (event.source === "upstream" && (event.type.startsWith("response.") || event.type === "upstream.error")) {
    if (diagnostics.firstEventAt === undefined) diagnostics.firstEventAt = event.at;
    diagnostics.lastEventAt = event.at;
  }
  if (TERMINAL_EVENT_TYPES.has(event.type) && diagnostics.upstreamTerminalAt === undefined
    && (event.source === "upstream" || event.source === "transport")) {
    diagnostics.upstreamTerminalAt = event.at;
  }
}

function normalizeReasoningWireValue(field: unknown, value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") {
    const sanitized = sanitizeDiagnosticMetadata(value);
    if (field === "thinking.type") {
      return sanitized === "enabled" || sanitized === "disabled" || sanitized === "adaptive" ? sanitized : undefined;
    }
    return sanitized && DIAGNOSTIC_EFFORTS.has(sanitized) ? sanitized : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (field === "reasoning.enabled" && typeof value === "boolean") return value;
  return undefined;
}

export function normalizeDiagnosticSend(raw: unknown): DiagnosticSendV1 | undefined {
  if (!isPlainObject(raw)
    || !isPositiveInteger(raw.sendOrdinal)
    || !isNonNegativeFiniteNumber(raw.startedAt)) return undefined;
  const sendId = sanitizedStringResult(raw.sendId, MAX_DIAGNOSTIC_ID_BYTES, true);
  if (!sendId.value || sendId.state !== "observed") return undefined;
  const result: DiagnosticSendV1 = {
    sendId: sendId.value,
    sendOrdinal: raw.sendOrdinal,
    startedAt: raw.startedAt,
  };
  if (isNonNegativeFiniteNumber(raw.endedAt)) result.endedAt = raw.endedAt;
  if (typeof raw.upstreamTransport === "string" && TRANSPORTS.has(raw.upstreamTransport as DiagnosticTransportV1)) {
    result.upstreamTransport = raw.upstreamTransport as DiagnosticTransportV1;
  }
  for (const field of [
    "endpointClass", "provider", "model", "adapter", "accountLogLabel", "forwardedModel", "requestedEffort",
    "effectiveEffort", "reasoningWireField", "serviceTier", "recoveryReason", "retryReason",
    "callerEffort", "configuredEffort", "callerServiceTier", "configuredServiceTier",
  ] as const) {
    const sanitized = diagnosticMetadataResult(field, raw[field]);
    if (sanitized.value && sanitized.state !== "redacted") result[field] = sanitized.value;
  }
  const reasoningWireValue = normalizeReasoningWireValue(raw.reasoningWireField, raw.reasoningWireValue);
  if (reasoningWireValue !== undefined) result.reasoningWireValue = reasoningWireValue;
  for (const field of ["status", "httpStatus", "websocketHandshakeStatus"] as const) {
    if (typeof raw[field] === "number" && Number.isInteger(raw[field]) && raw[field] >= 100 && raw[field] <= 599) {
      result[field] = raw[field];
    }
  }
  for (const field of ["upstreamRequestId", "upstreamResponseId", "upstreamEventId"] as const) {
    const sanitized = sanitizedStringResult(raw[field], MAX_DIAGNOSTIC_ID_BYTES, true);
    if (sanitized.state === "observed" && sanitized.value) result[field] = sanitized.value;
  }
  for (const field of ["bytesForwarded", "bytesReceived"] as const) {
    if (isNonNegativeFiniteNumber(raw[field])) result[field] = raw[field];
  }
  for (const field of ["upstreamRequestAccepted", "streamAborted", "connectionReused"] as const) {
    if (typeof raw[field] === "boolean") result[field] = raw[field];
  }
  return result;
}

export function normalizeDiagnosticSends(raw: unknown): DiagnosticSendV1[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const valid: DiagnosticSendV1[] = [];
  for (const index of boundedCollectionIndices(raw.length, MAX_DIAGNOSTIC_SENDS)) {
    let candidate: unknown;
    try {
      candidate = raw[index];
    } catch {
      continue;
    }
    const send = normalizeDiagnosticSend(candidate);
    if (send && valid.length < MAX_DIAGNOSTIC_SENDS) valid.push(send);
    else if (send && (send.endedAt !== undefined || send.status !== undefined)) valid[MAX_DIAGNOSTIC_SENDS - 1] = send;
  }
  return valid;
}

const cappedPendingSendOwners = new WeakMap<DiagnosticSendV1, DiagnosticSendOwner>();

export function beginDiagnosticSend(owner: DiagnosticSendOwner, input: DiagnosticSendStart): DiagnosticSendV1 {
  const sendOrdinal = Number.isInteger(owner.sendCount) && owner.sendCount >= 0 ? owner.sendCount + 1 : 1;
  owner.sendCount = sendOrdinal;
  const send = normalizeDiagnosticSend({
    sendId: proxyId("send"),
    sendOrdinal,
    ...input,
    startedAt: isNonNegativeFiniteNumber(input.startedAt) ? input.startedAt : Date.now(),
  })!;
  owner.sends ??= [];
  if (owner.sends.length < MAX_DIAGNOSTIC_SENDS) owner.sends.push(send);
  else cappedPendingSendOwners.set(send, owner);
  return send;
}

export function finishDiagnosticSend(send: DiagnosticSendV1, input: DiagnosticSendFinish): DiagnosticSendV1 {
  const normalized = normalizeDiagnosticSend({ ...send, ...input });
  if (!normalized) return send;
  for (const key of Object.keys(send)) delete (send as unknown as Record<string, unknown>)[key];
  Object.assign(send, normalized);
  const owner = cappedPendingSendOwners.get(send);
  if (owner && (send.endedAt !== undefined || send.status !== undefined)) {
    owner.sends ??= [];
    if (!owner.sends.some(retained => retained.sendId === send.sendId)) {
      owner.sends[Math.max(0, MAX_DIAGNOSTIC_SENDS - 1)] = send;
    }
    cappedPendingSendOwners.delete(send);
  }
  return send;
}
