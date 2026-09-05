// c:\Users\M\Desktop\mygame\b102\src\code\Player\Crafting\CraftingManager.ts

export interface Ingredient {
	itemId: number;
	count: number;
}

export interface Recipe {
	resultId: number;
	resultCount: number;
	ingredients: Ingredient[];
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
	}, // TNT Arrow
];

export interface MasonRecipe {
	sourceBlockId: number;
	targetShape: string;
	resultBlockId: number;
	resultBlockState: number;
}

export const MasonRecipes: MasonRecipe[] = [];
