// ---------------------------------------------------------------------------
// Chunk key packing
//
// Packs (chunkX, chunkY, chunkZ) into a bigint for use as an OPFS lookup key.
// Uses 21 bits per axis (range ±1,048,576) — plenty for any sane render
// distance and well within bigint's safe integer range.
//
// Uses bias-based encoding: each signed axis value is shifted into an unsigned
// [0, 2^21-1] range by adding AXIS_BIAS before packing. This avoids
// two's-complement collisions and ensures packChunkKey/unpackChunkKey are
// exact inverses for all valid inputs.
// ---------------------------------------------------------------------------

const AXIS_BITS = 21n;
const AXIS_MASK = (1n << AXIS_BITS) - 1n;
const AXIS_BIAS = 1n << (AXIS_BITS - 1n); // 1,048,576
const AXIS_MIN = -Number(AXIS_BIAS);
const AXIS_MAX = Number(AXIS_BIAS - 1n);

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
	const x = (BigInt(chunkX) + AXIS_BIAS) & AXIS_MASK;
	const y = (BigInt(chunkY) + AXIS_BIAS) & AXIS_MASK;
	const z = (BigInt(chunkZ) + AXIS_BIAS) & AXIS_MASK;
	return x | (y << AXIS_BITS) | (z << (AXIS_BITS * 2n));
}

export function unpackChunkKey(key: bigint): {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
} {
	const decode = (v: bigint): number => {
		return Number((v & AXIS_MASK) - AXIS_BIAS);
	};
	return {
		chunkX: decode(key),
		chunkY: decode(key >> AXIS_BITS),
		chunkZ: decode(key >> (AXIS_BITS * 2n)),
	};
}
