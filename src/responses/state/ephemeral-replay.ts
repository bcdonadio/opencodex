import { enforceAppOwnedMemoryBudget } from "../../lib/app-owned-memory";
import type { OcxProviderContinuationState } from "../../types";
import type { ResidentInput, ResidentResponseState } from "../state";
import { isBodyNonPersistable, markBodyNonPersistable } from "./body-policy";

const EPHEMERAL_RESPONSE_TTL_MS = 15 * 60 * 1_000;
const MAX_EPHEMERAL_RESPONSES = 128;
const MAX_EPHEMERAL_RESPONSE_BYTES = 8 * 1024 * 1024;

type ResponsePayload = {
  id?: unknown;
  output?: unknown;
  status?: unknown;
  incomplete_details?: unknown;
};

type EphemeralResponseState = ResidentResponseState & {
  responseId: string;
  expiresAt: number;
};

export type EphemeralReplayResolution =
  | { kind: "miss" }
  | { kind: "scope_mismatch" }
  | { kind: "hit"; state: ResidentResponseState; expiresAt: number };

export type RememberResponseStateOptions = {
  force?: boolean;
  clientThreadId?: string;
  ephemeral?: boolean;
  ephemeralScope?: string;
};

export interface EphemeralReplayStore {
  now: () => number;
  inputItems: (input: unknown) => unknown[];
  normalizedClientThreadId: (value: unknown) => string | undefined;
  ensureLoaded: () => void;
  measureResidentEntry: (id: string, entry: ResidentInput) => ResidentResponseState | null;
  setResidentEntry: (id: string, entry: ResidentInput) => void;
  schedulePersist: () => void;
}

let store: EphemeralReplayStore | null = null;
const ephemeralStates = new Map<string, EphemeralResponseState>();
let ephemeralBodyExpiry = new WeakMap<object, number>();
let ephemeralResponseBytes = 0;
let ephemeralExpiryTimer: ReturnType<typeof setTimeout> | null = null;

export function bindEphemeralReplayStore(next: EphemeralReplayStore): void {
  store = next;
}

function requireStore(): EphemeralReplayStore {
  if (!store) throw new Error("Ephemeral response replay store is not bound");
  return store;
}

function ephemeralResponseKey(scope: string, responseId: string): string {
  return JSON.stringify([scope, responseId]);
}

function pruneEphemeralResponses(at = requireStore().now()): void {
  for (const [id, state] of ephemeralStates) {
    if (state.expiresAt > at) continue;
    ephemeralStates.delete(id);
    ephemeralResponseBytes -= state.sizeBytes;
  }
  while (ephemeralStates.size > MAX_EPHEMERAL_RESPONSES
    || ephemeralResponseBytes > MAX_EPHEMERAL_RESPONSE_BYTES) {
    const oldest = ephemeralStates.keys().next().value as string | undefined;
    if (!oldest) break;
    ephemeralResponseBytes -= ephemeralStates.get(oldest)!.sizeBytes;
    ephemeralStates.delete(oldest);
  }
  if (ephemeralExpiryTimer) clearTimeout(ephemeralExpiryTimer);
  const next = [...ephemeralStates.values()].reduce<number | null>(
    (expiry, state) => expiry === null || state.expiresAt < expiry ? state.expiresAt : expiry,
    null,
  );
  ephemeralExpiryTimer = next === null ? null : setTimeout(
    () => pruneEphemeralResponses(),
    Math.max(1, next - requireStore().now()),
  );
  ephemeralExpiryTimer?.unref?.();
}

export function resolveEphemeralReplay(
  responseId: string,
  ephemeralScope?: string,
): EphemeralReplayResolution {
  pruneEphemeralResponses();
  const scope = typeof ephemeralScope === "string" && ephemeralScope.trim().length > 0
    ? ephemeralScope
    : undefined;
  const ephemeral = scope
    ? ephemeralStates.get(ephemeralResponseKey(scope, responseId))
    : undefined;
  if (!ephemeral) {
    return [...ephemeralStates.values()].some(state => state.responseId === responseId)
      ? { kind: "scope_mismatch" }
      : { kind: "miss" };
  }
  const { responseId: _responseId, expiresAt, ...state } = ephemeral;
  return {
    kind: "hit",
    state: { ...state, items: structuredClone(state.items) },
    expiresAt,
  };
}

export function markEphemeralReplayBody(body: object, expiresAt: number): void {
  markBodyNonPersistable(body);
  ephemeralBodyExpiry.set(body, expiresAt);
}

export function copyEphemeralReplayProvenance(source: object, target: object): void {
  const expiry = ephemeralBodyExpiry.get(source);
  if (expiry !== undefined) markEphemeralReplayBody(target, expiry);
}

function rememberEphemeralResponseState(
  request: Record<string, unknown>,
  response: ResponsePayload,
  clientThreadId?: string,
  ephemeralScope?: string,
): void {
  if (!ephemeralScope || ephemeralScope.trim().length === 0) return;
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status === "incomplete") {
    const details = response.incomplete_details;
    if (!details || typeof details !== "object" || Array.isArray(details)
      || (details as { reason?: unknown }).reason !== "max_output_tokens") return;
  } else if (response.status !== undefined && response.status !== "completed") return;
  const bound = requireStore();
  const createdAt = bound.now();
  const expiresAt = ephemeralBodyExpiry.get(request) ?? createdAt + EPHEMERAL_RESPONSE_TTL_MS;
  if (expiresAt <= createdAt) return;
  let requestItems: unknown[];
  let output: unknown[];
  try {
    requestItems = structuredClone(bound.inputItems(request.input));
    output = structuredClone(response.output);
  } catch {
    return;
  }
  const clientThread = bound.normalizedClientThreadId(clientThreadId);
  const candidate = bound.measureResidentEntry(response.id, {
    createdAt,
    ...(clientThread ? { clientThreadId: clientThread } : {}),
    items: [...requestItems, ...output],
    providerOutputStart: requestItems.length,
  });
  if (!candidate || candidate.sizeBytes > MAX_EPHEMERAL_RESPONSE_BYTES) return;
  const key = ephemeralResponseKey(ephemeralScope, response.id);
  const previous = ephemeralStates.get(key);
  if (previous) ephemeralResponseBytes -= previous.sizeBytes;
  ephemeralStates.delete(key);
  ephemeralStates.set(key, { ...candidate, responseId: response.id, expiresAt });
  ephemeralResponseBytes += candidate.sizeBytes;
  pruneEphemeralResponses(createdAt);
}

/**
 * Cache completed output and max_output_tokens partial output for previous_response_id replay.
 * Content-filtered incomplete and failed output are not authoritative replay history.
 */
export function rememberResponseState(
  requestBody: unknown,
  response: ResponsePayload,
  providerState?: OcxProviderContinuationState | string,
  opts?: RememberResponseStateOptions,
): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
  if (isBodyNonPersistable(request)) {
    if (opts?.ephemeral) {
      rememberEphemeralResponseState(request, response, opts.clientThreadId, opts.ephemeralScope);
    }
    return;
  }
  // `force` bypasses only the store:false skip. Non-persistable bodies returned above never
  // reach the durable store, regardless of force.
  if (request.store === false && !opts?.force) return;
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status === "incomplete") {
    const details = response.incomplete_details;
    if (!details || typeof details !== "object" || Array.isArray(details)
      || (details as { reason?: unknown }).reason !== "max_output_tokens") return;
  } else if (response.status !== undefined && response.status !== "completed") return;
  const bound = requireStore();
  bound.ensureLoaded();
  const normalizedProviderState: OcxProviderContinuationState = typeof providerState === "string"
    ? { cursor: { conversationId: providerState } }
    : structuredClone(providerState ?? {});
  if (normalizedProviderState.cursor?.conversationId) {
    normalizedProviderState.cursor.checkpointUsable = !response.output.some(item => {
      return !!item && typeof item === "object" && (item as { type?: unknown }).type === "function_call";
    });
  }
  const clientThreadId = bound.normalizedClientThreadId(opts?.clientThreadId);
  const requestItems = bound.inputItems(request.input);
  bound.setResidentEntry(response.id, {
    createdAt: bound.now(),
    ...(clientThreadId ? { clientThreadId } : {}),
    items: [...requestItems, ...response.output],
    providerOutputStart: requestItems.length,
    ...(Object.keys(normalizedProviderState).length > 0 ? { providers: normalizedProviderState } : {}),
  });
  enforceAppOwnedMemoryBudget();
  bound.schedulePersist();
}

export function resetEphemeralReplayForTests(): void {
  if (ephemeralExpiryTimer) clearTimeout(ephemeralExpiryTimer);
  ephemeralExpiryTimer = null;
  ephemeralStates.clear();
  ephemeralBodyExpiry = new WeakMap<object, number>();
  ephemeralResponseBytes = 0;
}
