import { Chunk } from "./Chunk";
import { ChunkWorkerPool } from "./ChunkWorkerPool";
import { SettingParams } from "../SettingParams";
import { WorldStorage } from "../WorldStorage";
import type { SavedChunkEntityData } from "../WorldStorage";
import { DistantTerrain } from "../Generation/DistanTerrain/DistantTerrian";
import { ChunkMesher } from "./ChunckMesher";

type ChunkBoundEntity = {
  getWorldPosition: () => { x: number; y: number; z: number };
  unload: () => void;
  isAlive?: () => boolean;
  serializeForChunkReload?: () => SavedChunkEntityData | null;
};

export class ChunkLoadingSystem {
  private static distantTerrain: DistantTerrain;

  private static loadQueue: Chunk[] = [];
  private static unloadQueueSet: Set<Chunk> = new Set();
  private static chunkBoundEntities: Map<symbol, ChunkBoundEntity> = new Map();
  private static pendingChunkEntityReloads: Map<
    bigint,
    SavedChunkEntityData[]
  > = new Map();
  private static chunkEntityLoaders: Map<
    string,
    (payload: unknown, chunk: Chunk) => void
  > = new Map();
  private static restoringChunkEntities = new Set<bigint>();
  private static chunkLoadedHookInstalled = false;
  private static flushPromise: Promise<void> | null = null;
  private static entityFlushPromise: Promise<void> | null = null;
  private static lastPersistedEntityChunkIds = new Set<bigint>();
  private static isProcessing = false;
  private static readonly LOAD_BATCH_SIZE = SettingParams.RENDER_DISTANCE * 4;
  private static readonly UNLOAD_BATCH_SIZE = SettingParams.RENDER_DISTANCE * 4;

  private static ensureChunkLoadedHook(): void {
    if (this.chunkLoadedHookInstalled) {
      return;
    }
    this.chunkLoadedHookInstalled = true;

    const previousOnChunkLoaded = Chunk.onChunkLoaded;
    Chunk.onChunkLoaded = (chunk: Chunk) => {
      previousOnChunkLoaded?.(chunk);
      void this.restoreChunkBoundEntitiesForChunk(chunk);
    };
  }

  public static registerChunkEntityLoader(
    type: string,
    loader: (payload: unknown, chunk: Chunk) => void,
  ): void {
    this.ensureChunkLoadedHook();
    this.chunkEntityLoaders.set(type, loader);

    for (const chunk of Chunk.chunkInstances.values()) {
      if (chunk.isLoaded) {
        void this.restoreChunkBoundEntitiesForChunk(chunk);
      }
    }
  }

  public static registerChunkBoundEntity(entity: ChunkBoundEntity): symbol {
    this.ensureChunkLoadedHook();
    const handle = Symbol("chunk-bound-entity");
    this.chunkBoundEntities.set(handle, entity);
    return handle;
  }

  public static unregisterChunkBoundEntity(handle: symbol | undefined): void {
    if (!handle) {
      return;
    }
    this.chunkBoundEntities.delete(handle);
  }

  private static async unloadChunkBoundEntitiesForChunk(
    chunk: Chunk,
  ): Promise<void> {
    const serializedEntities: SavedChunkEntityData[] = [];

    const chunkX = chunk.chunkX;
    const chunkY = chunk.chunkY;
    const chunkZ = chunk.chunkZ;
    const handlesToUnload: symbol[] = [];

    for (const [handle, entity] of this.chunkBoundEntities.entries()) {
      if (entity.isAlive && !entity.isAlive()) {
        handlesToUnload.push(handle);
        continue;
      }

      const worldPos = entity.getWorldPosition();
      const entityChunkX = this.worldToChunkCoord(worldPos.x);
      const entityChunkY = this.worldToChunkCoord(worldPos.y);
      const entityChunkZ = this.worldToChunkCoord(worldPos.z);

      if (
        entityChunkX === chunkX &&
        entityChunkY === chunkY &&
        entityChunkZ === chunkZ
      ) {
        handlesToUnload.push(handle);
      }
    }

    for (const handle of handlesToUnload) {
      const entity = this.chunkBoundEntities.get(handle);
      this.chunkBoundEntities.delete(handle);
      if (!entity) continue;

      const serialized = entity.serializeForChunkReload?.() ?? null;
      if (serialized) {
        serializedEntities.push(serialized);
      }

      try {
        entity.unload();
      } catch (error) {
        console.error("Failed to unload chunk-bound entity:", error);
      }
    }

    const chunkKey = Chunk.packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
    if (serializedEntities.length > 0) {
      this.pendingChunkEntityReloads.set(chunkKey, serializedEntities);
    } else {
      this.pendingChunkEntityReloads.delete(chunkKey);
    }

    try {
      await WorldStorage.saveChunkEntities(chunk.id, serializedEntities);
    } catch (error) {
      console.error("Failed to persist chunk-bound entities:", error);
    }
  }

  private static spawnSerializedEntities(
    serializedEntities: SavedChunkEntityData[],
    chunk: Chunk,
  ): SavedChunkEntityData[] {
    const remaining: SavedChunkEntityData[] = [];

    for (const serialized of serializedEntities) {
      const loader = this.chunkEntityLoaders.get(serialized.type);
      if (!loader) {
        remaining.push(serialized);
        continue;
      }

      try {
        loader(serialized.payload, chunk);
      } catch (error) {
        console.error("Failed to reload chunk-bound entity:", error);
        remaining.push(serialized);
      }
    }

    return remaining;
  }

  private static async restoreChunkBoundEntitiesForChunk(
    chunk: Chunk,
  ): Promise<void> {
    if (!chunk.isLoaded) {
      return;
    }
    if (this.chunkEntityLoaders.size === 0) {
      return;
    }
    if (this.restoringChunkEntities.has(chunk.id)) {
      return;
    }

    this.restoringChunkEntities.add(chunk.id);

    try {
      const pendingKey = Chunk.packCoords(
        chunk.chunkX,
        chunk.chunkY,
        chunk.chunkZ,
      );
      const pendingEntities = this.pendingChunkEntityReloads.get(pendingKey);
      if (pendingEntities && pendingEntities.length > 0) {
        const remainingPending = this.spawnSerializedEntities(
          pendingEntities,
          chunk,
        );
        if (remainingPending.length === 0) {
          this.pendingChunkEntityReloads.delete(pendingKey);
          await WorldStorage.saveChunkEntities(chunk.id, []);
          return;
        }
        this.pendingChunkEntityReloads.set(pendingKey, remainingPending);
        return;
      }

      const serializedEntities = await WorldStorage.loadChunkEntities(chunk.id);
      if (serializedEntities.length === 0) {
        return;
      }

      const remaining = this.spawnSerializedEntities(serializedEntities, chunk);

      await WorldStorage.saveChunkEntities(chunk.id, remaining);
    } catch (error) {
      console.error("Failed to restore chunk-bound entities:", error);
    } finally {
      this.restoringChunkEntities.delete(chunk.id);
    }
  }

  public static flushModifiedChunks(
    maxChunks = ChunkLoadingSystem.UNLOAD_BATCH_SIZE,
  ): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }

    const cappedBatchSize = Math.max(1, Math.floor(maxChunks));
    const chunksToSave: Chunk[] = [];

    for (const chunk of Chunk.chunkInstances.values()) {
      if (
        !chunk.isLoaded ||
        chunk.isPersistent ||
        (!chunk.isModified && !chunk.isLODMeshCacheDirty)
      ) {
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

  public static flushChunkBoundEntities(): Promise<void> {
    if (this.entityFlushPromise) {
      return this.entityFlushPromise;
    }

    const entitiesByChunk = new Map<bigint, SavedChunkEntityData[]>();
    const staleHandles: symbol[] = [];

    for (const [handle, entity] of this.chunkBoundEntities.entries()) {
      if (entity.isAlive && !entity.isAlive()) {
        staleHandles.push(handle);
        continue;
      }

      const serialized = entity.serializeForChunkReload?.() ?? null;
      if (!serialized) {
        continue;
      }

      const worldPos = entity.getWorldPosition();
      const chunkX = this.worldToChunkCoord(worldPos.x);
      const chunkY = this.worldToChunkCoord(worldPos.y);
      const chunkZ = this.worldToChunkCoord(worldPos.z);
      const chunkId = Chunk.packCoords(chunkX, chunkY, chunkZ);

      const list = entitiesByChunk.get(chunkId);
      if (list) {
        list.push(serialized);
      } else {
        entitiesByChunk.set(chunkId, [serialized]);
      }
    }

    for (const handle of staleHandles) {
      this.chunkBoundEntities.delete(handle);
    }

    const chunkIdsToPersist = new Set<bigint>([
      ...this.lastPersistedEntityChunkIds,
      ...entitiesByChunk.keys(),
    ]);

    if (chunkIdsToPersist.size === 0) {
      return Promise.resolve();
    }

    const flushPromise = Promise.all(
      Array.from(chunkIdsToPersist).map((chunkId) =>
        WorldStorage.saveChunkEntities(
          chunkId,
          entitiesByChunk.get(chunkId) ?? [],
        ),
      ),
    )
      .then(() => {
        this.lastPersistedEntityChunkIds = new Set(entitiesByChunk.keys());
      })
      .catch((error) => {
        console.error("Failed to flush chunk-bound entities:", error);
      });

    const trackedPromise = flushPromise.finally(() => {
      if (this.entityFlushPromise === trackedPromise) {
        this.entityFlushPromise = null;
      }
    });

    this.entityFlushPromise = trackedPromise;
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
    this.ensureChunkLoadedHook();

    if (!this.distantTerrain) {
      this.distantTerrain = new DistantTerrain();
    }

    // Keep/update your far-distance terrain renderer.
    this.distantTerrain.update(chunkX, chunkZ);

    const lod0HorizontalRadius = renderDistance;
    const lod1HorizontalRadius = renderDistance + 6;

    const lod0VerticalRadius = verticalRadius;
    const lod1VerticalRadius = verticalRadius + 2;

    // -----------------------------
    // Prune stale load requests
    // -----------------------------
    this.loadQueue = this.loadQueue.filter((chunk) => {
      const lod = this.getLODLevelForChunk(
        chunk.chunkX,
        chunk.chunkY,
        chunk.chunkZ,
        chunkX,
        chunkY,
        chunkZ,
        lod0HorizontalRadius,
        lod1HorizontalRadius,
        lod0VerticalRadius,
        lod1VerticalRadius,
      );

      if (lod === 2) {
        chunk.isTerrainScheduled = false;
        return false;
      }

      const previousLod = chunk.lodLevel ?? 0;
      chunk.lodLevel = lod;

      // queued chunks are not loaded yet, so no remesh here
      void previousLod;

      return true;
    });

    // -----------------------------
    // Remove chunks from unload queue if they are back in range
    // -----------------------------
    for (const chunk of this.unloadQueueSet) {
      const horizontalDist = Math.max(
        Math.abs(chunk.chunkX - chunkX),
        Math.abs(chunk.chunkZ - chunkZ),
      );
      const verticalDist = Math.abs(chunk.chunkY - chunkY);

      if (
        horizontalDist <= lod1HorizontalRadius &&
        verticalDist <= lod1VerticalRadius
      ) {
        this.unloadQueueSet.delete(chunk);
      }
    }

    // -----------------------------
    // Collect target chunks around the player
    // -----------------------------

    for (
      let y = chunkY - lod1VerticalRadius;
      y <= chunkY + lod1VerticalRadius;
      y++
    ) {
      if (y < 0 || y >= SettingParams.MAX_CHUNK_HEIGHT) {
        continue;
      }

      for (
        let x = chunkX - lod1HorizontalRadius;
        x <= chunkX + lod1HorizontalRadius;
        x++
      ) {
        for (
          let z = chunkZ - lod1HorizontalRadius;
          z <= chunkZ + lod1HorizontalRadius;
          z++
        ) {
          const horizontalDist = Math.max(
            Math.abs(x - chunkX),
            Math.abs(z - chunkZ),
          );
          const verticalDist = Math.abs(y - chunkY);

          // Outside LOD1 range -> do not create/load a normal chunk.
          // This area should be covered by DistantTerrain only.
          if (
            horizontalDist > lod1HorizontalRadius ||
            verticalDist > lod1VerticalRadius
          ) {
            continue;
          }

          const nextLod =
            horizontalDist <= lod0HorizontalRadius &&
            verticalDist <= lod0VerticalRadius
              ? 0
              : 1;

          const lod = this.getLODLevelForChunk(
            x,
            y,
            z,
            chunkX,
            chunkY,
            chunkZ,
            lod0HorizontalRadius,
            lod1HorizontalRadius,
            lod0VerticalRadius,
            lod1VerticalRadius,
          );

          // LOD2 = distant terrain only, so skip normal chunk creation/loading
          if (lod === 2) {
            continue;
          }

          let chunk = Chunk.getChunk(x, y, z);
          if (!chunk) {
            chunk = new Chunk(x, y, z);
          }

          const previousLod = chunk.lodLevel ?? 0;
          chunk.lodLevel = lod;

          // If a loaded chunk changes LOD, rebuild its mesh using the correct detail level
          if (chunk.isLoaded && previousLod !== lod) {
            chunk.scheduleRemesh(previousLod === 0 || lod === 0);
          }

          if (!chunk.isLoaded && !chunk.isTerrainScheduled) {
            chunk.isTerrainScheduled = true;
            this.loadQueue.push(chunk);
          }
        }
      }
    }

    // -----------------------------
    // Sort queue: LOD0 first, then by distance
    // -----------------------------
    if (this.loadQueue.length > 1) {
      this.loadQueue.sort((a, b) => {
        const lodDiff = (a.lodLevel ?? 0) - (b.lodLevel ?? 0);
        if (lodDiff !== 0) {
          return lodDiff;
        }

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

    // Keep your existing unload behavior.
    // queueUnloading() already adds CHUNK_UNLOAD_DISTANCE_BUFFER internally,
    // so passing lod0 radii here effectively keeps LOD1 chunks alive too.

    this.queueUnloading(
      chunkX,
      chunkY,
      chunkZ,
      lod1HorizontalRadius,
      lod1VerticalRadius,
    );

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
              chunk.isLoaded &&
              !chunk.isPersistent &&
              (chunk.isModified || chunk.isLODMeshCacheDirty),
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
              (!chunk.isModified && !chunk.isLODMeshCacheDirty) ||
              (savedChunkIds !== null && savedChunkIds.has(chunk.id));

            if (canUnload) {
              await this.unloadChunkBoundEntitiesForChunk(chunk);
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
                  const currentLod = chunk.lodLevel ?? 0;

                  const savedLODMesh =
                    currentLod === 0
                      ? {
                          opaque: savedData.opaqueMesh ?? null,
                          transparent: savedData.transparentMesh ?? null,
                        }
                      : savedData.lodMeshes?.[currentLod]
                        ? {
                            opaque:
                              savedData.lodMeshes[currentLod]?.opaque ?? null,
                            transparent:
                              savedData.lodMeshes[currentLod]?.transparent ??
                              null,
                          }
                        : null;

                  const hasDesiredMesh =
                    !!savedLODMesh &&
                    (!!savedLODMesh.opaque || !!savedLODMesh.transparent);

                  chunk.loadFromStorage(
                    savedData.blocks,
                    savedData.palette,
                    savedData.isUniform,
                    savedData.uniformBlockId,
                    savedData.light_array,
                    !hasDesiredMesh,
                  );

                  // Restore persisted LOD cache first
                  chunk.restoreLODMeshCache(savedData.lodMeshes);

                  // Also restore the base LOD0 mesh into the runtime cache
                  if (savedData.opaqueMesh || savedData.transparentMesh) {
                    chunk.setCachedLODMesh(0, {
                      opaque: savedData.opaqueMesh ?? null,
                      transparent: savedData.transparentMesh ?? null,
                    });
                    chunk.isLODMeshCacheDirty = false;
                  }

                  if (hasDesiredMesh) {
                    ChunkMesher.createMeshFromData(chunk, {
                      opaque: savedLODMesh!.opaque,
                      transparent: savedLODMesh!.transparent,
                    });

                    // Only reconcile borders immediately for full-detail mesh
                    if (currentLod === 0) {
                      this.scheduleChunkAndNeighborsRemesh(chunk);
                    }
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
  private static getLODLevelForChunk(
    targetChunkX: number,
    targetChunkY: number,
    targetChunkZ: number,
    playerChunkX: number,
    playerChunkY: number,
    playerChunkZ: number,
    lod0HorizontalRadius: number,
    lod1HorizontalRadius: number,
    lod0VerticalRadius: number,
    lod1VerticalRadius: number,
  ): number {
    const horizontalDist = Math.max(
      Math.abs(targetChunkX - playerChunkX),
      Math.abs(targetChunkZ - playerChunkZ),
    );

    const verticalDist = Math.abs(targetChunkY - playerChunkY);

    if (
      horizontalDist <= lod0HorizontalRadius &&
      verticalDist <= lod0VerticalRadius
    ) {
      return 0; // full detail
    }

    if (
      horizontalDist <= lod1HorizontalRadius &&
      verticalDist <= lod1VerticalRadius
    ) {
      return 1; // simplified detail
    }

    return 2; // distant terrain only
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
