import { BlockType } from "./BlockType";
import { FaceName } from "./FaceName";

/**
 * Per-block texture table, fixed-length array indexed by `FaceName`.
 * The `All` slot is always populated when a block has data; per-face
 * slots are `undefined` unless a per-face UV was explicitly set.
 */
export type BlockTextureDef = ([number, number] | undefined)[];

const MAX_BLOCK_TEXTURES = 1024;
const VIRTUAL_BLOCK_ID_START = 500;

const MASON_SHAPES = ["slab", "stairs", "half_wall", "pane", "fence"] as const;
type MasonShape = (typeof MASON_SHAPES)[number];

// Build BlockTextures from TextureDefinitions index order.
// UV coordinates are initially based on index position in the atlas.
export const BlockTextures: (BlockTextureDef | null)[] = buildBlockTextures();

function buildBlockTextures(): (BlockTextureDef | null)[] {
	const maxId = getMaxBlockTypeId();
	const size = Math.max(maxId + 1, MAX_BLOCK_TEXTURES);
	const result: (BlockTextureDef | null)[] = new Array(size).fill(null);

	// Regular blocks: map each block to its sequential atlas tile
	for (let id = 1; id <= maxId; id++) {
		const atlasIndex = id - 1;
		result[id] = createTileDef(atlasIndex % 16, Math.floor(atlasIndex / 16));
	}

	// MasonTable (90) shares WoodPlanks (35) texture
	const woodPlanksTile = getAtlasTileForBlockId(35);
	if (woodPlanksTile && result[90]) {
		result[90] = createTileDef(woodPlanksTile[0], woodPlanksTile[1]);
	}

	// Pre-compute virtual block entries for shape variants (500+).
	// These must exist at module load time so web workers see them.
	for (let id = 1; id <= maxId; id++) {
		const sourceTile = getTileFromResult(result, id);
		if (!sourceTile) continue;

		for (let shapeIdx = 0; shapeIdx < MASON_SHAPES.length; shapeIdx++) {
			const virtualId = getVirtualBlockIdSync(id, MASON_SHAPES[shapeIdx]);
			if (virtualId < size) {
				result[virtualId] = createTileDef(sourceTile[0], sourceTile[1]);
			}
		}
	}

	return result;
}

function createTileDef(col: number, row: number): BlockTextureDef {
	const def: BlockTextureDef = new Array(FaceName.Count).fill(undefined);
	def[FaceName.All] = [col, row];
	return def;
}

function getTileFromResult(
	result: (BlockTextureDef | null)[],
	blockId: number,
): [number, number] | null {
	const def = result[blockId];
	if (!def) return null;
	const uv = def[FaceName.All];
	if (!uv || uv.length < 2) return null;
	return [uv[0], uv[1]];
}

function getMaxBlockTypeId(): number {
	let maxId = 0;
	for (const value of Object.values(BlockType)) {
		if (typeof value === "number" && value > maxId) maxId = value;
	}
	return maxId;
}

function getAtlasTileForBlockId(id: number): [number, number] | null {
	const atlasIndex = id - 1;
	if (atlasIndex < 0) return null;
	return [atlasIndex % 16, Math.floor(atlasIndex / 16)];
}

/**
 * Deterministic virtual block ID allocation.
 * Must match between main thread and workers.
 */
export function getVirtualBlockId(
	sourceBlockId: number,
	shape: string,
): number | null {
	const shapeIdx = MASON_SHAPES.indexOf(shape as MasonShape);
	if (shapeIdx < 0) return null;
	return (
		VIRTUAL_BLOCK_ID_START +
		(sourceBlockId - 1) * MASON_SHAPES.length +
		shapeIdx
	);
}

function getVirtualBlockIdSync(sourceBlockId: number, shape: string): number {
	return getVirtualBlockId(sourceBlockId, shape) ?? -1;
}

export function setBlockAtlasTile(
	blockId: number,
	col: number,
	row: number,
): void {
	while (BlockTextures.length <= blockId) {
		BlockTextures.push(null);
	}
	BlockTextures[blockId] = createTileDef(col, row);
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
