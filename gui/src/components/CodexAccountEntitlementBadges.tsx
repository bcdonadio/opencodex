import { normalizeCodexAccountEntitlements } from "../codex-account-entitlements";
import type { CodexAccountEntitlement } from "../codex-account-entitlements";
import "./codex-account-entitlement-badges.css";

export default function CodexAccountEntitlementBadges({ entitlements }: {
  entitlements?: CodexAccountEntitlement[];
}) {
  return <>{normalizeCodexAccountEntitlements(entitlements).map(entitlement => (
    <span className="badge codex-entitlement-badge" key={entitlement}>{entitlement}</span>
  ))}</>;
}
