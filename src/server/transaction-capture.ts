import {
  beginDiagnosticSend, createDiagnosticAttemptId, createTransactionDiagnostics, finishDiagnosticSend,
  normalizeTransactionDiagnostics, recordDiagnosticEvent, observeDiagnosticIdentifier,
  MAX_DIAGNOSTIC_SENDS,
  type DiagnosticEventTypeV1, type DiagnosticSendV1, type TransactionDiagnosticsV1,
} from "../diagnostics/transaction";
import type { RequestLogContext } from "./request-log";
import type { TransportObservation } from "./responses/fetch-helpers";
import { httpStatusFromTerminalError } from "../lib/errors";

const clocks = new WeakMap<TransactionDiagnosticsV1, { start: number; output?: number; terminal?: number; lastSend?: DiagnosticSendV1 }>();
const sendOwners = new WeakMap<object, { sendCount: number; sends?: DiagnosticSendV1[] }>();
const activeSends = new WeakMap<object, DiagnosticSendV1>();
const sendState = new WeakMap<DiagnosticSendV1, { responseId?: string; terminalType?: string; terminalObserver?: object; directTypes: Set<string>; syntheticTypes: Set<string> }>();
const requestShapes = new WeakSet<RequestLogContext>();

/** Diagnostics never share exception handling with dispatch/admission. */
export function captureSafely(action: () => void): void { try { action(); } catch { /* optional observation */ } }

function diagnostics(ctx: RequestLogContext, requestId = "request", receivedAt = Date.now()): TransactionDiagnosticsV1 {
  if (!ctx.diagnostics) ctx.diagnostics = createTransactionDiagnostics({ requestId, receivedAt });
  if (!clocks.has(ctx.diagnostics)) clocks.set(ctx.diagnostics, { start: performance.now() });
  return ctx.diagnostics;
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
    d.method = req?.method;
    if (req) {
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
      d.inputItemCount = items.length;
      d.toolDefinitionCount = Array.isArray(b.tools) ? b.tools.length : 0;
      let messages = 0, calls = 0, results = 0, reasoning = 0, images = 0, audio = 0, files = 0, encrypted = 0;
      let remaining = 2048;
      for (const item of items.slice(0, 1024)) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "message" || item.role) messages++;
        if (item.type === "function_call" || item.type === "custom_tool_call") calls++;
        if (item.type === "function_call_output" || item.type === "custom_tool_call_output" || item.role === "tool") results++;
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
      if (remaining < 0) { d.captureTruncated = true; d.fieldAvailability.imageCount = { status: "truncated", source: "client" }; }
      if (items.length > 1024) { d.captureTruncated = true; d.fieldAvailability.inputItemCount = { status: "truncated", source: "client" }; }
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
    const d = diagnostics(ctx);
    const clock = clocks.get(d)!;
    if (clock.lastSend) finishDiagnosticSend(clock.lastSend, { endedAt: clock.lastSend.endedAt ?? Date.now(),
      ...(clock.lastSend.status === undefined && clock.lastSend.httpStatus !== undefined ? { status: clock.lastSend.httpStatus } : {}) });
    delete clock.terminal;
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
    const responseId = synthetic ? undefined : identifier(d, "upstreamResponseId", response.id ?? p.response_id, "upstream", true);
    if (responseId && state?.responseId && state.responseId !== responseId) d.responseIdMismatch = true;
    if (responseId && state) state.responseId ??= responseId;
    if (type) {
      d.streamEventCount = Number(d.streamEventCount ?? 0) + 1;
      if (d.streamEventCount === 1) d.firstEventAt = Date.now();
      d.lastEventAt = Date.now();
    }
    if (bytes > 0) d.bytesReceived = Number(d.bytesReceived ?? 0) + bytes;
    d.lastEventType = type;
    if (typeof p.sequence_number === "number") d.lastEventSequence = p.sequence_number;
    if (response.model) d.responseModel = response.model;
    if (response.reasoning?.effort) d.responseEffort = response.reasoning.effort;
    if (response.usage) { d.usageSource = "upstream"; d.usageReportedAt = Date.now(); if (responseId) d.lastKnownUsageResponseId = responseId; }
    const terminal = ["response.completed", "response.failed", "response.incomplete", "error"].includes(type);
    if (terminal) {
      if (!synthetic && state?.terminalType) d.duplicateTerminalSuppressed = true;
      else {
        if (!synthetic && state) { state.terminalType = type; state.terminalObserver = observer; }
        d.terminalEventType = type; clocks.get(diagnostics(ctx))!.terminal = performance.now();
      }
      if (type !== "response.completed") d.outputDeliveredBeforeFailure = clocks.get(diagnostics(ctx))!.output !== undefined;
    }
    const error = response.error ?? p.error;
    if (error && typeof error === "object" && !d.errorOrigin) {
      d.errorOrigin = "upstream"; d.upstreamErrorCode = error.code; d.errorType = error.type;
      d.errorParam = error.param; d.errorMessage = error.message; d.errorEnvelopeSchema = p.response ? "response.error" : "error";
    }
    if (response.incomplete_details) d.incompleteReason = response.incomplete_details.reason;
    if (type === "response.output_item.added" && p.item?.type) {
      const known = ["message", "reasoning", "function_call", "custom_tool_call", "web_search_call", "image_generation_call"];
      const kind = known.includes(p.item.type) ? p.item.type : "unknown";
      const counts = (d.outputItemCountsByType ?? {}) as Record<string, number>;
      counts[kind] = (counts[kind] ?? 0) + 1; d.outputItemCountsByType = counts;
    }
    if (eventTypes.has(type) || type === "error") recordDiagnosticEvent(d, {
      type: (type === "error" ? "upstream.error" : type) as DiagnosticEventTypeV1,
      at: Date.now(), source: synthetic ? "proxy" : "upstream", responseId, elapsedMs: performance.now() - clocks.get(diagnostics(ctx))!.start,
    });
    if (send && responseId) send.upstreamResponseId ??= responseId;
    if (send && terminal) finishDiagnosticSend(send, { endedAt: Date.now(), status: type === "response.completed" ? 200
      : type === "response.incomplete" ? 502 : httpStatusFromTerminalError(response.error ?? p.error) });
    clean(ctx);
  });
}

export function recordSyntheticTerminal(ctx: RequestLogContext, type: "response.failed" | "response.incomplete"): void {
  recordProtocolEvent(ctx, { type }, 0, false, true);
}

export function recordDeliveredOutput(ctx: RequestLogContext): void {
  captureSafely(() => { diagnostics(ctx); clocks.get(diagnostics(ctx))!.output ??= performance.now(); });
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
    d.usageSource ??= ctx.usageFromBridge ? "adapter" : ctx.usage ? "upstream" : undefined;
    if (!ctx.usage) d.usageMissingReason = "not_reported";
    d.fieldAvailability.terminalMappedStatus = { status: "derived", source: "derived" };
    if (terminal) {
      // HTTP inspectors observe an upstream branch and cannot prove socket delivery.
      if (ctx.inboundTransport === "websocket") {
        d.downstreamTerminalSentAt = Date.now();
        recordDiagnosticEvent(d, { type: "downstream.terminal.sent", at: Date.now(), source: "downstream" });
      } else d.fieldAvailability.downstreamTerminalSentAt = { status: "not_observed", source: "transport" };
    }
    if (status === 499) { d.streamAborted = true; d.cancellationReason = "client_cancel"; d.downstreamClosedAt = Date.now(); }
    const clock = clocks.get(diagnostics(ctx))!;
    if (status >= 400) {
      d.outputDeliveredBeforeFailure = clock.output !== undefined || ctx.firstOutputMs !== undefined;
      d.fieldAvailability.outputDeliveredBeforeFailure = { status: "derived", source: "derived" };
    }
    if (clock.terminal !== undefined) { d.finalizationLagMs = Math.max(0, performance.now() - clock.terminal); d.derivedFields = ["finalizationLagMs"]; }
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
    else {
      const d = diagnostics(ctx);
      if (event.connectionId) d.upstreamConnectionId = event.connectionId;
      if (event.reused !== undefined) d.connectionReused = event.reused;
      if (event.sequence !== undefined) d.upstreamRequestSequenceOnConnection = event.sequence;
      if (event.generation !== undefined) d.connectionGeneration = event.generation;
      if (event.ageMs !== undefined) d.connectionAgeMs = event.ageMs;
      if (event.kind === "mismatch") d.correlationMismatch = true;
      if (event.kind === "connect") {
        d.upstreamConnectStartedAt = Date.now();
        recordDiagnosticEvent(d, { type: "upstream.connect.started", at: Date.now(), source: "transport" });
      }
      if (event.kind === "open") {
        d.websocketHandshakeStatus = 101; d.upstreamConnectedAt = Date.now(); d.handshakeCompletedAt = Date.now();
        recordDiagnosticEvent(d, { type: "upstream.connected", at: Date.now(), source: "transport" });
      }
      if (event.kind === "close") { d.websocketCloseCode = event.code; d.closedBy = "upstream"; recordDiagnosticEvent(d, { type: "upstream.closed", at: Date.now(), source: "transport" }); }
      clean(ctx);
    }
  });
}
