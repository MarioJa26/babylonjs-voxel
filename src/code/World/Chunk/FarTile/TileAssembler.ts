// TileAssembler.ts

import { unpackBlockId } from "../../BlockEncoding";
import { Chunk } from "../Chunk";
import { FarTileLightSummary, FarTileSurfaceSummary } from "./FarTile";
import { FarTileRecord, FarTileStorage } from "./FarTileStorage";
import {
  getTileChunkBounds,
  tileIdForChunk,
  TILE_CHUNK_SIZE,
} from "./TileMath";

type PendingTileEntry = {
  id: FarTileRecord["id"];
  // key: `${chunkX}:${chunkZ}`
  chunks: Map<string, Chunk>;
};

const pendingTiles = new Map<string, PendingTileEntry>();

function tileKey(id: FarTileRecord["id"]): string {
  const { lod, regionX, regionZ, regionY } = id;
  return regionY == null
    ? `${lod}:${regionX}:${regionZ}`
    : `${lod}:${regionX}:${regionY}:${regionZ}`;
}

function chunkKey(chunkX: number, chunkZ: number): string {
  return `${chunkX}:${chunkZ}`;
}

export class TileAssembler {
  /**
   * Register a chunk that has just finished loading/generation.
   * Call this from your Chunk.onChunkLoaded hook.
   */
  public static registerChunk(chunk: Chunk): void {
    const id = tileIdForChunk(chunk.chunkX, chunk.chunkZ);
    const key = tileKey(id);

    let entry = pendingTiles.get(key);
    if (!entry) {
      entry = {
        id,
        chunks: new Map<string, Chunk>(),
      };
      pendingTiles.set(key, entry);
    }

    entry.chunks.set(chunkKey(chunk.chunkX, chunk.chunkZ), chunk);

    if (TileAssembler.isTileComplete(entry)) {
      void TileAssembler.finalizeTile(entry);
      pendingTiles.delete(key);
    }
  }

  private static isTileComplete(entry: PendingTileEntry): boolean {
    const { regionX, regionZ } = entry.id;
    const bounds = getTileChunkBounds(regionX, regionZ);

    let count = 0;
    for (let x = bounds.minChunkX; x <= bounds.maxChunkX; x++) {
      for (let z = bounds.minChunkZ; z <= bounds.maxChunkZ; z++) {
        if (entry.chunks.has(chunkKey(x, z))) {
          count++;
        }
      }
    }

    return count === TILE_CHUNK_SIZE * TILE_CHUNK_SIZE;
  }

  private static async finalizeTile(entry: PendingTileEntry): Promise<void> {
    const chunks = Array.from(entry.chunks.values());

    const surface: FarTileSurfaceSummary = this.buildSurfaceSummary(chunks);
    const light: FarTileLightSummary = {
      skyLightAverage: surface.averageHeight >= 0 ? surface.averageHeight : 0, // placeholder; see below
      blockLightAverage: 0,
      // we also compute avg light in summary; you can wire it here instead
    };

    const record: FarTileRecord = {
      id: entry.id,
      surface,
      light,
      mesh: null, // Phase 3 will provide tile meshes
      version: 1,
    };

    await FarTileStorage.saveTile(record);
  }

  /**
   * SUPER SIMPLE summary: iterate all voxels of the 2x2 chunks.
   * This is intentionally naive for Phase 2. You can refine to "surface-only"
   * sampling later (e.g. scanning from top for first non-air).
   */
  private static buildSurfaceSummary(chunks: Chunk[]): FarTileSurfaceSummary & {
    avgLight: number;
  } {
    let minHeight = Number.POSITIVE_INFINITY;
    let maxHeight = Number.NEGATIVE_INFINITY;
    let totalHeight = 0;
    let totalSamples = 0;

    let dominantBlockId = 0;
    const histogram = new Map<number, number>();

    let totalLight = 0;
    let lightSamples = 0;

    for (const chunk of chunks) {
      const blockArray = chunk.block_array;
      const lightArray = chunk.light_array;

      if (!blockArray) continue;

      const size = Chunk.SIZE;
      const size2 = size * size;

      for (let i = 0; i < blockArray.length; i++) {
        const packed = blockArray[i];

        // Resolve blockId — choose either:
        const blockId = unpackBlockId(packed);
        // or, if you prefer to keep it simple:
        // const blockId = packed & 0xffff;

        // approximate height from index (assuming y-major: x + y*size + z*size2)
        const y = Math.floor(i / size2);

        if (y < minHeight) minHeight = y;
        if (y > maxHeight) maxHeight = y;
        totalHeight += y;

        const currentCount = histogram.get(blockId) ?? 0;
        histogram.set(blockId, currentCount + 1);

        if (lightArray) {
          totalLight += lightArray[i];
          lightSamples++;
        }

        totalSamples++;
      }
    }

    if (totalSamples === 0) {
      // fallback values for empty tiles
      minHeight = 0;
      maxHeight = 0;
      totalSamples = 1;
    }

    // dominant block
    for (const [id, count] of histogram.entries()) {
      if (
        dominantBlockId === 0 ||
        count > (histogram.get(dominantBlockId) ?? 0)
      ) {
        dominantBlockId = id;
      }
    }

    const averageHeight = totalHeight / totalSamples;
    const avgLight = lightSamples > 0 ? totalLight / lightSamples : 15; // default bright

    return {
      minHeight,
      maxHeight,
      averageHeight,
      dominantBlockId,
      dominantWaterBlockId: 0,
      waterCoverage: 0,
      avgLight,
    };
  }
}
