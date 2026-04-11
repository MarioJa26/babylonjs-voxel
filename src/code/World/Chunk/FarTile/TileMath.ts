// TileMath.ts

import { TileId } from "./FarTileStorage";

// Finest tile = 2×2 chunks
export const TILE_CHUNK_SIZE = 2;

/**
 * Convert a chunk coordinate (chunkX, chunkZ) to tile coordinate.
 */
export function chunkToTileCoords(
  chunkX: number,
  chunkZ: number,
): { regionX: number; regionZ: number } {
  const regionX = Math.floor(chunkX / TILE_CHUNK_SIZE);
  const regionZ = Math.floor(chunkZ / TILE_CHUNK_SIZE);
  return { regionX, regionZ };
}

export function tileIdForChunk(chunkX: number, chunkZ: number): TileId {
  const { regionX, regionZ } = chunkToTileCoords(chunkX, chunkZ);
  return {
    lod: 0, // finest level for far tiles
    regionX,
    regionZ,
  };
}

/**
 * Returns chunk bounds (inclusive) for a LOD0 tile.
 */
export function getTileChunkBounds(
  regionX: number,
  regionZ: number,
): {
  minChunkX: number;
  maxChunkX: number;
  minChunkZ: number;
  maxChunkZ: number;
} {
  const minChunkX = regionX * TILE_CHUNK_SIZE;
  const minChunkZ = regionZ * TILE_CHUNK_SIZE;

  return {
    minChunkX,
    maxChunkX: minChunkX + TILE_CHUNK_SIZE - 1,
    minChunkZ,
    maxChunkZ: minChunkZ + TILE_CHUNK_SIZE - 1,
  };
}
