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
	// Add more recipes here
];
