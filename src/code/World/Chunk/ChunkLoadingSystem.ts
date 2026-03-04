import { Chunk } from "./Chunk";
import { ChunkWorkerPool } from "./ChunkWorkerPool";
import { ChunkMesher } from "./ChunckMesher";
import { SettingParams } from "../SettingParams";
import { WorldStorage } from "../WorldStorage";
import { DistantTerrain } from "../Generation/DistanTerrain/DistantTerrian";

export class ChunkLoadingSystem {
  private static distantTerrain: DistantTerrain;

  private static loadQueue: Chunk[] = [];
  private static unloadQueue: Chunk[] = [];
  private static flushPromise: Promise<void> | null = null;
  private static isProcessing = false;
  private static readonly LOAD_BATCH_SIZE = SettingParams.RENDER_DISTANCE * 4;
  private static readonly UNLOAD_BATCH_SIZE = SettingParams.RENDER_DISTANCE * 4;

  public static flushModifiedChunks(
    maxChunks = ChunkLoadingSystem.UNLOAD_BATCH_SIZE,
  ): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }

    const cappedBatchSize = Math.max(1, Math.floor(maxChunks));
    const chunksToSave: Chunk[] = [];

    for (const chunk of Chunk.chunkInstances.values()) {
      if (!chunk.isLoaded || !chunk.isModified) {
        continue;
      }
      chunksToSave.push(chunk);
      if (chunksToSave.length >= cappedBatchSize) {
        break;
      }
    }

    if (chunksToSave.length === 0) {
      return Promise.resolve();
    }

    const savePromise = WorldStorage.saveChunks(chunksToSave).catch((error) => {
      console.error("Periodic chunk save failed:", error);
    });
    const trackedPromise = savePromise.finally(() => {
      if (this.flushPromise === trackedPromise) {
        this.flushPromise = null;
      }
    });
    this.flushPromise = trackedPromise;
    return trackedPromise;
  }

  private static scheduleChunkAndNeighborsRemesh(chunk: Chunk): void {
    const pool = ChunkWorkerPool.getInstance();
    pool.scheduleRemesh(chunk, true);
    pool.scheduleRemesh(chunk.getNeighbor(-1, 0, 0), true);
    pool.scheduleRemesh(chunk.getNeighbor(1, 0, 0), true);
    pool.scheduleRemesh(chunk.getNeighbor(0, -1, 0), true);
    pool.scheduleRemesh(chunk.getNeighbor(0, 1, 0), true);
    pool.scheduleRemesh(chunk.getNeighbor(0, 0, -1), true);
    pool.scheduleRemesh(chunk.getNeighbor(0, 0, 1), true);
  }

  public static async updateChunksAround(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    renderDistance = SettingParams.RENDER_DISTANCE,
    verticalRadius = SettingParams.VERTICAL_RENDER_DISTANCE,
  ) {
    if (!this.distantTerrain) {
      this.distantTerrain = new DistantTerrain();
    }
    this.distantTerrain.update(chunkX, chunkZ);

    // Optimization: Prune the load queue.
    // If the player moved fast, remove chunks from the queue that are now out of range.
    // This prevents "Loading then immediately Unloading" overhead.
    this.loadQueue = this.loadQueue.filter((chunk) => {
      const dist = Math.max(
        Math.abs(chunk.chunkX - chunkX),
        Math.abs(chunk.chunkZ - chunkZ),
      );
      if (dist > renderDistance) {
        chunk.isTerrainScheduled = false; // Reset flag so it can be queued again if we return
        return false;
      }
      return true;
    });

    // Optimization: Prune the unload queue.
    // If the player moved back towards a chunk that was scheduled for unload, remove it from the queue.
    const removeRadius =
      renderDistance + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER;
    const verticalRemoveRadius =
      verticalRadius + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER;

    this.unloadQueue = this.unloadQueue.filter((chunk) => {
      const dist = Math.max(
        Math.abs(chunk.chunkX - chunkX),
        Math.abs(chunk.chunkZ - chunkZ),
      );

      return (
        dist > removeRadius ||
        Math.abs(chunk.chunkY - chunkY) > verticalRemoveRadius
      );
    });

    // 1. Collect all potential chunk coordinates
    for (let y = chunkY - verticalRadius; y <= chunkY + verticalRadius; y++) {
      if (y >= SettingParams.MAX_CHUNK_HEIGHT || y < 0) continue;
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
            chunk.isTerrainScheduled = true;
            this.loadQueue.push(chunk);
          }
        }
      }
    }

    // Sort chunks by distance to prioritize loading closer chunks first
    this.loadQueue.sort((a, b) => {
      const distA =
        (a.chunkX - chunkX) ** 2 +
        (a.chunkY - chunkY) ** 2 +
        (a.chunkZ - chunkZ) ** 2;
      const distB =
        (b.chunkX - chunkX) ** 2 +
        (b.chunkY - chunkY) ** 2 +
        (b.chunkZ - chunkZ) ** 2;
      return distA - distB;
    });

    // 2. Identify chunks to unload
    this.queueUnloading(chunkX, chunkY, chunkZ, renderDistance, verticalRadius);

    // 3. Start processing if not already active
    if (!this.isProcessing) {
      this.processQueues();
    }
  }

  private static queueUnloading(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    renderDistance: number,
    verticalRadius: number,
  ) {
    const removeRadius =
      renderDistance + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER;

    for (const chunk of Chunk.chunkInstances.values()) {
      if (this.unloadQueue.includes(chunk)) continue;

      const { chunkX: cx, chunkY: cy, chunkZ: cz } = chunk;
      if (
        Math.abs(cx - chunkX) > removeRadius ||
        Math.abs(cz - chunkZ) > removeRadius ||
        Math.abs(cy - chunkY) >
          verticalRadius + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER
      ) {
        this.unloadQueue.push(chunk);
      }
    }
  }

  private static async processQueues() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    const processLoop = async () => {
      // --- Process Unload Batch ---
      if (this.unloadQueue.length > 0) {
        const batch = this.unloadQueue.splice(0, this.UNLOAD_BATCH_SIZE);
        const chunksToSave = batch.filter((c) => c.isModified);

        if (chunksToSave.length > 0) {
          try {
            await WorldStorage.saveChunks(chunksToSave);
          } catch (e) {
            console.error("Background save failed:", e);
          }
        }

        for (const chunk of batch) {
          // Only dispose of chunks that are not modified.
          // If a chunk was modified, it will only be disposed if the save was successful.
          // If saving failed, isModified remains true, and we keep the chunk in memory to retry saving later.
          if (!chunk.isModified) {
            chunk.dispose();
            chunk.isLoaded = false;
            Chunk.chunkInstances.delete(chunk.id);
          }
        }
      }

      // --- Process Load Batch ---
      if (this.loadQueue.length > 0) {
        const batch = this.loadQueue.splice(0, this.LOAD_BATCH_SIZE);
        // Filter out chunks that might have been disposed (unloaded) while in queue
        const validBatch = batch.filter((c) => c.isTerrainScheduled);

        if (validBatch.length > 0) {
          const chunkIdsToLoad = validBatch.map((chunk) => chunk.id);
          const chunksToGenerate: Chunk[] = [];

          try {
            const loadedDataMap = await WorldStorage.loadChunks(chunkIdsToLoad);

            for (const chunk of validBatch) {
              // Double check if disposed during await
              if (!chunk.isTerrainScheduled) continue;

              const savedData = loadedDataMap.get(chunk.id);
              if (savedData) {
                const hasMeshes =
                  savedData.opaqueMesh || savedData.transparentMesh;

                chunk.loadFromStorage(
                  savedData.blocks,
                  savedData.palette,
                  savedData.isUniform,
                  savedData.uniformBlockId,
                  savedData.light_array,
                  !hasMeshes,
                );

                if (hasMeshes) {
                  ChunkMesher.createMeshFromData(chunk, {
                    opaque: savedData.opaqueMesh ?? null,
                    transparent: savedData.transparentMesh ?? null,
                  });
                  // Keep cached meshes for fast load, but still reconcile chunk borders
                  // with currently loaded neighbors via worker remesh scheduling.
                  this.scheduleChunkAndNeighborsRemesh(chunk);
                }
              } else {
                chunksToGenerate.push(chunk);
              }
            }

            if (chunksToGenerate.length > 0) {
              ChunkWorkerPool.getInstance().scheduleTerrainGenerationBatch(
                chunksToGenerate,
              );
            }
          } catch (e) {
            console.warn("Failed to load chunks from storage", e);
          }
        }
      }

      if (this.loadQueue.length > 0 || this.unloadQueue.length > 0) {
        requestAnimationFrame(processLoop);
      } else {
        this.isProcessing = false;
      }
    };

    processLoop();
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
    blockId: number,
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
    worldZ: number,
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

  public static areChunksLoadedAround(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    horizontalRadius = 1,
    verticalRadius = 0,
  ): boolean {
    for (let y = chunkY - verticalRadius; y <= chunkY + verticalRadius; y++) {
      for (
        let x = chunkX - horizontalRadius;
        x <= chunkX + horizontalRadius;
        x++
      ) {
        for (
          let z = chunkZ - horizontalRadius;
          z <= chunkZ + horizontalRadius;
          z++
        ) {
          const chunk = Chunk.getChunk(x, y, z);
          if (!chunk || !chunk.isLoaded) {
            return false;
          }
        }
      }
    }
    return true;
  }
}
