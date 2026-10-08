export interface CodexUltrafastTier {
  readonly id: "ultrafast";
  readonly name: string;
  readonly description: string;
}

const MAX_SERVICE_TIERS = 32;
const MAX_TIER_NAME_LENGTH = 64;
const MAX_TIER_DESCRIPTION_LENGTH = 256;

function boundedTierText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value
    && !/[\u0000-\u001F\u007F]/.test(value)
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

/** Accept only the bounded, explicit Ultrafast declaration from an authenticated native roster. */
export function parseCodexUltrafastTier(row: {
  readonly service_tiers?: unknown;
  readonly additional_speed_tiers?: unknown;
}): CodexUltrafastTier | undefined {
  const tiers = row.service_tiers;
  const speeds = row.additional_speed_tiers;
  if (!Array.isArray(tiers) || tiers.length === 0 || tiers.length > MAX_SERVICE_TIERS
    || !Array.isArray(speeds) || speeds.length === 0 || speeds.length > MAX_SERVICE_TIERS) return undefined;

  const declarations = tiers.filter(tier => (
    !!tier && typeof tier === "object" && !Array.isArray(tier)
    && (tier as { id?: unknown }).id === "ultrafast"
  ));
  const speedDeclarations = speeds.filter(speed => speed === "ultrafast");
  if (declarations.length !== 1 || speedDeclarations.length !== 1) return undefined;

  const declaration = declarations[0] as { name?: unknown; description?: unknown };
  if (!boundedTierText(declaration.name, MAX_TIER_NAME_LENGTH)
    || !boundedTierText(declaration.description, MAX_TIER_DESCRIPTION_LENGTH)) return undefined;
  return { id: "ultrafast", name: declaration.name, description: declaration.description };
}
