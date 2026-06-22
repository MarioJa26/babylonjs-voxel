import { BlockType } from "./BlockType";
import { FaceName } from "./FaceName";

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
