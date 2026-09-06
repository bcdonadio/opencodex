import type { DiagnosticSendV1, TransactionDiagnosticsV1 } from "../diagnostics/transaction";
import type { AttemptRecoveryKind } from "../usage/log";
import type { RequestLogContext } from "./request-log";

// A recovery kind is a fact about the NEXT dispatch, not the last entry in an
// attempt's deduplicated history. Consume it once so later ordinary sends do
// not inherit a recovery that happened earlier in the attempt.
const pendingRecovery = new WeakMap<object, AttemptRecoveryKind>();

export function noteRecoveryDispatch(attempt: object, recovery?: AttemptRecoveryKind): void {
  try {
    if (recovery) pendingRecovery.set(attempt, recovery);
    else pendingRecovery.delete(attempt);
  } catch { /* optional observation */ }
}

export function initializeRecoveryAvailability(d: TransactionDiagnosticsV1): void {
  for (const field of ["retryDelayMs", "retryDecision", "recoveryReason", "resumeMode",
    "stateRestored", "stateRestoreSource", "policyFallbackAttempted", "policyFallbackOutcome"]) {
    d.fieldAvailability[field] ??= { status: "not_observed", source: "proxy" };
  }
  // Several independent retry owners have separate budgets. No transaction-wide
  // budget exists, and subtracting aggregate sends would invent one.
  d.fieldAvailability.retryBudgetRemaining = { status: "unsupported", source: "proxy" };
}

export function captureRecoveryDispatch(
  d: TransactionDiagnosticsV1, attempt: object, send: DiagnosticSendV1,
): void {
  const reason = pendingRecovery.get(attempt);
  pendingRecovery.delete(attempt);
  if (!reason) return;
  send.recoveryReason = reason;
  send.retryReason = reason;
  d.recoveryReason = reason;
  d.retryDecision = "retry_dispatched";
  d.fieldAvailability.recoveryReason = { status: "observed", source: "proxy" };
  d.fieldAvailability.retryDecision = { status: "observed", source: "proxy" };
}

/** The selected scheduled delay, not an estimate of elapsed sleep or a budget. */
export function captureRetryDelay(ctx: RequestLogContext, delayMs: number): number {
  try {
    const d = ctx.diagnostics;
    if (d && Number.isFinite(delayMs) && delayMs >= 0) {
      d.retryDelayMs = delayMs;
      d.retryDecision = "retry_wait_scheduled";
      d.fieldAvailability.retryDelayMs = { status: "observed", source: "proxy" };
      d.fieldAvailability.retryDecision = { status: "observed", source: "proxy" };
    }
  } catch { /* optional observation */ }
  return delayMs;
}

/** Only the replay-prefix owner proves actual restoration of local state. */
export function captureReplayRestoration(d: TransactionDiagnosticsV1, replayedItems: number): void {
  if (replayedItems <= 0) return;
  d.stateRestored = true;
  d.stateRestoreSource = "previous_response_replay";
  d.resumeMode = "local_replay";
  for (const field of ["stateRestored", "stateRestoreSource", "resumeMode"]) {
    d.fieldAvailability[field] = { status: "observed", source: "proxy" };
  }
}

/** Called immediately before the policy owner dispatches a new candidate. */
export function capturePolicyFallback(ctx: RequestLogContext, attempted: boolean): void {
  try {
    const d = ctx.diagnostics;
    if (!d) return;
    d.policyFallbackAttempted = attempted;
    d.fieldAvailability.policyFallbackAttempted = { status: "observed", source: "proxy" };
    if (attempted) {
      delete d.policyFallbackOutcome;
      d.fieldAvailability.policyFallbackOutcome = { status: "not_observed", source: "proxy" };
      d.recoveryReason = "fallback";
      d.fieldAvailability.recoveryReason = { status: "observed", source: "proxy" };
    } else {
      d.policyFallbackOutcome = "not_attempted";
      d.fieldAvailability.policyFallbackOutcome = { status: "observed", source: "proxy" };
    }
  } catch { /* optional observation */ }
}

/** Headers alone cannot prove fallback success; use the final request outcome. */
export function finishRecoveryCapture(d: TransactionDiagnosticsV1, status: number): void {
  if (d.policyFallbackAttempted !== true) return;
  d.policyFallbackOutcome = status >= 200 && status < 400 ? "succeeded" : "failed";
  d.fieldAvailability.policyFallbackOutcome = { status: "observed", source: "proxy" };
}
