import type { ItemDefinition } from "./ItemRegistry";
import { Recipes } from "../Crafting/CraftingManager";

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
				icon: "/texture/placeholder.png",
				maxStack: 1,
				useAction: "use_tool",
			});

			Recipes.push({
				resultId: itemId,
				resultCount: 1,
				ingredients: [
					{ itemId: material.ingotItemId, count: kind.ingotCount },
					{ itemId: TOOL_STICK_ITEM_ID, count: kind.stickCount },
				],
			});
		}
	}
}

/** Mining-speed multiplier for a tool item id, or undefined for non-tools. */
export function getToolSpeedMultiplier(toolItemId: number): number | undefined {
	for (const material of TOOL_MATERIALS) {
		const offset = toolItemId - material.baseToolItemId;
		if (offset >= 0 && offset < TOOL_KINDS.length) {
			return material.speedMultiplier;
		}
	}
	return undefined;
}
