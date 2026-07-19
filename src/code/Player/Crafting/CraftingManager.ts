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
	{
		resultId: 5, // Example: Wood Planks
		resultCount: 4,
		ingredients: [{ itemId: 28, count: 1 }], // Requires 1 Log (ID 28)
	},
	{
		resultId: 1, // Example: Stone
		resultCount: 1,
		ingredients: [{ itemId: 3, count: 2 }], // Requires 2 Dirt (ID 3) - Just for testing
	},
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
	// Add more recipes here
];

export interface MasonRecipe {
	sourceBlockId: number;
	targetShape: string;
	resultBlockId: number;
	resultBlockState: number;
}

export const MasonRecipes: MasonRecipe[] = [];
