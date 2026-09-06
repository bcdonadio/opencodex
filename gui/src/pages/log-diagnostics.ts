/** Browser-only projection of transaction v1. Keep allowlists aligned with
 * src/diagnostics/transaction.ts; never import its server crypto/redaction runtime. */
export type EvidencePrimitive = string | number | boolean;
export type EvidenceFields = Record<string, EvidencePrimitive>;
export interface LogDiagnostics {
  fields: EvidenceFields;
  events: EvidenceFields[];
  availability: Record<string, { status: string; source?: string }>;
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
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const string = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= 500
  && [...value].every(char => { const point = char.codePointAt(0)!; return point >= 32 && (point < 127 || point > 159); });
const sources = ["client", "proxy", "transport", "upstream", "downstream"];
const availabilityStates = ["observed", "derived", "unsupported", "not_observed", "redacted", "truncated", "unknown"];
const eventTypes = ["request.received", "request.admitted", "route.selected", "upstream.connect.started",
  "upstream.connected", "upstream.handshake.completed", "upstream.request.sent", "upstream.headers.received",
  "response.created", "response.output_item.added", "response.output_text.delta", "response.completed",
  "response.failed", "response.incomplete", "upstream.error", "upstream.closed", "downstream.terminal.sent",
  "downstream.closed", "request.finalized", "request.persisted"];
function project(raw: Record<string, unknown>, strings: readonly string[], numbers: readonly string[], booleans: readonly string[] = []): EvidenceFields {
  const fields: EvidenceFields = {};
  for (const key of strings) if (string(raw[key])) fields[key] = raw[key];
  for (const key of numbers) if (number(raw[key])) fields[key] = raw[key];
  for (const key of booleans) if (typeof raw[key] === "boolean") fields[key] = raw[key];
  return fields;
}
export function parseLogDiagnostics(raw: unknown): LogDiagnostics | undefined {
  if (!object(raw) || raw.schemaVersion !== 1 || raw.diagnosticCaptureVersion !== 1 ||
      raw.recordKind !== "request" || !string(raw.transactionId) || !number(raw.receivedAt) ||
      raw.timestampSource !== "proxy_wall_clock" || raw.retentionClass !== "usage_ledger" ||
      raw.redactionVersion !== 1 || !["proxy", "client", "upstream", "mixed"].includes(String(raw.correlationSource)) ||
      !["direct", "derived", "unknown"].includes(String(raw.correlationConfidence)) ||
      !Array.isArray(raw.events) || !object(raw.fieldAvailability) ||
      !number(raw.droppedDiagnosticEventCount) || typeof raw.captureTruncated !== "boolean" ||
      typeof raw.redactionApplied !== "boolean") return undefined;
  const fields = project(raw,
    [...IDENTIFIER_FIELDS, ...METADATA_FIELDS, ...ERROR_FIELDS, "transactionId", "correlationSource", "correlationConfidence", "timestampSource", "retentionClass"],
    [...NON_NEGATIVE_NUMBER_FIELDS, "schemaVersion", "diagnosticCaptureVersion", "receivedAt", "droppedDiagnosticEventCount", "redactionVersion"],
    [...BOOLEAN_FIELDS, "captureTruncated", "redactionApplied"]);
  const enums: Record<string, string[]> = {
    inboundProtocol: ["responses", "chat", "messages"],
    inboundTransport: ["http", "websocket", "mixed"], upstreamTransport: ["http", "websocket", "mixed"],
    terminalSource: ["upstream", "synthetic"], transportPhase: ["pre_headers", "mid_stream", "terminal_sse"],
  };
  for (const [key, values] of Object.entries(enums)) if (string(raw[key]) && values.includes(raw[key])) fields[key] = raw[key];
  for (const key of STRING_LIST_FIELDS) {
    const values = raw[key];
    if (Array.isArray(values)) values.slice(0, 64).forEach((value, index) => { if (string(value)) fields[`${key}.${index}`] = value; });
  }
  for (const key of COUNTER_MAP_FIELDS) {
    const values = raw[key];
    if (object(values)) for (const [field, value] of Object.entries(values).slice(0, 64)) {
      if (/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(field) && number(value)) fields[`${key}.${field}`] = value;
    }
  }
  const known = new Set([...Object.keys(fields), ...IDENTIFIER_FIELDS, ...METADATA_FIELDS, ...ERROR_FIELDS,
    ...NON_NEGATIVE_NUMBER_FIELDS, ...BOOLEAN_FIELDS, ...STRING_LIST_FIELDS, ...COUNTER_MAP_FIELDS,
    ...Object.keys(enums), "events", "fieldAvailability"]);
  const availability: LogDiagnostics["availability"] = {};
  for (const [key, value] of Object.entries(raw.fieldAvailability).slice(0, 256)) {
    if (!known.has(key) || !object(value) || !availabilityStates.includes(String(value.status))) continue;
    availability[key] = { status: String(value.status) };
    if (string(value.source) && [...sources, "route", "adapter", "derived", "persistence"].includes(value.source)) availability[key].source = value.source;
  }
  const events = raw.events.slice(0, 64).flatMap(value => {
    if (!object(value) || !number(value.eventSequence) || !Number.isInteger(value.eventSequence) || value.eventSequence < 1 ||
      !number(value.at) || !eventTypes.includes(String(value.type)) || !sources.includes(String(value.source))) return [];
    return [project(value, ["type", "source", "responseId", "eventId"], ["eventSequence", "at", "elapsedMs"])];
  });
  return { fields, events, availability };
}
const sendStrings = ["sendId", "upstreamTransport", "endpointClass", "provider", "model", "adapter",
  "accountLogLabel", "forwardedModel", "requestedEffort", "effectiveEffort", "reasoningWireField",
  "serviceTier", "recoveryReason", "retryReason", "upstreamRequestId", "upstreamResponseId", "upstreamEventId"];
const sendNumbers = ["sendOrdinal", "startedAt", "endedAt", "status", "httpStatus", "websocketHandshakeStatus", "bytesForwarded", "bytesReceived"];
export function parseAttemptEvidence(raw: unknown): EvidenceFields[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 64).flatMap(attempt => {
    if (!object(attempt)) return [];
    const parent = project(attempt, ["attemptId", "provider", "model", "adapter"], ["ordinal", "sendCount", "status", "attemptStartedAt", "attemptEndedAt"]);
    if (["http", "websocket", "mixed"].includes(String(attempt.upstreamTransport))) parent.upstreamTransport = String(attempt.upstreamTransport);
    const sends = Array.isArray(attempt.sends) ? attempt.sends.slice(0, 16).flatMap(send => {
      if (!object(send) || !string(send.sendId) || !number(send.sendOrdinal) || !Number.isInteger(send.sendOrdinal) || send.sendOrdinal < 1 || !number(send.startedAt)) return [];
      const fields = project(send, sendStrings, sendNumbers, ["upstreamRequestAccepted", "streamAborted", "connectionReused"]);
      if (string(send.reasoningWireValue) || number(send.reasoningWireValue) || typeof send.reasoningWireValue === "boolean") fields.reasoningWireValue = send.reasoningWireValue;
      return [{ ...parent, ...fields }];
    }) : [];
    return sends.length ? sends : [parent];
  });
}

/** Strip unknown diagnostic data before it reaches either the cache or raw-log view. */
export function sanitizeLogEvidence<T extends { diagnostics?: unknown; attempts?: unknown }>(entry: T): T {
  const parsed = parseLogDiagnostics(entry.diagnostics);
  const result = { ...entry };
  delete result.diagnostics;
  if (parsed) {
    const clean: Record<string, unknown> = { ...parsed.fields, recordKind: "request", events: parsed.events, fieldAvailability: parsed.availability };
    for (const key of STRING_LIST_FIELDS) {
      const members = Object.entries(parsed.fields).filter(([field]) => field.startsWith(`${key}.`));
      if (members.length) clean[key] = members.map(([, value]) => value);
      for (const [field] of members) delete clean[field];
    }
    for (const key of COUNTER_MAP_FIELDS) {
      const members = Object.entries(parsed.fields).filter(([field]) => field.startsWith(`${key}.`));
      if (members.length) clean[key] = Object.fromEntries(members.map(([field, value]) => [field.slice(key.length + 1), value]));
      for (const [field] of members) delete clean[field];
    }
    result.diagnostics = clean;
  }
  if (Array.isArray(entry.attempts)) result.attempts = entry.attempts.map(attempt => {
    if (!object(attempt)) return attempt;
    const copy = { ...attempt };
    delete copy.sends;
    if (Array.isArray(attempt.sends)) copy.sends = parseAttemptEvidence([{ sends: attempt.sends }]);
    return copy;
  });
  return result;
}
