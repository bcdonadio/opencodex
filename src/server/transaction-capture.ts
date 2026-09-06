import {
  beginDiagnosticSend, createDiagnosticAttemptId, createTransactionDiagnostics, finishDiagnosticSend,
  normalizeTransactionDiagnostics, recordDiagnosticEvent, observeDiagnosticIdentifier,
  MAX_DIAGNOSTIC_SENDS,
  type DiagnosticEventTypeV1, type DiagnosticSendV1, type TransactionDiagnosticsV1,
} from "../diagnostics/transaction";
import type { RequestLogContext } from "./request-log";
import type { TransportObservation } from "./responses/fetch-helpers";
import { httpStatusFromTerminalError } from "../lib/errors";
import { version as proxyVersion } from "../../package.json";
import { observeDecodedRequestBody } from "./request-decompress";

const clocks = new WeakMap<TransactionDiagnosticsV1, { start: number; output?: number; terminal?: number; sent?: number; event?: number; firstEvent?: number; connect?: number; finalized?: number; lastSend?: DiagnosticSendV1 }>();
const sendOwners = new WeakMap<object, { sendCount: number; sends?: DiagnosticSendV1[] }>();
const activeSends = new WeakMap<object, DiagnosticSendV1>();
const sendState = new WeakMap<DiagnosticSendV1, { responseId?: string; terminalType?: string; terminalObserver?: object; directTypes: Set<string>; syntheticTypes: Set<string> }>();
const requestShapes = new WeakSet<RequestLogContext>();

/** Diagnostics never share exception handling with dispatch/admission. */
export function captureSafely(action: () => void): void { try { action(); } catch { /* optional observation */ } }

function diagnostics(ctx: RequestLogContext, requestId = "request", receivedAt = Date.now()): TransactionDiagnosticsV1 {
  if (!ctx.diagnostics) {
    ctx.diagnostics = createTransactionDiagnostics({ requestId, receivedAt, proxyVersion });
    recordDiagnosticEvent(ctx.diagnostics, { type: "request.received", at: receivedAt, source: "proxy", elapsedMs: 0 });
    for (const field of ["modelSwitchRequested", "modelSwitchApplied", "modelSwitchEffectiveFromRequestId",
      "settingsUpdatedAt", "settingsAppliedAt", "proxyCommit", "proxyBuildId", "modelCatalogRevision"]) {
      ctx.diagnostics.fieldAvailability[field] = { status: "unsupported", source: "proxy" };
    }
    for (const field of ["subscriptionPlan", "entitlementSource", "cyberAccessStatus", "cyberAccessProgram",
      "modelAccessStatus", "policyEventId", "policyRuleId", "billedUsageSource"]) {
      ctx.diagnostics.fieldAvailability[field] = { status: "unknown", source: "upstream" };
    }
  }
  if (!clocks.has(ctx.diagnostics)) clocks.set(ctx.diagnostics, { start: performance.now() });
  return ctx.diagnostics;
}

function derived(d: TransactionDiagnosticsV1, field: string, end: number, start?: number): void {
  if (start === undefined) return;
  d[field] = Math.max(0, end - start);
  d.derivedFields = [...new Set([...(Array.isArray(d.derivedFields) ? d.derivedFields as string[] : []), field])];
  d.fieldAvailability[field] = { status: "derived", source: "derived" };
}

/** Called when a handler has selected its route; the send hook refreshes snapshots. */
export function recordSelectedRoute(ctx: RequestLogContext): void {
  captureSafely(() => {
    const d = diagnostics(ctx);
    if (d.routeSelectedAt === undefined) {
      d.routeSelectedAt = Date.now();
      recordDiagnosticEvent(d, { type: "route.selected", at: Date.now(), source: "proxy" });
    }
    d.adapterName = ctx.providerAdapter ?? ctx.activeAttempt?.adapter;
    const protocols: Record<string, string> = { "openai-responses": "responses", "openai-chat": "chat", anthropic: "messages", gemini: "gemini" };
    d.upstreamProtocol = protocols[String(d.adapterName)];
    if (d.upstreamProtocol) d.fieldAvailability.upstreamProtocol = { status: "observed", source: "adapter" };
    if (!d.upstreamProtocol) d.fieldAvailability.upstreamProtocol = { status: "not_observed", source: "adapter" };
    clean(ctx);
  });
}

export function recordReconstructedContext(ctx: RequestLogContext, body: unknown, replayedItems: number): void {
  captureSafely(() => {
    if (!body || typeof body !== "object") return;
    const input = (body as { input?: unknown }).input;
    const d = diagnostics(ctx);
    d.reconstructedInputCount = Array.isArray(input) ? input.length : typeof input === "string" ? 1 : 0;
    d.replayedItemCount = replayedItems;
    if (replayedItems > 0) {
      d.continuationMode = "local_replay";
      d.contextTransformationKinds = ["previous_response_replay"];
    }
    clean(ctx);
  });
}

export function recordContextEstimate(ctx: RequestLogContext, contextWindow?: number): void {
  captureSafely(() => {
    const d = diagnostics(ctx);
    if (contextWindow !== undefined) d.contextWindowTokens = contextWindow;
    else d.fieldAvailability.contextWindowTokens = { status: "not_observed", source: "adapter" };
    const estimate = ctx.usageLogInputTokens ?? ctx.activeAttempt?.inputTokenEstimate;
    if (typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0) {
      d.tokenEstimateMethod = "adapter_input_estimate";
      if (contextWindow && contextWindow > 0) {
        d.contextUsageRatioEstimate = estimate / contextWindow;
        d.fieldAvailability.contextUsageRatioEstimate = { status: "derived", source: "derived" };
      }
    }
    clean(ctx);
  });
}

function activeSend(ctx: RequestLogContext): DiagnosticSendV1 | undefined {
  return ctx.activeAttempt ? activeSends.get(ctx.activeAttempt) : undefined;
}

function identifier(d: TransactionDiagnosticsV1, field: string, raw: unknown, source: "client" | "upstream", first = false): string | undefined {
  const result = observeDiagnosticIdentifier(raw);
  if (result.state === "excluded") return undefined;
  if (!first || d[field] === undefined) {
    d.fieldAvailability[field] = { status: result.state, source };
    if (result.value) d[field] = result.value;
    else delete d[field];
  }
  if (result.state === "truncated") d.captureTruncated = true;
  if (result.state === "redacted") d.redactionApplied = true;
  if (result.value) { d.correlationSource = "mixed"; d.correlationConfidence = "direct"; }
  return result.value;
}

export function finishAttemptDiagnostics(attempt: object, status: number): void {
  captureSafely(() => {
    const send = activeSends.get(attempt);
    if (send) finishDiagnosticSend(send, { endedAt: Date.now(), status });
  });
}

function clean(ctx: RequestLogContext): void {
  const normalized = normalizeTransactionDiagnostics(ctx.diagnostics);
  if (normalized && ctx.diagnostics) {
    // Keep shared combo request identity stable while replacing only allowlisted data.
    for (const key of Object.keys(ctx.diagnostics)) delete ctx.diagnostics[key];
    Object.assign(ctx.diagnostics, normalized);
  }
}

export function observeRequestTransport(ctx: RequestLogContext, transport: "http" | "websocket",
  req?: Request, requestId?: string, start?: number, connectionId?: string, sequence?: number): void {
  captureSafely(() => {
    const d = diagnostics(ctx, requestId, start);
    ctx.inboundTransport = transport;
    d.inboundTransport = transport;
    d.inboundProtocol = ctx.inboundProtocol;
    if (ctx.admissionKind && d.admittedAt === undefined) {
      d.admittedAt = Date.now();
      recordDiagnosticEvent(d, { type: "request.admitted", at: Date.now(), source: "proxy" });
    }
    d.method = req?.method;
    if (req) {
      observeDecodedRequestBody(req, (body, bytes) => recordRequestShape(ctx, body, bytes));
      const path = new URL(req.url).pathname;
      d.endpointClass = path.endsWith("/compact") ? "compact" : path.includes("images") ? "images"
        : path.includes("search") ? "search" : path.includes("live") ? "live"
          : path.includes("messages") ? "messages" : path.includes("chat") ? "chat" : "responses";
      d.originator = req.headers.get("originator");
      for (const [header, field] of [["x-client-request-id", "clientRequestId"], ["x-request-id", "clientRequestId"], ["x-codex-turn-id", "codexTurnId"],
        ["thread-id", "codexThreadId"], ["x-codex-thread-id", "codexThreadId"], ["session_id", "codexSessionId"]]) {
        identifier(d, field!, req.headers.get(header!), "client");
      }
    }
    if (connectionId) d.connectionId = connectionId;
    if (sequence !== undefined) d.requestSequenceOnConnection = sequence;
    d.runtimeName = "bun";
    d.runtimeVersion = Bun.version;
    d.osPlatform = process.platform;
    d.architecture = process.arch;
    clean(ctx);
  });
}

/** Bounded structural observation: never retain content, tool schemas or media references. */
export function recordRequestShape(ctx: RequestLogContext, body: unknown, bytes?: number, forwarded = false): void {
  captureSafely(() => {
    if (!forwarded && requestShapes.has(ctx)) return;
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    if (!forwarded) requestShapes.add(ctx);
    const b = body as Record<string, unknown>;
    const d = diagnostics(ctx);
    if (bytes !== undefined) d[forwarded ? "forwardedRequestBytes" : "requestBytes"] = bytes;
    const previous = identifier(d, forwarded ? "forwardedPreviousResponseId" : "previousResponseId", b.previous_response_id, "client");
    if (forwarded) {
      if (previous) d.forwardedPreviousResponseId = previous;
      d.forwardedModel = b.model;
      if (d.originalPreviousResponseId !== undefined) {
        d.previousResponseRewriteApplied = d.originalPreviousResponseId !== previous;
        d.fieldAvailability.previousResponseRewriteApplied = { status: "derived", source: "derived" };
      }
    } else {
      identifier(d, "originalPreviousResponseId", b.previous_response_id, "client");
      d.previousResponseUsed = Boolean(previous);
      const metadata = b.client_metadata;
      if (metadata && typeof metadata === "object") {
        for (const [key, field] of [["thread_id", "codexThreadId"], ["turn_id", "codexTurnId"], ["session_id", "codexSessionId"]]) {
          identifier(d, field!, (metadata as Record<string, unknown>)[key!], "client");
        }
      }
      const items = Array.isArray(b.input) ? b.input : Array.isArray(b.messages) ? b.messages : [];
      d.inputItemCount = typeof b.input === "string" ? 1 : items.length;
      d.conversationItemCount = d.inputItemCount;
      d.deltaInputCount = d.inputItemCount;
      d.continuationMode = previous ? "previous_response" : "explicit_input";
      d.toolDefinitionCount = Array.isArray(b.tools) ? b.tools.length : 0;
      let messages = 0, calls = 0, results = 0, reasoning = 0, images = 0, audio = 0, files = 0, encrypted = 0;
      let remaining = 2048;
      let toolBytes = 0, largestToolBytes = 0, toolBytesComplete = true;
      for (const item of items.slice(0, 1024)) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "message" || item.role) messages++;
        if (item.type === "function_call" || item.type === "custom_tool_call") calls++;
        if (Array.isArray(item.tool_calls)) calls += item.tool_calls.length;
        if (item.type === "function_call_output" || item.type === "custom_tool_call_output" || item.role === "tool") results++;
        if (item.type === "function_call_output" || item.type === "custom_tool_call_output" || item.role === "tool") {
          const value = item.output ?? item.content;
          if (typeof value === "string" && value.length <= 1024 * 1024 - toolBytes) {
            const length = Buffer.byteLength(value); toolBytes += length; largestToolBytes = Math.max(largestToolBytes, length);
          } else toolBytesComplete = false;
        }
        if (item.type === "reasoning") reasoning++;
        if (item.encrypted_content !== undefined) encrypted++;
        if (Array.isArray(item.content)) for (const part of item.content) {
          if (--remaining < 0) break;
          if (!part || typeof part !== "object") continue;
          if (part.type === "input_image" || part.type === "image_url") images++;
          if (part.type === "input_audio" || part.type === "audio") audio++;
          if (part.type === "input_file" || part.type === "file") files++;
        }
      }
      d.messageCount = messages; d.toolCallCount = calls; d.toolResultCount = results; d.reasoningItemCount = reasoning;
      d.imageCount = images; d.audioCount = audio; d.fileCount = files; d.encryptedItemCount = encrypted;
      if (toolBytesComplete && items.length <= 1024) {
        d.toolResultBytes = toolBytes; d.largestToolResultBytes = largestToolBytes;
      } else {
        d.fieldAvailability.toolResultBytes = { status: "not_observed", source: "client" };
        d.fieldAvailability.largestToolResultBytes = { status: "not_observed", source: "client" };
      }
      d.fieldAvailability.attachmentBytes = { status: "not_observed", source: "client" };
      if (remaining < 0) { d.captureTruncated = true; d.fieldAvailability.imageCount = { status: "truncated", source: "client" }; }
      if (items.length > 1024) {
        d.captureTruncated = true;
        for (const field of ["messageCount", "toolCallCount", "toolResultCount", "reasoningItemCount", "imageCount", "audioCount", "fileCount", "encryptedItemCount"]) {
          d.fieldAvailability[field] = { status: "truncated", source: "client" };
        }
      }
      d.streamingRequested = b.stream; d.storeRequested = b.store; d.parallelToolCalls = b.parallel_tool_calls;
      d.maxOutputTokens = b.max_output_tokens ?? b.max_tokens;
      d.truncationMode = b.truncation;
      d.toolChoiceMode = typeof b.tool_choice === "string" ? b.tool_choice : undefined;
    }
    clean(ctx);
  });
}

export function recordForwardedRequest(ctx: RequestLogContext, transport: "http" | "websocket", body?: unknown): void {
  captureSafely(() => {
    recordSelectedRoute(ctx);
    const d = diagnostics(ctx);
    const clock = clocks.get(d)!;
    if (clock.lastSend) finishDiagnosticSend(clock.lastSend, { endedAt: clock.lastSend.endedAt ?? Date.now(),
      ...(clock.lastSend.status === undefined && clock.lastSend.httpStatus !== undefined ? { status: clock.lastSend.httpStatus } : {}) });
    delete clock.terminal;
    clock.sent = performance.now();
    delete clock.firstEvent;
    delete clock.event;
    for (const field of ["upstreamTimeToFirstEventMs", "upstreamDurationMs", "idleBeforeFailureMs"]) delete d[field];
    delete d.responseIdMismatch;
    delete d.duplicateTerminalSuppressed;
    delete d.terminalEventType;
    ctx.upstreamTransport = ctx.upstreamTransport && ctx.upstreamTransport !== transport ? "mixed" : transport;
    d.upstreamTransport = ctx.upstreamTransport;
    d.upstreamCallMade = true;
    d.upstreamRequestSentAt = Date.now();
    d.requestSettingsRevision = `settings_${Bun.hash(JSON.stringify([
      ctx.provider, ctx.model, ctx.accountLogLabel, ctx.effectiveEffort, ctx.requestedServiceTier, transport,
    ])).toString(16)}`;
    d.fieldAvailability.requestSettingsRevision = { status: "derived", source: "derived" };
    if (!ctx.activeAttempt) {
      ctx.activeAttempt = {
        ordinal: (ctx.attempts?.length ?? 0) + 1, attemptId: createDiagnosticAttemptId(), attemptStartedAt: Date.now(),
        provider: ctx.provider, model: ctx.model, adapter: ctx.providerAdapter ?? ctx.provider,
        status: 0, durationMs: 0, sendCount: 0, recoveryKinds: [], usageStatus: "unreported",
      };
      ctx.activeAttemptStartedAt = Date.now();
      (ctx.attempts ??= []).push(ctx.activeAttempt);
    }
    const attempt = ctx.activeAttempt;
    if (attempt) {
      attempt.upstreamTransport = attempt.upstreamTransport && attempt.upstreamTransport !== transport ? "mixed" : transport;
      let owner = sendOwners.get(attempt);
      if (!owner) { owner = { sendCount: 0 }; sendOwners.set(attempt, owner); }
      const send = beginDiagnosticSend(owner, {
        startedAt: Date.now(), upstreamTransport: transport, endpointClass: d.endpointClass as string,
        provider: ctx.provider, model: ctx.model, adapter: ctx.providerAdapter,
        accountLogLabel: ctx.accountLogLabel, requestedEffort: ctx.requestedEffort,
        effectiveEffort: ctx.effectiveEffort, reasoningWireField: ctx.reasoningWireField,
        reasoningWireValue: ctx.reasoningWireValue, serviceTier: ctx.requestedServiceTier,
        recoveryReason: attempt.recoveryKinds.at(-1),
      });
      attempt.sends = owner.sends;
      attempt.sendCount = owner.sendCount;
      if (owner.sendCount > MAX_DIAGNOSTIC_SENDS) { d.captureTruncated = true; d.fieldAvailability.sends = { status: "truncated", source: "transport" }; }
      activeSends.set(attempt, send);
      sendState.set(send, { directTypes: new Set(), syntheticTypes: new Set() });
      clock.lastSend = send;
    }
    if (typeof body === "string") {
      d.forwardedRequestBytes = Buffer.byteLength(body);
      d.bytesForwarded = Number(d.bytesForwarded ?? 0) + Buffer.byteLength(body);
      if (Buffer.byteLength(body) <= 1024 * 1024) {
        try { recordRequestShape(ctx, JSON.parse(body), Buffer.byteLength(body), true); } catch { /* non-JSON */ }
      } else {
        delete d.forwardedModel;
        d.captureTruncated = true;
        d.fieldAvailability.forwardedModel = { status: "truncated", source: "transport" };
      }
      const send = activeSend(ctx);
      if (send) { send.bytesForwarded = Buffer.byteLength(body); send.forwardedModel = ctx.diagnostics?.forwardedModel as string | undefined; }
    }
    recordDiagnosticEvent(ctx.diagnostics!, { type: "upstream.request.sent", at: Date.now(), source: "transport" });
    clean(ctx);
  });
}

export function recordUpstreamResponse(ctx: RequestLogContext, response: Response, transport: "http" | "websocket" = "http"): void {
  captureSafely(() => {
    const d = diagnostics(ctx);
    if (transport === "http") d.httpStatus = response.status;
    d.upstreamHeadersAt = Date.now();
    d.upstreamContentType = response.headers.get("content-type")?.split(";")[0];
    const id = identifier(d, "upstreamRequestId", response.headers.get("x-request-id") ?? response.headers.get("openai-request-id"), "upstream");
    for (const [header, field] of [["x-ratelimit-limit-requests", "requestLimit"], ["x-ratelimit-limit-tokens", "tokenLimit"]]) {
      const value = response.headers.get(header!);
      if (value !== null && /^\d+(?:\.\d+)?$/.test(value)) d[field!] = Number(value);
    }
    d.upstreamRequestAccepted = response.ok;
    const send = activeSend(ctx);
    if (send) finishDiagnosticSend(send, { endedAt: Date.now(), ...(transport === "http" ? { httpStatus: response.status } : {}),
      upstreamRequestId: id, upstreamRequestAccepted: response.ok });
    recordDiagnosticEvent(d, { type: "upstream.headers.received", at: Date.now(), source: "transport" });
    clean(ctx);
  });
}

const eventTypes = new Set(["response.created", "response.output_item.added", "response.output_text.delta",
  "response.completed", "response.failed", "response.incomplete"]);
const protocolTypes = new Set([...eventTypes, "error", "response.in_progress", "response.output_item.done",
  "response.content_part.added", "response.content_part.done", "response.output_text.done",
  "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.refusal.delta", "response.refusal.done"]);

export function recordProtocolEvent(ctx: RequestLogContext, payload: unknown, bytes = 0, direct = false, fromProxy = false, observer?: object): void {
  captureSafely(() => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, any>;
    const d = diagnostics(ctx);
    const type = typeof p.type === "string" ? p.type : "";
    const send = activeSend(ctx);
    const state = send ? sendState.get(send) : undefined;
    const synthetic = fromProxy || (!direct && ctx.terminalSource === "synthetic");
    // A tee/preflight and its adopted response can inspect the same terminal.
    // Only a repeated terminal at the same observer is a duplicate wire fact.
    if (!synthetic && state?.terminalType === type && state.terminalObserver !== observer
      && (state.terminalObserver !== undefined || observer !== undefined)) return;
    if (!direct && !synthetic && state?.directTypes.has(type)) return;
    if (direct && state && state.directTypes.size < 64 && type.length <= 64) state.directTypes.add(type);
    if (synthetic && state) {
      if (state.syntheticTypes.has(type)) return;
      if (state.syntheticTypes.size < 64 && type.length <= 64) state.syntheticTypes.add(type);
    }
    const response = p.response && typeof p.response === "object" ? p.response : p;
    // Event IDs are not response IDs. Only an explicit response object or JSON
    // response carries its ID here; standalone events use response_id.
    const responseId = synthetic ? undefined : identifier(d, "upstreamResponseId",
      p.response ? response.id : (!type || p.object === "response") ? p.id : p.response_id, "upstream", true);
    const eventId = synthetic ? undefined : identifier(d, "upstreamEventId", p.event_id, "upstream");
    if (responseId && state?.responseId && state.responseId !== responseId) d.responseIdMismatch = true;
    if (responseId && state) state.responseId ??= responseId;
    if (type) {
      d.streamEventCount = Number(d.streamEventCount ?? 0) + 1;
      if (!synthetic) {
        d.firstEventAt ??= Date.now();
        d.lastEventAt = Date.now();
      }
    }
    if (bytes > 0) d.bytesReceived = Number(d.bytesReceived ?? 0) + bytes;
    if (!synthetic && type) {
      d.lastEventType = protocolTypes.has(type) ? type : "unknown";
      d.protocolEventType = d.lastEventType;
      if (Number.isSafeInteger(p.sequence_number) && p.sequence_number >= 0) d.lastEventSequence = p.sequence_number;
    }
    if (!synthetic && type === "response.created") d.upstreamRequestAccepted = true;
    if (response.model) d.responseModel = response.model;
    if (response.reasoning?.effort) d.responseEffort = response.reasoning.effort;
    if (response.usage) { d.usageSource = "upstream"; d.usageReportedAt = Date.now(); if (responseId) d.lastKnownUsageResponseId = responseId; }
    const terminal = ["response.completed", "response.failed", "response.incomplete", "error"].includes(type);
    const clock = clocks.get(d)!;
    const now = performance.now();
    if (!synthetic && type) {
      if (clock.firstEvent === undefined) {
        clock.firstEvent = now;
        derived(d, "upstreamTimeToFirstEventMs", now, clock.sent);
      }
      if (terminal) {
        derived(d, "upstreamDurationMs", now, clock.sent);
        if (type !== "response.completed") derived(d, "idleBeforeFailureMs", now, clock.event ?? clock.sent);
      }
      clock.event = now;
    }
    if (terminal) {
      if (!synthetic && state?.terminalType) d.duplicateTerminalSuppressed = true;
      else {
        if (!synthetic && state) { state.terminalType = type; state.terminalObserver = observer; }
        d.terminalEventType = type; clocks.get(diagnostics(ctx))!.terminal = performance.now();
      }
      if (type !== "response.completed" && clocks.get(d)!.output !== undefined) d.outputDeliveredBeforeFailure = true;
    }
    const error = response.error ?? p.error;
    if (error && typeof error === "object" && !d.errorOrigin) {
      d.errorOrigin = "upstream"; d.upstreamErrorCode = error.code; d.errorType = error.type;
      d.errorEnvelopeSchema = p.response ? "response.error" : "error";
    }
    if (response.incomplete_details && ["max_output_tokens", "content_filter"].includes(response.incomplete_details.reason))
      d.incompleteReason = response.incomplete_details.reason;
    if (type === "response.output_item.added" && p.item?.type) {
      const known = ["message", "reasoning", "function_call", "custom_tool_call", "web_search_call", "image_generation_call"];
      const kind = known.includes(p.item.type) ? p.item.type : "unknown";
      const counts = (d.outputItemCountsByType ?? {}) as Record<string, number>;
      counts[kind] = (counts[kind] ?? 0) + 1; d.outputItemCountsByType = counts;
    }
    if (eventTypes.has(type) || type === "error") recordDiagnosticEvent(d, {
      type: (type === "error" ? "upstream.error" : type) as DiagnosticEventTypeV1,
      at: Date.now(), source: synthetic ? "proxy" : "upstream", responseId, eventId, elapsedMs: performance.now() - clocks.get(diagnostics(ctx))!.start,
    });
    if (send && responseId) send.upstreamResponseId ??= responseId;
    if (send && eventId) send.upstreamEventId = eventId;
    if (send && !synthetic && type === "response.created") send.upstreamRequestAccepted = true;
    if (send && terminal) finishDiagnosticSend(send, { endedAt: Date.now(), status: type === "response.completed" ? 200
      : type === "response.incomplete" ? 502 : httpStatusFromTerminalError(response.error ?? p.error) });
    clean(ctx);
  });
}

export function recordSyntheticTerminal(ctx: RequestLogContext, type: "response.failed" | "response.incomplete"): void {
  recordProtocolEvent(ctx, { type }, 0, false, true);
}

export function recordDeliveredOutput(ctx: RequestLogContext, kind?: string): void {
  captureSafely(() => {
    const d = diagnostics(ctx);
    clocks.get(d)!.output ??= performance.now();
    const known: Record<string, string> = { text: "text", reasoning: "reasoning", tool_call: "tool_call", refusal: "refusal", audio: "audio", image: "image",
      "response.output_text.delta": "text", "response.reasoning_summary_text.delta": "reasoning",
      "response.function_call_arguments.delta": "tool_call", "response.refusal.delta": "refusal" };
    if (kind && Object.hasOwn(known, kind)) d.lastOutputKind = known[kind];
    clean(ctx);
  });
}

/** Called only after the downstream owner accepts the terminal write. */
export function recordDownstreamTerminal(ctx: RequestLogContext): void {
  captureSafely(() => {
    const d = diagnostics(ctx);
    if (d.downstreamTerminalSentAt !== undefined) return;
    d.downstreamTerminalSentAt = Date.now();
    derived(d, "downstreamDeliveryLagMs", performance.now(), clocks.get(d)!.terminal);
    recordDiagnosticEvent(d, { type: "downstream.terminal.sent", at: Date.now(), source: "downstream" });
    clean(ctx);
  });
}

/** Successful append is live evidence only: the completed write cannot encode its end. */
export function diagnosticFinalizedClock(d: TransactionDiagnosticsV1 | undefined): number | undefined {
  return d ? clocks.get(d)?.finalized : undefined;
}

export function recordPersistenceOutcome(d: TransactionDiagnosticsV1 | undefined, success: boolean, started?: number): void {
  captureSafely(() => {
    if (!d) return;
    d.recordPersisted = success;
    d.logSink = "usage.jsonl";
    d.fieldAvailability.recordPersisted = { status: "observed", source: "persistence" };
    if (success) {
      d.persistedAt = Date.now();
      d.fieldAvailability.persistedAt = { status: "observed", source: "persistence" };
      derived(d, "persistenceLagMs", performance.now(), started);
      recordDiagnosticEvent(d, { type: "request.persisted", at: Date.now(), source: "proxy" });
    } else d.persistenceErrorCode = "append_failed";
  });
}

export function recordReceivedBytes(ctx: RequestLogContext, bytes: number): void {
  captureSafely(() => {
    const send = activeSend(ctx);
    if (send && (sendState.get(send)?.directTypes.size ?? 0) > 0) return; // Native WS owner already measured the real frames.
    const d = diagnostics(ctx);
    d.bytesReceived = Number(d.bytesReceived ?? 0) + bytes;
    if (send) send.bytesReceived = Number(send.bytesReceived ?? 0) + bytes;
  });
}

export function finalizeDiagnostics(ctx: RequestLogContext, status: number, requestId: string, start: number, terminal = false): void {
  captureSafely(() => {
    const d = diagnostics(ctx, requestId, start);
    if (ctx.activeAttempt) {
      const owner = sendOwners.get(ctx.activeAttempt);
      if (owner) ctx.activeAttempt.sendCount = owner.sendCount;
    }
    d.terminalMappedStatus = status;
    d.terminalSource = ctx.terminalSource ?? (d.terminalEventType ? "upstream" : undefined);
    d.transportPhase = ctx.transportPhase;
    if (ctx.activeAttempt?.streamAborted) d.streamAborted = true;
    d.finalizedAt = Date.now();
    // A positive legacy send count without an observed send is incomplete evidence.
    if (d.upstreamCallMade !== true) {
      if (!(ctx.attempts ?? []).some(attempt => attempt.sendCount > 0) && !(ctx.activeAttempt?.sendCount)) d.upstreamCallMade = false;
      else d.fieldAvailability.upstreamCallMade = { status: "not_observed", source: "transport" };
    }
    d.logSink = "usage.jsonl";
    d.usageSource ??= ctx.usageFromBridge ? "adapter" : ctx.usage ? "upstream" : undefined;
    if (!ctx.usage) d.usageMissingReason = "not_reported";
    d.fieldAvailability.terminalMappedStatus = { status: "derived", source: "derived" };
    if (terminal && d.downstreamTerminalSentAt === undefined)
      d.fieldAvailability.downstreamTerminalSentAt = { status: "not_observed", source: "transport" };
    if (status === 499) { d.streamAborted = true; d.cancellationReason = "client_cancel"; d.downstreamClosedAt = Date.now();
      recordDiagnosticEvent(d, { type: "downstream.closed", at: Date.now(), source: "downstream" }); }
    const clock = clocks.get(diagnostics(ctx))!;
    if (status >= 400) {
      if (clock.output !== undefined) d.outputDeliveredBeforeFailure = true;
      else { delete d.outputDeliveredBeforeFailure; d.fieldAvailability.outputDeliveredBeforeFailure = { status: "not_observed", source: "transport" }; }
    }
    clock.finalized = performance.now();
    derived(d, "finalizationLagMs", clock.finalized, clock.terminal);
    d.clockAnomaly = Date.now() < Number(d.receivedAt);
    recordDiagnosticEvent(d, { type: "request.finalized", at: Date.now(), source: "proxy", elapsedMs: performance.now() - clock.start });
    const send = activeSend(ctx);
    if (send) finishDiagnosticSend(send, { endedAt: Date.now(), status, streamAborted: status === 499 || d.streamAborted === true });
    clean(ctx);
  });
}

/** Callback-only transport leaf integration; all exceptions terminate here. */
export function transportObserver(ctx: RequestLogContext): (event: TransportObservation) => void {
  return event => captureSafely(() => {
    if (event.kind === "prepared") {
      if (ctx.activeAttempt && !sendOwners.has(ctx.activeAttempt)) sendOwners.set(ctx.activeAttempt, { sendCount: 0 });
      return;
    }
    if (event.kind === "send") recordForwardedRequest(ctx, event.transport, event.body);
    else if (event.kind === "response") recordUpstreamResponse(ctx, event.response, event.transport);
    else if (event.kind === "event") recordProtocolEvent(ctx, event.payload, event.bytes, true);
    else if (event.kind === "stream_failure") {
      const d = diagnostics(ctx);
      d.streamAborted = true;
      d.errorOrigin = "transport";
      d.cancellationReason = event.reason;
      d.cancellationSource = event.reason === "client_cancel" || event.reason === "request_abort" ? "client"
        : event.reason === "owner_cancel" ? "proxy" : "transport";
      if (event.reason === "frame_overflow" || event.reason === "queue_overflow") d.bodyOverflowBytes = event.bytes;
      // A prelude timer is not an idle-between-events timer.
      if (event.reason === "prelude_timeout") d.fieldAvailability.idleTimeoutMs = { status: "not_observed", source: "transport" };
      const send = activeSend(ctx);
      if (send) send.streamAborted = true;
      clean(ctx);
    }
    else {
      const d = diagnostics(ctx);
      if (event.connectionId) d.upstreamConnectionId = event.connectionId;
      if (event.reused !== undefined) d.connectionReused = event.reused;
      if (event.sequence !== undefined) d.upstreamRequestSequenceOnConnection = event.sequence;
      if (event.generation !== undefined) d.connectionGeneration = event.generation;
      if (event.ageMs !== undefined) d.connectionAgeMs = event.ageMs;
      if (event.kind === "mismatch") d.correlationMismatch = true;
      if (event.kind === "connect") {
        clocks.get(d)!.connect = performance.now();
        d.upstreamConnectStartedAt = Date.now();
        recordDiagnosticEvent(d, { type: "upstream.connect.started", at: Date.now(), source: "transport" });
      }
      if (event.kind === "open") {
        d.websocketHandshakeStatus = 101; d.upstreamConnectedAt = Date.now(); d.handshakeCompletedAt = Date.now();
        recordDiagnosticEvent(d, { type: "upstream.connected", at: Date.now(), source: "transport" });
        recordDiagnosticEvent(d, { type: "upstream.handshake.completed", at: Date.now(), source: "transport" });
        derived(d, "connectMs", performance.now(), clocks.get(d)!.connect);
        derived(d, "handshakeMs", performance.now(), clocks.get(d)!.connect);
      }
      if (event.kind === "close") { d.websocketCloseCode = event.code; d.closedBy = "upstream"; recordDiagnosticEvent(d, { type: "upstream.closed", at: Date.now(), source: "transport" }); }
      clean(ctx);
    }
  });
}
