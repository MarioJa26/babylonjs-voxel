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
