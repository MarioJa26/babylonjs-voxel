// ---------------------------------------------------------------------------
// VoxelMath
//
// Babylon-free, cross-cutting voxel math used by both the main thread and Web
// Workers such as LightCore, chunkWorker, and OPFS workers.
//
// Everything in this module must remain free of BabylonJS and browser-only
// imports.
// ---------------------------------------------------------------------------

/**
 * Length of one chunk edge in voxels.
 *
 * CHUNK_SIZE must remain a positive power of two because several optimized
 * indexing paths use CHUNK_SHIFT and CHUNK_MASK.
 */
export const CHUNK_SIZE = 32;

/** log2(CHUNK_SIZE). */
export const CHUNK_SHIFT = 5;

/** Bit mask for local coordinates when inputs are safely representable as i32. */
export const CHUNK_MASK = CHUNK_SIZE - 1;

/** Number of columns or layers in a chunk. */
export const CHUNK_SIZE2 = CHUNK_SIZE * CHUNK_SIZE;

/** Number of voxels in a chunk. */
export const CHUNK_SIZE3 = CHUNK_SIZE2 * CHUNK_SIZE;

// Clearer aliases for call sites that describe area or volume.
export const CHUNK_AREA = CHUNK_SIZE2;
export const CHUNK_VOLUME = CHUNK_SIZE3;

/**
 * Converts a world coordinate to the chunk coordinate containing it.
 *
 * Division is intentional. JavaScript bitwise operators coerce operands to
 * signed 32-bit integers, so `Math.floor(value) >> CHUNK_SHIFT` wraps for
 * sufficiently large positive or negative world coordinates.
 */
export function worldToChunkCoord(value: number): number {
	return Math.floor(value / CHUNK_SIZE);
}

/**
 * Converts a world coordinate to its local block coordinate within a chunk.
 *
 * The result is in [0, CHUNK_SIZE - 1] for every finite input, including
 * negative coordinates.
 *
 * This avoids `& CHUNK_MASK`, which would first coerce the world coordinate
 * to a signed 32-bit integer.
 */
export function worldToBlockCoord(value: number): number {
	const block = Math.floor(value);
	const chunk = Math.floor(block / CHUNK_SIZE);
	return block - chunk * CHUNK_SIZE;
}

/**
 * Converts integer world voxel coordinates to the local voxel index within
 * their containing chunk.
 *
 * Layout:
 *     localX + localY * CHUNK_SIZE + localZ * CHUNK_SIZE²
 */
export function worldToLocalIndex(
	worldX: number,
	worldY: number,
	worldZ: number,
): number {
	const localX = worldToBlockCoord(worldX);
	const localY = worldToBlockCoord(worldY);
	const localZ = worldToBlockCoord(worldZ);

	return localX + localY * CHUNK_SIZE + localZ * CHUNK_SIZE2;
}

/**
 * Converts local chunk coordinates to a dense chunk voxel index.
 *
 * Layout:
 *     x + y * CHUNK_SIZE + z * CHUNK_SIZE²
 *
 * Inputs are expected to be integer coordinates in [0, CHUNK_SIZE - 1].
 */
export function chunkIndex(x: number, y: number, z: number): number {
	return x + y * CHUNK_SIZE + z * CHUNK_SIZE2;
}

/**
 * Converts a strided three-dimensional coordinate to a one-dimensional index.
 *
 * Layout:
 *     x + y * size + z * size²
 *
 * Use chunkIndex() when indexing a normal 32³ chunk. It avoids receiving and
 * multiplying a dynamic size at each call site.
 */
export function idx3(x: number, y: number, z: number, size: number): number {
	return x + y * size + z * size * size;
}

/**
 * Converts a strided two-dimensional column coordinate to a one-dimensional
 * index.
 *
 * Layout:
 *     x + z * size
 */
export function idx2(x: number, z: number, size: number): number {
	return x + z * size;
}

/**
 * Converts a local X/Z chunk column coordinate to its one-dimensional index.
 *
 * Layout:
 *     x + z * CHUNK_SIZE
 */
export function chunkColumnIndex(x: number, z: number): number {
	return x + z * CHUNK_SIZE;
}

// ---------------------------------------------------------------------------
// Packed light helpers
//
// A packed light byte stores sky light in the high nibble and block light in
// the low nibble. Each component has a range of 0..15.
// ---------------------------------------------------------------------------

/** Number of bits occupied by one light component. */
export const LIGHT_NIBBLE_SHIFT = 4;

/** Mask selecting one four-bit light component. */
export const LIGHT_NIBBLE_MASK = 0x0f;

/** Bit position of the sky-light nibble. */
export const SKY_LIGHT_SHIFT = LIGHT_NIBBLE_SHIFT;

/** Mask for packed block light in the low nibble. */
export const BLOCK_LIGHT_MASK = LIGHT_NIBBLE_MASK;

/** Mask for packed sky light in the high nibble. */
export const SKY_LIGHT_MASK = LIGHT_NIBBLE_MASK << SKY_LIGHT_SHIFT;

/**
 * Returns sky light from the high nibble as a value in [0, 15].
 */
export function getSkyLight(packed: number): number {
	return (packed >>> SKY_LIGHT_SHIFT) & LIGHT_NIBBLE_MASK;
}

/**
 * Returns block light from the low nibble as a value in [0, 15].
 */
export function getBlockLight(packed: number): number {
	return packed & BLOCK_LIGHT_MASK;
}

/**
 * Packs sky and block light values into one byte.
 *
 * Values are masked to four bits, preserving the previous wrapping behavior
 * for inputs outside 0..15.
 */
export function packLight(sky: number, block: number): number {
	return (
		((sky & LIGHT_NIBBLE_MASK) << SKY_LIGHT_SHIFT) | (block & BLOCK_LIGHT_MASK)
	);
}

/**
 * Replaces the sky-light nibble while preserving the block-light nibble.
 */
export function withSkyLight(packed: number, sky: number): number {
	return (
		((sky & LIGHT_NIBBLE_MASK) << SKY_LIGHT_SHIFT) | (packed & BLOCK_LIGHT_MASK)
	);
}

/**
 * Replaces the block-light nibble while preserving the sky-light nibble.
 */
export function withBlockLight(packed: number, block: number): number {
	return (packed & SKY_LIGHT_MASK) | (block & BLOCK_LIGHT_MASK);
}
