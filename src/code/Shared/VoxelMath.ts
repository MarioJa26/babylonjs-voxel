// ---------------------------------------------------------------------------
// VoxelMath
//
// Babylon-free, cross-cutting voxel math used by both the main thread and the
// Web Workers (LightCore, chunkWorker, opfs).  Centralising these avoids the
// many copy-pasted constants (CHUNK_SIZE, chunk-size shifts, FACE bit layout
// is in BlockShapes) and bit-twiddling helpers that previously lived in a
// dozen files.
//
// Everything here MUST stay free of BabylonJS / browser-only imports.
// ---------------------------------------------------------------------------

// Chunk dimensions.  Only valid for the hardcoded CHUNK_SIZE = 32 used
// throughout the project; if that ever changes these derive automatically.
export const CHUNK_SIZE = 32;
export const CHUNK_SHIFT = 5;
export const CHUNK_MASK = CHUNK_SIZE - 1;

export const CHUNK_SIZE2 = CHUNK_SIZE * CHUNK_SIZE;
export const CHUNK_SIZE3 = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;

/**
 * Converts a world coordinate to the chunk coordinate that contains it.
 */
export function worldToChunkCoord(value: number): number {
	return Math.floor(value) >> CHUNK_SHIFT;
}

/**
 * Converts a world coordinate to the local block index (0..CHUNK_SIZE-1)
 * within its chunk.
 */
export function worldToBlockCoord(value: number): number {
	return Math.floor(value) & CHUNK_MASK;
}

/**
 * Strided 3D -> 1D voxel index: x + y*size + z*size*size.
 */
export function idx3(x: number, y: number, z: number, size: number): number {
	return x + y * size + z * size * size;
}

/**
 * Strided 2D -> 1D index for column maps: x + z*size.
 */
export function idx2(x: number, z: number, size: number): number {
	return x + z * size;
}

// ---------------------------------------------------------------------------
// Light nibble decode
//
// A packed light value stores sky light in the high nibble and block light in
// the low nibble (each 0..15).  These helpers centralise the split so the
// magic `>> 4 & 0xf` pattern isn't re-inlined at ~20 sites.
// ---------------------------------------------------------------------------

export const LIGHT_NIBBLE_SHIFT = 4;
export const LIGHT_NIBBLE_MASK = 0xf;

/**
 * Bit position of the sky-light nibble within a packed light value.
 * Shared single source so main-thread (Chunk) and worker (LightCore) agree.
 */
export const SKY_LIGHT_SHIFT = 4;

/**
 * Sky light (high nibble) as a 0..15 value.
 */
export function getSkyLight(packed: number): number {
	return (packed >> LIGHT_NIBBLE_SHIFT) & LIGHT_NIBBLE_MASK;
}

/**
 * Block light (low nibble) as a 0..15 value.
 */
export function getBlockLight(packed: number): number {
	return packed & LIGHT_NIBBLE_MASK;
}

/**
 * Packs a sky/block light pair (each 0..15) into a single nibble value.
 */
export function packLight(sky: number, block: number): number {
	return (
		((sky & LIGHT_NIBBLE_MASK) << LIGHT_NIBBLE_SHIFT) |
		(block & LIGHT_NIBBLE_MASK)
	);
}
