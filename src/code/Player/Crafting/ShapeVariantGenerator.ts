import {
	getShapeByBlockId,
	getShapeDefinitions,
	shapeInitPromise,
} from "@/code/World/Shape/BlockShapes";
import { getVirtualBlockId } from "@/code/World/Texture/BlockTextures";
import { BlockType } from "@/code/World/Texture/BlockType";
import {
	type TextureDefinition,
	TextureDefinitionMap,
	TextureDefinitions,
	TextureDefinitionsReady,
} from "@/code/World/Texture/TextureDefinitions";
import { ItemRegistry } from "../Inventory/ItemRegistry";
import { type MasonRecipe, MasonRecipes } from "./CraftingManager";

const MASON_SHAPES = ["slab", "stairs", "half_wall", "pane", "fence"] as const;

let _generated = false;

export async function generateShapeVariants(): Promise<void> {
	if (_generated) return;
	_generated = true;

	await TextureDefinitionsReady;
	await shapeInitPromise;

	const shapeDefs = getShapeDefinitions();
	const shapeMap = getShapeByBlockId();

	const shapeIndexByName = new Map<string, number>();
	for (let i = 0; i < shapeDefs.length; i++) {
		shapeIndexByName.set(shapeDefs[i].name, i);
	}

	const sourceBlocks: TextureDefinition[] = [];
	for (const def of TextureDefinitions) {
		if (def.id >= 500) continue;
		if (def.id === BlockType.Air) continue;
		if (def.id === BlockType.MasonTable) continue;

		const shapeDef = shapeDefs[shapeMap[def.id]] ?? shapeDefs[0];
		if (shapeDef.name === "cube") {
			sourceBlocks.push(def);
		}
	}

	for (const sourceDef of sourceBlocks) {
		const sourceShapeDef = shapeDefs[shapeMap[sourceDef.id]] ?? shapeDefs[0];

		for (const targetShape of MASON_SHAPES) {
			if (targetShape === sourceShapeDef.name) continue;

			const shapeIndex = shapeIndexByName.get(targetShape);
			if (shapeIndex === undefined) continue;

			const virtualId = getVirtualBlockId(sourceDef.id, targetShape);
			if (virtualId === null) continue;

			const variantName = `${sourceDef.name}_${targetShape}`;
			const displayName = `${sourceDef.name
				.split("_")
				.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
				.join(" ")} ${targetShape
				.split("_")
				.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
				.join(" ")}`;

			const variantDef: TextureDefinition = {
				id: virtualId,
				name: variantName,
				path: sourceDef.path,
				hardness: sourceDef.hardness,
				shape: targetShape,
			};

			TextureDefinitions.push(variantDef);
			TextureDefinitionMap.set(virtualId, variantDef);

			// Atlas tile is already set by buildBlockTextures() in BlockTextures.ts
			// No need to call setBlockAtlasTile here — workers already have the data

			shapeMap[virtualId] = shapeIndex;

			ItemRegistry.register({
				id: virtualId,
				name: displayName,
				description: `Shape: ${targetShape}\nID: ${virtualId}\nSource: ${sourceDef.name}\nblockId: ${virtualId}\nblockState: 0`,
				useAction: "place_block",
				blockId: virtualId,
				blockState: 0,
				shape: targetShape,
			});

			MasonRecipes.push({
				sourceBlockId: sourceDef.id,
				targetShape,
				resultBlockId: virtualId,
				resultBlockState: 0,
			});
		}
	}
}
