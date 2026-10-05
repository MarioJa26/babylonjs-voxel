import { Recipes } from "../Crafting/CraftingManager";
import { MaterialTier, materialTierName } from "./Materials/MaterialTier";
import type { ItemDefinition } from "./Types/InventoryTypes";

// ─── Procedural tool generation ───
// Tool items are generated from a material × kind table instead of being
// enumerated by hand. Each material defines its ingot (used in the crafting
// recipe), the first item id of its 5-tool set, and its stats.
// Ores for these materials are placed procedurally by OreGenerator.

export const TOOL_STICK_ITEM_ID = 1016;

/** Wood and stone tools are hand-authored in public/data/items.json. */
const NO_INGOT = -1;

export interface ToolMaterial {
	name: string;
	tier: MaterialTier;
	/** Ingot item consumed by this material's recipes, or NO_INGOT when hand-authored. */
	ingotItemId: number;
	baseToolItemId: number;
	/** Lowest tier this material can harvest; compared against a block's requiredLevel. */
	miningLevel: number;
	speedMultiplier: number;
	durability: number;
	/** Rune slots available on gear made of this material. 0 disables magic entirely. */
	runeSlots: number;
	/** How readily this material holds a rune inscription. */
	enchantability: number;
}

export interface ToolKind {
	name: string;
	ingotCount: number;
	stickCount: number;
	description: string;
}

export enum ToolKindId {
	Pickaxe = 0,
	Sword = 1,
	Axe = 2,
	Shovel = 3,
	Hoe = 4,
}

export const TOOL_KINDS: ToolKind[] = [
	{
		name: "Pickaxe",
		ingotCount: 3,
		stickCount: 2,
		description: "Mines stone and ores quickly.",
	},
	{
		name: "Sword",
		ingotCount: 2,
		stickCount: 1,
		description: "Deals strong melee damage.",
	},
	{
		name: "Axe",
		ingotCount: 3,
		stickCount: 2,
		description: "Fells trees with ease.",
	},
	{
		name: "Shovel",
		ingotCount: 1,
		stickCount: 2,
		description: "Digs dirt and sand faster.",
	},
	{
		name: "Hoe",
		ingotCount: 2,
		stickCount: 2,
		description: "Tills soil for farming.",
	},
];

/**
 * Wood and stone predate the ingot-driven generator: their items and recipes
 * are hand-authored in public/data/items.json and CraftingManager. They are
 * indexed here anyway so every tool lookup goes through one path, but
 * `ingotItemId: NO_INGOT` keeps the generator from re-registering them.
 */
const LEGACY_TOOL_MATERIALS: ToolMaterial[] = [
	{
		name: "Wooden",
		tier: MaterialTier.Leather,
		ingotItemId: NO_INGOT,
		baseToolItemId: 1000,
		miningLevel: 0,
		speedMultiplier: 1.8,
		durability: 40,
		runeSlots: 0,
		enchantability: 0,
	},
	{
		name: "Stone",
		tier: MaterialTier.Stone,
		ingotItemId: NO_INGOT,
		baseToolItemId: 1005,
		miningLevel: 2,
		speedMultiplier: 2.2,
		durability: 130,
		runeSlots: 0,
		enchantability: 0,
	},
];

export const TOOL_MATERIALS: ToolMaterial[] = [
	{
		name: "Iron",
		tier: MaterialTier.Iron,
		ingotItemId: 1021,
		baseToolItemId: 1010,
		miningLevel: 4,
		speedMultiplier: 2.5,
		durability: 550,
		runeSlots: 1,
		enchantability: 2,
	},
	{
		// Fast but soft, and holds a rune better than anything else in the game.
		name: "Gold",
		tier: MaterialTier.Iron,
		ingotItemId: 1025,
		baseToolItemId: 1027,
		miningLevel: 4,
		speedMultiplier: 3.0,
		durability: 150,
		runeSlots: 1,
		enchantability: 4,
	},
	{
		name: "Copper",
		tier: MaterialTier.Bronze,
		ingotItemId: 1026,
		baseToolItemId: 1032,
		miningLevel: 3,
		speedMultiplier: 2.0,
		durability: 200,
		runeSlots: 0,
		enchantability: 1,
	},
];

/** Resolved facts for one tool item id. Built once from the tables above. */
export interface ToolFacts {
	material: ToolMaterial;
	kind: ToolKindId;
}

const toolIndex = new Map<number, ToolFacts>();

function indexMaterials(rows: readonly ToolMaterial[]): void {
	for (const material of rows) {
		for (let i = 0; i < TOOL_KINDS.length; i++) {
			toolIndex.set(material.baseToolItemId + i, {
				material,
				kind: i as ToolKindId,
			});
		}
	}
}

indexMaterials(LEGACY_TOOL_MATERIALS);
indexMaterials(TOOL_MATERIALS);

/**
 * Registers the full tool sets (2× per material, one recipe per tool) and every
 * crafting recipe that uses the material's ingot. `registerItem` is injected so
 * this module never creates an import cycle with ItemRegistry.
 */
export function registerProceduralTools(
	registerItem: (def: ItemDefinition) => void,
): void {
	for (const material of TOOL_MATERIALS) {
		for (let i = 0; i < TOOL_KINDS.length; i++) {
			const kind = TOOL_KINDS[i]!;
			const itemId = material.baseToolItemId + i;

			registerItem({
				id: itemId,
				name: `${material.name} ${kind.name}`,
				description: `A ${kind.name.toLowerCase()} made of ${material.name}.\n${kind.description}`,
				icon: `/texture/items/${material.name.toLowerCase()}/${kind.name.toLowerCase()}.png`,
				maxStack: 1,
				useAction: "use_tool",
			});

			Recipes.push({
				resultId: itemId,
				resultCount: 1,
				ingredients: [
					{ itemId: material.ingotItemId, count: kind.ingotCount },
					{ itemId: 35, count: kind.stickCount },
				],
			});
		}
	}
}

/** Material and kind for a tool item id, or undefined for non-tools. */
export function getToolFacts(toolItemId: number): ToolFacts | undefined {
	return toolIndex.get(toolItemId);
}

/** Numeric tool kind for a tool item id, or undefined for non-tools. */
export function getToolKind(toolItemId: number): ToolKindId | undefined {
	return toolIndex.get(toolItemId)?.kind;
}

/** Mining-speed multiplier for a tool item id, or undefined for non-tools. */
export function getToolSpeedMultiplier(toolItemId: number): number | undefined {
	return toolIndex.get(toolItemId)?.material.speedMultiplier;
}

/**
 * Mining level of a tool, compared against a block's `requiredLevel`.
 * Bare hands and non-tools are level 0, so an ungated block stays hand-mineable.
 */
export function getToolMiningLevel(toolItemId?: number): number {
	if (!toolItemId) return 0;
	return toolIndex.get(toolItemId)?.material.miningLevel ?? 0;
}

/** Material tier of a tool, or undefined for non-tools. */
export function getToolMaterialTier(
	toolItemId?: number,
): MaterialTier | undefined {
	if (!toolItemId) return undefined;
	return toolIndex.get(toolItemId)?.material.tier;
}

/** Durability budget of a tool, or 0 when the item is not durable. */
export function getToolMaxDurability(toolItemId?: number): number {
	if (!toolItemId) return 0;
	return toolIndex.get(toolItemId)?.material.durability ?? 0;
}

/** Multi-line stat block for a tool's item tooltip, or null if not a tool. */
export function getToolTooltipStats(itemId: number): string | null {
	const facts = getToolFacts(itemId);
	if (facts === undefined) return null;

	const kindName = TOOL_KINDS[facts.kind]!.name;
	const material = facts.material;
	const speed = getToolSpeedMultiplier(itemId);
	const speedText = speed !== undefined ? `${speed}x` : "—";

	const lines = [
		`Kind: ${kindName}`,
		`Material: ${material.name}`,
		// "Harvest tier" rather than "Tier": wood and stone sit at a floor on the
		// same ladder, so the line reports what the tool can harvest rather than
		// implying it is made of the named material.
		`Harvest tier: ${materialTierName(material.tier)} (level ${material.miningLevel})`,
		`Mining speed: ${speedText}`,
		`Durability: ${material.durability}`,
	];

	// Only advertise rune capacity once some tier actually grants it, so the
	// early-game tooltips do not promise a magic system that cannot run yet.
	if (material.runeSlots > 0) {
		lines.push(`Rune slots: ${material.runeSlots}`);
		lines.push(`Enchantability: ${material.enchantability}`);
	}

	return lines.join("\n");
}

/**
 * Durability block for an item's tooltip, or null when it has no budget.
 * Lives here so the material table stays the single source of truth for how
 * long a tool lasts.
 */
export function getDurabilityTooltip(item: {
	durability: number;
	maxDurability: number;
}): string | null {
	const { durability, maxDurability } = item;
	if (maxDurability <= 0) return null;

	if (durability <= 0) {
		return "Durability: SPENT - this tool needs repair before it works";
	}

	// Cross the line at a third remaining, which is roughly where a player
	// starts budgeting repairs.
	const label = durability / maxDurability <= 0.34 ? " (worn)" : "";
	return `Durability: ${durability} / ${maxDurability}${label}`;
}

/** Parse a case-insensitive tool kind name or numeric id to enum. */
export function parseToolKind(value: unknown): ToolKindId | undefined {
	if (typeof value === "number" && Number.isInteger(value)) {
		if (value >= 0 && value < TOOL_KINDS.length) return value as ToolKindId;
		return undefined;
	}
	if (typeof value === "string") {
		const lower = value.toLowerCase();
		for (let i = 0; i < TOOL_KINDS.length; i++) {
			if (TOOL_KINDS[i]!.name.toLowerCase() === lower) return i as ToolKindId;
		}
	}
	return undefined;
}
