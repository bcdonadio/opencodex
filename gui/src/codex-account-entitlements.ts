export type CodexAccountEntitlement = "daybreak-blue" | "daybreak-red" | "ultrafast";

const knownEntitlements = new Set<CodexAccountEntitlement>([
  "daybreak-blue", "daybreak-red", "ultrafast",
]);

export function normalizeCodexAccountEntitlements(value: unknown): CodexAccountEntitlement[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is CodexAccountEntitlement => knownEntitlements.has(entry)))];
}
