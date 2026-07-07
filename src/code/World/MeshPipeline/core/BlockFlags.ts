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

const BLOCK_FLAGS_CACHE = new Uint8Array(DENSE_CACHE_SIZE);
const BLOCK_FLAGS_READY = new Uint8Array(DENSE_CACHE_SIZE);
const BLOCK_ID_CACHE = new Uint16Array(DENSE_CACHE_SIZE);
const BLOCK_ID_READY = new Uint8Array(DENSE_CACHE_SIZE);
const BLOCK_IS_CUBE_CACHE = new Uint8Array(DENSE_CACHE_SIZE);
const BLOCK_IS_CUBE_READY = new Uint8Array(DENSE_CACHE_SIZE);

function canUseDenseCache(packed: number): boolean {
	return packed >= 0 && packed <= DENSE_CACHE_MASK;
}

export function getCachedBlockId(packed: number): number {
	if (!packed) return 0;

	if (canUseDenseCache(packed)) {
		if (BLOCK_ID_READY[packed]) {
			return BLOCK_ID_CACHE[packed];
		}

		const id = unpackBlockId(packed);
		BLOCK_ID_CACHE[packed] = id;
		BLOCK_ID_READY[packed] = 1;
		return id;
	}

	return unpackBlockId(packed);
}

export function getCachedIsCube(packed: number): boolean {
	if (!packed) return false;

	if (canUseDenseCache(packed)) {
		if (BLOCK_IS_CUBE_READY[packed]) {
			return BLOCK_IS_CUBE_CACHE[packed] !== 0;
		}

		const shape = getShapeInfo(packed);
		const isCube = shape.isCube;
		BLOCK_IS_CUBE_CACHE[packed] = isCube ? 1 : 0;
		BLOCK_IS_CUBE_READY[packed] = 1;
		return isCube;
	}

	return getShapeInfo(packed).isCube;
}

export function getCachedFlags(packed: number): number {
	if (!packed) return 0;

	if (canUseDenseCache(packed)) {
		if (BLOCK_FLAGS_READY[packed]) {
			return BLOCK_FLAGS_CACHE[packed];
		}

		const id = unpackBlockId(packed);
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

		BLOCK_FLAGS_CACHE[packed] = flags;
		BLOCK_FLAGS_READY[packed] = 1;
		BLOCK_ID_CACHE[packed] = id;
		BLOCK_ID_READY[packed] = 1;

		return flags;
	}

	// fallback
	const id = unpackBlockId(packed);
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

	return flags;
}
