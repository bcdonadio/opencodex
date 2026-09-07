import { MAX_CLIENT_SSE_FRAME_BYTES } from "../sse-frame-buffer";
import { sanitizeDiagnosticError } from "../../diagnostics/transaction";
import { isSafeResponseHeader } from "../safe-response-headers";
import { CodexWsMetadata, type CodexWsQuotaObserver } from "./codex-ws-metadata";
import { CODEX_RESPONSES_HTTP_URL, type PreparedCodexWsRequest } from "./codex-ws-request";
import { CodexWsCorrelation } from "./codex-ws-correlation";
import type { CodexWsSession } from "./codex-ws-session";
import type { ProviderFetchOptions, TransportObservation } from "./fetch-helpers";
import { UPGRADE_DEADLINE_MS, CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS, MAX_CODEX_WS_FRAME_BYTES,
  MAX_CODEX_WS_QUEUE_BYTES, markCodexWsResponse, normalizeResponsesWsRelayEvent, closedBeforeTerminalMessage } from "./codex-ws-wire";

interface ExchangeOptions {
  session: CodexWsSession;
  url: string;
  init: RequestInit;
  prepared: PreparedCodexWsRequest;
  sseFallback: typeof globalThis.fetch;
  onQuota?: CodexWsQuotaObserver;
  beforeDispatch?: (headers: Headers) => void;
  observeTransport?: ProviderFetchOptions["observeTransport"];
  onTransport?: (transport: "http" | "websocket") => void;
}

const HTTP_HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Rebuild only permitted metadata: upstream framing describes a different body. */
function rejectionHeaders(source: Record<string, unknown>, prelude: Headers): Headers {
  const connectionHeaders = new Set<string>();
  for (const [name, value] of Object.entries(source)) {
    if (name.toLowerCase() !== "connection" || typeof value !== "string") continue;
    for (const token of value.split(",")) {
      const lower = token.trim().toLowerCase();
      if (HTTP_HEADER_TOKEN.test(lower)) connectionHeaders.add(lower);
    }
  }
  // Reuse the metadata owner's count/value/family budgets and window freshness
  // rules, without publishing quota twice. The unmarked HTTP response owns it.
  const projected = new CodexWsMetadata();
  try {
    for (const values of [Object.fromEntries(prelude), source]) {
      const headers = Object.fromEntries(Object.entries(values).filter(([name, value]) => {
        if (!HTTP_HEADER_TOKEN.test(name) || !isSafeResponseHeader(name)
          || connectionHeaders.has(name.toLowerCase())) return false;
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return false;
        return !(typeof value === "number" && !Number.isFinite(value)) && !/[\r\n\0]/.test(String(value));
      }));
      if (Object.keys(headers).length === 0) continue;
      const event = { type: "codex.response.metadata", headers };
      // Bound the combined serialized seed and updates, even for replacements.
      projected.consume(event, Buffer.byteLength(JSON.stringify(event)));
    }
    const headers = projected.snapshot();
    headers.set("content-type", "application/json");
    headers.set("cache-control", "no-store");
    return headers;
  } finally {
    projected.finish();
  }
}

/**
 * Carry #3740's refused-create status back to the HTTP recovery path. Codex's
 * responses_websocket.rs accepts status/status_code and scalar header values;
 * unlike its native client, this relay converts only precommit 4xx. Returning a
 * post-send 5xx or fetch rejection could cause the outer retry wrapper to resend.
 */
function wrappedRejectionResponse(payload: Record<string, unknown>, prelude: Headers): Response | null {
  if (payload.type !== "error" || payload.stream_id !== undefined) return null;
  // The native typed wrapper has one aliased field, not two competing statuses.
  if (Object.hasOwn(payload, "status_code") && Object.hasOwn(payload, "status")) return null;
  const status = Object.hasOwn(payload, "status_code") ? payload.status_code : payload.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 499) return null;
  const error = payload.error;
  if (error != null && (!record(error)
    || [error.code, error.message].some(value => value != null && typeof value !== "string"))) return null;
  if (payload.headers != null && !record(payload.headers)) return null;
  const headers = rejectionHeaders(record(payload.headers) ? payload.headers : {}, prelude);
  return new Response(JSON.stringify({
    error: error ?? { type: "upstream_error", message: "Upstream rejected the request" },
  }), { status, headers });
}

/** The sole SSE exchange state machine for both one-shot and retained sockets. */
export function codexWsExchange(options: ExchangeOptions): Promise<Response> {
  const { session, url, init, prepared, sseFallback, onQuota, beforeDispatch, onTransport } = options;
  const { frameText, headers } = prepared;
  const observe = (event: TransportObservation): void => {
    try { options.observeTransport?.(event); } catch { /* optional diagnostics */ }
  };
  const signal = init.signal ?? undefined;
  if (!session.opened) observe({ kind: "connect", connectionId: session.connectionId, generation: session.generation });
  return new Promise<Response>((resolve, reject) => {
    const ws = session.socket;

    let opened = session.opened;
    let settledPreOpen = false;
    let sent = false;
    let received = false;
    let responseCommitted = false;
    let terminal = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    const metadata = url === CODEX_RESPONSES_HTTP_URL ? new CodexWsMetadata(onQuota) : null;
    let rejectedCorrelation = false;
    const correlation = session.retainable ? new CodexWsCorrelation(session.reused, id => session.hasCompleted(id),
      () => { rejectedCorrelation = true; observe({ kind: "mismatch" }); }) : null;
    let detachOwner = () => {};
    let preludeTimer: ReturnType<typeof setTimeout> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      cancel() {
        if (terminal) return;
        observe({ kind: "stream_failure", reason: "client_cancel" });
        terminal = true;
        cleanup();
        session.dispose();
      },
    }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_CODEX_WS_QUEUE_BYTES }));

    const cleanup = () => {
      clearTimeout(upgradeTimer);
      clearTimeout(preludeTimer);
      signal?.removeEventListener("abort", onAbort);
      metadata?.finish();
      correlation?.finish();
      detachOwner();
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    };

    const commitResponse = () => {
      if (responseCommitted) return;
      responseCommitted = true;
      clearTimeout(preludeTimer);
      const responseHeaders = metadata?.snapshot() ?? new Headers();
      responseHeaders.set("content-type", "text/event-stream; charset=utf-8");
      const response = new Response(stream, { status: 200, headers: responseHeaders });
      metadata?.commit();
      markCodexWsResponse(response, Boolean(metadata && onQuota));
      observe({ kind: "response", transport: "websocket", response });
      resolve(response);
    };

    const failStream = (error: unknown,
      reason: "request_abort" | "owner_cancel" | "prelude_timeout" | "frame_overflow" | "queue_overflow" | "transport_error" | "upstream_close" | "stream_closed" | "protocol_error",
      evidence?: { bytes?: number; timeoutMs?: number }) => {
      if (terminal) return;
      observe({ kind: "stream_failure", reason, ...evidence });
      terminal = true;
      // A frame may already be executing upstream. Settle as a body failure,
      // never a fetch rejection/5xx that the pre-stream wrapper could resend.
      if (sent) commitResponse();
      cleanup();
      try { controller?.error(typeof error === "string" ? new Error(error) : error); } catch { /* stream already done */ }
      session.dispose();
    };

    const upgradeTimer = setTimeout(() => {
      if (opened || settledPreOpen) return;
      settledPreOpen = true;
      cleanup();
      session.dispose();
      resolve(sseFallback(url, init));
    }, UPGRADE_DEADLINE_MS);

    const cancelExchange = (reason: unknown, source: "request_abort" | "owner_cancel") => {
      if (terminal || settledPreOpen) return;
      if (!sent) {
        observe({ kind: "stream_failure", reason: source });
        settledPreOpen = true;
        terminal = true;
        cleanup();
        session.dispose();
        reject(reason);
        return;
      }
      failStream(reason, source);
    };
    const onAbort = () => cancelExchange(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"), "request_abort");
    signal?.addEventListener("abort", onAbort, { once: true });

    const onOpen = () => {
      if (settledPreOpen) return;
      clearTimeout(upgradeTimer);
      opened = true;
      const connection = { connectionId: session.connectionId, reused: session.reused,
        sequence: ++session.requestSequence, generation: session.generation,
        ageMs: Math.max(0, performance.now() - session.createdMonotonic) };
      observe({ kind: "open", ...connection });
      try {
        beforeDispatch?.(new Headers(headers));
      } catch (error) {
        // Settle and detach before close: a synchronous close event must not resend over SSE.
        settledPreOpen = true;
        terminal = true;
        cleanup();
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onError);
        session.dispose();
        reject(error);
        return;
      }
      if (terminal || settledPreOpen || signal?.aborted) return;
      sent = true;
      let sentSuccessfully = false;
      try {
        ws.send(frameText);
        sentSuccessfully = true;
      } catch {
        if (received || responseCommitted) {
          if (terminal) session.dispose();
          failStream("codex websocket send failed after response activity", "transport_error");
          return;
        }
        // send() throwing means the frame never left, so no upstream turn
        // started and the SSE resend cannot double-generate. Falling back
        // (instead of erroring a synthetic 200 body) keeps the pre-stream
        // HTTP error/refresh/failover machinery in charge.
        settledPreOpen = true;
        sent = false;
        cleanup();
        session.dispose();
        resolve(sseFallback(url, init));
        return;
      }
      // A successful send is the first point at which this logical request has
      // crossed the upstream WebSocket boundary. Keep this observer outside
      // the send catch: a telemetry failure must never trigger an HTTP resend
      // after a frame was accepted by the socket.
      if (sentSuccessfully) {
        observe({ kind: "send", transport: "websocket", body: frameText });
        // Connection metadata belongs only to a successfully dispatched frame.
        observe({ kind: "connection", ...connection });
        try { onTransport?.("websocket"); } catch { /* telemetry is observational */ }
      }
      if (!metadata) commitResponse();
      else if (!responseCommitted && !terminal) {
        preludeTimer = setTimeout(() => failStream("codex websocket response prelude timed out", "prelude_timeout",
          { timeoutMs: CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS }), CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS);
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (!controller || terminal) return;
      received = true;
      const text = typeof event.data === "string" ? event.data : "";
      if (!text) return;
      // UTF-8 byte length is always at least the JS string length. Reject this
      // cheap lower bound before parsing so an obviously oversized frame does
      // not create another large object graph.
      if (text.length > MAX_CODEX_WS_FRAME_BYTES) {
        failStream("codex websocket frame exceeds the response size limit", "frame_overflow");
        return;
      }
      const rawEncodedText = encoder.encode(text);
      if (rawEncodedText.byteLength > MAX_CODEX_WS_FRAME_BYTES) {
        failStream("codex websocket frame exceeds the response size limit", "frame_overflow", { bytes: rawEncodedText.byteLength });
        return;
      }
      const normalized = normalizeResponsesWsRelayEvent(text);
      if (!normalized) return;
      const { type } = normalized;
      let relayText = normalized.text;
      let controlFrame = false;
      if (metadata) {
        try {
          const sanitized = metadata.consume(normalized.payload, rawEncodedText.byteLength);
          if (sanitized !== null) {
            relayText = sanitized;
            controlFrame = true;
          }
        } catch (error) {
          failStream(error, "protocol_error");
          return;
        }
      }
      const encodedText = relayText === text ? rawEncodedText : encoder.encode(relayText);
      if (encodedText.byteLength > MAX_CODEX_WS_FRAME_BYTES) {
        failStream("codex websocket frame exceeds the response size limit", "frame_overflow", { bytes: encodedText.byteLength });
        return;
      }
      if (!controlFrame && !type.startsWith("response.") && type !== "error") return;
      if (!controlFrame) {
        rejectedCorrelation = false;
        try { correlation?.accept(normalized.payload); } catch (error) { failStream(error, "protocol_error"); return; }
        if (!rejectedCorrelation) observe({ kind: "event", payload: normalized.payload, bytes: rawEncodedText.byteLength });
        // Correlation must run first: a reused socket's foreign-stream error
        // must not become an HTTP refusal that could authorize account replay.
        if (metadata && sent && !responseCommitted && type === "error") {
          let rejection: Response | null;
          try { rejection = wrappedRejectionResponse(normalized.payload, metadata.snapshot()); }
          catch (error) { failStream(error, "protocol_error"); return; }
          if (rejection) {
            terminal = true;
            cleanup();
            try { controller.close(); } catch { /* unused stream already closed */ }
            session.dispose();
            observe({ kind: "response", transport: "websocket", response: rejection });
            resolve(rejection);
            return;
          }
        }
        commitResponse();
      }
      const prefix = encoder.encode(`event: ${type}\ndata: `);
      const suffix = encoder.encode("\n\n");
      const frameBytes = prefix.byteLength + encodedText.byteLength + suffix.byteLength;
      if (frameBytes > MAX_CLIENT_SSE_FRAME_BYTES) {
        failStream("codex websocket frame exceeds the response size limit", "frame_overflow", { bytes: frameBytes });
        return;
      }
      const availableBytes = controller.desiredSize ?? 0;
      if (frameBytes > availableBytes) {
        failStream("codex websocket response exceeded the buffered queue limit", "queue_overflow", { bytes: frameBytes });
        return;
      }
      const sseFrame = new Uint8Array(frameBytes);
      sseFrame.set(prefix);
      sseFrame.set(encodedText, prefix.byteLength);
      sseFrame.set(suffix, prefix.byteLength + encodedText.byteLength);
      try {
        controller.enqueue(sseFrame);
      } catch {
        failStream("codex websocket response stream closed while enqueueing", "stream_closed");
        return;
      }
      if (type === "response.completed" || type === "response.failed" || type === "response.incomplete" || type === "error") {
        const completedId = correlation?.completed(normalized.payload) ?? null;
        terminal = true;
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
        session.release(completedId);
      }
    };

    const onClose = (event: unknown) => {
      const close = event as { code?: number; reason?: unknown } | null;
      observe({ kind: "close", connectionId: session.connectionId, code: close?.code,
        reason: sanitizeDiagnosticError(close?.reason) });
      cleanup();
      if (!opened) {
        if (settledPreOpen) return;
        settledPreOpen = true;
        // Upgrade rejected (401/403/429/5xx). Retry over plain SSE so the real
        // HTTP status reaches the existing refresh/rotation handlers. No turn
        // started upstream, so the resend cannot double-generate.
        resolve(sseFallback(url, init));
        return;
      }
      if (sent && !terminal) failStream(closedBeforeTerminalMessage(event), "upstream_close");
    };

    const onError = () => {
      if (terminal || settledPreOpen) return;
      if (!opened && !sent) {
        settledPreOpen = true;
        terminal = true;
        cleanup();
        session.dispose();
        resolve(sseFallback(url, init));
      } else failStream("codex websocket transport error", "transport_error");
    };
    detachOwner = session.bindOwner(reason => cancelExchange(reason, "owner_cancel"));
    ws.addEventListener("open", onOpen);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
    if (signal?.aborted) onAbort();
    else if (session.opened) onOpen();
  });
}
