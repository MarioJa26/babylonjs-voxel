import { packChunkKeyFast } from "../../Storage/ChunkKey.js";
import type { Chunk } from "../Chunk";
import { packCoords } from "../DataStructures/ChunkCoords";

export const chunkInstances = new Map<bigint, Chunk>();
export const chunkByNumericKey = new Map<number, Chunk>();

// 8 sets x 4 ways = 32 cache entries.
// A lookup examines only the four entries belonging to its coordinate hash.
const FAST_SET_COUNT = 8;
const FAST_WAYS = 4;
const FAST_SLOTS = FAST_SET_COUNT * FAST_WAYS;
const FAST_SET_MASK = FAST_SET_COUNT - 1;
const FAST_WAY_MASK = FAST_WAYS - 1;

const EMPTY_COORDINATE = 0x7fffffff;

const fastX = new Int32Array(FAST_SLOTS).fill(EMPTY_COORDINATE);
const fastY = new Int32Array(FAST_SLOTS).fill(EMPTY_COORDINATE);
const fastZ = new Int32Array(FAST_SLOTS).fill(EMPTY_COORDINATE);
const fastChunks: (Chunk | undefined)[] = new Array(FAST_SLOTS).fill(undefined);

// Distinguishes a cached miss from an unused slot.
const fastOccupied = new Uint8Array(FAST_SLOTS);

// Round-robin replacement cursor for each set.
const fastCursors = new Uint8Array(FAST_SET_COUNT);

// Positive cache entries can be invalidated directly without scanning all slots.
const fastSlotByChunk = new WeakMap<Chunk, number>();

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

function getFastSet(x: number, y: number, z: number): number {
	return (
		(Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) &
		FAST_SET_MASK
	);
}

function clearFastSlot(index: number): void {
	if (fastOccupied[index] === 0) {
		return;
	}

	const cached = fastChunks[index];

	if (cached !== undefined && fastSlotByChunk.get(cached) === index) {
		fastSlotByChunk.delete(cached);
	}

	fastOccupied[index] = 0;
	fastX[index] = EMPTY_COORDINATE;
	fastY[index] = EMPTY_COORDINATE;
	fastZ[index] = EMPTY_COORDINATE;
	fastChunks[index] = undefined;
}

function writeFastSlot(
	index: number,
	x: number,
	y: number,
	z: number,
	chunk: Chunk | undefined,
): void {
	clearFastSlot(index);

	if (chunk !== undefined) {
		// Preserve the invariant that a Chunk has at most one positive
		// entry in the fast cache.
		const previousIndex = fastSlotByChunk.get(chunk);

		if (previousIndex !== undefined && previousIndex !== index) {
			clearFastSlot(previousIndex);
		}

		fastSlotByChunk.set(chunk, index);
	}

	fastX[index] = x;
	fastY[index] = y;
	fastZ[index] = z;
	fastChunks[index] = chunk;
	fastOccupied[index] = 1;
}

export function invalidateFastChunkCache(chunk: Chunk): void {
	// Clear the positive entry by object identity in O(1).
	const chunkSlot = fastSlotByChunk.get(chunk);

	if (chunkSlot !== undefined) {
		clearFastSlot(chunkSlot);
	}

	// Cached misses have no Chunk reference, so inspect only the four slots
	// that could contain this coordinate.
	const setStart =
		getFastSet(chunk.chunkX, chunk.chunkY, chunk.chunkZ) * FAST_WAYS;

	for (let way = 0; way < FAST_WAYS; way++) {
		const index = setStart + way;

		if (
			fastOccupied[index] !== 0 &&
			fastX[index] === chunk.chunkX &&
			fastY[index] === chunk.chunkY &&
			fastZ[index] === chunk.chunkZ
		) {
			clearFastSlot(index);
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

	// Clears both stale positive entries and cached misses.
	invalidateFastChunkCache(chunk);
}

export function unregisterChunk(chunk: Chunk): void {
	chunkInstances.delete(chunk.id);

	if (inNumericRange(chunk.chunkX, chunk.chunkY, chunk.chunkZ)) {
		chunkByNumericKey.delete(
			packChunkKeyFast(chunk.chunkX, chunk.chunkY, chunk.chunkZ),
		);
	}

	// Prevents getChunkFast from returning an unregistered cached chunk.
	invalidateFastChunkCache(chunk);
}

export function getChunkFast(
	x: number,
	y: number,
	z: number,
): Chunk | undefined {
	const set = getFastSet(x, y, z);
	const setStart = set * FAST_WAYS;

	for (let way = 0; way < FAST_WAYS; way++) {
		const index = setStart + way;

		if (
			fastOccupied[index] === 0 ||
			fastX[index] !== x ||
			fastY[index] !== y ||
			fastZ[index] !== z
		) {
			continue;
		}

		const cached = fastChunks[index];

		// undefined represents a valid cached miss.
		if (cached === undefined) {
			return undefined;
		}

		if (cached.chunkX === x && cached.chunkY === y && cached.chunkZ === z) {
			return cached;
		}

		// The Chunk object changed coordinates without prior invalidation.
		clearFastSlot(index);
		break;
	}

	const chunk = inNumericRange(x, y, z)
		? chunkByNumericKey.get(packChunkKeyFast(x, y, z))
		: chunkInstances.get(packCoords(x, y, z));

	const replacementWay = fastCursors[set];
	const replacementIndex = setStart + replacementWay;

	fastCursors[set] = (replacementWay + 1) & FAST_WAY_MASK;

	writeFastSlot(replacementIndex, x, y, z, chunk);

	return chunk;
}
