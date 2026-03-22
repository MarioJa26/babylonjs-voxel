import { Chunk } from "./Chunk";
import { ChunkWorkerPool } from "./ChunkWorkerPool";
import { ChunkMesher } from "./ChunckMesher";
import { SettingParams } from "../SettingParams";
import { WorldStorage } from "../WorldStorage";
import { DistantTerrain } from "../Generation/DistanTerrain/DistantTerrian";

export class ChunkLoadingSystem {
  private static distantTerrain: DistantTerrain;

  private static loadQueue: Chunk[] = [];
  private static unloadQueueSet: Set<Chunk> = new Set();
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
      if (!chunk.isLoaded || chunk.isPersistent || !chunk.isModified) {
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

    const neighbors = [
      chunk,
      chunk.getNeighbor(-1, 0, 0),
      chunk.getNeighbor(1, 0, 0),
      chunk.getNeighbor(0, -1, 0),
      chunk.getNeighbor(0, 1, 0),
      chunk.getNeighbor(0, 0, -1),
      chunk.getNeighbor(0, 0, 1),
    ];

    for (const neighbor of neighbors) {
      pool.scheduleRemesh(neighbor, true);
    }
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

    // Prune stale load requests if the player moved.
    this.loadQueue = this.loadQueue.filter((chunk) => {
      const horizontalDist = Math.max(
        Math.abs(chunk.chunkX - chunkX),
        Math.abs(chunk.chunkZ - chunkZ),
      );
      const verticalDist = Math.abs(chunk.chunkY - chunkY);

      const inRange =
        horizontalDist <= renderDistance && verticalDist <= verticalRadius;

      if (!inRange) {
        chunk.isTerrainScheduled = false;
        return false;
      }

      return true;
    });

    // Remove chunks from the unload queue if they came back into range.
    const removeRadius =
      renderDistance + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER;
    const verticalRemoveRadius =
      verticalRadius + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER;

    for (const chunk of this.unloadQueueSet) {
      const horizontalDist = Math.max(
        Math.abs(chunk.chunkX - chunkX),
        Math.abs(chunk.chunkZ - chunkZ),
      );
      const verticalDist = Math.abs(chunk.chunkY - chunkY);

      if (
        horizontalDist <= removeRadius &&
        verticalDist <= verticalRemoveRadius
      ) {
        this.unloadQueueSet.delete(chunk);
      }
    }

    // Collect/load target chunks around the player.
    for (let y = chunkY - verticalRadius; y <= chunkY + verticalRadius; y++) {
      if (y < 0 || y >= SettingParams.MAX_CHUNK_HEIGHT) {
        continue;
      }

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

          if (!chunk.isLoaded && !chunk.isTerrainScheduled) {
            chunk.isTerrainScheduled = true;
            this.loadQueue.push(chunk);
          }
        }
      }
    }

    if (this.loadQueue.length > 1) {
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
    }

    this.queueUnloading(chunkX, chunkY, chunkZ, renderDistance, verticalRadius);

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
    const verticalRemoveRadius =
      verticalRadius + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER;

    for (const chunk of Chunk.chunkInstances.values()) {
      if (chunk.isPersistent) continue;
      if (!chunk.isLoaded) continue;
      if (this.unloadQueueSet.has(chunk)) continue;

      const cx = chunk.chunkX;
      const cy = chunk.chunkY;
      const cz = chunk.chunkZ;

      if (
        Math.abs(cx - chunkX) > removeRadius ||
        Math.abs(cz - chunkZ) > removeRadius ||
        Math.abs(cy - chunkY) > verticalRemoveRadius
      ) {
        this.unloadQueueSet.add(chunk);
      }
    }
  }

  private static async processQueues() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    const processLoop = async () => {
      try {
        // --- Process Unload Batch ---
        if (this.unloadQueueSet.size > 0) {
          const batch: Chunk[] = [];
          let count = 0;

          for (const chunk of this.unloadQueueSet) {
            batch.push(chunk);
            this.unloadQueueSet.delete(chunk);

            if (++count >= this.UNLOAD_BATCH_SIZE) {
              break;
            }
          }

          const chunksToSave = batch.filter(
            (chunk) =>
              chunk.isLoaded && chunk.isModified && !chunk.isPersistent,
          );

          let savedChunkIds: Set<bigint> | null = null;

          if (chunksToSave.length > 0) {
            try {
              await WorldStorage.saveChunks(chunksToSave);
              savedChunkIds = new Set(chunksToSave.map((chunk) => chunk.id));
            } catch (e) {
              console.error("Background save failed:", e);
            }
          }

          for (const chunk of batch) {
            if (chunk.isPersistent) continue;
            if (!chunk.isLoaded) continue;

            const canUnload =
              !chunk.isModified ||
              (savedChunkIds !== null && savedChunkIds.has(chunk.id));

            if (canUnload) {
              chunk.dispose();
              chunk.isLoaded = false;
              chunk.isTerrainScheduled = false;
              Chunk.chunkInstances.delete(chunk.id);
            }
          }
        }

        // --- Process Load Batch ---
        if (this.loadQueue.length > 0) {
          const batch = this.loadQueue.splice(0, this.LOAD_BATCH_SIZE);

          // Ignore chunks that were unscheduled while waiting in queue.
          const validBatch = batch.filter((chunk) => chunk.isTerrainScheduled);

          if (validBatch.length > 0) {
            const chunkIdsToLoad = validBatch.map((chunk) => chunk.id);
            const chunksToGenerate: Chunk[] = [];

            try {
              const loadedDataMap =
                await WorldStorage.loadChunks(chunkIdsToLoad);

              for (const chunk of validBatch) {
                // Chunk may have been unscheduled while awaiting storage.
                if (!chunk.isTerrainScheduled) {
                  continue;
                }

                const savedData = loadedDataMap.get(chunk.id);

                if (savedData) {
                  const hasMeshes =
                    !!savedData.opaqueMesh || !!savedData.transparentMesh;

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

                    // Reconcile borders with currently loaded neighbors.
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

              // Important: allow these chunks to be retried later.
              for (const chunk of validBatch) {
                if (!chunk.isLoaded) {
                  chunk.isTerrainScheduled = false;
                }
              }
            }
          }
        }

        if (this.loadQueue.length > 0 || this.unloadQueueSet.size > 0) {
          requestAnimationFrame(() => {
            void processLoop();
          });
        } else {
          this.isProcessing = false;
        }
      } catch (error) {
        console.error("ChunkLoadingSystem process loop failed:", error);
        this.isProcessing = false;
      }
    };

    void processLoop();
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
    state = 0,
  ) {
    const chunkX = this.worldToChunkCoord(worldX);
    const chunkY = this.worldToChunkCoord(worldY);
    const chunkZ = this.worldToChunkCoord(worldZ);

    const chunk = Chunk.getChunk(chunkX, chunkY, chunkZ);
    if (!chunk) return;

    const localX = this.worldToBlockCoord(worldX);
    const localY = this.worldToBlockCoord(worldY);
    const localZ = this.worldToBlockCoord(worldZ);

    chunk.setBlock(localX, localY, localZ, blockId, state);
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

  public static getBlockStateByWorldCoords(
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

    return chunk.getBlockState(localX, localY, localZ);
  }

  public static getLightByWorldCoords(
    worldX: number,
    worldY: number,
    worldZ: number,
  ): number {
    const chunkX = this.worldToChunkCoord(worldX);
    const chunkY = this.worldToChunkCoord(worldY);
    const chunkZ = this.worldToChunkCoord(worldZ);

    const chunk = Chunk.getChunk(chunkX, chunkY, chunkZ);
    if (!chunk || !chunk.isLoaded) {
      return 15 << Chunk.SKY_LIGHT_SHIFT;
    }

    const localX = this.worldToBlockCoord(worldX);
    const localY = this.worldToBlockCoord(worldY);
    const localZ = this.worldToBlockCoord(worldZ);

    return chunk.getLight(localX, localY, localZ);
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
