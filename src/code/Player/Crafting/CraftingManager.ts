// c:\Users\M\Desktop\mygame\b102\src\code\Player\Crafting\CraftingManager.ts

export interface Ingredient {
	itemId: number;
	count: number;
}

export interface Recipe {
	resultId: number;
	resultCount: number;
	ingredients: Ingredient[];
	/**
	 * Station this recipe must be performed at, or undefined for a hand recipe.
	 *
	 * Deliberately a plain string rather than an import from StationTypes: the
	 * crafting table must not depend on the station subsystem, and nothing here
	 * needs the kind list.
	 */
	station?:
		| "kiln"
		| "furnace"
		| "crucible"
		| "anvil"
		| "whetstone"
		| "smeltery";
	/** Min MaterialTier of the station cap required. */
	minTier?: number;
}

/** Whether a recipe is a hand recipe — craftable from the inventory. */
export function isHandRecipe(recipe: Recipe): boolean {
	return recipe.station === undefined;
}

export const Recipes: Recipe[] = [
	// Wood log -> 4 wood blocks (id 35)
	{ resultId: 35, resultCount: 4, ingredients: [{ itemId: 10, count: 1 }] }, // BarkWillow02
	{ resultId: 35, resultCount: 4, ingredients: [{ itemId: 22, count: 1 }] }, // PineBark
	{ resultId: 35, resultCount: 4, ingredients: [{ itemId: 28, count: 1 }] }, // BarkBrown02
	{ resultId: 35, resultCount: 4, ingredients: [{ itemId: 31, count: 1 }] }, // BarkBrown01
	{ resultId: 35, resultCount: 4, ingredients: [{ itemId: 33, count: 1 }] }, // MetasequoiaBark
	{ resultId: 35, resultCount: 4, ingredients: [{ itemId: 42, count: 1 }] }, // WoodTrunkWall
	{ resultId: 35, resultCount: 4, ingredients: [{ itemId: 73, count: 1 }] }, // BirchBark
	{ resultId: 35, resultCount: 4, ingredients: [{ itemId: 85, count: 1 }] }, // PalmTrunk
	{ resultId: 35, resultCount: 4, ingredients: [{ itemId: 87, count: 1 }] }, // SierranConiferBark
	{ resultId: 35, resultCount: 4, ingredients: [{ itemId: 95, count: 1 }] }, // MangroveWood
	// Wooden tools from 5 wood planks (id 5). Placeholder tool items (ids 1000-1004).
	{
		resultId: 1000,
		resultCount: 1,
		ingredients: [{ itemId: 35, count: 5 }], // 5 Wood Planks -> Wooden Pickaxe
	},
	{
		resultId: 1001,
		resultCount: 1,
		ingredients: [{ itemId: 35, count: 5 }], // 5 Wood Planks -> Wooden Sword
	},
	{
		resultId: 1002,
		resultCount: 1,
		ingredients: [{ itemId: 35, count: 5 }], // 5 Wood Planks -> Wooden Axe
	},
	{
		resultId: 1003,
		resultCount: 1,
		ingredients: [{ itemId: 35, count: 5 }], // 5 Wood Planks -> Wooden Shovel
	},
	{
		resultId: 1004,
		resultCount: 1,
		ingredients: [{ itemId: 35, count: 5 }], // 5 Wood Planks -> Wooden Hoe
	},
	// Stone tools: 2 wood planks (id 5) + 3 stone (id 1). Placeholder tool items (ids 1005-1009).
	{
		resultId: 1005,
		resultCount: 1,
		ingredients: [
			{ itemId: 35, count: 2 }, // 2 Wood Planks
			{ itemId: 1, count: 3 }, // 3 Stone
		],
	},
	{
		resultId: 1006,
		resultCount: 1,
		ingredients: [
			{ itemId: 35, count: 2 }, // 2 Wood Planks
			{ itemId: 1, count: 3 }, // 3 Stone
		],
	},
	{
		resultId: 1007,
		resultCount: 1,
		ingredients: [
			{ itemId: 35, count: 2 }, // 2 Wood Planks
			{ itemId: 1, count: 3 }, // 3 Stone
		],
	},
	{
		resultId: 1008,
		resultCount: 1,
		ingredients: [
			{ itemId: 35, count: 2 }, // 2 Wood Planks
			{ itemId: 1, count: 3 }, // 3 Stone
		],
	},
	{
		resultId: 1009,
		resultCount: 1,
		ingredients: [
			{ itemId: 35, count: 2 }, // 2 Wood Planks
			{ itemId: 1, count: 3 }, // 3 Stone
		],
	},
	// WoodCrate: 10 wood planks -> 1 WoodCrate (id 92)
	{
		resultId: 92,
		resultCount: 1,
		ingredients: [{ itemId: 35, count: 10 }],
	},
	// Add more recipes here
	// Arrow ammunition: 1 material + 1 stick → 4 arrows
	{
		resultId: 1023,
		resultCount: 4,
		ingredients: [{ itemId: 35, count: 1 }],
	}, // Wooden Arrow
	{
		resultId: 1040,
		resultCount: 4,
		ingredients: [
			{ itemId: 1021, count: 1 },
			{ itemId: 1023, count: 4 },
		],
	}, // Iron Arrow
	{
		resultId: 1041,
		resultCount: 4,
		ingredients: [
			{ itemId: 1025, count: 1 },
			{ itemId: 1023, count: 4 },
		],
	}, // Gold Arrow
	{
		resultId: 1042,
		resultCount: 4,
		ingredients: [
			{ itemId: 1019, count: 1 },
			{ itemId: 1023, count: 4 },
		],
	}, // Coal Arrow
	{
		resultId: 1043,
		resultCount: 4,
		ingredients: [
			{ itemId: 1026, count: 1 },
			{ itemId: 1023, count: 4 },
		],
	}, // Copper Arrow
	{
		resultId: 1044,
		resultCount: 4,
		ingredients: [
			{ itemId: 60, count: 1 },
			{ itemId: 1023, count: 4 },
		],
	}, // Glass Arrow
	{
		resultId: 1045,
		resultCount: 1,
		ingredients: [
			{ itemId: 100, count: 1 },
			{ itemId: 1023, count: 1 },
		],
	},
	{
		resultId: 1049,
		resultCount: 1,
		ingredients: [{ itemId: 1046, count: 1 }],
	},
	{
		resultId: 1050,
		resultCount: 1,
		ingredients: [{ itemId: 1047, count: 1 }],
	},
	{
		resultId: 1051,
		resultCount: 1,
		ingredients: [{ itemId: 1048, count: 1 }],
	},
	// ─── Leather armour (tier 0) ───
	// Hides come from cows; leather is the first material on the ladder and the
	// first thing with an equipment slot.
	{
		resultId: 1119,
		resultCount: 3,
		ingredients: [{ itemId: 1118, count: 1 }],
	},
	{
		resultId: 1120,
		resultCount: 1,
		ingredients: [{ itemId: 1119, count: 5 }],
	},
	{
		resultId: 1121,
		resultCount: 1,
		ingredients: [{ itemId: 1119, count: 8 }],
	},
	{
		resultId: 1122,
		resultCount: 1,
		ingredients: [{ itemId: 1119, count: 7 }],
	},
	{
		resultId: 1123,
		resultCount: 1,
		ingredients: [{ itemId: 1119, count: 4 }],
	},
	// ─── Station blocks ───
	// Crafted by hand so a player is never stranded without a way to make the
	// stations that produce everything else. These are the recipe *items*; the
	// blocks themselves place from the auto-registered block item.
	{
		resultId: 105,
		resultCount: 1,
		ingredients: [{ itemId: 1, count: 8 }],
	},
	{
		resultId: 106,
		resultCount: 1,
		ingredients: [
			{ itemId: 105, count: 1 },
			{ itemId: 1, count: 4 },
		],
	},
	{
		resultId: 107,
		resultCount: 1,
		ingredients: [
			{ itemId: 1, count: 4 },
			{ itemId: 35, count: 1 },
		],
	},
	{
		resultId: 108,
		resultCount: 1,
		ingredients: [
			{ itemId: 1, count: 8 },
			{ itemId: 1021, count: 2 },
		],
		station: "crucible",
		minTier: 3,
	},
	{
		resultId: 109,
		resultCount: 1,
		ingredients: [
			{ itemId: 1, count: 8 },
			{ itemId: 1021, count: 3 },
		],
		station: "crucible",
		minTier: 3,
	},
	{
		resultId: 110,
		resultCount: 1,
		ingredients: [
			{ itemId: 1, count: 16 },
			{ itemId: 1025, count: 4 },
		],
		station: "smeltery",
		minTier: 6,
	},
	// ─── Alloys ───
	// Two inputs, so these are crafting recipes gated on a station rather than
	// station smelts: mixing metals happens in the crucible, not in a smelt chain.
	{
		resultId: 1126,
		resultCount: 1,
		ingredients: [
			{ itemId: 1026, count: 3 }, // Copper Ingot
			{ itemId: 1125, count: 1 }, // Tin Ingot
		],
		station: "crucible",
		minTier: 3,
	},
	// ─── Smithing ───
	// Chainmaking lives in STATION_RECIPES, not here: draw-wire and weave-chain
	// are single-input transforms that fit an anvil's input slot, so they run at
	// the station itself and the panel shows the result. Only the alloy recipes,
	// which need two inputs at once, stay in the crafting list.
];

export interface MasonRecipe {
	sourceBlockId: number;
	targetShape: string;
	resultBlockId: number;
	resultBlockState: number;
}

export const MasonRecipes: MasonRecipe[] = [];
