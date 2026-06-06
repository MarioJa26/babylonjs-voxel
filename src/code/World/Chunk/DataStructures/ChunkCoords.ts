// ---------------------------------------------------------------------------
// ChunkCoords
//
// Packed chunk coordinate helpers.  A chunk's packed id is a BigInt
// composed of three signed 21-bit axes.  Same encoding as the old
// packCoords() at the bottom of Chunk.ts — extracted so it can be shared
// with worker-only modules (LightCore, ChunkLightHeader) that must not
// pull in BabylonJS.
// ---------------------------------------------------------------------------

const COORD_AXIS_BITS = 21n;
const COORD_AXIS_MASK = (1n << COORD_AXIS_BITS) - 1n;
const COORD_AXIS_BIAS = 1n << (COORD_AXIS_BITS - 1n);

export function packCoords(x: number, y: number, z: number): bigint {
	const bx = (BigInt(x) + COORD_AXIS_BIAS) & COORD_AXIS_MASK;
	const by = (BigInt(y) + COORD_AXIS_BIAS) & COORD_AXIS_MASK;
	const bz = (BigInt(z) + COORD_AXIS_BIAS) & COORD_AXIS_MASK;
	return bx | (by << COORD_AXIS_BITS) | (bz << (COORD_AXIS_BITS * 2n));
}

export function unpackChunkCoords(id: bigint): {
	x: number;
	y: number;
	z: number;
} {
	const bx = id & COORD_AXIS_MASK;
	const by = (id >> COORD_AXIS_BITS) & COORD_AXIS_MASK;
	const bz = (id >> (COORD_AXIS_BITS * 2n)) & COORD_AXIS_MASK;
	return {
		x: Number(bx - COORD_AXIS_BIAS),
		y: Number(by - COORD_AXIS_BIAS),
		z: Number(bz - COORD_AXIS_BIAS),
	};
}
