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
	// Add more recipes here
];

export interface MasonRecipe {
	sourceBlockId: number;
	targetShape: string;
	resultBlockId: number;
	resultBlockState: number;
}

export const MasonRecipes: MasonRecipe[] = [];
