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
import { registerItem } from "../Inventory/ItemRegistry";
import { MasonRecipes } from "./CraftingManager";

const MASON_SHAPES = ["slab", "stairs", "half_wall", "pane", "fence"] as const;

let _generated = false;

function toDisplayName(value: string): string {
	let result = "";
	let capitalizeNext = true;

	for (let i = 0; i < value.length; i++) {
		const ch = value[i];

		if (ch === "_") {
			result += " ";
			capitalizeNext = true;
			continue;
		}

		result += capitalizeNext ? ch.toUpperCase() : ch;
		capitalizeNext = false;
	}

	return result;
}

export async function generateShapeVariants(): Promise<void> {
	if (_generated) return;
	_generated = true;

	await TextureDefinitionsReady;
	await shapeInitPromise;

	const shapeDefs = getShapeDefinitions();
	const shapeMap = getShapeByBlockId();
	const fallbackShapeDef = shapeDefs[0];

	const shapeIndexByName = new Map<string, number>();
	for (let i = 0; i < shapeDefs.length; i++) {
		shapeIndexByName.set(shapeDefs[i].name, i);
	}

	const targetShapes: Array<{
		name: (typeof MASON_SHAPES)[number];
		index: number;
		displayName: string;
	}> = [];

	for (const targetShape of MASON_SHAPES) {
		const index = shapeIndexByName.get(targetShape);
		if (index !== undefined) {
			targetShapes.push({
				name: targetShape,
				index,
				displayName: toDisplayName(targetShape),
			});
		}
	}

	if (targetShapes.length === 0) return;

	const sourceBlocks: TextureDefinition[] = [];

	for (const def of TextureDefinitions) {
		if (
			def.id >= 500 ||
			def.id === BlockType.Air ||
			def.id === BlockType.MasonTable
		) {
			continue;
		}

		const shapeIndex = shapeMap[def.id];
		const shapeDef =
			shapeIndex !== undefined
				? (shapeDefs[shapeIndex] ?? fallbackShapeDef)
				: fallbackShapeDef;

		if (shapeDef.name === "cube") {
			sourceBlocks.push(def);
		}
	}

	for (const sourceDef of sourceBlocks) {
		const sourceDisplayName = toDisplayName(sourceDef.name);

		for (const targetShape of targetShapes) {
			const virtualId = getVirtualBlockId(sourceDef.id, targetShape.name);
			if (virtualId === null) continue;

			const variantDef: TextureDefinition = {
				id: virtualId,
				name: `${sourceDef.name}_${targetShape.name}`,
				path: sourceDef.path,
				hardness: sourceDef.hardness,
				shape: targetShape.name,
				preferredTool: sourceDef.preferredTool,
			};

			TextureDefinitions.push(variantDef);
			TextureDefinitionMap.set(virtualId, variantDef);

			// Atlas tile is already set by buildBlockTextures() in BlockTextures.ts
			// No need to call setBlockAtlasTile here, workers already have the data
			shapeMap[virtualId] = targetShape.index;

			registerItem({
				id: virtualId,
				name: `${sourceDisplayName} ${targetShape.displayName}`,
				description: `Shape: ${targetShape.name}\nID: ${virtualId}\nSource: ${sourceDef.name}\nblockId: ${virtualId}\nblockState: 0`,
				useAction: "place_block",
				blockId: virtualId,
				blockState: 0,
				shape: targetShape.name,
			});

			MasonRecipes.push({
				sourceBlockId: sourceDef.id,
				targetShape: targetShape.name,
				resultBlockId: virtualId,
				resultBlockState: 0,
			});
		}
	}
}
