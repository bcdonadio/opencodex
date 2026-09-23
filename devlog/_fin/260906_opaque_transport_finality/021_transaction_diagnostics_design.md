# Transaction Diagnostics Design

**Status:** Approved for implementation by the explicit 2026-09-06 delegation.

**Purpose:** Preserve bounded, privacy-safe facts needed to diagnose false-positive
policy interruptions and other terminal failures without changing routing, retry,
model selection, authentication, or inference behavior.

**Incident anchors:** [openai/codex#43131](https://github.com/openai/codex/issues/43131)
and [openai/codex#42906](https://github.com/openai/codex/issues/42906). The design
uses only their public/sanitized evidence. It does not retain or reconstruct the
underlying prompts, tool payloads, hidden reasoning, or unrestricted transcripts.

## Decision

Add one optional, versioned `diagnostics` envelope to the canonical
`PersistedUsageEntry` row and bounded attempt/send records beneath the existing
`attempts` array. Keep existing canonical top-level fields where they already
exist; the envelope carries only new evidence and lifecycle structure. The
append-only owner-only `usage.jsonl` remains the sole durable authority.

Three alternatives were considered:

1. Flatten every proposed field onto the usage row. This makes old readers
   tolerant, but creates a sprawling contract and duplicates established fields.
2. Add a versioned envelope to the existing row. This preserves compatibility,
   gives capture bounds one owner, and keeps request, attempt, and send scopes
   explicit. **Selected.**
3. Add a second transaction event log. This can preserve every event, but creates
   split authority, retention synchronization, failure recursion, and more privacy
   surface. Rejected.

The derived `routing-history.sqlite` index continues to retain normalized
`row_json`; it may index selection fields but is never the authority for support
exports. `/api/logs` remains a 2,000-row operational ring. Support exports read
normalized canonical rows directly and apply their own row/window/byte limits.

## Schema and capture contract

`TransactionDiagnosticsV1` is an allowlisted value object. All timestamps are UTC
Unix epoch milliseconds from the proxy wall clock. Durations are non-negative
milliseconds measured from a monotonic clock where the runtime exposes one.
External identifiers are control-character-free strings capped at 256 UTF-8 bytes.
Free-form error text is redacted and capped at 500 UTF-8 bytes. Field names and
enum values are capped at 64 bytes.

The envelope contains:

- `schemaVersion: 1`, `diagnosticCaptureVersion: 1`, proxy-generated
  `transactionId`, `recordKind: "request"`, `correlationSource`, and
  `correlationConfidence`.
- Explicit client identifiers only when present in supported allowlisted request
  metadata or headers: `codexThreadId`, `codexTurnId`, `codexSessionId`,
  `clientRequestId`, and parent/root identifiers. An opaque conversation digest is
  never promoted into one of these fields.
- Runtime/config provenance that the proxy can state itself: product/version,
  Bun version, platform/architecture, endpoint/protocol/transports, and bounded
  configuration revisions computed from already-loaded relevant settings. No
  machine name, path, argv, environment dump, or raw configuration is retained.
- `requestShape`, a bounded scalar/count summary of the parsed request and the
  emitted wire body. It never stores strings from message content, instructions,
  tool schemas/arguments/results, file names/URLs, or encrypted items.
- `lifecycle`, a fixed set of timestamps/durations plus at most 64 compact events.
  Events retain sequence, type, timestamp/elapsed time, source, and selected IDs;
  they never retain frames or payloads. Further events increment
  `droppedDiagnosticEventCount` and set `captureTruncated`.
- `wire`, containing real handshake/HTTP status separately from
  `terminalMappedStatus`, content type, bounded event counters/types, byte counts,
  accepted/delivery/abort facts, and transport terminal provenance.
- `error`, containing only allowlisted structured error fields and approved
  diagnostic response headers. Unknown object keys may be retained as a bounded
  list of names, never their values.
- `fieldAvailability`, a bounded map whose values are `observed`, `derived`,
  `unsupported`, `not_observed`, `redacted`, `truncated`, or `unknown`, with an
  optional fixed provenance label. Absence never means false or zero.
- `persistence`, which states the intended sink/retention/redaction contract. A
  failed append remains non-fatal. Since the failed write cannot report itself to
  the failed sink, live API rows may show `recordPersisted: false`; exports state
  only what canonical rows can prove and never fabricate an error row.

Each `PersistedUsageAttempt` keeps its existing `ordinal` as the canonical
attempt ordinal and gains a proxy-generated `attemptId`, start/end timestamps,
transport and terminal provenance, settings/account snapshots when observed, and
up to 16 `sends`. Each send has `sendId`, `sendOrdinal`, start/end time, transport,
status, retry/recovery reason, account/model/wire snapshots, and explicitly
observed upstream identifiers. When the cap is exceeded, aggregate `sendCount`
remains authoritative and the diagnostics report truncation.

## Field inventory matrix

The status vocabulary is: **durable** (already persisted and normalized), **lost**
(captured today but dropped across a boundary), **capture** (safe and exposed at a
supported boundary), **conditional** (persist only when an explicit provider/client
fact is present), **unavailable** (no supported boundary), and **excluded**
(privacy or semantic risk). Existing canonical names remain top-level; new names
live in `diagnostics`, `requestShape`, `lifecycle`, `wire`, `error`, or attempt/send
records. Every captured value survives normalization, reload, history detail, and
support export unless the matrix explicitly marks it local-only or public-redacted.

### 1. Record identity and provenance

| Fields | Type / meaning | Status, source, persistence/export |
| --- | --- | --- |
| `requestId` | bounded string; logical proxy request | **durable**, proxy-generated; private and public export |
| `schemaVersion`, `diagnosticCaptureVersion` | positive integer schema revisions | **capture**, proxy constants; durable/exported |
| `transactionId` | bounded proxy-generated ID for one logical transaction | **capture**, created with request log context; durable/exported |
| `attemptId`, existing `ordinal` (semantic `attemptOrdinal`) | bounded ID and positive integer physical attempt order | **capture**; durable in attempts/exported |
| `sendId`, `sendOrdinal` | bounded ID and positive integer physical send order | **capture**; durable in bounded sends/exported |
| `eventSequence` | positive integer event order | **capture**; durable in bounded lifecycle events/exported |
| `recordKind` | closed enum, initially `request` | **capture**; durable/exported |
| `recordId` | separate record identifier | **excluded** as a duplicate of canonical `requestId` for v1 |
| `parentRequestId`, `retryOfRequestId`, `replayOfRequestId` | bounded explicit proxy/client linkage IDs | **conditional**; never inferred; durable/exported when observed |
| `correlationSource`, `correlationConfidence` | closed provenance enums | **capture**; durable/exported |
| `fieldAvailability` | bounded field-to-state map | **capture**; durable/exported |

### 2. Codex and response correlation

| Fields | Type / meaning | Status, source, persistence/export |
| --- | --- | --- |
| existing `conversationId` | bounded opaque grouping ID | **durable**; never relabeled as a Codex thread |
| `codexThreadId`, `codexTurnId`, `codexSessionId`, `rootThreadId`, `rootTurnId`, `parentThreadId`, `agentId`, `parentAgentId`, `agentRole` | bounded explicit client metadata/header IDs/role | **conditional** on allowlisted supported metadata; private export; public export consistently pseudonymizes IDs |
| `clientRequestId`, `clientResponseId` | IDs explicitly sent/seen at the client boundary | **conditional**; durable/exported with provenance |
| `upstreamResponseId` | response ID from an explicit `response.created`/terminal response | **capture**; preserve even when failure precedes usage; durable/exported |
| `previousResponseId`, `originalPreviousResponseId`, `forwardedPreviousResponseId` | explicit continuation IDs at caller and wire boundaries | **capture** as IDs only; public export pseudonymizes consistently |
| `upstreamRequestId`, `upstreamConversationId`, `upstreamSessionId`, `upstreamEventId`, `policyEventId`, `traceId`, `spanId`, `parentSpanId` | explicit upstream/header/event IDs | **conditional** on an approved header/event field; never invented |
| `connectionId`, `upstreamConnectionId`, `connectionGeneration`, `requestSequenceOnConnection` | proxy-generated connection scope/order | **capture** where the WS owner exposes it; otherwise `not_observed` |

### 3. Timing and lifecycle

| Fields | Type / meaning | Status, source, persistence/export |
| --- | --- | --- |
| existing `timestamp`, `durationMs`, `firstOutputMs` | UTC start epoch ms; elapsed ms | **durable**; `timestamp` is the semantic `receivedAt`; exported |
| `receivedAt`, `admittedAt`, `routeSelectedAt`, `upstreamRequestSentAt`, `upstreamHeadersAt`, `responseCreatedAt`, `firstEventAt`, `lastEventAt`, `upstreamTerminalAt`, `downstreamTerminalSentAt`, `finalizedAt`, `persistedAt` | UTC epoch ms | **capture** at owning hooks; absent when hook is not reached |
| `queuedAt`, `upstreamConnectStartedAt`, `upstreamConnectedAt`, `handshakeCompletedAt`, `downstreamClosedAt` | UTC epoch ms | **conditional** on transport/queue owner exposing the transition |
| `queueMs`, `connectMs`, `handshakeMs`, `upstreamTimeToFirstEventMs`, `firstOutputMs`, `upstreamDurationMs`, `downstreamDeliveryLagMs`, `finalizationLagMs`, `persistenceLagMs`, `idleBeforeFailureMs` | non-negative monotonic elapsed ms | **capture/conditional** from observed transition pairs; listed in `derivedFields` |
| `timestampSource`, `derivedFields`, `clockAnomaly` | fixed source, bounded field list, anomaly boolean | **capture**; durable/exported |

### 4. Client, runtime, and configuration provenance

| Fields | Type / meaning | Status, source, persistence/export |
| --- | --- | --- |
| `inboundProtocol` | closed wire enum | **durable** but currently lost on reload; repair projection |
| `inboundTransport`, `upstreamTransport` | closed `http`/`websocket`/`mixed` evidence | **capture**; reuse the already-proven downstream transport slice; durable/exported |
| `clientProduct`, `clientVersion`, `codexCoreVersion`, `desktopVersion`, `originator` | bounded explicit client facts | **conditional** on approved headers/metadata; no user-agent dump |
| `upstreamProtocol`, `adapterName`, `protocolVersion` | closed/bounded route facts | **capture** from selected adapter/protocol |
| `proxyVersion`, `runtimeName`, `runtimeVersion`, `osPlatform`, `architecture` | proxy self-provenance | **capture**; public export retains product/runtime scalars |
| `proxyCommit`, `proxyBuildId`, `proxyInstanceId`, `osVersion`, `adapterVersion`, `configRevision`, `routeConfigRevision`, `modelCatalogRevision`, `relevantFeatureFlags`, `diagnosticMode`, `proxyRestartGeneration` | bounded explicit runtime/config facts | **conditional** when the runtime has a stable source; no path/env/argv inference |

### 5. Model, routing, reasoning, and tier

| Fields | Type / meaning | Status, source, persistence/export |
| --- | --- | --- |
| existing `provider`, `requestedAlias`, `requestedModel`, `resolvedModel`, `model`, `routeDecision`, `shadowCallRewrittenFrom`, `requestedEffort`, `effectiveEffort`, `reasoningWireField`, `reasoningWireValue`, tier/speed fields and `tierOutcome` | bounded route, caller, wire, response facts | **durable**; preserve existing names and provenance |
| `forwardedModel` | model value in actual emitted body | **capture** per send; durable/exported |
| `responseModel`, `responseEffort` | explicit response metadata | **conditional**; never inferred from requested/selected values |
| `routeKind`, `routeDecisionId`, `selectedCandidate`, `fallbackReason`, `rewriteReason` | projections of the existing route trace/recovery facts | **durable/conditional** through canonical trace; export may present a derived view without duplicating JSONL fields |
| `settingsRevision`, `settingsUpdatedAt`, `settingsAppliedAt`, `requestSettingsRevision` | bounded revision/timestamps of relevant loaded settings | **capture** when a stable config snapshot can be computed; never claims a UI event changed an in-flight request |
| `modelSwitchRequested`, `modelSwitchApplied`, `modelSwitchEffectiveFromRequestId` | explicit settings-change facts | **unavailable** in v1 absent a durable settings event source; report as unsupported/not observed |

### 6. Authentication and access metadata

| Fields | Type / meaning | Status, source, persistence/export |
| --- | --- | --- |
| existing `admissionKind`, `accountLogLabel`, `affinity` | closed admission and installation-local pseudonymous account evidence | **durable/lost**; repair reload and persist `affinity`; public export re-pseudonymizes |
| `authMode`, `accountPseudonym`, `accountSelectionSource`, `accountAffinity`, `accountChangedBetweenAttempts`, `accountPoolSelectionReason` | closed/bounded observed account-selection facts | **capture/conditional** from legitimate route selection; no raw account IDs |
| `subscriptionPlan`, `entitlementSource`, `entitlementObservedAt`, `cyberAccessStatus`, `cyberAccessProgram`, `modelAccessStatus`, `authRefreshOccurred`, `authRefreshResult` | explicit provider access facts | **conditional** only when the legitimate route directly exposes them; otherwise `unknown` |

### 7. Request shape and retained context

| Fields | Type / meaning | Status, source, persistence/export |
| --- | --- | --- |
| `requestBytes`, `forwardedRequestBytes`, all item/tool/media/encrypted/reasoning/conversation counts, `attachmentBytes`, `toolResultBytes`, `largestToolResultBytes` | non-negative counts/bytes from a bounded structural walker | **capture**; no content, schemas, paths, names, URLs, or hashes |
| `contextWindowTokens`, `maxOutputTokens`, existing per-attempt `inputTokenEstimate`, `tokenEstimateMethod`, `contextUsageRatioEstimate` | non-negative token scalars and bounded method label | **capture/conditional**; estimates are labeled and never billing facts |
| `previousResponseUsed`, `continuationMode`, `deltaInputCount`, `reconstructedInputCount`, `replayedItemCount`, `locallyInjectedItemCounts`, `contextTransformationKinds`, `droppedItemCounts`, `truncatedItemCounts`, `compactionOccurred`, `compactionCount`, `lastCompactionAt` | booleans/counts/closed transformation names | **capture/conditional** where transformation owners already know the fact |
| `toolChoiceMode`, `parallelToolCalls`, `streamingRequested`, `storeRequested`, `truncationMode` | bounded scalar request options | **capture** without retaining request content |

### 8. Wire and stream evidence

| Fields | Type / meaning | Status, source, persistence/export |
| --- | --- | --- |
| existing `status`, `terminalStatus`, `closeReason`, `transportPhase`, `terminalSource`, `localTerminalReason` | mapped status and terminal facts | **durable/lost**; persist all outcomes and repair reload |
| `endpointClass`, `upstreamHostname`, `method` | closed endpoint/host class and method | **capture**; never URL/query/path text |
| `httpStatus`, `websocketHandshakeStatus`, `terminalMappedStatus` | integer status values with separate provenance | **capture/conditional**; never call a stream terminal mapped 400 a handshake 400 |
| `upstreamContentType`, `protocolEventType`, `terminalEventType`, `lastEventType`, `lastEventSequence`, `lastOutputKind`, `outputItemCountsByType`, `streamEventCount` | bounded allowlisted event/type counters | **capture**; no frames or output content |
| `bytesReceived`, `bytesForwarded`, `outputDeliveredBeforeFailure`, `upstreamRequestAccepted`, `streamAborted`, `connectionReused` | byte counts/booleans | **capture/conditional** at transport owners |
| `websocketCloseCode`, `websocketCloseReason`, `closedBy`, `connectionAgeMs`, `reconnectCount`, `heartbeatTimeout`, `idleTimeoutMs`, `bodyStallMs`, `bodyOverflowBytes` | close/timeout evidence | **conditional**; reason sanitized/capped; absent when not exposed |

### 9. Policy/error/failure details

| Fields | Type / meaning | Status, source, persistence/export |
| --- | --- | --- |
| existing `errorCode`, `upstreamError`, `terminalStatus`, `closeReason` | classified code and bounded redacted message | **durable**; normalize defensively even for direct log callers |
| `upstreamErrorCode`, `errorType`, `errorParam`, `errorMessage`, `retryable`, `retryAfterMs`, `incompleteReason`, `contentFilterResult`, `errorEnvelopeSchema`, `errorMessageTruncated`, `unknownErrorFieldNames` | allowlisted structured provider error evidence | **capture/conditional**; unknown values excluded, names bounded |
| `refusalCategory`, `policyRuleId`, `policyStage`, `policyDecisionSource` | explicit provider policy facts | **conditional** only; never derive from message/model/plan |
| `errorOrigin` | closed `client`/`proxy`/`transport`/`upstream` source | **capture** |
| `requestIdHeader`, `upstreamTraceHeaders` | approved allowlisted ID/version/rate-limit header values | **conditional**; never dump headers |

### 10. Attempts, resends, fallback, and recovery

| Fields | Type / meaning | Status, source, persistence/export |
| --- | --- | --- |
| existing `attempts`, `ordinal`, `status`, `durationMs`, `sendCount`, `recoveryKinds`, account/model/adapter/reasoning/tier/usage fields | attempt facts | **durable** |
| `attemptStartedAt`, `attemptEndedAt`, `attemptStatus`, bounded `sends`, `retryDelayMs`, `retryDecision`, `retryBudgetRemaining`, `recoveryReason` | per-attempt/send lifecycle | **capture/conditional**; `attemptStatus` is represented by canonical existing `status` to avoid a duplicate |
| fallback from/to provider/model, `policyFallbackAttempted`, `policyFallbackOutcome`, `previousResponseRewriteApplied`, `resumeMode`, `stateRestored`, `stateRestoreSource` | bounded recovery facts | **capture/conditional** from existing recovery owners |
| existing `locallyAnswered`, plus `upstreamCallMade` | booleans | **durable/capture**; zero sends remain explicit |
| `correlationMismatch`, `responseIdMismatch`, `duplicateTerminalSuppressed`, `cancellationSource`, `cancellationReason` | bounded correlation/terminal facts | **capture/conditional**; cancellation reason sanitized |

### 11. Usage and limits

| Fields | Type / meaning | Status, source, persistence/export |
| --- | --- | --- |
| existing `usageStatus`, token counters and totals | provider-reported or explicitly estimated token facts | **durable**; estimates stay labeled |
| `usageSource`, `usageReportedAt`, `usagePartial`, `usageMissingReason`, `lastKnownUsageResponseId` | bounded usage provenance/completeness | **capture/conditional**; failed rows never borrow prior request totals |
| `billedUsageSource` | explicit billing provenance | **unavailable** unless provider explicitly supplies it; never guessed |
| request/token/account-window limits and reset fields, `rateLimitReachedType`, `spendControlReached`, `quotaErrorCode` | provider-reported numeric/enum limit facts | **conditional** on legitimate route metadata; unknown remains unknown |

### 12. Persistence, capture completeness, and support export

| Fields | Type / meaning | Status, source, persistence/export |
| --- | --- | --- |
| `logSink`, `recordPersisted`, `persistenceErrorCode`, `droppedDiagnosticEventCount`, `captureTruncated`, `truncationReason`, `redactionApplied`, `redactionVersion`, `retentionClass`, `expiresAt` | bounded capture/persistence facts | **capture/conditional**; write failures never recurse or alter inference |
| `exportSchemaVersion`, `exportGeneratedAt`, `exportWindowStart`, `exportWindowEnd`, `exportSelectionIds`, `exportCompleteness`, `unavailableFields`, `logCoverageStart`, `logCoverageEnd`, `serviceRestartWithinWindow`, `relatedIssueUrls` | support bundle header/coverage facts | **capture** at export generation; related URLs must be explicit approved issue URLs |

## Privacy and public export

Private management/history views may show the existing installation-local
`accountLogLabel` and explicitly observed local correlation IDs. Public support
exports use a random per-export key to consistently re-pseudonymize account,
thread, turn, session, agent, conversation, response, connection, trace, and span
identifiers. Proxy request/transaction/attempt/send IDs remain because they are
needed to correlate the bundle itself and reveal no account identity.

Exports are constructed from an allowlist rather than from object spreading. The
generator accepts either at most 32 selected request IDs or a time window no wider
than 24 hours, emits at most 2,000 records and 8 MiB of JSON, and reports every
selection/truncation gap. It never reads another file, follows a path supplied by
the caller, publishes data, or sends data to a third party.

## User surfaces

- `GET /api/transaction-diagnostics/export` accepts repeated `requestId` values or
  bounded `from`/`to` epoch-millisecond parameters and returns the sanitized bundle.
- `ocx logs export --request <id>` (repeatable) or `--from <ms> --to <ms>` prints
  JSON to stdout. `--out <path>` is an explicit local write and refuses replacement
  unless `--force` is present.
- The Logs detail dialog adds a compact Diagnostics section and an explicit
  “Export support bundle” download action for the selected request. The normal log
  table remains unchanged.
- Public docs explain source authority, field availability, redaction, bounds,
  status provenance, and the facts OpenAI does not expose.

## Verification

Synthetic tests cover HTTP JSON, SSE, and WebSocket success/failure; created then
policy failure before usage; missing response/usage IDs; multiple requests on one
WebSocket; HTTP handshake versus stream/synthetic terminal; retries/resends and
settings/model/account changes; cancellation/disconnect/incomplete; duplicate and
out-of-order terminals; old-row normalization and reload; adversarial metadata;
redaction and export bounds; and logging failure isolation. No test intentionally
triggers a live policy decision, and no production service is stopped or replaced.
