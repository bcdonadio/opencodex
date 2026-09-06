import type { RequestLogContext } from "./request-log";

const accountLabel = /^(?:main|[po][0-9a-f]{6})$/;
const authModes = new Set(["key", "forward", "oauth", "local"]);
const sentAccounts = new WeakMap<RequestLogContext, { attempt: object; label?: string; unknown: boolean }>();

/** Observe resolved route facts only; never accept credentials or raw account IDs. */
export function recordRouteAuth(
  ctx: RequestLogContext,
  authMode: unknown,
  selection?: { kind: "main" | "pool" | "main-pool"; fixedAccount?: boolean },
): void {
  try {
    const d = ctx.diagnostics;
    if (!d) return;
    delete d.authMode;
    delete d.accountSelectionSource;
    delete d.accountPoolSelectionReason;
    if (typeof authMode === "string" && authModes.has(authMode)) {
      d.authMode = authMode;
      d.fieldAvailability.authMode = { status: "observed", source: "proxy" };
    } else d.fieldAvailability.authMode = { status: "not_observed", source: "proxy" };
    if (authMode === "forward" && selection) {
      d.accountSelectionSource = selection.fixedAccount === true ? "explicit_selector" : selection.kind;
      d.fieldAvailability.accountSelectionSource = { status: "observed", source: "proxy" };
    } else d.fieldAvailability.accountSelectionSource = { status: "not_observed", source: "proxy" };
    // Context kind identifies the selected source, not the pool ranking reason or binding.
    d.fieldAvailability.accountPoolSelectionReason = { status: "not_observed", source: "proxy" };
    d.fieldAvailability.accountAffinity = { status: "not_observed", source: "proxy" };
  } catch { /* Observation must never affect route selection. */ }
}

/** Compare only identities on actual sends belonging to distinct attempt owners. */
export function recordAuthSend(ctx: RequestLogContext): void {
  try {
    const d = ctx.diagnostics;
    if (!d) return;
    const label = typeof ctx.accountLogLabel === "string" && accountLabel.test(ctx.accountLogLabel)
      ? ctx.accountLogLabel : undefined;
    delete d.accountPseudonym;
    if (label) d.accountPseudonym = label;
    d.fieldAvailability.accountPseudonym = { status: label ? "observed" : "not_observed", source: "proxy" };
    const attempt = ctx.activeAttempt;
    if (!attempt) return;
    const previous = sentAccounts.get(ctx);
    if (previous && previous.attempt !== attempt) {
      if (previous.label && label && (previous.label !== label || !previous.unknown)) {
        d.accountChangedBetweenAttempts = d.accountChangedBetweenAttempts === true || previous.label !== label;
        d.fieldAvailability.accountChangedBetweenAttempts = { status: "derived", source: "derived" };
      } else if (d.accountChangedBetweenAttempts !== true) {
        delete d.accountChangedBetweenAttempts;
        d.fieldAvailability.accountChangedBetweenAttempts = { status: "not_observed", source: "proxy" };
      }
    }
    sentAccounts.set(ctx, { attempt, label, unknown: previous?.unknown === true || !label });
  } catch { /* Observation must never affect dispatch. */ }
}

/** A completed forced-refresh operation, not a claim about unobserved background refresh. */
export function recordAuthRefresh(ctx: RequestLogContext, result: "succeeded" | "failed"): void {
  try {
    const d = ctx.diagnostics;
    if (!d) return;
    d.authRefreshOccurred = true;
    d.authRefreshResult = result;
    d.fieldAvailability.authRefreshOccurred = { status: "observed", source: "proxy" };
    d.fieldAvailability.authRefreshResult = { status: "observed", source: "proxy" };
  } catch { /* Observation must never affect credential recovery. */ }
}
