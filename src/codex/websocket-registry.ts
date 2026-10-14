import type { ServerWebSocket } from "bun";
import type { WsData } from "../server/ws-bridge";
import { createAdmissionGate, type AdmissionMetrics, type AdmissionReservation } from "../lib/admission";

export const MAX_TRACKED_CODEX_WEBSOCKETS = 128;
const websocketGate = createAdmissionGate("codex_websockets", MAX_TRACKED_CODEX_WEBSOCKETS);

// Bound idle sockets may outlive their threads because Codex caches the connection.
// Reclaim one only under pressure; in-flight turns and native continuations retain ownership.
const reservations = new Set<{
  socket?: ServerWebSocket<WsData>;
  release(): void;
}>();

export function tryReserveCodexWebSocket(): AdmissionReservation<ServerWebSocket<WsData>> | null {
  if (websocketGate.metrics().active >= MAX_TRACKED_CODEX_WEBSOCKETS) {
    for (const reservation of reservations) {
      const ws = reservation.socket;
      if (!ws || ws.data.cancel || ws.data.nativeControl) continue;
      reservation.release();
      unregisterCodexWebSocket(ws);
      try { ws.close(1000, "idle connection reclaimed"); } catch { /* already closed */ }
      break;
    }
  }
  const gateLease = websocketGate.tryAcquire();
  if (!gateLease) return null;
  let active = true;
  const reservation = {
    socket: undefined as ServerWebSocket<WsData> | undefined,
    release() {
      if (!active) return;
      active = false;
      reservations.delete(reservation);
      reservation.socket = undefined;
      gateLease.release();
    },
  };
  reservations.add(reservation);
  return {
    bind(value) {
      if (active) reservation.socket = value;
    },
    release: reservation.release,
  };
}

export function codexWebSocketAdmissionMetrics(): AdmissionMetrics {
  return websocketGate.metrics();
}

const socketsByAccount = new Map<string, Set<ServerWebSocket<WsData>>>();

function trackedAccountId(ws: ServerWebSocket<WsData>): string | null {
  const ctx = ws.data.authContext;
  return ctx?.kind === "pool" || ctx?.kind === "main-pool" ? ctx.accountId : null;
}

function addSocketForAccount(accountId: string | null, ws: ServerWebSocket<WsData>): void {
  if (!accountId) return;
  let sockets = socketsByAccount.get(accountId);
  if (!sockets) {
    sockets = new Set();
    socketsByAccount.set(accountId, sockets);
  }
  sockets.add(ws);
}

function removeSocketForAccount(accountId: string | null, ws: ServerWebSocket<WsData>): void {
  if (!accountId) return;
  const sockets = socketsByAccount.get(accountId);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) socketsByAccount.delete(accountId);
}

export function registerCodexWebSocket(ws: ServerWebSocket<WsData>): void {
  addSocketForAccount(trackedAccountId(ws), ws);
}

export function unregisterCodexWebSocket(ws: ServerWebSocket<WsData>): void {
  removeSocketForAccount(trackedAccountId(ws), ws);
}

export function updateCodexWebSocketAuthContext(
  ws: ServerWebSocket<WsData>,
  authContext: WsData["authContext"],
): void {
  const before = trackedAccountId(ws);
  removeSocketForAccount(before, ws);
  ws.data.authContext = authContext;
  addSocketForAccount(trackedAccountId(ws), ws);
}

export function invalidateCodexWebSocketsForAccount(accountId: string): number {
  const sockets = socketsByAccount.get(accountId);
  if (!sockets) return 0;
  const snapshot = [...sockets];
  socketsByAccount.delete(accountId);
  for (const ws of snapshot) {
    try {
      ws.data.cancel?.();
    } catch {
      /* ignore cancel callbacks during invalidation */
    }
    try {
      ws.close(4001, "Codex account invalidated");
    } catch {
      /* socket may already be closing */
    }
  }
  return snapshot.length;
}

export function getTrackedCodexWebSocketCountForAccount(accountId: string): number {
  return socketsByAccount.get(accountId)?.size ?? 0;
}

export function clearCodexWebSocketRegistry(): void {
  socketsByAccount.clear();
}
