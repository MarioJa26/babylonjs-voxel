import { unpackBlockId } from "../../Chunk/DataStructures/BlockEncoding";
import { BLOCK_TYPE } from "../../Chunk/Worker/ChunkMesherConstants";
import {
	isCrossBlockId,
	isCrossDiagonalBlockId,
} from "../../Shape/BlockShapes";
import { isFenceBlockId } from "../../Shape/FenceConnect";
import { MaterialType } from "../types/MeshTypes";
import {
	getMaterialType,
	getShapeInfo,
	isGreedyCompatiblePackedBlock,
} from "./ShapePipeline";

export const FLAG_SOLID = 1 << 0;
export const FLAG_TRANSPARENT = 1 << 1;
export const FLAG_PARTIAL = 1 << 2;
export const FLAG_GREEDY = 1 << 3;
export const FLAG_WATER_GLASS = 1 << 4;
export const FLAG_CUSTOM_CROSS = 1 << 5;
export const FLAG_CUSTOM_CROSS_DIAGONAL = 1 << 6;
export const FLAG_CUSTOM_FENCE = 1 << 7;

// Glass-specific flag — set for block IDs that are glass (not water).
// Used by VoxelMaskExtractor for transparent interface preference.
const GLASS_BLOCK_IDS = new Set([60, 61]);
const GLASS_LUT = (() => {
	const lut = new Uint8Array(256);
	for (const id of GLASS_BLOCK_IDS) lut[id] = 1;
	return lut;
})();

export function isGlassBlock(blockId: number): boolean {
	return blockId >= 0 && blockId < 256 && GLASS_LUT[blockId] !== 0;
}

const DENSE_CACHE_SIZE = 1 << 16;
const DENSE_CACHE_MASK = DENSE_CACHE_SIZE - 1;

/**
 * Single packed dense cache. Collapses the previous 6 typed arrays into one
 * Uint32Array so the hot getCachedFlagsAndId path is a single aligned load and
 * a single store on miss (instead of 2 ready-probes + 2 data reads/writes).
 *
 * Bit layout per entry:
 *   bit 31     = ready
 *   bit 30     = isCube
 *   bits 16-25 = block id (fits in BLOCK_ID_BITS = 10)
 *   bits 0-15  = flags
 */
const FLAGS_ID_CACHE = new Uint32Array(DENSE_CACHE_SIZE);

const FIC_READY = 1 << 31;
const FIC_ISCUBE = 1 << 30;
const FIC_ID_SHIFT = 16;
const FIC_ID_MASK = 0x3ff << FIC_ID_SHIFT;
const FIC_FLAGS_MASK = 0xffff;

// Sparse overflow fallback (only for packed keys beyond the dense range).
const FLAGS_ID_OVERFLOW = new Map<number, number>();

function canUseDenseCache(packed: number): boolean {
	return packed >= 0 && packed <= DENSE_CACHE_MASK;
}

export function getCachedBlockId(packed: number): number {
	if (!packed) return 0;

	if (canUseDenseCache(packed)) {
		const e = FLAGS_ID_CACHE[packed];
		if (e & FIC_READY) return (e & FIC_ID_MASK) >>> FIC_ID_SHIFT;
	}

	return unpackBlockId(packed);
}

/**
 * Build the full packed cache entry (ready | isCube | id | flags) for a packed
 * block, writing it into the dense cache and returning it. Centralizes the
 * isCube folding so every writer keeps the entry consistent.
 */
function buildEntry(packed: number, id: number): number {
	const shape = getShapeInfo(packed);
	const materialType = getMaterialType(id);
	const greedyCompatible = isGreedyCompatiblePackedBlock(packed);

	let flags = 0;
	if (id !== 0) flags |= FLAG_SOLID;
	if (materialType === MaterialType.WaterOrGlass || BLOCK_TYPE[id] !== 0) {
		flags |= FLAG_TRANSPARENT;
	}
	if (!shape.isCube) flags |= FLAG_PARTIAL;
	if (greedyCompatible) flags |= FLAG_GREEDY;
	if (materialType === MaterialType.WaterOrGlass) flags |= FLAG_WATER_GLASS;
	if (!greedyCompatible) {
		if (isCrossBlockId(id)) flags |= FLAG_CUSTOM_CROSS;
		else if (isCrossDiagonalBlockId(id)) flags |= FLAG_CUSTOM_CROSS_DIAGONAL;
		else if (isFenceBlockId(id)) flags |= FLAG_CUSTOM_FENCE;
	}

	const entry =
		FIC_READY |
		(id << FIC_ID_SHIFT) |
		(flags & FIC_FLAGS_MASK) |
		(shape.isCube ? FIC_ISCUBE : 0);
	return entry >>> 0;
}

/**
 * Combined flags + id lookup — the hot path. Single cache probe; flags in the
 * low 16 bits, id in bits 16-25. Returns 0 only for air (packed === 0).
 */
export function getCachedFlagsAndId(packed: number): number {
	if (!packed) return 0;

	if (canUseDenseCache(packed)) {
		const e = FLAGS_ID_CACHE[packed];
		if (e & FIC_READY) {
			return e & (FIC_FLAGS_MASK | FIC_ID_MASK);
		}

		const id = unpackBlockId(packed);
		const entry = buildEntry(packed, id);
		FLAGS_ID_CACHE[packed] = entry;
		return entry & (FIC_FLAGS_MASK | FIC_ID_MASK);
	}

	const overflow = FLAGS_ID_OVERFLOW.get(packed);
	if (overflow !== undefined) {
		return overflow & (FIC_FLAGS_MASK | FIC_ID_MASK);
	}

	const id = unpackBlockId(packed);
	const entry = buildEntry(packed, id);
	FLAGS_ID_OVERFLOW.set(packed, entry);
	return entry & (FIC_FLAGS_MASK | FIC_ID_MASK);
}

const FLAGS_AND_ID_ID_MASK = 0xffff0000;

export function getFlagsFromCombined(combined: number): number {
	return combined & 0xffff;
}

export function getIdFromCombined(combined: number): number {
	return (combined & FLAGS_AND_ID_ID_MASK) >>> 16;
}

export function getCachedIsCube(packed: number): boolean {
	if (!packed) return false;

	if (canUseDenseCache(packed)) {
		const e = FLAGS_ID_CACHE[packed];
		if (e & FIC_READY) return (e & FIC_ISCUBE) !== 0;
		// Populate via entry build (which derives isCube from shape).
		getCachedFlagsAndId(packed);
		return (FLAGS_ID_CACHE[packed] & FIC_ISCUBE) !== 0;
	}

	return getShapeInfo(packed).isCube;
}

function computeFlags(packed: number, id: number): number {
	return buildEntry(packed, id) & FIC_FLAGS_MASK;
}

export function getCachedFlags(packed: number): number {
	if (!packed) return 0;

	if (canUseDenseCache(packed)) {
		const e = FLAGS_ID_CACHE[packed];
		if (e & FIC_READY) return e & FIC_FLAGS_MASK;
		// buildEntry writes the full entry (incl. isCube); just return flags.
		return buildEntry(packed, unpackBlockId(packed)) & FIC_FLAGS_MASK;
	}

	// fallback
	return computeFlags(packed, unpackBlockId(packed));
}
