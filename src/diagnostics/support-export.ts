import { createHmac, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  sanitizeDiagnosticError,
  type DiagnosticAvailabilityV1,
  type DiagnosticEventV1,
  type DiagnosticSendV1,
  type TransactionDiagnosticsV1,
} from "./transaction";
import type { PersistedUsageAttempt, PersistedUsageEntry } from "../usage/log";

export const SUPPORT_EXPORT_MAX_REQUEST_IDS = 32;
export const SUPPORT_EXPORT_MAX_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const SUPPORT_EXPORT_MAX_RECORDS = 2_000;
export const SUPPORT_EXPORT_MAX_BYTES = 8 * 1024 * 1024;

export const SUPPORT_EXPORT_RELATED_ISSUE_URLS = [
  "https://github.com/openai/codex/issues/43131",
  "https://github.com/openai/codex/issues/42906",
] as const;

export type SupportExportSelection =
  | { requestIds: readonly string[] }
  | { from: number; to: number };

export interface SupportExportGapV1 {
  kind: "request_not_found" | "field_unavailable" | "record_limit" | "byte_limit" | "record_validation" | "log_coverage";
  requestId?: string;
  field?: string;
  omittedRecordCount: number;
}

export interface SupportExportRecordV1 {
  requestId: string;
  timestamp: number;
  provider: string;
  model: string;
  [field: string]: unknown;
}

export interface TransactionSupportExportV1 {
  exportSchemaVersion: 1;
  exportGeneratedAt: number;
  exportWindowStart?: number;
  exportWindowEnd?: number;
  exportSelectionIds: string[];
  exportCompleteness: "complete" | "partial";
  logCoverageStart?: number;
  logCoverageEnd?: number;
  serviceRestartWithinWindow: "unknown";
  unavailableFields: string[];
  gaps: SupportExportGapV1[];
  redactionVersion: 1;
  truncationVersion: 1;
  source: "canonical_usage_ledger";
  relatedIssueUrls: [string, string];
  records: SupportExportRecordV1[];
}

export interface BuildSupportExportOptions {
  generatedAt?: number;
  pseudonymKey?: Uint8Array;
  /** The bounded canonical reader skipped bytes, entries, or unreadable input. */
  canonicalScanIncomplete?: boolean;
}

type ExportObject = Record<string, unknown>;
interface Pseudonymizer {
  key: Uint8Array;
  cache: Map<string, string>;
}

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+/@ -]*$/;
const REQUEST_ID_HEADER_NAMES = new Set(["x-request-id", "openai-request-id", "request-id"]);
const TRACE_HEADER_NAMES = new Set(["x-trace-id", "x-span-id", "traceparent"]);
const PRIVATE_DIAGNOSTIC_ID_FIELDS = [
  "codexThreadId", "codexTurnId", "codexSessionId", "rootThreadId", "rootTurnId",
  "parentThreadId", "agentId", "parentAgentId", "clientRequestId", "clientResponseId",
  "upstreamResponseId", "previousResponseId", "originalPreviousResponseId",
  "forwardedPreviousResponseId", "upstreamRequestId", "upstreamConversationId",
  "upstreamSessionId", "upstreamEventId", "policyEventId", "traceId", "spanId",
  "parentSpanId", "connectionId", "upstreamConnectionId", "lastKnownUsageResponseId",
  "proxyCommit", "proxyBuildId", "proxyInstanceId", "configRevision", "routeConfigRevision",
  "modelCatalogRevision", "routeDecisionId", "selectedCandidate", "settingsRevision",
  "requestSettingsRevision",
] as const;
const RETAINED_DIAGNOSTIC_ID_FIELDS = [
  "parentRequestId", "retryOfRequestId", "replayOfRequestId", "modelSwitchEffectiveFromRequestId",
] as const;
const DIAGNOSTIC_METADATA_FIELDS = [
  "agentRole", "clientProduct", "clientVersion", "codexCoreVersion", "desktopVersion",
  "originator", "upstreamProtocol", "adapterName", "protocolVersion", "proxyVersion",
  "runtimeName", "runtimeVersion", "osPlatform", "architecture", "osVersion",
  "adapterVersion", "diagnosticMode", "forwardedModel", "responseModel", "responseEffort",
  "callerEffort", "configuredEffort", "configuredEffortSource",
  "routeKind", "fallbackReason", "rewriteReason", "authMode", "accountSelectionSource",
  "accountPoolSelectionReason", "subscriptionPlan", "entitlementSource", "cyberAccessStatus",
  "cyberAccessProgram", "modelAccessStatus", "authRefreshResult", "tokenEstimateMethod",
  "continuationMode", "toolChoiceMode", "truncationMode", "endpointClass", "upstreamHostname",
  "method", "upstreamContentType", "protocolEventType", "terminalEventType", "lastEventType",
  "lastOutputKind", "closedBy", "upstreamErrorCode", "errorType", "errorParam",
  "incompleteReason", "contentFilterResult", "errorEnvelopeSchema", "refusalCategory",
  "policyRuleId", "policyStage", "policyDecisionSource", "errorOrigin", "truncationReason",
  "logSink", "persistenceErrorCode", "usageSource", "usageMissingReason", "billedUsageSource",
  "rateLimitReachedType", "quotaErrorCode", "retryDecision", "recoveryReason", "resumeMode",
  "stateRestoreSource", "cancellationSource", "cancellationReason",
] as const;
const DIAGNOSTIC_NUMBER_FIELDS = [
  "admittedAt", "routeSelectedAt", "queuedAt", "upstreamConnectStartedAt", "upstreamConnectedAt",
  "handshakeCompletedAt", "upstreamRequestSentAt", "upstreamHeadersAt", "responseCreatedAt",
  "firstEventAt", "lastEventAt", "upstreamTerminalAt", "downstreamTerminalSentAt",
  "downstreamClosedAt", "finalizedAt", "persistedAt", "settingsUpdatedAt", "settingsAppliedAt",
  "entitlementObservedAt", "usageReportedAt", "modelSwitchAppliedAt", "lastCompactionAt", "expiresAt", "queueMs",
  "connectMs", "handshakeMs", "upstreamTimeToFirstEventMs", "firstOutputMs", "upstreamDurationMs",
  "downstreamDeliveryLagMs", "finalizationLagMs", "persistenceLagMs", "idleBeforeFailureMs",
  "requestBytes", "forwardedRequestBytes", "inputItemCount", "messageCount", "toolDefinitionCount",
  "toolCallCount", "toolResultCount", "imageCount", "audioCount", "fileCount", "encryptedItemCount",
  "reasoningItemCount", "conversationItemCount", "attachmentBytes", "toolResultBytes",
  "forwardedInputItemCount", "forwardedConversationItemCount", "forwardedMessageCount",
  "forwardedToolDefinitionCount", "forwardedToolCallCount", "forwardedToolResultCount",
  "forwardedReasoningItemCount", "forwardedEncryptedItemCount", "forwardedImageCount",
  "forwardedAudioCount", "forwardedFileCount", "forwardedAttachmentBytes",
  "forwardedToolResultBytes", "forwardedLargestToolResultBytes",
  "largestToolResultBytes", "contextWindowTokens", "contextUsageRatioEstimate", "maxOutputTokens", "deltaInputCount",
  "reconstructedInputCount", "replayedItemCount", "compactionCount", "httpStatus",
  "websocketHandshakeStatus", "terminalMappedStatus", "lastEventSequence", "streamEventCount",
  "bytesReceived", "bytesForwarded", "websocketCloseCode", "connectionAgeMs", "reconnectCount",
  "idleTimeoutMs", "bodyStallMs", "bodyOverflowBytes", "retryAfterMs", "connectionGeneration",
  "requestSequenceOnConnection", "upstreamRequestSequenceOnConnection", "retryDelayMs",
  "retryBudgetRemaining", "usageMissingCount", "requestLimit", "tokenLimit", "accountWindowLimit",
  "accountWindowRemaining", "accountWindowResetAt",
] as const;
const DIAGNOSTIC_BOOLEAN_FIELDS = [
  "clockAnomaly", "modelSwitchRequested", "modelSwitchApplied", "accountChangedBetweenAttempts",
  "authRefreshOccurred", "previousResponseUsed", "parallelToolCalls", "streamingRequested",
  "storeRequested", "compactionOccurred", "outputDeliveredBeforeFailure", "upstreamRequestAccepted",
  "streamAborted", "connectionReused", "heartbeatTimeout", "errorMessageTruncated", "retryable",
  "policyFallbackAttempted", "previousResponseRewriteApplied", "stateRestored", "upstreamCallMade",
  "correlationMismatch", "responseIdMismatch", "duplicateTerminalSuppressed", "usagePartial",
  "spendControlReached", "recordPersisted",
] as const;
const DIAGNOSTIC_LIST_FIELDS = [
  "derivedFields", "relevantFeatureFlags", "contextTransformationKinds", "unknownErrorFieldNames",
] as const;
const DIAGNOSTIC_COUNTER_FIELDS = [
  "outputItemCountsByType", "locallyInjectedItemCounts", "droppedItemCounts", "truncatedItemCounts",
] as const;
const IMPORTANT_AVAILABILITY_FIELDS = [
  "upstreamResponseId", "policyEventId", "traceId", "connectionId", "subscriptionPlan",
  "entitlementSource", "cyberAccessStatus", "modelAccessStatus", "modelSwitchRequested",
  "modelSwitchApplied", "billedUsageSource", "usageSource",
] as const;

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeToken(value: unknown, maxBytes = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (!normalized || normalized !== value || Buffer.byteLength(normalized, "utf8") > maxBytes) return undefined;
  if (!SAFE_TOKEN.test(normalized) || normalized.includes("://") || normalized.includes("?")
    || normalized.includes("#") || normalized.startsWith("/") || normalized.includes("\\")
    || /(?:^sk-|^ocx_|\bBearer\s+|\bAuthorization\b|\b(?:token|secret|api[_-]?key)\s*[:=])/i.test(normalized)) return undefined;
  return normalized;
}

function setToken(target: ExportObject, field: string, value: unknown, maxBytes = 256): void {
  const safe = safeToken(value, maxBytes);
  if (safe !== undefined) target[field] = safe;
}

function setNumber(target: ExportObject, field: string, value: unknown): void {
  if (finiteNonNegative(value)) target[field] = value;
}

function setBoolean(target: ExportObject, field: string, value: unknown): void {
  if (typeof value === "boolean") target[field] = value;
}

function pseudonym(value: unknown, state: Pseudonymizer): string | undefined {
  if (typeof value === "string") {
    const existing = state.cache.get(value);
    if (existing) return existing;
  }
  const safe = safeToken(value);
  if (!safe) return undefined;
  const existing = state.cache.get(safe);
  if (existing) return existing;
  const mapped = `psn_${createHmac("sha256", state.key).update(safe, "utf8").digest("hex").slice(0, 24)}`;
  state.cache.set(safe, mapped);
  if (typeof value === "string") state.cache.set(value, mapped);
  return mapped;
}

function setPseudonym(target: ExportObject, field: string, value: unknown, state: Pseudonymizer): void {
  const mapped = pseudonym(value, state);
  if (mapped) target[field] = mapped;
}

function publicError(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/(?:https?:\/\/|file:|(?:^|\s)(?:\/home\/|\/Users\/|\/tmp\/|\/mnt\/|[A-Za-z]:\\)|\bBearer\s+|\bAuthorization\s*[:=]|\b(?:token|secret|api[_-]?key)\s*[:=])/i.test(value)) {
    return undefined;
  }
  return sanitizeDiagnosticError(value);
}

function exportUsage(value: unknown): ExportObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: ExportObject = {};
  for (const field of [
    "inputTokens", "outputTokens", "contextTotalTokens", "totalTokens", "cachedInputTokens",
    "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens",
  ]) setNumber(result, field, source[field]);
  setBoolean(result, "estimated", source.estimated);
  return Object.keys(result).length > 0 ? result : undefined;
}

function exportTierOutcome(value: unknown): ExportObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: ExportObject = {};
  for (const field of [
    "canonical", "wireKind", "wireValue", "fastOutcome", "fastDowngradeReason", "confirmation",
    "responseServiceTier",
  ]) setToken(result, field, source[field], 64);
  setBoolean(result, "callerTierDropped", source.callerTierDropped);
  setBoolean(result, "callerFastSuppressedByConfig", source.callerFastSuppressedByConfig);
  return Object.keys(result).length > 0 ? result : undefined;
}

function exportSend(send: DiagnosticSendV1, state: Pseudonymizer): ExportObject | undefined {
  const sendId = safeToken(send.sendId);
  if (!sendId || !finiteNonNegative(send.sendOrdinal) || !finiteNonNegative(send.startedAt)) return undefined;
  const result: ExportObject = { sendId, sendOrdinal: send.sendOrdinal, startedAt: send.startedAt };
  for (const field of ["endedAt", "status", "httpStatus", "websocketHandshakeStatus", "bytesForwarded", "bytesReceived"]) {
    setNumber(result, field, send[field as keyof DiagnosticSendV1]);
  }
  for (const field of [
    "upstreamTransport", "endpointClass", "provider", "model", "adapter", "forwardedModel",
    "requestedEffort", "effectiveEffort", "reasoningWireField", "serviceTier", "recoveryReason", "retryReason",
    "callerEffort", "configuredEffort", "callerServiceTier", "configuredServiceTier",
  ]) setToken(result, field, send[field as keyof DiagnosticSendV1], 64);
  if (typeof send.reasoningWireValue === "number" && finiteNonNegative(send.reasoningWireValue)) {
    result.reasoningWireValue = send.reasoningWireValue;
  } else if (typeof send.reasoningWireValue === "boolean") {
    result.reasoningWireValue = send.reasoningWireValue;
  } else {
    setToken(result, "reasoningWireValue", send.reasoningWireValue, 64);
  }
  for (const field of ["upstreamRequestAccepted", "streamAborted", "connectionReused"]) {
    setBoolean(result, field, send[field as keyof DiagnosticSendV1]);
  }
  for (const field of ["upstreamRequestId", "upstreamResponseId", "upstreamEventId"] as const) {
    setPseudonym(result, field, send[field], state);
  }
  setPseudonym(result, "accountLogLabel", send.accountLogLabel, state);
  return result;
}

function exportAttempt(attempt: PersistedUsageAttempt, state: Pseudonymizer): ExportObject | undefined {
  if (!Number.isInteger(attempt.ordinal) || attempt.ordinal < 1) return undefined;
  const result: ExportObject = { ordinal: attempt.ordinal };
  setToken(result, "attemptId", attempt.attemptId);
  for (const field of ["attemptStartedAt", "attemptEndedAt", "status", "durationMs", "firstOutputMs", "sendCount", "inputTokenEstimate", "totalTokens"]) {
    setNumber(result, field, attempt[field as keyof PersistedUsageAttempt]);
  }
  for (const field of ["upstreamTransport", "provider", "model", "adapter", "usageStatus", "errorCode", "requestedEffort", "effectiveEffort", "reasoningWireField"]) {
    setToken(result, field, attempt[field as keyof PersistedUsageAttempt], 64);
  }
  setBoolean(result, "streamAborted", attempt.streamAborted);
  setBoolean(result, "locallyAnswered", attempt.locallyAnswered);
  setPseudonym(result, "accountLogLabel", attempt.accountLogLabel, state);
  if (Array.isArray(attempt.recoveryKinds)) {
    result.recoveryKinds = attempt.recoveryKinds.map(value => safeToken(value, 64)).filter((value): value is string => Boolean(value));
  }
  if (typeof attempt.reasoningWireValue === "number" && finiteNonNegative(attempt.reasoningWireValue)) {
    result.reasoningWireValue = attempt.reasoningWireValue;
  } else if (typeof attempt.reasoningWireValue === "boolean") {
    result.reasoningWireValue = attempt.reasoningWireValue;
  } else {
    setToken(result, "reasoningWireValue", attempt.reasoningWireValue, 64);
  }
  const usage = exportUsage(attempt.usage);
  if (usage) result.usage = usage;
  const tier = exportTierOutcome(attempt.tierOutcome);
  if (tier) result.tierOutcome = tier;
  if (Array.isArray(attempt.sends)) {
    const sends: ExportObject[] = [];
    for (const send of attempt.sends) {
      const exported = exportSend(send, state);
      if (exported) sends.push(exported);
    }
    result.sends = sends;
  }
  return result;
}

function exportAvailability(value: Record<string, DiagnosticAvailabilityV1>): ExportObject {
  const result: ExportObject = {};
  for (const [rawField, availability] of Object.entries(value)) {
    const field = safeToken(rawField, 64);
    if (!field || !availability || typeof availability !== "object") continue;
    const item: ExportObject = {};
    setToken(item, "status", availability.status, 64);
    setToken(item, "source", availability.source, 64);
    if (item.status) result[field] = item;
  }
  return result;
}

function exportEvent(event: DiagnosticEventV1, state: Pseudonymizer): ExportObject | undefined {
  if (!Number.isInteger(event.eventSequence) || event.eventSequence < 1 || !finiteNonNegative(event.at)) return undefined;
  const result: ExportObject = { eventSequence: event.eventSequence, at: event.at };
  setToken(result, "type", event.type, 64);
  setToken(result, "source", event.source, 64);
  setNumber(result, "elapsedMs", event.elapsedMs);
  setPseudonym(result, "responseId", event.responseId, state);
  setPseudonym(result, "eventId", event.eventId, state);
  return result.type && result.source ? result : undefined;
}

function exportCounterMap(value: unknown): ExportObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: ExportObject = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = safeToken(rawKey, 64);
    if (key && finiteNonNegative(rawValue)) result[key] = rawValue;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function exportDiagnostics(source: TransactionDiagnosticsV1, state: Pseudonymizer): ExportObject | undefined {
  const transactionId = safeToken(source.transactionId);
  if (!transactionId) return undefined;
  const result: ExportObject = {
    schemaVersion: 1,
    diagnosticCaptureVersion: 1,
    transactionId,
    recordKind: "request",
    receivedAt: source.receivedAt,
    timestampSource: "proxy_wall_clock",
    droppedDiagnosticEventCount: source.droppedDiagnosticEventCount,
    captureTruncated: source.captureTruncated,
    redactionApplied: true,
    redactionVersion: 1,
    retentionClass: "usage_ledger",
  };
  setToken(result, "correlationSource", source.correlationSource, 64);
  setToken(result, "correlationConfidence", source.correlationConfidence, 64);
  for (const field of RETAINED_DIAGNOSTIC_ID_FIELDS) setToken(result, field, source[field]);
  for (const field of PRIVATE_DIAGNOSTIC_ID_FIELDS) setPseudonym(result, field, source[field], state);
  setPseudonym(result, "accountPseudonym", source.accountPseudonym, state);
  setPseudonym(result, "accountAffinity", source.accountAffinity, state);
  if (typeof source.requestIdHeader === "string" && REQUEST_ID_HEADER_NAMES.has(source.requestIdHeader)) {
    result.requestIdHeader = source.requestIdHeader;
  }
  for (const field of DIAGNOSTIC_METADATA_FIELDS) setToken(result, field, source[field], 64);
  for (const field of DIAGNOSTIC_NUMBER_FIELDS) setNumber(result, field, source[field]);
  for (const field of DIAGNOSTIC_BOOLEAN_FIELDS) setBoolean(result, field, source[field]);
  for (const field of ["inboundProtocol", "inboundTransport", "upstreamTransport", "terminalSource", "transportPhase", "closeReason", "policyFallbackOutcome"] as const) {
    setToken(result, field, source[field], 64);
  }
  const errorMessage = publicError(source.errorMessage);
  if (errorMessage) result.errorMessage = errorMessage;
  const websocketCloseReason = publicError(source.websocketCloseReason);
  if (websocketCloseReason) result.websocketCloseReason = websocketCloseReason;
  for (const field of DIAGNOSTIC_LIST_FIELDS) {
    const raw = source[field];
    if (!Array.isArray(raw)) continue;
    result[field] = raw.map(value => safeToken(value, 64)).filter((value): value is string => Boolean(value));
  }
  if (Array.isArray(source.upstreamTraceHeaders)) {
    result.upstreamTraceHeaders = source.upstreamTraceHeaders
      .filter((value): value is string => typeof value === "string" && TRACE_HEADER_NAMES.has(value));
  }
  for (const field of DIAGNOSTIC_COUNTER_FIELDS) {
    const map = exportCounterMap(source[field]);
    if (map) result[field] = map;
  }
  result.fieldAvailability = exportAvailability(source.fieldAvailability);
  const events: ExportObject[] = [];
  for (const event of source.events) {
    const exported = exportEvent(event, state);
    if (exported) events.push(exported);
  }
  result.events = events;
  return result;
}

function exportRouteDecision(value: PersistedUsageEntry["routeDecision"], state: Pseudonymizer): ExportObject | undefined {
  if (!value) return undefined;
  const result: ExportObject = { version: 1, createdAt: value.createdAt };
  setPseudonym(result, "decisionId", value.decisionId, state);
  setToken(result, "requestedModel", value.requestedModel);
  setToken(result, "routeKind", value.routeKind, 64);
  if (value.profile) {
    const profile: ExportObject = {};
    setPseudonym(profile, "id", value.profile.id, state);
    setPseudonym(profile, "revision", value.profile.revision, state);
    result.profile = profile;
  }
  const selected: ExportObject = { candidateIndex: value.selected.candidateIndex };
  setToken(selected, "provider", value.selected.provider);
  setToken(selected, "model", value.selected.model);
  setPseudonym(selected, "accountRef", value.selected.accountRef, state);
  setToken(selected, "reason", value.selected.reason, 128);
  setToken(selected, "tieBreak", value.selected.tieBreak, 128);
  result.selected = selected;
  if (value.truncated) {
    const truncated: ExportObject = {};
    for (const field of ["candidates", "exclusions", "requirements", "strings", "compatibility"] as const) {
      if (value.truncated[field] === true) truncated[field] = true;
    }
    result.truncated = truncated;
  }
  return result;
}

function exportRecord(entry: PersistedUsageEntry, state: Pseudonymizer): SupportExportRecordV1 | undefined {
  const requestId = safeToken(entry.requestId);
  const provider = safeToken(entry.provider);
  const model = safeToken(entry.model);
  if (!requestId || !provider || !model || !finiteNonNegative(entry.timestamp)) return undefined;
  const result: SupportExportRecordV1 = { requestId, timestamp: entry.timestamp, provider, model };
  for (const field of [
    "requestedAlias", "surface", "admissionKind", "inboundProtocol", "resolvedModel", "requestedModel",
    "shadowCallRewrittenFrom", "requestedEffort", "effectiveEffort", "reasoningWireField",
    "callerServiceTier", "requestedServiceTier", "requestedSpeedLabel", "configuredServiceTier",
    "configuredSpeedLabel", "responseServiceTier", "usageStatus", "errorCode", "terminalStatus",
    "closeReason", "affinity", "transportPhase", "terminalSource",
  ] as const) setToken(result, field, entry[field], 128);
  for (const field of ["status", "durationMs", "firstOutputMs", "totalTokens"] as const) {
    setNumber(result, field, entry[field]);
  }
  setBoolean(result, "modelSupportsServiceTier", entry.modelSupportsServiceTier);
  setPseudonym(result, "apiKeyId", entry.apiKeyId, state);
  setPseudonym(result, "accountLogLabel", entry.accountLogLabel, state);
  setPseudonym(result, "conversationId", entry.conversationId, state);
  if (typeof entry.reasoningWireValue === "number" && finiteNonNegative(entry.reasoningWireValue)) {
    result.reasoningWireValue = entry.reasoningWireValue;
  } else if (typeof entry.reasoningWireValue === "boolean") {
    result.reasoningWireValue = entry.reasoningWireValue;
  } else {
    setToken(result, "reasoningWireValue", entry.reasoningWireValue, 64);
  }
  const upstreamError = publicError(entry.upstreamError);
  if (upstreamError) result.upstreamError = upstreamError;
  const localTerminalReason = publicError(entry.localTerminalReason);
  if (localTerminalReason) result.localTerminalReason = localTerminalReason;
  const usage = exportUsage(entry.usage);
  if (usage) result.usage = usage;
  const tier = exportTierOutcome(entry.tierOutcome);
  if (tier) result.tierOutcome = tier;
  if (Array.isArray(entry.attempts)) {
    const attempts: ExportObject[] = [];
    for (const attempt of entry.attempts) {
      const exported = exportAttempt(attempt, state);
      if (exported) attempts.push(exported);
    }
    result.attempts = attempts;
  }
  const diagnostics = entry.diagnostics ? exportDiagnostics(entry.diagnostics, state) : undefined;
  if (diagnostics) result.diagnostics = diagnostics;
  const routeDecision = exportRouteDecision(entry.routeDecision, state);
  if (routeDecision) result.routeDecision = routeDecision;
  return result;
}

function validateSelection(selection: SupportExportSelection): SupportExportSelection {
  if ("requestIds" in selection) {
    if (!Array.isArray(selection.requestIds) || selection.requestIds.length < 1
      || selection.requestIds.length > SUPPORT_EXPORT_MAX_REQUEST_IDS) {
      throw new RangeError(`requestIds must contain 1 to ${SUPPORT_EXPORT_MAX_REQUEST_IDS} values`);
    }
    const requestIds: string[] = [];
    for (const raw of selection.requestIds) {
      const requestId = safeToken(raw);
      if (!requestId) throw new RangeError("requestIds must contain safe non-empty identifiers");
      if (!requestIds.includes(requestId)) requestIds.push(requestId);
    }
    return { requestIds };
  }
  if (!Number.isSafeInteger(selection.from) || !Number.isSafeInteger(selection.to)
    || selection.from < 0 || selection.to < 0 || selection.from > selection.to) {
    throw new RangeError("from and to must be non-negative epoch-millisecond integers in ascending order");
  }
  if (selection.to - selection.from > SUPPORT_EXPORT_MAX_WINDOW_MS) {
    throw new RangeError("time window must not exceed 24 hours");
  }
  return { from: selection.from, to: selection.to };
}

function hasField(value: unknown, field: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(item => hasField(item, field));
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, field)) return true;
  return Object.entries(record).some(([key, item]) =>
    key !== "fieldAvailability" && hasField(item, field));
}

function bundleBytes(bundle: TransactionSupportExportV1): number {
  return Buffer.byteLength(JSON.stringify(bundle), "utf8");
}

function timestampBounds(entries: readonly PersistedUsageEntry[]): [number | undefined, number | undefined] {
  let start: number | undefined;
  let end: number | undefined;
  for (const entry of entries) {
    if (!finiteNonNegative(entry.timestamp)) continue;
    start = start === undefined ? entry.timestamp : Math.min(start, entry.timestamp);
    end = end === undefined ? entry.timestamp : Math.max(end, entry.timestamp);
  }
  return [start, end];
}

export function buildSupportExport(
  rawSelection: SupportExportSelection,
  entries: readonly PersistedUsageEntry[],
  options: BuildSupportExportOptions = {},
): TransactionSupportExportV1 {
  const selection = validateSelection(rawSelection);
  const generatedAt = options.generatedAt ?? Date.now();
  if (!finiteNonNegative(generatedAt)) throw new RangeError("generatedAt must be a non-negative timestamp");
  const key = options.pseudonymKey ?? randomBytes(32);
  if (key.byteLength < 16) throw new RangeError("pseudonymKey must contain at least 16 bytes");
  const pseudonymizer: Pseudonymizer = { key, cache: new Map() };

  const [logCoverageStart, logCoverageEnd] = timestampBounds(entries);
  let selected: PersistedUsageEntry[];
  let selectionIds: string[] = [];
  let windowStart: number | undefined;
  let windowEnd: number | undefined;
  const gaps: SupportExportGapV1[] = [];
  if (options.canonicalScanIncomplete) gaps.push({ kind: "log_coverage", omittedRecordCount: 0 });

  if ("requestIds" in selection) {
    selectionIds = [...selection.requestIds];
    const wanted = new Set(selection.requestIds);
    selected = entries.filter(entry => wanted.has(entry.requestId));
    const found = new Set(selected.map(entry => entry.requestId));
    for (const requestId of selection.requestIds) {
      if (!found.has(requestId)) gaps.push({ kind: "request_not_found", requestId, omittedRecordCount: 1 });
    }
    [windowStart, windowEnd] = timestampBounds(selected);
  } else {
    windowStart = selection.from;
    windowEnd = selection.to;
    selected = entries.filter(entry => finiteNonNegative(entry.timestamp)
      && entry.timestamp >= selection.from && entry.timestamp <= selection.to);
    if (logCoverageStart === undefined || logCoverageEnd === undefined
      || logCoverageStart > selection.from || logCoverageEnd < selection.to) {
      if (!gaps.some(gap => gap.kind === "log_coverage")) {
        gaps.push({ kind: "log_coverage", omittedRecordCount: 0 });
      }
    }
  }

  let recordLimitOmitted = 0;
  if (selected.length > SUPPORT_EXPORT_MAX_RECORDS) {
    recordLimitOmitted = selected.length - SUPPORT_EXPORT_MAX_RECORDS;
    selected = selected.slice(0, SUPPORT_EXPORT_MAX_RECORDS);
    gaps.push({ kind: "record_limit", omittedRecordCount: recordLimitOmitted });
  }

  const oldRowCount = selected.filter(entry => !entry.diagnostics).length;
  if (oldRowCount > 0) {
    gaps.push({ kind: "field_unavailable", field: "diagnostics", omittedRecordCount: oldRowCount });
  }

  const bundle: TransactionSupportExportV1 = {
    exportSchemaVersion: 1,
    exportGeneratedAt: generatedAt,
    ...(windowStart === undefined ? {} : { exportWindowStart: windowStart }),
    ...(windowEnd === undefined ? {} : { exportWindowEnd: windowEnd }),
    exportSelectionIds: selectionIds,
    exportCompleteness: "complete",
    ...(logCoverageStart === undefined ? {} : { logCoverageStart }),
    ...(logCoverageEnd === undefined ? {} : { logCoverageEnd }),
    serviceRestartWithinWindow: "unknown",
    unavailableFields: [],
    gaps,
    redactionVersion: 1,
    truncationVersion: 1,
    source: "canonical_usage_ledger",
    relatedIssueUrls: [SUPPORT_EXPORT_RELATED_ISSUE_URLS[0], SUPPORT_EXPORT_RELATED_ISSUE_URLS[1]],
    records: [],
  };

  // Leave room for the final byte-gap and unavailable-field metadata, then verify
  // the exact serialized object below. The reserve is conservative and bounded.
  const metadataReserve = 8 * 1_024;
  const emptyBundleBytes = bundleBytes(bundle);
  let recordsArrayBytes = 2;
  let byteOmitted = 0;
  let validationOmitted = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const exported = exportRecord(selected[index]!, pseudonymizer);
    if (!exported) {
      validationOmitted += 1;
      continue;
    }
    const recordBytes = Buffer.byteLength(JSON.stringify(exported), "utf8");
    const nextRecordsArrayBytes = recordsArrayBytes + recordBytes + (bundle.records.length > 0 ? 1 : 0);
    if (emptyBundleBytes - 2 + nextRecordsArrayBytes > SUPPORT_EXPORT_MAX_BYTES - metadataReserve) {
      byteOmitted += selected.length - index;
      break;
    }
    bundle.records.push(exported);
    recordsArrayBytes = nextRecordsArrayBytes;
  }
  if (byteOmitted > 0) gaps.push({ kind: "byte_limit", omittedRecordCount: byteOmitted });
  if (validationOmitted > 0) gaps.push({ kind: "record_validation", omittedRecordCount: validationOmitted });

  bundle.unavailableFields = IMPORTANT_AVAILABILITY_FIELDS.filter(field =>
    !bundle.records.some(record => hasField(record, field)));
  bundle.exportCompleteness = gaps.length > 0 ? "partial" : "complete";
  while (bundleBytes(bundle) > SUPPORT_EXPORT_MAX_BYTES && bundle.records.length > 0) {
    bundle.records.pop();
    const byteGap = gaps.find(gap => gap.kind === "byte_limit");
    if (byteGap) byteGap.omittedRecordCount += 1;
    else gaps.push({ kind: "byte_limit", omittedRecordCount: 1 });
    bundle.exportCompleteness = "partial";
    bundle.unavailableFields = IMPORTANT_AVAILABILITY_FIELDS.filter(field =>
      !bundle.records.some(record => hasField(record, field)));
  }
  return bundle;
}
