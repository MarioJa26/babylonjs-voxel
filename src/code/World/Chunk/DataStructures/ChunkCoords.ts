// ---------------------------------------------------------------------------
// ChunkCoords
//
// Packs three signed 21-bit coordinates into one bigint.
// Valid non-wrapping range per axis: -1_048_576 to 1_048_575.
// ---------------------------------------------------------------------------

const COORD_AXIS_BITS = 21n;
const COORD_AXIS_MASK = (1n << COORD_AXIS_BITS) - 1n;
const COORD_AXIS_BIAS = 1n << (COORD_AXIS_BITS - 1n);

const COORD_Y_SHIFT = COORD_AXIS_BITS;
const COORD_Z_SHIFT = COORD_AXIS_BITS * 2n;

export function packCoords(x: number, y: number, z: number): bigint {
	const bx = (BigInt(x) + COORD_AXIS_BIAS) & COORD_AXIS_MASK;
	const by = (BigInt(y) + COORD_AXIS_BIAS) & COORD_AXIS_MASK;
	const bz = (BigInt(z) + COORD_AXIS_BIAS) & COORD_AXIS_MASK;

	return bx | (by << COORD_Y_SHIFT) | (bz << COORD_Z_SHIFT);
}

export function unpackChunkCoords(id: bigint): {
	x: number;
	y: number;
	z: number;
} {
	return {
		x: Number((id & COORD_AXIS_MASK) - COORD_AXIS_BIAS),
		y: Number(((id >> COORD_Y_SHIFT) & COORD_AXIS_MASK) - COORD_AXIS_BIAS),
		z: Number(((id >> COORD_Z_SHIFT) & COORD_AXIS_MASK) - COORD_AXIS_BIAS),
	};
}
