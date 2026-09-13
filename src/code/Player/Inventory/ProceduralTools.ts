import { Recipes } from "../Crafting/CraftingManager";
import type { ItemDefinition } from "./Types/InventoryTypes";

// ─── Procedural tool generation ───
// Tool items are generated from a material × kind table instead of being
// enumerated by hand. Each material defines its ingot (used in the crafting
// recipe), the first item id of its 5-tool set, and a mining-speed multiplier.
// Ores for these materials are placed procedurally by OreGenerator.

export const TOOL_STICK_ITEM_ID = 1016;

export interface ToolMaterial {
	name: string;
	ingotItemId: number;
	baseToolItemId: number;
	speedMultiplier: number;
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

export const TOOL_MATERIALS: ToolMaterial[] = [
	{
		name: "Iron",
		ingotItemId: 1021,
		baseToolItemId: 1010,
		speedMultiplier: 2.5,
	},
	{
		name: "Gold",
		ingotItemId: 1025,
		baseToolItemId: 1027,
		speedMultiplier: 3.0,
	},
	{
		name: "Copper",
		ingotItemId: 1026,
		baseToolItemId: 1032,
		speedMultiplier: 2.0,
	},
];

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

/** Mining-speed multiplier for Wood/Stone tools (not in TOOL_MATERIALS). */
const STATIC_TOOL_SPEED: Record<number, number> = {
	// Wood 1000-1004
	1000: 1.8,
	1001: 1.8,
	1002: 1.8,
	1003: 1.8,
	1004: 1.8,
	// Stone 1005-1009
	1005: 2.2,
	1006: 2.2,
	1007: 2.2,
	1008: 2.2,
	1009: 2.2,
};

/** Mining-speed multiplier for a tool item id, or undefined for non-tools. */
export function getToolSpeedMultiplier(toolItemId: number): number | undefined {
	for (const material of TOOL_MATERIALS) {
		const offset = toolItemId - material.baseToolItemId;
		if (offset >= 0 && offset < TOOL_KINDS.length) {
			return material.speedMultiplier;
		}
	}
	return STATIC_TOOL_SPEED[toolItemId];
}

/** Numeric tool kind for a tool item id, or undefined for non-tools. */
export function getToolKind(toolItemId: number): ToolKindId | undefined {
	for (const material of TOOL_MATERIALS) {
		const offset = toolItemId - material.baseToolItemId;
		if (offset >= 0 && offset < TOOL_KINDS.length) {
			return offset as ToolKindId;
		}
	}
	if (toolItemId >= 1000 && toolItemId <= 1004) {
		return (toolItemId - 1000) as ToolKindId;
	}
	if (toolItemId >= 1005 && toolItemId <= 1009) {
		return (toolItemId - 1005) as ToolKindId;
	}
	return undefined;
}

/** Multi-line stat block for a tool's item tooltip, or null if not a tool. */
export function getToolTooltipStats(itemId: number): string | null {
	const kind = getToolKind(itemId);
	if (kind === undefined) return null;

	const kindName = TOOL_KINDS[kind]!.name;
	const speed = getToolSpeedMultiplier(itemId);
	const speedText = speed !== undefined ? `${speed}x` : "—";

	return [`Kind: ${kindName}`, `Mining speed: ${speedText}`].join("\n");
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
