import { BlockType } from "./BlockType";
import { FaceName } from "./FaceName";
import type { TextureDefinition } from "./TextureDefinitions";

/**
 * Per-block texture table, fixed-length array indexed by `FaceName`.
 * The `All` slot is always populated when a block has data; per-face
 * slots are `undefined` unless a per-face UV was explicitly set.
 */
export type BlockTextureDef = ([number, number] | undefined)[];

// Build BlockTextures from TextureDefinitions index order.
// UV coordinates are initially based on index position in the atlas.
export const BlockTextures: (BlockTextureDef | null)[] = buildBlockTextures();

function buildBlockTextures(): (BlockTextureDef | null)[] {
	const maxId = getMaxBlockTypeId();
	const result: (BlockTextureDef | null)[] = new Array(maxId + 1).fill(null);

	for (let id = 1; id <= maxId; id++) {
		const atlasIndex = id - 1;
		const def: BlockTextureDef = new Array(FaceName.Count).fill(undefined);
		def[FaceName.All] = [atlasIndex % 16, Math.floor(atlasIndex / 16)];
		result[id] = def;
	}

	return result;
}

function getMaxBlockTypeId(): number {
	let maxId = 0;
	for (const value of Object.values(BlockType)) {
		if (typeof value === "number" && value > maxId) maxId = value;
	}
	return maxId;
}

// Call this after the atlas is built to update UV coordinates
// Pass the UV map from TextureAtlasFactory to avoid importing it (worker compatibility)
export function updateBlockTexturesUV(
	uvMap: Record<string, { u: number; v: number; tileSize: number }>,
	textureDefinitions: TextureDefinition[],
): void {
	if (BlockTextures.length <= 1) return;

	for (
		let i = 1;
		i < BlockTextures.length && i <= textureDefinitions.length;
		i++
	) {
		const def = textureDefinitions[i - 1];
		if (!def || !BlockTextures[i]) continue;

		const uv = uvMap[def.name];
		if (uv) {
			const existing = BlockTextures[i]!;
			existing[FaceName.All] = [Math.round(uv.u * 16), Math.round(uv.v * 16)];
		}
	}
}
export function getAtlasTile(blockId: number | null): [number, number] | null {
	if (blockId === null) return null;

	const blockTexture = BlockTextures[blockId];
	if (!blockTexture) return null;

	const uv =
		blockTexture[FaceName.All] ??
		blockTexture[FaceName.Side] ??
		blockTexture[FaceName.Top] ??
		blockTexture[FaceName.Bottom];

	if (!uv || uv.length < 2) return null;
	return [uv[0], uv[1]];
}
