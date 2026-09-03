const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_RECOVERIES = 32;
const CACHE_TTL_MS = 15 * 60 * 1000;

interface RecoveryCacheEntry {
  assignment: string;
  bytes: number;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

interface RecoveryFlight {
  controller: AbortController;
  promise: Promise<string | null>;
  waiters: number;
  settled: boolean;
}

const RECOVERY_CACHE = new Map<string, RecoveryCacheEntry>();
const RECOVERY_FLIGHTS = new Map<string, RecoveryFlight>();
let recoveryCacheBytes = 0;

function deleteRecoveryCacheEntry(key: string, expected?: RecoveryCacheEntry): void {
  const entry = RECOVERY_CACHE.get(key);
  if (!entry || (expected && entry !== expected)) return;
  RECOVERY_CACHE.delete(key);
  if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  recoveryCacheBytes = Math.max(0, recoveryCacheBytes - entry.bytes);
}

function sweepRecoveryCache(now: number, maxEntries: number): void {
  for (const [key, entry] of RECOVERY_CACHE) {
    if (entry.expiresAt > now) continue;
    deleteRecoveryCacheEntry(key, entry);
  }
  while (RECOVERY_CACHE.size > maxEntries || recoveryCacheBytes > MAX_CACHE_BYTES) {
    const oldest = RECOVERY_CACHE.keys().next().value;
    if (oldest === undefined) break;
    deleteRecoveryCacheEntry(oldest);
  }
}

function insertRecoveryCacheEntry(key: string, assignment: string, maxEntries: number): void {
  const replaced = RECOVERY_CACHE.get(key);
  if (replaced) deleteRecoveryCacheEntry(key, replaced);
  const insertedAt = Date.now();
  const entry: RecoveryCacheEntry = {
    assignment,
    bytes: Buffer.byteLength(assignment),
    expiresAt: insertedAt + CACHE_TTL_MS,
    expiryTimer: null,
  };
  entry.expiryTimer = setTimeout(
    () => deleteRecoveryCacheEntry(key, entry),
    CACHE_TTL_MS,
  );
  entry.expiryTimer.unref?.();
  RECOVERY_CACHE.set(key, entry);
  recoveryCacheBytes += entry.bytes;
  sweepRecoveryCache(insertedAt, maxEntries);
}

function refreshRecoveryCacheEntry(key: string, entry: RecoveryCacheEntry, now: number): void {
  if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  entry.expiresAt = now + CACHE_TTL_MS;
  entry.expiryTimer = setTimeout(
    () => deleteRecoveryCacheEntry(key, entry),
    CACHE_TTL_MS,
  );
  entry.expiryTimer.unref?.();
  // Reinsert to keep byte/entry eviction ordered by most recent use.
  RECOVERY_CACHE.delete(key);
  RECOVERY_CACHE.set(key, entry);
}

export function readCachedAgentTaskRecoveries(keys: string[], maxEntries: number): string[] | null {
  const now = Date.now();
  sweepRecoveryCache(now, maxEntries);
  const entries = keys.map(key => RECOVERY_CACHE.get(key));
  // A continuation is one recovery unit: do not refresh or expose a partial history when any
  // ciphertext-scoped entry is unavailable.
  if (entries.some(entry => entry === undefined)) return null;

  const touched = new Set(keys);
  // Preserve the cache's existing LRU ordering while moving the batch to the MRU end. History
  // order is conversational, not recency, and must not rewrite eviction priority item by item.
  const orderedTouched = [...RECOVERY_CACHE.entries()].filter(([key]) => touched.has(key));
  for (const [key, entry] of orderedTouched) refreshRecoveryCacheEntry(key, entry, now);
  return entries.map(entry => entry!.assignment);
}

export function readCachedAgentTaskRecovery(key: string, maxEntries: number): string | null {
  return readCachedAgentTaskRecoveries([key], maxEntries)?.[0] ?? null;
}

function startRecoveryFlight(
  key: string,
  maxEntries: number,
  request: (signal: AbortSignal) => Promise<string | null>,
): RecoveryFlight | null {
  const active = RECOVERY_FLIGHTS.get(key);
  if (active) return active;
  if (RECOVERY_FLIGHTS.size >= MAX_CONCURRENT_RECOVERIES) return null;

  const controller = new AbortController();
  const flight: RecoveryFlight = {
    controller,
    promise: Promise.resolve(null),
    waiters: 0,
    settled: false,
  };
  flight.promise = request(controller.signal)
    .then((assignment) => {
      if (!assignment || controller.signal.aborted) return null;
      insertRecoveryCacheEntry(key, assignment, maxEntries);
      return assignment;
    })
    .finally(() => {
      flight.settled = true;
      if (RECOVERY_FLIGHTS.get(key) === flight) RECOVERY_FLIGHTS.delete(key);
    });
  RECOVERY_FLIGHTS.set(key, flight);
  return flight;
}

async function waitForRecoveryCapacity(abortSignal?: AbortSignal): Promise<boolean> {
  if (abortSignal?.aborted) return false;
  const pending = [...RECOVERY_FLIGHTS.values()].map(flight => (
    flight.promise.then(() => undefined, () => undefined)
  ));
  if (pending.length === 0) return true;
  if (!abortSignal) {
    await Promise.race(pending);
    return true;
  }

  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<false>((resolve) => {
      onAbort = () => resolve(false);
      abortSignal.addEventListener("abort", onAbort, { once: true });
      if (abortSignal.aborted) onAbort();
    });
    return await Promise.race([
      Promise.race(pending).then(() => true as const),
      cancelled,
    ]);
  } finally {
    if (onAbort) abortSignal.removeEventListener("abort", onAbort);
  }
}

async function waitForRecoveryFlight(
  flight: RecoveryFlight,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (abortSignal?.aborted) return null;
  flight.waiters += 1;
  let onAbort: (() => void) | undefined;
  try {
    if (!abortSignal) return await flight.promise;
    const cancelled = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      abortSignal.addEventListener("abort", onAbort, { once: true });
      if (abortSignal.aborted) onAbort();
    });
    return await Promise.race([flight.promise, cancelled]);
  } finally {
    if (onAbort) abortSignal?.removeEventListener("abort", onAbort);
    flight.waiters = Math.max(0, flight.waiters - 1);
    if (flight.waiters === 0 && !flight.settled) {
      flight.controller.abort(new DOMException("All recovery callers cancelled", "AbortError"));
    }
  }
}

export async function resolveCachedAgentTaskRecovery(
  key: string,
  maxEntries: number,
  request: (signal: AbortSignal) => Promise<string | null>,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  for (;;) {
    if (abortSignal?.aborted) return null;
    sweepRecoveryCache(Date.now(), maxEntries);
    const cached = readCachedAgentTaskRecovery(key, maxEntries);
    if (cached !== null) return cached;
    const flight = startRecoveryFlight(key, maxEntries, request);
    if (flight) return waitForRecoveryFlight(flight, abortSignal);
    // The process-wide cap is a concurrency bound, not a terminal admission failure. Queue until
    // any active flight settles, then recheck cache/key sharing and claim the freed slot.
    if (!await waitForRecoveryCapacity(abortSignal)) return null;
  }
}

export function discardCachedAgentTaskRecovery(key: string): void {
  deleteRecoveryCacheEntry(key);
}

export function resetAgentTaskRecoveryCache(): void {
  for (const flight of RECOVERY_FLIGHTS.values()) {
    flight.controller.abort(new DOMException("Recovery state reset", "AbortError"));
  }
  RECOVERY_FLIGHTS.clear();
  for (const key of [...RECOVERY_CACHE.keys()]) deleteRecoveryCacheEntry(key);
}

export function agentTaskRecoveryWaiterCountForTests(): number {
  let count = 0;
  for (const flight of RECOVERY_FLIGHTS.values()) count += flight.waiters;
  return count;
}

export function agentTaskRecoveryCacheSnapshotForTests(): { entries: number; bytes: number } {
  return { entries: RECOVERY_CACHE.size, bytes: recoveryCacheBytes };
}
