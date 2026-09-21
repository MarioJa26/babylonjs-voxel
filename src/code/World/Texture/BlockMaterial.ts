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
