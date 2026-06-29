// ---------------------------------------------------------------------------
// ChunkCoordUtils
//
// Pure coordinate-conversion functions extracted from ChunkLoadingSystem to
// break the DistantTerrain ↔ ChunkLoadingSystem ↔ ChunkStreamingController
// import cycle. These have zero dependencies on Chunk, Player, or Map1.
// ---------------------------------------------------------------------------

import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";

const CHUNK_SIZE = GenerationParams.CHUNK_SIZE;

/**
 * Converts a world coordinate to the chunk coordinate that contains it.
 */
export function worldToChunkCoord(value: number): number {
	return Math.floor(value / CHUNK_SIZE);
}

/**
 * Converts a world coordinate to the local block index (0..CHUNK_SIZE-1)
 * within its chunk.
 */
export function worldToBlockCoord(value: number): number {
	return ((Math.floor(value) % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
}
