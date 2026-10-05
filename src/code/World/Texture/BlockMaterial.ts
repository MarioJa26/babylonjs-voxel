// World/Texture/BlockMaterial.ts
//
// Worker-safe single source of truth for virtual mason shape-variant IDs.
//
// Virtual IDs are allocated deterministically (must match BlockTextures.ts
// and Shape/BlockShapes.ts):
//   virtualId = VIRTUAL_BLOCK_ID_START + (sourceBlockId - 1) * VIRTUAL_SHAPE_COUNT + shapeIdx
// with VIRTUAL_SHAPE_COUNT = 5 (slab, stairs, half_wall, pane, fence).
//
// Transparent materials (glass/water) must survive the shape change:
// a glass stairs block must still read as glass, not opaque. Every
// transparency/material lookup should resolve through getSourceBlockId()
// first, so virtual variants inherit their source block's material.

export const VIRTUAL_BLOCK_ID_START = 500;
export const VIRTUAL_SHAPE_COUNT = 5;

/** Block ids are packed into 10 bits (see Chunk/DataStructures/BlockEncoding). */
export const BLOCK_ID_LIMIT = 1024;

/**
 * Highest source block id that could receive shape variants before the highest
 * generated virtual id overflows the 10-bit block-id space.
 *
 * Worst case is shapeIdx = VIRTUAL_SHAPE_COUNT - 1:
 *   START + (source - 1) * COUNT + (COUNT - 1) <= BLOCK_ID_LIMIT - 1
 */
const BLOCK_BUDGET_SOURCE_MAX =
	Math.floor(
		(BLOCK_ID_LIMIT - 1 - VIRTUAL_BLOCK_ID_START - (VIRTUAL_SHAPE_COUNT - 1)) /
			VIRTUAL_SHAPE_COUNT,
	) + 1;

/**
 * Highest source block id that actually gets shape variants.
 *
 * The 10-bit budget allows 104, but the real ceiling is lower: source block
 * 101 maps to virtual ids 1000-1004, which collide with the hand-authored
 * wooden tool items (1000-1004), and 102/103/104 collide with the stone
 * (1005-1009) and iron (1010-1014) tool items. Those collisions were silent —
 * `registerItem` shallow-merges, so the tool's icon and `maxStack: 1` survived
 * while its name, blockId and useAction were overwritten, turning each tool
 * into a placeable ore slab.
 *
 * Capping at 100 keeps every generated virtual id below 1000 and leaves
 * 101-499 free for real blocks. Blocks 101-104 (ruby / sapphire / emerald ore
 * and TempleGlyph) therefore place as cubes only, which costs nothing.
 */
export const MAX_SHAPE_VARIANT_SOURCE_ID = Math.min(
	100,
	BLOCK_BUDGET_SOURCE_MAX,
);

/** Number of virtual variant ids generated below {@link MAX_SHAPE_VARIANT_SOURCE_ID}. */
export const VIRTUAL_BLOCK_ID_COUNT =
	MAX_SHAPE_VARIANT_SOURCE_ID * VIRTUAL_SHAPE_COUNT;

export const GLASS_01_BLOCK_ID = 60;
export const GLASS_02_BLOCK_ID = 61;
export const WATER_SOURCE_BLOCK_ID = 30;

/** Base IDs that count as transparent for occlusion/meshing/light. */
const TRANSPARENT_BASE_IDS = new Set([30, 60, 61, 64, 66]);

export function isVirtualBlockId(blockId: number): boolean {
	return (
		typeof blockId === "number" &&
		Number.isInteger(blockId) &&
		blockId >= VIRTUAL_BLOCK_ID_START
	);
}

/**
 * Map any block ID back to its material source.
 * Non-virtual IDs return unchanged; virtual IDs return the source cube ID.
 * Out-of-range / non-integer inputs return the input unchanged.
 */
export function getSourceBlockId(blockId: number): number {
	if (
		typeof blockId !== "number" ||
		!Number.isFinite(blockId) ||
		blockId < VIRTUAL_BLOCK_ID_START
	) {
		return blockId;
	}
	const offset = Math.floor(blockId) - VIRTUAL_BLOCK_ID_START;
	if (offset < 0) return blockId;
	const source = Math.floor(offset / VIRTUAL_SHAPE_COUNT) + 1;
	if (source < 1) return blockId;
	return source;
}

/**
 * All virtual IDs derived from one source block (slab/stairs/half_wall/pane/fence).
 */
export function getVirtualBlockIdsForSource(sourceBlockId: number): number[] {
	if (
		typeof sourceBlockId !== "number" ||
		!Number.isFinite(sourceBlockId) ||
		sourceBlockId < 1
	) {
		return [];
	}
	const base =
		VIRTUAL_BLOCK_ID_START +
		(Math.floor(sourceBlockId) - 1) * VIRTUAL_SHAPE_COUNT;
	const out: number[] = [];
	for (let i = 0; i < VIRTUAL_SHAPE_COUNT; i++) out.push(base + i);
	return out;
}

export function isGlassSourceId(sourceId: number): boolean {
	return sourceId === GLASS_01_BLOCK_ID || sourceId === GLASS_02_BLOCK_ID;
}

export function isWaterSourceId(sourceId: number): boolean {
	return sourceId === WATER_SOURCE_BLOCK_ID;
}

/** True for base glass IDs and any virtual variant derived from glass. */
export function isGlassBlockId(blockId: number): boolean {
	if (typeof blockId !== "number" || !Number.isFinite(blockId)) return false;
	return isGlassSourceId(getSourceBlockId(Math.floor(blockId)));
}

/** True for base water ID and any virtual variant derived from water. */
export function isWaterBlockId(blockId: number): boolean {
	if (typeof blockId !== "number" || !Number.isFinite(blockId)) return false;
	return isWaterSourceId(getSourceBlockId(Math.floor(blockId)));
}

/** True for any transparent base material, including via virtual inheritance. */
export function isTransparentBlockId(blockId: number): boolean {
	if (typeof blockId !== "number" || !Number.isFinite(blockId)) return false;
	return TRANSPARENT_BASE_IDS.has(getSourceBlockId(Math.floor(blockId)));
}

/** Water filters full sunlight (carries the tinted-sun behavior). */
export function isFullSunFilterBlockId(blockId: number): boolean {
	if (typeof blockId !== "number" || !Number.isFinite(blockId)) return false;
	return isWaterSourceId(getSourceBlockId(Math.floor(blockId)));
}
