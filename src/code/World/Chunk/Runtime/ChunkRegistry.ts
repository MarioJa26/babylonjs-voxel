import { packChunkKeyFast } from "../../Storage/ChunkKey.js";
import type { Chunk } from "../Chunk";
import { packCoords } from "../DataStructures/ChunkCoords";

export const chunkInstances = new Map<bigint, Chunk>();
export const chunkByNumericKey = new Map<number, Chunk>();

// 256 sets x 4 ways = 1,024 cache entries.
//
// Each lookup examines only the four entries assigned to its coordinate hash.
// The cache uses round-robin replacement independently within each set.
const FAST_SET_COUNT = 256;
const FAST_WAYS = 4;
const FAST_SLOTS = FAST_SET_COUNT * FAST_WAYS;

const FAST_SET_MASK = FAST_SET_COUNT - 1;
const FAST_WAY_MASK = FAST_WAYS - 1;

const EMPTY_COORDINATE = 0x7fffffff;

// Structure-of-arrays layout keeps coordinate probes compact and avoids
// allocating cache-entry objects.
const fastX = new Int32Array(FAST_SLOTS);
const fastY = new Int32Array(FAST_SLOTS);
const fastZ = new Int32Array(FAST_SLOTS);
const fastChunks: (Chunk | undefined)[] = new Array(FAST_SLOTS);

// Distinguishes an unused slot from a valid cached miss.
//
// fastOccupied[index] === 0:
//     Slot is unused.
//
// fastOccupied[index] === 1 && fastChunks[index] === undefined:
//     Slot contains a cached miss.
const fastOccupied = new Uint8Array(FAST_SLOTS);

// Round-robin replacement cursor for each set.
const fastCursors = new Uint8Array(FAST_SET_COUNT);

// Allows positive entries to be invalidated by Chunk identity without
// scanning the entire cache.
const fastSlotByChunk = new WeakMap<Chunk, number>();

fastX.fill(EMPTY_COORDINATE);
fastY.fill(EMPTY_COORDINATE);
fastZ.fill(EMPTY_COORDINATE);

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

/**
 * Returns the cache set for a coordinate.
 *
 * Only the lowest eight hash bits are required because FAST_SET_COUNT is 256.
 * These constants are the original prime multipliers reduced modulo 256:
 *
 * 73856093 % 256 = 93
 * 19349663 % 256 = 159
 * 83492791 % 256 = 183
 *
 * Math.imul preserves the original signed 32-bit coordinate hashing behavior,
 * including for negative coordinates and coordinates outside the numeric-key
 * range.
 */
function getFastSet(x: number, y: number, z: number): number {
	return (
		(Math.imul(x, 93) ^ Math.imul(y, 159) ^ Math.imul(z, 183)) & FAST_SET_MASK
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
		// Preserve the invariant that each Chunk has at most one positive
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
	// Clear a positive entry directly by object identity.
	const chunkSlot = fastSlotByChunk.get(chunk);

	if (chunkSlot !== undefined) {
		clearFastSlot(chunkSlot);
	}

	// Cached misses contain no Chunk reference. Only inspect the four slots
	// belonging to this coordinate's set.
	const setStart = getFastSet(chunk.chunkX, chunk.chunkY, chunk.chunkZ) << 2;

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
		const numericKey = packChunkKeyFast(
			chunk.chunkX,
			chunk.chunkY,
			chunk.chunkZ,
		);

		chunkByNumericKey.set(numericKey, chunk);
	}

	// Clears stale positive entries and cached misses for this coordinate.
	invalidateFastChunkCache(chunk);
}

export function unregisterChunk(chunk: Chunk): void {
	chunkInstances.delete(chunk.id);

	if (inNumericRange(chunk.chunkX, chunk.chunkY, chunk.chunkZ)) {
		const numericKey = packChunkKeyFast(
			chunk.chunkX,
			chunk.chunkY,
			chunk.chunkZ,
		);

		chunkByNumericKey.delete(numericKey);
	}

	// Prevent getChunkFast from returning the unregistered cached object.
	invalidateFastChunkCache(chunk);
}

export function getChunkFast(
	x: number,
	y: number,
	z: number,
): Chunk | undefined {
	/*
	 * Inline the hash in this hottest function.
	 *
	 * The reduced multipliers produce the same lowest eight hash bits as the
	 * original multipliers, which is all that FAST_SET_MASK retains.
	 */
	const set =
		(Math.imul(x, 93) ^ Math.imul(y, 159) ^ Math.imul(z, 183)) & FAST_SET_MASK;

	// FAST_WAYS is fixed at four.
	const setStart = set << 2;

	let index = setStart;

	if (
		fastOccupied[index] !== 0 &&
		fastX[index] === x &&
		fastY[index] === y &&
		fastZ[index] === z
	) {
		const cached = fastChunks[index];

		// undefined is a valid cached miss.
		if (cached === undefined) {
			return undefined;
		}

		if (cached.chunkX === x && cached.chunkY === y && cached.chunkZ === z) {
			return cached;
		}

		// The object moved without explicit invalidation.
		clearFastSlot(index);
	}

	index = setStart + 1;

	if (
		fastOccupied[index] !== 0 &&
		fastX[index] === x &&
		fastY[index] === y &&
		fastZ[index] === z
	) {
		const cached = fastChunks[index];

		if (cached === undefined) {
			return undefined;
		}

		if (cached.chunkX === x && cached.chunkY === y && cached.chunkZ === z) {
			return cached;
		}

		clearFastSlot(index);
	}

	index = setStart + 2;

	if (
		fastOccupied[index] !== 0 &&
		fastX[index] === x &&
		fastY[index] === y &&
		fastZ[index] === z
	) {
		const cached = fastChunks[index];

		if (cached === undefined) {
			return undefined;
		}

		if (cached.chunkX === x && cached.chunkY === y && cached.chunkZ === z) {
			return cached;
		}

		clearFastSlot(index);
	}

	index = setStart + 3;

	if (
		fastOccupied[index] !== 0 &&
		fastX[index] === x &&
		fastY[index] === y &&
		fastZ[index] === z
	) {
		const cached = fastChunks[index];

		if (cached === undefined) {
			return undefined;
		}

		if (cached.chunkX === x && cached.chunkY === y && cached.chunkZ === z) {
			return cached;
		}

		clearFastSlot(index);
	}

	let chunk: Chunk | undefined;

	// Inline the range check on the cache-miss path.
	if (
		x >= -1048576 &&
		x < 1048576 &&
		z >= -1048576 &&
		z < 1048576 &&
		y >= -1024 &&
		y < 1024
	) {
		chunk = chunkByNumericKey.get(packChunkKeyFast(x, y, z));
	} else {
		chunk = chunkInstances.get(packCoords(x, y, z));
	}

	const replacementWay = fastCursors[set];
	const replacementIndex = setStart + replacementWay;

	fastCursors[set] = (replacementWay + 1) & FAST_WAY_MASK;

	writeFastSlot(replacementIndex, x, y, z, chunk);

	return chunk;
}
