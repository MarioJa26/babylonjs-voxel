// ---------------------------------------------------------------------------
// Chunk key packing
//
// Packs (chunkX, chunkY, chunkZ) into a bigint for use as an OPFS lookup key.
// Uses 21 bits per axis (range ±1,048,576) — plenty for any sane render
// distance and well within bigint's safe integer range.
//
// Delegates to the shared packCoords/unpackChunkCoords encoding in
// ChunkCoords.ts so there is a single source of truth for the bias-based
// 21-bit-per-axis layout.
// ---------------------------------------------------------------------------

import {
	packCoords,
	unpackChunkCoords,
} from "../Chunk/DataStructures/ChunkCoords";

const AXIS_BITS = 21;
const AXIS_BIAS = 1 << (AXIS_BITS - 1); // 1,048,576
const AXIS_MIN = -AXIS_BIAS;
const AXIS_MAX = AXIS_BIAS - 1;

function validateAxis(v: number, name: string): void {
	if (!Number.isInteger(v) || v < AXIS_MIN || v > AXIS_MAX) {
		throw new RangeError(
			`${name} out of range: ${v}. Expected ${AXIS_MIN}..${AXIS_MAX}`,
		);
	}
}

export function packChunkKey(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
): bigint {
	validateAxis(chunkX, "chunkX");
	validateAxis(chunkY, "chunkY");
	validateAxis(chunkZ, "chunkZ");
	return packCoords(chunkX, chunkY, chunkZ);
}

export function unpackChunkKey(key: bigint): {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
} {
	const { x, y, z } = unpackChunkCoords(key);
	return { chunkX: x, chunkY: y, chunkZ: z };
}
export const BIAS_XZ = 1 << 20; // 1,048,576
export const RANGE_XZ = 1 << 21; // 2,097,152
export const BIAS_Y = 1 << 10; // 1,024
export const RANGE_Y = 1 << 11; // 2,048

export function packChunkKeyFast(cx: number, cy: number, cz: number): number {
	return ((cx + BIAS_XZ) * RANGE_Y + (cy + BIAS_Y)) * RANGE_XZ + (cz + BIAS_XZ);
}

/**
 * Unpacks a key back into [cx, cy, cz]. Returns a shared scratch tuple,
 * the same convention used by other scratch buffers in this codebase
 * (e.g. the Int32Array(6) voxel-coordinate scratch in ChunkWorkerPool).
 *
 * Read the values out (destructure immediately) before calling unpack
 * again — the tuple is overwritten on the next call. Safe across `await`
 * only if you've already copied cx/cy/cz into locals beforehand.
 */
const _scratch: [number, number, number] = [0, 0, 0];
export function unpackChunkKeyFast(
	key: number,
): readonly [number, number, number] {
	const cz = (key % RANGE_XZ) - BIAS_XZ;
	const rest = Math.floor(key / RANGE_XZ);
	const cy = (rest % RANGE_Y) - BIAS_Y;
	const cx = Math.floor(rest / RANGE_Y) - BIAS_XZ;
	_scratch[0] = cx;
	_scratch[1] = cy;
	_scratch[2] = cz;
	return _scratch;
}
