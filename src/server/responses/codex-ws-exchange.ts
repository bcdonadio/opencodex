import { MAX_CLIENT_SSE_FRAME_BYTES } from "../sse-frame-buffer";
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
}

/** The sole SSE exchange state machine for both one-shot and retained sockets. */
export function codexWsExchange(options: ExchangeOptions): Promise<Response> {
  const { session, url, init, prepared, sseFallback, onQuota, beforeDispatch } = options;
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
      observe({ kind: "open", connectionId: session.connectionId, reused: session.reused,
        sequence: ++session.requestSequence, generation: session.generation,
        ageMs: Math.max(0, performance.now() - session.createdMonotonic) });
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
      try {
        ws.send(frameText);
        observe({ kind: "send", transport: "websocket", body: frameText });
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
      observe({ kind: "close", connectionId: session.connectionId, code: (event as { code?: number })?.code });
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
