import { randomUUID } from "node:crypto";
import { redactSecretString } from "../lib/redact";

export const TRANSACTION_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;
export const DIAGNOSTIC_CAPTURE_VERSION = 1 as const;
export const MAX_DIAGNOSTIC_EVENTS = 64;
export const MAX_DIAGNOSTIC_SENDS = 16;
export const MAX_DIAGNOSTIC_ID_BYTES = 256;
export const MAX_DIAGNOSTIC_ERROR_BYTES = 500;

const MAX_DIAGNOSTIC_FIELD_NAME_BYTES = 64;
const MAX_DIAGNOSTIC_METADATA_BYTES = 64;
const MAX_DIAGNOSTIC_LIST_MEMBERS = 64;
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
  | "request.persisted";

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
  "largestToolResultBytes", "contextWindowTokens", "maxOutputTokens", "deltaInputCount",
  "reconstructedInputCount", "replayedItemCount", "compactionCount", "httpStatus",
  "websocketHandshakeStatus", "terminalMappedStatus", "lastEventSequence", "streamEventCount", "bytesReceived",
  "bytesForwarded", "websocketCloseCode", "connectionAgeMs", "reconnectCount", "idleTimeoutMs", "bodyStallMs",
  "bodyOverflowBytes", "retryAfterMs", "connectionGeneration", "requestSequenceOnConnection", "retryDelayMs",
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
  "policyFallbackOutcome", "requestId",
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

function sanitizedString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // Remove record/control boundaries before redaction so a credential label cannot use
  // a newline to limit the redactor's range and expose a suffix when this is normalized again.
  const withoutControls = redactSecretString(value.replace(CONTROL_CHARACTERS, ""))
    .replace(CONTROL_CHARACTERS, "")
    .trim();
  if (!withoutControls) return undefined;
  let bytes = 0;
  let retained = "";
  for (const character of withoutControls) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    retained += character;
    bytes += characterBytes;
  }
  return retained || undefined;
}

export function sanitizeDiagnosticIdentifier(value: unknown): string | undefined {
  return sanitizedString(value, MAX_DIAGNOSTIC_ID_BYTES);
}

export function sanitizeDiagnosticError(value: unknown): string | undefined {
  return sanitizedString(value, MAX_DIAGNOSTIC_ERROR_BYTES);
}

function sanitizeDiagnosticMetadata(value: unknown): string | undefined {
  return sanitizedString(value, MAX_DIAGNOSTIC_METADATA_BYTES);
}

function proxyId(kind: "txn" | "attempt" | "send"): string {
  return `ocx-${kind}-${randomUUID()}`;
}

export function createDiagnosticAttemptId(): string {
  return proxyId("attempt");
}

function normalizeAvailability(raw: unknown): Record<string, DiagnosticAvailabilityV1> {
  if (!isPlainObject(raw)) return {};
  const normalized: Record<string, DiagnosticAvailabilityV1> = {};
  for (const [rawName, rawValue] of Object.entries(raw)) {
    if (Object.keys(normalized).length === MAX_DIAGNOSTIC_LIST_MEMBERS) break;
    const name = sanitizedString(rawName, MAX_DIAGNOSTIC_FIELD_NAME_BYTES);
    if (!name || !KNOWN_DIAGNOSTIC_FIELDS.has(name) || !isPlainObject(rawValue)) continue;
    if (typeof rawValue.status !== "string"
      || !AVAILABILITY_STATUSES.has(rawValue.status as DiagnosticAvailabilityStatusV1)) continue;
    if (rawValue.source !== undefined
      && (typeof rawValue.source !== "string"
        || !AVAILABILITY_SOURCES.has(rawValue.source as DiagnosticAvailabilitySourceV1))) continue;
    normalized[name] = {
      status: rawValue.status as DiagnosticAvailabilityStatusV1,
      ...(rawValue.source === undefined
        ? {}
        : { source: rawValue.source as DiagnosticAvailabilitySourceV1 }),
    };
  }
  return normalized;
}

function normalizeEvent(raw: unknown): DiagnosticEventV1 | undefined {
  if (!isPlainObject(raw)
    || !isPositiveInteger(raw.eventSequence)
    || typeof raw.type !== "string"
    || !EVENT_TYPES.has(raw.type as DiagnosticEventTypeV1)
    || !isNonNegativeFiniteNumber(raw.at)
    || typeof raw.source !== "string"
    || !EVENT_SOURCES.has(raw.source as DiagnosticEventSourceV1)) return undefined;
  const responseId = sanitizeDiagnosticIdentifier(raw.responseId);
  const eventId = sanitizeDiagnosticIdentifier(raw.eventId);
  return {
    eventSequence: raw.eventSequence,
    type: raw.type as DiagnosticEventTypeV1,
    at: raw.at,
    source: raw.source as DiagnosticEventSourceV1,
    ...(isNonNegativeFiniteNumber(raw.elapsedMs) ? { elapsedMs: raw.elapsedMs } : {}),
    ...(responseId ? { responseId } : {}),
    ...(eventId ? { eventId } : {}),
  };
}

function boundedEvents(raw: unknown): { events: DiagnosticEventV1[]; dropped: number } {
  if (!Array.isArray(raw)) return { events: [], dropped: 0 };
  const valid = raw.map(normalizeEvent).filter((event): event is DiagnosticEventV1 => event !== undefined);
  const invalidCount = raw.length - valid.length;
  if (valid.length <= MAX_DIAGNOSTIC_EVENTS) return { events: valid, dropped: invalidCount };
  const lastTerminal = valid.findLast(event => TERMINAL_EVENT_TYPES.has(event.type));
  const retained = valid.slice(0, MAX_DIAGNOSTIC_EVENTS);
  if (lastTerminal && !retained.includes(lastTerminal)) retained[MAX_DIAGNOSTIC_EVENTS - 1] = lastTerminal;
  return { events: retained, dropped: invalidCount + valid.length - retained.length };
}

function normalizedStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values: string[] = [];
  for (const value of raw) {
    const normalized = sanitizeDiagnosticMetadata(value);
    if (normalized && !values.includes(normalized)) values.push(normalized);
    if (values.length === MAX_DIAGNOSTIC_LIST_MEMBERS) break;
  }
  return values;
}

function normalizedCounterMap(raw: unknown): Record<string, number> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const result: Record<string, number> = {};
  for (const [rawName, value] of Object.entries(raw)) {
    if (Object.keys(result).length === MAX_DIAGNOSTIC_LIST_MEMBERS) break;
    const name = sanitizeDiagnosticMetadata(rawName);
    if (name && isNonNegativeFiniteNumber(value)) result[name] = value;
  }
  return result;
}

function assignOptionalDiagnostics(raw: Record<string, unknown>, result: TransactionDiagnosticsV1): void {
  for (const field of IDENTIFIER_FIELDS) {
    const value = sanitizeDiagnosticIdentifier(raw[field]);
    if (value) result[field] = value;
  }
  for (const field of METADATA_FIELDS) {
    const value = sanitizeDiagnosticMetadata(raw[field]);
    if (value) result[field] = value;
  }
  for (const field of ERROR_FIELDS) {
    const value = sanitizeDiagnosticError(raw[field]);
    if (value) result[field] = value;
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
    fieldAvailability: normalizeAvailability(raw.fieldAvailability),
    droppedDiagnosticEventCount: priorDropped + bounded.dropped,
    captureTruncated: raw.captureTruncated || bounded.dropped > 0,
    redactionApplied: raw.redactionApplied,
    redactionVersion: 1,
    retentionClass: "usage_ledger",
  };
  assignOptionalDiagnostics(raw, result);
  return result;
}

export function createTransactionDiagnostics(input: CreateTransactionDiagnosticsInput): TransactionDiagnosticsV1 {
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
    fieldAvailability: normalizeAvailability(input.fieldAvailability),
    droppedDiagnosticEventCount: 0,
    captureTruncated: false,
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

export function recordDiagnosticEvent(
  diagnostics: TransactionDiagnosticsV1,
  input: DiagnosticEventInput,
): void {
  const event = normalizeEvent({
    ...input,
    eventSequence: diagnostics.events.length + diagnostics.droppedDiagnosticEventCount + 1,
  });
  if (!event) {
    diagnostics.droppedDiagnosticEventCount += 1;
    diagnostics.captureTruncated = true;
    return;
  }

  if (diagnostics.events.length < MAX_DIAGNOSTIC_EVENTS) diagnostics.events.push(event);
  else {
    diagnostics.droppedDiagnosticEventCount += 1;
    diagnostics.captureTruncated = true;
    if (TERMINAL_EVENT_TYPES.has(event.type)) diagnostics.events[MAX_DIAGNOSTIC_EVENTS - 1] = event;
  }

  if (event.type === "response.created") {
    if (diagnostics.responseCreatedAt === undefined) diagnostics.responseCreatedAt = event.at;
    if (event.responseId && diagnostics.upstreamResponseId === undefined) {
      diagnostics.upstreamResponseId = event.responseId;
      diagnostics.correlationSource = diagnostics.correlationSource === "proxy"
        ? "mixed"
        : diagnostics.correlationSource === "client"
          ? "mixed"
          : diagnostics.correlationSource;
      diagnostics.correlationConfidence = "direct";
    }
  }
  if (diagnostics.firstEventAt === undefined) diagnostics.firstEventAt = event.at;
  diagnostics.lastEventAt = event.at;
  if (TERMINAL_EVENT_TYPES.has(event.type) && diagnostics.upstreamTerminalAt === undefined
    && (event.source === "upstream" || event.source === "transport")) {
    diagnostics.upstreamTerminalAt = event.at;
  }
}

function normalizeReasoningWireValue(field: unknown, value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") return sanitizeDiagnosticMetadata(value);
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (field === "reasoning.enabled" && typeof value === "boolean") return value;
  return undefined;
}

export function normalizeDiagnosticSend(raw: unknown): DiagnosticSendV1 | undefined {
  if (!isPlainObject(raw)
    || !isPositiveInteger(raw.sendOrdinal)
    || !isNonNegativeFiniteNumber(raw.startedAt)) return undefined;
  const sendId = sanitizeDiagnosticIdentifier(raw.sendId);
  if (!sendId) return undefined;
  const result: DiagnosticSendV1 = {
    sendId,
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
  ] as const) {
    const value = sanitizeDiagnosticMetadata(raw[field]);
    if (value) result[field] = value;
  }
  const reasoningWireValue = normalizeReasoningWireValue(raw.reasoningWireField, raw.reasoningWireValue);
  if (reasoningWireValue !== undefined) result.reasoningWireValue = reasoningWireValue;
  for (const field of ["status", "httpStatus", "websocketHandshakeStatus"] as const) {
    if (typeof raw[field] === "number" && Number.isInteger(raw[field]) && raw[field] >= 100 && raw[field] <= 599) {
      result[field] = raw[field];
    }
  }
  for (const field of ["upstreamRequestId", "upstreamResponseId", "upstreamEventId"] as const) {
    const value = sanitizeDiagnosticIdentifier(raw[field]);
    if (value) result[field] = value;
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
  const valid = raw.map(normalizeDiagnosticSend).filter((send): send is DiagnosticSendV1 => send !== undefined);
  if (valid.length <= MAX_DIAGNOSTIC_SENDS) return valid;
  const lastTerminal = valid.findLast(send => send.endedAt !== undefined || send.status !== undefined);
  return [...valid.slice(0, MAX_DIAGNOSTIC_SENDS - 1), lastTerminal ?? valid.at(-1)!];
}

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
  else owner.sends[MAX_DIAGNOSTIC_SENDS - 1] = send;
  return send;
}

export function finishDiagnosticSend(send: DiagnosticSendV1, input: DiagnosticSendFinish): DiagnosticSendV1 {
  const normalized = normalizeDiagnosticSend({ ...send, ...input });
  if (!normalized) return send;
  for (const key of Object.keys(send)) delete (send as unknown as Record<string, unknown>)[key];
  Object.assign(send, normalized);
  return send;
}
