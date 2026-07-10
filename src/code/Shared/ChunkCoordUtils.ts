// ---------------------------------------------------------------------------
// ChunkCoordUtils
//
// Pure coordinate-conversion functions extracted from ChunkLoadingSystem to
// break the DistantTerrain ↔ ChunkLoadingSystem ↔ ChunkStreamingController
// import cycle. These have zero dependencies on Chunk, Player, or Map1.
// ---------------------------------------------------------------------------

//Only works for ChunkSize = 32
const CHUNK_SHIFT = 5;
const CHUNK_MASK = 31;

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
