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

const MASON_SHAPE_COUNT = MASON_SHAPES.length;
const MAX_BLOCK_TYPE_ID = getMaxBlockTypeId();
const TEXTURE_CAPACITY = getTextureCapacity(MAX_BLOCK_TYPE_ID);

export const BlockFaceTileX = new Uint8Array(TEXTURE_CAPACITY * FaceName.Count);
export const BlockFaceTileY = new Uint8Array(TEXTURE_CAPACITY * FaceName.Count);

// Sparse AoS kept only for per-face overrides (setBlockAtlasTile). Hot path
// reads BlockFaceTileX/Y directly — no per-block tuple allocation.
export const BlockTextures: (BlockTextureDef | null)[] = buildBlockTextures(
	MAX_BLOCK_TYPE_ID,
	TEXTURE_CAPACITY,
);

function writeDirect(blockId: number, col: number, row: number): void {
	const baseIdx = blockId * FaceName.Count;
	if (baseIdx < 0 || baseIdx + FaceName.Count > BlockFaceTileX.length) return;
	for (let face = 0; face < FaceName.Count; face++) {
		const idx = baseIdx + face;
		BlockFaceTileX[idx] = col;
		BlockFaceTileY[idx] = row;
	}
}

function buildBlockTextures(
	maxId: number,
	size: number,
): (BlockTextureDef | null)[] {
	const result: (BlockTextureDef | null)[] = new Array(size).fill(null);

	// Regular blocks: sequential atlas tiles written directly to typed arrays.
	// No per-block tuple allocation — saves ~80KB + GC.
	for (let id = 1; id <= maxId; id++) {
		const atlasIndex = id - 1;
		writeDirect(id, atlasIndex & 15, atlasIndex >> 4);
	}

	// MasonTable (90) shares WoodPlanks (35) tile.
	writeDirect(90, 34 & 15, 34 >> 4);

	// Virtual shape variants (500+) — direct writes, no intermediate defs.
	for (let id = 1; id <= maxId; id++) {
		const atlasIndex = id - 1;
		const col = atlasIndex & 15;
		const row = atlasIndex >> 4;
		// Only if source was in range (it always is for 1..maxId)
		const virtualBase = VIRTUAL_BLOCK_ID_START + (id - 1) * MASON_SHAPE_COUNT;
		for (let shapeIdx = 0; shapeIdx < MASON_SHAPE_COUNT; shapeIdx++) {
			const virtualId = virtualBase + shapeIdx;
			if (virtualId < size) writeDirect(virtualId, col, row);
		}
	}
	// Re-apply alias after virtual loop to ensure it sticks
	writeDirect(90, 34 & 15, 34 >> 4);

	return result;
}

function createTileDef(col: number, row: number): BlockTextureDef {
	const def = new Array<[number, number] | undefined>(FaceName.Count);
	def[FaceName.All] = [col, row];
	return def;
}

function writePackedTiles(blockId: number, def: BlockTextureDef): void {
	const baseIdx = blockId * FaceName.Count;

	// Preserve old behavior for out-of-capacity dynamic IDs:
	// BlockTextures can grow, but packed typed arrays cannot.
	if (baseIdx < 0 || baseIdx + FaceName.Count > BlockFaceTileX.length) {
		return;
	}

	const allTile = def[FaceName.All];

	for (let face = 0; face < FaceName.Count; face++) {
		const tile = def[face] ?? allTile;
		if (!tile) continue;

		const idx = baseIdx + face;
		BlockFaceTileX[idx] = tile[0];
		BlockFaceTileY[idx] = tile[1];
	}
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

	for (const key in BlockType) {
		const value = BlockType[key as keyof typeof BlockType];
		if (typeof value === "number" && value > maxId) {
			maxId = value;
		}
	}

	return maxId;
}

function getTextureCapacity(maxBlockTypeId: number): number {
	if (maxBlockTypeId <= 0) return MAX_BLOCK_TEXTURES;

	const maxVirtualId =
		VIRTUAL_BLOCK_ID_START +
		(maxBlockTypeId - 1) * MASON_SHAPE_COUNT +
		(MASON_SHAPE_COUNT - 1);

	return Math.max(MAX_BLOCK_TEXTURES, maxBlockTypeId + 1, maxVirtualId + 1);
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
		VIRTUAL_BLOCK_ID_START + (sourceBlockId - 1) * MASON_SHAPE_COUNT + shapeIdx
	);
}

export function setBlockAtlasTile(
	blockId: number,
	col: number,
	row: number,
): void {
	while (BlockTextures.length <= blockId) {
		BlockTextures.push(null);
	}

	const def = createTileDef(col, row);
	BlockTextures[blockId] = def;
	writePackedTiles(blockId, def);
}

export function getAtlasTile(blockId: number | null): [number, number] | null {
	if (blockId === null) return null;
	// Prefer sparse AoS if custom override exists, else typed arrays
	const blockTexture = BlockTextures[blockId];
	if (blockTexture) {
		const uv =
			blockTexture[FaceName.All] ??
			blockTexture[FaceName.Side] ??
			blockTexture[FaceName.Top] ??
			blockTexture[FaceName.Bottom];
		if (uv && uv.length >= 2) return [uv[0], uv[1]];
	}
	if (blockId < 0 || blockId >= TEXTURE_CAPACITY) return null;
	const base = blockId * FaceName.Count + FaceName.All;
	if (base < 0 || base >= BlockFaceTileX.length) return null;
	// Uninitialized but in-range defaults are 0,0 which is valid tile for air; return it
	return [BlockFaceTileX[base], BlockFaceTileY[base]];
}

/**
 * Per-face atlas tile lookup used by the inventory cube icon. Falls back to
 * the generic `All`/`Side` tile when a per-face slot is not set.
 */
export function getFaceAtlasTile(
	blockId: number | null,
	face: FaceName,
): [number, number] | null {
	if (blockId === null) return null;
	const blockTexture = BlockTextures[blockId];
	if (blockTexture) {
		const uv = blockTexture[face] ?? blockTexture[FaceName.All];
		if (uv && uv.length >= 2) return [uv[0], uv[1]];
	}
	if (blockId < 0 || blockId >= TEXTURE_CAPACITY) return null;
	const base = blockId * FaceName.Count;
	if (base < 0 || base + face >= BlockFaceTileX.length) return null;
	return [BlockFaceTileX[base + face], BlockFaceTileY[base + face]];
}
