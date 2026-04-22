import { unpackBlockId } from "../../BlockEncoding";
import { BLOCK_TYPE } from "../../Chunk/Worker/ChunkMesherConstants";
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

const DENSE_CACHE_SIZE = 1 << 16;
const DENSE_CACHE_MASK = DENSE_CACHE_SIZE - 1;

const BLOCK_FLAGS_CACHE = new Uint8Array(DENSE_CACHE_SIZE);
const BLOCK_FLAGS_READY = new Uint8Array(DENSE_CACHE_SIZE);
const BLOCK_ID_CACHE = new Uint16Array(DENSE_CACHE_SIZE);

function canUseDenseCache(packed: number): boolean {
	return packed >= 0 && packed <= DENSE_CACHE_MASK;
}

export function getCachedBlockId(packed: number): number {
	if (!packed) return 0;

	if (canUseDenseCache(packed)) {
		if (!BLOCK_FLAGS_READY[packed]) {
			const id = unpackBlockId(packed);
			BLOCK_ID_CACHE[packed] = id;
		}
		return BLOCK_ID_CACHE[packed];
	}

	return unpackBlockId(packed);
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

		BLOCK_FLAGS_CACHE[packed] = flags;
		BLOCK_FLAGS_READY[packed] = 1;
		BLOCK_ID_CACHE[packed] = id;

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

	return flags;
}
