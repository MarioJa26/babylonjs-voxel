// ─── Material tiers ───
//
// A material tier is the spine of progression. One integer drives mining
// level, tool speed, durability, melee damage, armor value, rune capacity and
// enchantability. Blocks declare a `requiredLevel` in blocks.json and compare it
// against the held tool's material, so a single number gates the world:
//
//   canHarvestBlock(blockId, toolItemId)
//     → getToolMiningLevel(toolItemId) >= def.requiredLevel
//
// Two tools of different materials but the same tier behave identically for
// harvesting and differently only for speed/durability/damage, which keeps the
// ladder readable while leaving tuning room in the material tables.
//
// See plans/progression.md for the full ladder and the phase breakdown.

export const enum MaterialTier {
	Leather = 0,
	Flint = 1,
	Stone = 2,
	Bronze = 3,
	Iron = 4,
	ReinforcedIron = 5,
	Silver = 6,
	ReinforcedSilver = 7,
	UnderworldIron = 8,
	StarSilver = 9,
}

export const MATERIAL_TIER_COUNT = 10;

/** Human-readable tier names, indexed by MaterialTier. */
export const MATERIAL_TIER_NAMES: readonly string[] = [
	"Leather",
	"Flint",
	"Stone",
	"Bronze",
	"Iron",
	"Reinforced Iron",
	"Silver",
	"Reinforced Silver",
	"Underworld Iron",
	"Star Silver",
];

/**
 * Validate a tier read from data (blocks.json `requiredLevel`). Out-of-range
 * values return undefined so the caller can warn and fall back rather than
 * silently gating the player out of every block.
 */
export function clampMaterialTier(value: unknown): MaterialTier | undefined {
	if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
	if (value < 0 || value >= MATERIAL_TIER_COUNT) return undefined;
	return value as MaterialTier;
}

export function materialTierName(tier: MaterialTier): string {
	return MATERIAL_TIER_NAMES[tier] ?? "Unknown";
}
