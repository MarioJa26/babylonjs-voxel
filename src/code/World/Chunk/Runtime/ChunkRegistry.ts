import { packChunkKeyFast } from "../../Storage/ChunkKey.js";
import type { Chunk } from "../Chunk";
import { packCoords } from "../DataStructures/ChunkCoords";

export const chunkInstances = new Map<bigint, Chunk>();
export const chunkByNumericKey = new Map<number, Chunk>();

// 256 sets x 4 ways = 1,024 cache entries.
//
// Each lookup examines only the four entries assigned to its coordinate hash.
// Replacement is round-robin independently within each set.
//
// These values must remain powers of two because masking is used instead of
// remainder operations.
const FAST_SET_COUNT = 256;
const FAST_WAYS = 4;
const FAST_SLOTS = FAST_SET_COUNT * FAST_WAYS;

const FAST_SET_MASK = FAST_SET_COUNT - 1;
const FAST_WAY_MASK = FAST_WAYS - 1;
const FAST_SET_SHIFT = 2;

// Numeric-key coordinate limits.
const NUMERIC_XZ_MIN = -1048576;
const NUMERIC_XZ_MAX = 1048576;
const NUMERIC_Y_MIN = -1024;
const NUMERIC_Y_MAX = 1024;

/*
 * Structure-of-arrays layout keeps probes compact and avoids cache-entry
 * object allocations.
 *
 * Coordinate arrays do not need sentinel initialization. fastOccupied is the
 * authoritative validity marker, so values in unoccupied slots are ignored.
 */
const fastX = new Int32Array(FAST_SLOTS);
const fastY = new Int32Array(FAST_SLOTS);
const fastZ = new Int32Array(FAST_SLOTS);
const fastChunks: (Chunk | undefined)[] = new Array(FAST_SLOTS);

/*
 * Distinguishes an unused slot from a cached miss.
 *
 * fastOccupied[index] === 0:
 *     Slot is unused.
 *
 * fastOccupied[index] === 1 && fastChunks[index] === undefined:
 *     Slot contains a cached miss.
 */
const fastOccupied = new Uint8Array(FAST_SLOTS);

// Round-robin replacement cursor for each set.
const fastCursors = new Uint8Array(FAST_SET_COUNT);

/*
 * Allows positive entries to be invalidated by Chunk identity without
 * scanning the complete cache.
 *
 * Each Chunk can have at most one positive fast-cache entry.
 */
const fastSlotByChunk = new WeakMap<Chunk, number>();

function inNumericRange(x: number, y: number, z: number): boolean {
	return (
		x >= NUMERIC_XZ_MIN &&
		x < NUMERIC_XZ_MAX &&
		z >= NUMERIC_XZ_MIN &&
		z < NUMERIC_XZ_MAX &&
		y >= NUMERIC_Y_MIN &&
		y < NUMERIC_Y_MAX
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
 */
function getFastSet(x: number, y: number, z: number): number {
	return (
		(Math.imul(x, 93) ^ Math.imul(y, 159) ^ Math.imul(z, 183)) & FAST_SET_MASK
	);
}

/**
 * Clear one fast-cache slot.
 *
 * Coordinate arrays are deliberately not reset because fastOccupied controls
 * whether their contents are valid. Avoiding those writes reduces cache
 * invalidation work.
 */
function clearFastSlot(index: number): void {
	if (fastOccupied[index] === 0) {
		return;
	}

	const cached = fastChunks[index];

	if (cached !== undefined && fastSlotByChunk.get(cached) === index) {
		fastSlotByChunk.delete(cached);
	}

	fastOccupied[index] = 0;
	fastChunks[index] = undefined;
}

function writeFastSlot(
	index: number,
	x: number,
	y: number,
	z: number,
	chunk: Chunk | undefined,
): void {
	/*
	 * Clear the replacement slot first so its previous positive entry is
	 * removed from fastSlotByChunk.
	 */
	clearFastSlot(index);

	if (chunk !== undefined) {
		/*
		 * Preserve the invariant that each Chunk has at most one positive
		 * cache entry.
		 */
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

	/*
	 * Publish occupancy last. This keeps the slot internally coherent even
	 * though JavaScript execution is single-threaded here.
	 */
	fastOccupied[index] = 1;
}

/**
 * Invalidates a Chunk's positive cache entry and any cached miss stored for
 * its current coordinates.
 */
export function invalidateFastChunkCache(chunk: Chunk): void {
	const x = chunk.chunkX;
	const y = chunk.chunkY;
	const z = chunk.chunkZ;

	/*
	 * Clear a positive entry directly by object identity.
	 */
	const chunkSlot = fastSlotByChunk.get(chunk);

	if (chunkSlot !== undefined) {
		clearFastSlot(chunkSlot);
	}

	/*
	 * Cached misses have no Chunk identity. Only inspect the four slots in the
	 * coordinate's set.
	 */
	const setStart = getFastSet(x, y, z) << FAST_SET_SHIFT;
	const end = setStart + FAST_WAYS;

	for (let index = setStart; index < end; index++) {
		if (
			fastOccupied[index] !== 0 &&
			fastX[index] === x &&
			fastY[index] === y &&
			fastZ[index] === z
		) {
			clearFastSlot(index);
		}
	}
}

export function registerChunk(chunk: Chunk): void {
	const x = chunk.chunkX;
	const y = chunk.chunkY;
	const z = chunk.chunkZ;

	/*
	 * Invalidate before publishing the replacement. This removes a cached miss
	 * and any stale positive cache entry for this object.
	 */
	invalidateFastChunkCache(chunk);

	chunkInstances.set(chunk.id, chunk);

	if (inNumericRange(x, y, z)) {
		chunkByNumericKey.set(packChunkKeyFast(x, y, z), chunk);
	}
}

export function unregisterChunk(chunk: Chunk): void {
	const x = chunk.chunkX;
	const y = chunk.chunkY;
	const z = chunk.chunkZ;

	/*
	 * Delete only when this exact object remains authoritative. A replacement
	 * Chunk may already have been registered for the same ID or coordinates.
	 */
	if (chunkInstances.get(chunk.id) === chunk) {
		chunkInstances.delete(chunk.id);
	}

	if (inNumericRange(x, y, z)) {
		const numericKey = packChunkKeyFast(x, y, z);

		if (chunkByNumericKey.get(numericKey) === chunk) {
			chunkByNumericKey.delete(numericKey);
		}
	}

	/*
	 * Prevent the fast cache from returning the unregistered object. This also
	 * clears any cached entry matching the object's current coordinates.
	 */
	invalidateFastChunkCache(chunk);
}

export function getChunkFast(
	x: number,
	y: number,
	z: number,
): Chunk | undefined {
	/*
	 * Inline the coordinate hash in this hottest function.
	 *
	 * The reduced multipliers produce the same lowest eight bits as the
	 * original multipliers, which is all FAST_SET_MASK retains.
	 */
	const set =
		(Math.imul(x, 93) ^ Math.imul(y, 159) ^ Math.imul(z, 183)) & FAST_SET_MASK;

	const setStart = set << FAST_SET_SHIFT;

	/*
	 * The four ways are intentionally unrolled. This avoids loop bookkeeping
	 * and gives JavaScript engines fixed probe offsets.
	 */
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

		/*
		 * The object moved without explicit invalidation. Remove this stale
		 * positive entry and continue to the authoritative maps.
		 */
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

	/*
	 * Inline the range check on the cache-miss path. Most lookups should return
	 * from the four probes above.
	 */
	if (
		x >= NUMERIC_XZ_MIN &&
		x < NUMERIC_XZ_MAX &&
		z >= NUMERIC_XZ_MIN &&
		z < NUMERIC_XZ_MAX &&
		y >= NUMERIC_Y_MIN &&
		y < NUMERIC_Y_MAX
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
