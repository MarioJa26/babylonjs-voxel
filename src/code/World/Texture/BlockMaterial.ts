// World/Texture/BlockMaterial.ts
//
// Worker-safe single source of truth for virtual mason shape-variant IDs.
//
// Virtual IDs are allocated deterministically and must match BlockTextures.ts
// and Shape/BlockShapes.ts:
//
//   virtualId =
//       VIRTUAL_BLOCK_ID_START +
//       (sourceBlockId - 1) * VIRTUAL_SHAPE_COUNT +
//       shapeIdx
//
// VIRTUAL_SHAPE_COUNT = 5:
//   0 = slab
//   1 = stairs
//   2 = half_wall
//   3 = pane
//   4 = fence
//
// Material lookups must resolve virtual IDs through getSourceBlockId() so
// transparent materials such as glass and water retain their behavior.
//
// Liquids (water, lava, oil) are classified by LiquidRegistry; this module
// only delegates so every worker import path sees one behavior.

import { isLiquidSourceId } from "../Liquid/LiquidRegistry";

export const VIRTUAL_BLOCK_ID_START = 500;
export const VIRTUAL_SHAPE_COUNT = 5;

/** Block IDs are packed into 10 bits. */
export const BLOCK_ID_LIMIT = 1024;

/**
 * Highest source ID whose complete set of variants fits in the block-ID space.
 *
 * Worst case:
 *
 *   START + (source - 1) * COUNT + (COUNT - 1) <= BLOCK_ID_LIMIT - 1
 */
const BLOCK_BUDGET_SOURCE_MAX =
	Math.floor(
		(BLOCK_ID_LIMIT - 1 - VIRTUAL_BLOCK_ID_START - (VIRTUAL_SHAPE_COUNT - 1)) /
			VIRTUAL_SHAPE_COUNT,
	) + 1;

/**
 * Source IDs 101 and above would generate IDs starting at 1000, colliding
 * with hand-authored tool items. Keep all generated variants below 1000.
 */
export const MAX_SHAPE_VARIANT_SOURCE_ID = Math.min(
	100,
	BLOCK_BUDGET_SOURCE_MAX,
);

/** Number of generated virtual block IDs. */
export const VIRTUAL_BLOCK_ID_COUNT =
	MAX_SHAPE_VARIANT_SOURCE_ID * VIRTUAL_SHAPE_COUNT;

/** Exclusive upper bound of the generated virtual block-ID range. */
export const VIRTUAL_BLOCK_ID_END =
	VIRTUAL_BLOCK_ID_START + VIRTUAL_BLOCK_ID_COUNT;

export const GLASS_01_BLOCK_ID = 60;
export const GLASS_02_BLOCK_ID = 61;
export const WATER_SOURCE_BLOCK_ID = 30;

/**
 * Returns true only for IDs that belong to the generated virtual block range.
 *
 * IDs at or above VIRTUAL_BLOCK_ID_END are not virtual blocks, even if they
 * are numerically above VIRTUAL_BLOCK_ID_START.
 */
export function isVirtualBlockId(blockId: number): boolean {
	return (
		Number.isInteger(blockId) &&
		blockId >= VIRTUAL_BLOCK_ID_START &&
		blockId < VIRTUAL_BLOCK_ID_END
	);
}

/**
 * Maps a valid virtual block ID back to its material source.
 *
 * Non-virtual, out-of-range, and non-integer values are returned unchanged.
 */
export function getSourceBlockId(blockId: number): number {
	if (!isVirtualBlockId(blockId)) {
		return blockId;
	}

	return (
		Math.floor((blockId - VIRTUAL_BLOCK_ID_START) / VIRTUAL_SHAPE_COUNT) + 1
	);
}

/**
 * Returns all virtual variants derived from a source block:
 * slab, stairs, half-wall, pane, and fence.
 *
 * Sources outside the configured variant range return an empty array.
 */
export function getVirtualBlockIdsForSource(sourceBlockId: number): number[] {
	if (
		!Number.isInteger(sourceBlockId) ||
		sourceBlockId < 1 ||
		sourceBlockId > MAX_SHAPE_VARIANT_SOURCE_ID
	) {
		return [];
	}

	const base =
		VIRTUAL_BLOCK_ID_START + (sourceBlockId - 1) * VIRTUAL_SHAPE_COUNT;

	return [base, base + 1, base + 2, base + 3, base + 4];
}

export function isGlassSourceId(sourceId: number): boolean {
	return sourceId === GLASS_01_BLOCK_ID || sourceId === GLASS_02_BLOCK_ID;
}

export function isWaterSourceId(sourceId: number): boolean {
	return sourceId === WATER_SOURCE_BLOCK_ID;
}

/**
 * Returns true for transparent source materials.
 *
 * A switch avoids allocating or consulting a Set for this small, fixed list.
 */
export function isTransparentSourceId(sourceId: number): boolean {
	switch (sourceId) {
		case GLASS_01_BLOCK_ID:
		case GLASS_02_BLOCK_ID:
		case 64:
		case 66:
			return true;

		default:
			return isLiquidSourceId(sourceId);
	}
}

/** True for base glass IDs and valid virtual variants derived from glass. */
export function isGlassBlockId(blockId: number): boolean {
	return (
		Number.isInteger(blockId) && isGlassSourceId(getSourceBlockId(blockId))
	);
}

/** True for the base water ID and valid virtual variants derived from water. */
export function isWaterBlockId(blockId: number): boolean {
	return (
		Number.isInteger(blockId) && isWaterSourceId(getSourceBlockId(blockId))
	);
}

/**
 * True for transparent base materials and valid virtual variants inheriting
 * from those materials.
 */
export function isTransparentBlockId(blockId: number): boolean {
	return (
		Number.isInteger(blockId) &&
		isTransparentSourceId(getSourceBlockId(blockId))
	);
}

/** Water filters full sunlight, including valid virtual water variants. */
export function isFullSunFilterBlockId(blockId: number): boolean {
	return (
		Number.isInteger(blockId) && isWaterSourceId(getSourceBlockId(blockId))
	);
}
