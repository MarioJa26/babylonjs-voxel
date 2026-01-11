import { Chunk } from "./Chunk/Chunk";
import { ChunkWorkerPool } from "./Chunk/ChunkWorkerPool";
import { ChunkMesher } from "./Chunk/ChunckMesher";
import { SettingParams } from "./SettingParams";
import { WorldStorage } from "./WorldStorage";
import { GenerationParams } from "./Generation/NoiseAndParameters/GenerationParams";
import { DistantTerrain } from "./Chunk/DistantTerrian";

export class World {
  private static distantTerrain: DistantTerrain;

  /*
  constructor() {
    World.updateChunksAround(0, 0, 0, 2);
  }
*/
  /**
   * Ensure chunks exist around the provided world position.
   * Only creates chunks when the player's chunk coordinate moves to a new chunk.
   * Optionally removes chunks that are outside the radius.
   */
  public static async updateChunksAround(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    playerY: number,
    renderDistance = SettingParams.RENDER_DISTANCE,
    verticalRadius = SettingParams.VERTICAL_RENDER_DISTANCE
  ) {
    if (!this.distantTerrain) {
      this.distantTerrain = new DistantTerrain();
    }
    this.distantTerrain.update(chunkX, chunkZ);

    const chunksToLoadFromDB: Chunk[] = [];
    const chunksToGenerate: Chunk[] = [];

    // 1. Collect all potential chunk coordinates and their distances
    for (let y = chunkY - verticalRadius; y <= chunkY + verticalRadius; y++) {
      if (
        y >= SettingParams.MAX_CHUNK_HEIGHT ||
        (playerY > GenerationParams.CHUNK_SIZE && y < 0)
      )
        continue;
      for (let x = chunkX - renderDistance; x <= chunkX + renderDistance; x++) {
        for (
          let z = chunkZ - renderDistance;
          z <= chunkZ + renderDistance;
          z++
        ) {
          let chunk = Chunk.getChunk(x, y, z);
          if (!chunk) {
            chunk = new Chunk(x, y, z);
          }

          // Close chunk: Needs full terrain
          if (!chunk.isLoaded && !chunk.isTerrainScheduled) {
            chunksToLoadFromDB.push(chunk);
            chunk.isTerrainScheduled = true;
          }
        }
      }
    }

    // 4. Fire off a single batch DB load request
    const chunkIdsToLoad = chunksToLoadFromDB.map((chunk) => chunk.id);
    const loadedDataMap = await WorldStorage.loadChunks(chunkIdsToLoad);

    // 5. Process the results
    for (const chunk of chunksToLoadFromDB) {
      const savedData = loadedDataMap.get(chunk.id);
      if (savedData) {
        // Populate block data without triggering an automatic remesh
        chunk.populate(savedData.blocks, savedData.light_array, true);

        // If we have saved mesh data, use it directly!
        if (
          savedData.opaqueMesh ||
          savedData.waterMesh ||
          savedData.glassMesh
        ) {
          ChunkMesher.createMeshFromData(chunk, {
            opaque: savedData.opaqueMesh!,
            water: savedData.waterMesh!,
            glass: savedData.glassMesh!,
          });
        } else {
          // If no mesh data, now we schedule a remesh
          chunk.scheduleRemesh();
        }
      } else {
        // Otherwise, add to generation queue
        chunksToGenerate.push(chunk);
      }
    }

    // 6. Enqueue chunks for generation
    ChunkWorkerPool.getInstance().scheduleTerrainGenerationBatch(
      chunksToGenerate
    );

    // optional: remove chunks far outside the radius to free memory
    const removeRadius =
      renderDistance + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER;
    const chunksToSave: Chunk[] = [];
    const chunksToRemove: Chunk[] = [];

    for (const chunk of Chunk.chunkInstances.values()) {
      const { chunkX: cx, chunkY: cy, chunkZ: cz } = chunk;
      if (
        Math.abs(cx - chunkX) > removeRadius ||
        Math.abs(cz - chunkZ) > removeRadius ||
        Math.abs(cy - chunkY) >
          verticalRadius + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER
      ) {
        chunksToRemove.push(chunk);
        if (chunk.isModified) {
          chunksToSave.push(chunk);
        }
      }
    }

    try {
      await WorldStorage.saveChunks(chunksToSave);
    } catch (e) {
      console.error("Failed to save chunks before unload:", e);
    }

    for (const chunk of chunksToRemove) {
      chunk.dispose();
      chunk.isLoaded = false;
      Chunk.chunkInstances.delete(chunk.id);
    }
  }

  public static deleteBlock(worldX: number, worldY: number, worldZ: number) {
    const chunkX = this.worldToChunkCoord(worldX);
    const chunkY = this.worldToChunkCoord(worldY);
    const chunkZ = this.worldToChunkCoord(worldZ);

    const chunk = Chunk.getChunk(chunkX, chunkY, chunkZ);
    if (!chunk) return;

    const localX = this.worldToBlockCoord(worldX);
    const localY = this.worldToBlockCoord(worldY);
    const localZ = this.worldToBlockCoord(worldZ);

    chunk.deleteBlock(localX, localY, localZ);
  }

  public static setBlock(
    worldX: number,
    worldY: number,
    worldZ: number,
    blockId: number
  ) {
    const chunkX = this.worldToChunkCoord(worldX);
    const chunkY = this.worldToChunkCoord(worldY);
    const chunkZ = this.worldToChunkCoord(worldZ);

    const chunk = Chunk.getChunk(chunkX, chunkY, chunkZ);
    if (!chunk) return;

    const localX = this.worldToBlockCoord(worldX);
    const localY = this.worldToBlockCoord(worldY);
    const localZ = this.worldToBlockCoord(worldZ);

    chunk.setBlock(localX, localY, localZ, blockId);
  }

  public static getBlockByWorldCoords(
    worldX: number,
    worldY: number,
    worldZ: number
  ): number {
    const chunkX = this.worldToChunkCoord(worldX);
    const chunkY = this.worldToChunkCoord(worldY);
    const chunkZ = this.worldToChunkCoord(worldZ);

    const chunk = Chunk.getChunk(chunkX, chunkY, chunkZ);
    if (!chunk) return 0;

    const localX = this.worldToBlockCoord(worldX);
    const localY = this.worldToBlockCoord(worldY);
    const localZ = this.worldToBlockCoord(worldZ);

    return chunk.getBlock(localX, localY, localZ);
  }

  /**
   * Converts world coordinates to chunk coordinates.
   * @param value The world coordinate value (e.g., player's x position).
   * @returns The corresponding chunk coordinate.
   */
  public static worldToChunkCoord(value: number): number {
    return Math.floor(value / Chunk.SIZE);
  }

  /**
   * Converts world coordinates to local block coordinates within a chunk.
   * @param value The world coordinate value.
   * @returns The local block coordinate (0-63).
   */
  public static worldToBlockCoord(value: number): number {
    return ((Math.floor(value) % Chunk.SIZE) + Chunk.SIZE) % Chunk.SIZE;
  }
}
