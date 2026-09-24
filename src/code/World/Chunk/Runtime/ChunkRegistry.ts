import { packChunkKeyFast } from "../../Storage/ChunkKey.js";
import type { Chunk } from "../Chunk";
import { packCoords } from "../DataStructures/ChunkCoords";

export const chunkInstances = new Map<bigint, Chunk>();
export const chunkByNumericKey = new Map<number, Chunk>();

const FAST_SLOTS = 8;
const EMPTY_COORDINATE = 0x7fffffff;
const fastX = new Int32Array(FAST_SLOTS).fill(EMPTY_COORDINATE);
const fastY = new Int32Array(FAST_SLOTS).fill(EMPTY_COORDINATE);
const fastZ = new Int32Array(FAST_SLOTS).fill(EMPTY_COORDINATE);
const fastChunks: (Chunk | undefined)[] = new Array(FAST_SLOTS).fill(undefined);
let fastCursor = 0;

function inNumericRange(x: number, y: number, z: number): boolean {
	return (
		x >= -1048576 &&
		x < 1048576 &&
		z >= -1048576 &&
		z < 1048576 &&
		y >= -1024 &&
		y < 1024
	);
}

export function invalidateFastChunkCache(chunk: Chunk): void {
	for (let i = 0; i < FAST_SLOTS; i++) {
		if (
			fastChunks[i] === chunk ||
			(fastX[i] === chunk.chunkX &&
				fastY[i] === chunk.chunkY &&
				fastZ[i] === chunk.chunkZ)
		) {
			fastX[i] = EMPTY_COORDINATE;
			fastY[i] = EMPTY_COORDINATE;
			fastZ[i] = EMPTY_COORDINATE;
			fastChunks[i] = undefined;
		}
	}
}

export function registerChunk(chunk: Chunk): void {
	chunkInstances.set(chunk.id, chunk);
	if (inNumericRange(chunk.chunkX, chunk.chunkY, chunk.chunkZ)) {
		chunkByNumericKey.set(
			packChunkKeyFast(chunk.chunkX, chunk.chunkY, chunk.chunkZ),
			chunk,
		);
	}
	invalidateFastChunkCache(chunk);
}

export function unregisterChunk(chunk: Chunk): void {
	chunkInstances.delete(chunk.id);
	if (inNumericRange(chunk.chunkX, chunk.chunkY, chunk.chunkZ)) {
		chunkByNumericKey.delete(
			packChunkKeyFast(chunk.chunkX, chunk.chunkY, chunk.chunkZ),
		);
	}
}

export function getChunkFast(
	x: number,
	y: number,
	z: number,
): Chunk | undefined {
	for (let i = 0; i < FAST_SLOTS; i++) {
		if (fastX[i] !== x || fastY[i] !== y || fastZ[i] !== z) continue;

		const cached = fastChunks[i];
		if (
			cached !== undefined &&
			cached.chunkX === x &&
			cached.chunkY === y &&
			cached.chunkZ === z
		) {
			return cached;
		}

		fastX[i] = EMPTY_COORDINATE;
		fastY[i] = EMPTY_COORDINATE;
		fastZ[i] = EMPTY_COORDINATE;
		fastChunks[i] = undefined;
		break;
	}

	const chunk = inNumericRange(x, y, z)
		? chunkByNumericKey.get(packChunkKeyFast(x, y, z))
		: chunkInstances.get(packCoords(x, y, z));

	fastX[fastCursor] = x;
	fastY[fastCursor] = y;
	fastZ[fastCursor] = z;
	fastChunks[fastCursor] = chunk;
	fastCursor = (fastCursor + 1) & (FAST_SLOTS - 1);

	return chunk;
}
