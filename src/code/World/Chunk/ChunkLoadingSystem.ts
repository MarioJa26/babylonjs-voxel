import { Chunk } from "./Chunk";
import { ChunkWorkerPool } from "./ChunkWorkerPool";
import { SettingParams } from "../SettingParams";
import { WorldStorage } from "../WorldStorage";
import type { SavedChunkData, SavedChunkEntityData } from "../WorldStorage";
import { DistantTerrain } from "../Generation/DistanTerrain/DistantTerrian";
import { ChunkMesher } from "./ChunckMesher";
import { ChunkLodRuleSet } from "./LOD/ChunkLodRules";
import { getCurrentLodCacheVersion } from "./LOD/LodCacheVersion";
import type { MeshData } from "./DataStructures/MeshData";

type ChunkBoundEntity = {
  getWorldPosition: () => { x: number; y: number; z: number };
  unload: () => void;
  isAlive?: () => boolean;
  serializeForChunkReload?: () => SavedChunkEntityData | null;
};

export type ChunkLoadingDebugStats = {
  loadQueueLength: number;
  unloadQueueLength: number;
  loadBatchLimit: number;
  unloadBatchLimit: number;
  frameBudgetMs: number;
  lastProcessMs: number;
  totalProcessLoops: number;
  lastLoadedFromStorage: number;
  lastGenerated: number;
  lastHydrated: number;
  lastUnloaded: number;
  lastSaved: number;
  totalLoadedFromStorage: number;
  totalGenerated: number;
  totalHydrated: number;
  totalUnloaded: number;
  totalSaved: number;
  lastLodCacheVersionMismatches: number;
  totalLodCacheVersionMismatches: number;
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
  private static debugStats: ChunkLoadingDebugStats = {
    loadQueueLength: 0,
    unloadQueueLength: 0,
    loadBatchLimit: Math.max(1, Math.floor(SettingParams.RENDER_DISTANCE * 4)),
    unloadBatchLimit: Math.max(
      1,
      Math.floor(SettingParams.RENDER_DISTANCE * 4),
    ),
    frameBudgetMs: Math.max(0.5, SettingParams.CHUNK_LOADING_FRAME_BUDGET_MS),
    lastProcessMs: 0,
    totalProcessLoops: 0,
    lastLoadedFromStorage: 0,
    lastGenerated: 0,
    lastHydrated: 0,
    lastUnloaded: 0,
    lastSaved: 0,
    totalLoadedFromStorage: 0,
    totalGenerated: 0,
    totalHydrated: 0,
    totalUnloaded: 0,
    totalSaved: 0,
    lastLodCacheVersionMismatches: 0,
    totalLodCacheVersionMismatches: 0,
  };

  private static getLoadBatchSize(): number {
    const configured = Math.floor(SettingParams.CHUNK_LOAD_BATCH_LIMIT);
    if (configured > 0) {
      return configured;
    }
    return Math.max(1, Math.floor(SettingParams.RENDER_DISTANCE * 4));
  }

  private static getUnloadBatchSize(): number {
    const configured = Math.floor(SettingParams.CHUNK_UNLOAD_BATCH_LIMIT);
    if (configured > 0) {
      return configured;
    }
    return Math.max(1, Math.floor(SettingParams.RENDER_DISTANCE * 4));
  }

  private static getProcessFrameBudgetMs(): number {
    return Math.max(0.5, SettingParams.CHUNK_LOADING_FRAME_BUDGET_MS);
  }

  private static refreshQueueDebugSnapshot(): void {
    this.debugStats.loadQueueLength = this.loadQueue.length;
    this.debugStats.unloadQueueLength = this.unloadQueueSet.size;
    this.debugStats.loadBatchLimit = this.getLoadBatchSize();
    this.debugStats.unloadBatchLimit = this.getUnloadBatchSize();
    this.debugStats.frameBudgetMs = this.getProcessFrameBudgetMs();
  }

  public static getDebugStats(): ChunkLoadingDebugStats {
    this.refreshQueueDebugSnapshot();
    return { ...this.debugStats };
  }

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
    maxChunks = ChunkLoadingSystem.getUnloadBatchSize(),
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

    const lodRuleSet = ChunkLodRuleSet.fromRenderRadii(
      renderDistance,
      verticalRadius,
    );
    const { lod3HorizontalRadius, lod3VerticalRadius } = lodRuleSet.radii;

    // -----------------------------
    // Prune stale load requests
    // -----------------------------
    this.loadQueue = this.loadQueue.filter((chunk) => {
      const decision = lodRuleSet.resolve(
        {
          chunkX: chunk.chunkX,
          chunkY: chunk.chunkY,
          chunkZ: chunk.chunkZ,
        },
        { chunkX, chunkY, chunkZ },
      );

      if (!decision.allowsChunkCreation) {
        chunk.isTerrainScheduled = false;
        return false;
      }

      const previousLod = chunk.lodLevel ?? 0;
      chunk.lodLevel = decision.lodLevel;

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
        horizontalDist <= lod3HorizontalRadius &&
        verticalDist <= lod3VerticalRadius
      ) {
        this.unloadQueueSet.delete(chunk);
      }
    }

    // -----------------------------
    // Collect target chunks around the player
    // -----------------------------

    for (
      let y = chunkY - lod3VerticalRadius;
      y <= chunkY + lod3VerticalRadius;
      y++
    ) {
      if (y < 0 || y >= SettingParams.MAX_CHUNK_HEIGHT) {
        continue;
      }

      for (
        let x = chunkX - lod3HorizontalRadius;
        x <= chunkX + lod3HorizontalRadius;
        x++
      ) {
        for (
          let z = chunkZ - lod3HorizontalRadius;
          z <= chunkZ + lod3HorizontalRadius;
          z++
        ) {
          const decision = lodRuleSet.resolve(
            {
              chunkX: x,
              chunkY: y,
              chunkZ: z,
            },
            { chunkX, chunkY, chunkZ },
          );

          // LOD4 = distant terrain only, so skip normal chunk creation/loading
          if (!decision.allowsChunkCreation) {
            continue;
          }

          let chunk = Chunk.getChunk(x, y, z);
          if (!chunk) {
            chunk = new Chunk(x, y, z);
          }

          const previousLod = chunk.lodLevel ?? 0;
          chunk.lodLevel = decision.lodLevel;

          // If a loaded chunk changes LOD, rebuild its mesh using the correct detail level
          if (chunk.isLoaded && previousLod !== decision.lodLevel) {
            const targetLod = decision.lodLevel;

            // Mesh-only chunks can only switch LOD immediately when a cached mesh
            // for the target LOD already exists. Otherwise schedule hydration/generation.
            if (!chunk.hasVoxelData) {
              const hasTargetCachedMesh = chunk.hasCachedLODMesh(targetLod);
              if (targetLod <= 1 || !hasTargetCachedMesh) {
                if (!chunk.isTerrainScheduled) {
                  chunk.isTerrainScheduled = true;
                  this.loadQueue.push(chunk);
                }
                continue;
              }
            }

            chunk.scheduleRemesh(previousLod === 0 || decision.lodLevel === 0);
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
    // so passing lod3 radii here effectively keeps outer chunks alive too.

    this.queueUnloading(
      chunkX,
      chunkY,
      chunkZ,
      lod3HorizontalRadius,
      lod3VerticalRadius,
    );

    // Continuously precompute and cache far LOD meshes in the background.
    ChunkWorkerPool.getInstance().scheduleBackgroundLodPrecompute(
      chunkX,
      chunkY,
      chunkZ,
    );

    this.refreshQueueDebugSnapshot();

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

  private static getSavedMeshForLod(
    savedData: SavedChunkData,
    lod: number,
  ): { opaque: MeshData | null; transparent: MeshData | null } | null {
    if (lod === 0) {
      return {
        opaque: savedData.opaqueMesh ?? null,
        transparent: savedData.transparentMesh ?? null,
      };
    }

    const entry = savedData.lodMeshes?.[lod];
    if (!entry) return null;
    return {
      opaque: entry.opaque ?? null,
      transparent: entry.transparent ?? null,
    };
  }

  private static pickBestSavedMesh(
    savedData: SavedChunkData,
    desiredLod: number,
  ): { opaque: MeshData | null; transparent: MeshData | null } | null {
    const availableLods = new Set<number>();

    if (savedData.opaqueMesh || savedData.transparentMesh) {
      availableLods.add(0);
    }

    if (savedData.lodMeshes) {
      for (const key of Object.keys(savedData.lodMeshes)) {
        const lod = Number(key);
        if (!Number.isFinite(lod)) continue;
        const mesh = this.getSavedMeshForLod(savedData, lod);
        if (mesh && (mesh.opaque || mesh.transparent)) {
          availableLods.add(lod);
        }
      }
    }

    if (availableLods.size === 0) {
      return null;
    }

    const sortedLods = Array.from(availableLods).sort((a, b) => {
      const distA = Math.abs(a - desiredLod);
      const distB = Math.abs(b - desiredLod);
      if (distA !== distB) return distA - distB;
      return a - b;
    });

    for (const lod of sortedLods) {
      const mesh = this.getSavedMeshForLod(savedData, lod);
      if (mesh && (mesh.opaque || mesh.transparent)) {
        return mesh;
      }
    }

    return null;
  }

  private static async processQueues() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    const processLoop = async () => {
      const loopStartMs = performance.now();
      let loadedFromStorageCount = 0;
      let generatedCount = 0;
      let hydratedCount = 0;
      let unloadedCount = 0;
      let savedCount = 0;
      let lodCacheVersionMismatchCount = 0;

      try {
        // --- Process Unload Batch ---
        if (this.unloadQueueSet.size > 0) {
          const batch: Chunk[] = [];
          let count = 0;
          const unloadBatchSize = this.getUnloadBatchSize();

          for (const chunk of this.unloadQueueSet) {
            batch.push(chunk);
            this.unloadQueueSet.delete(chunk);

            if (++count >= unloadBatchSize) {
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
              savedCount = chunksToSave.length;
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
              unloadedCount++;
            }
          }
        }

        // --- Process Load Batch ---
        if (this.loadQueue.length > 0) {
          const batch = this.loadQueue.splice(0, this.getLoadBatchSize());

          // Ignore chunks that were unscheduled while waiting in queue.
          const validBatch = batch.filter((chunk) => chunk.isTerrainScheduled);

          if (validBatch.length > 0) {
            const nearChunks: Chunk[] = [];
            const farChunks: Chunk[] = [];
            for (const chunk of validBatch) {
              if ((chunk.lodLevel ?? 0) <= 1) {
                nearChunks.push(chunk);
              } else {
                farChunks.push(chunk);
              }
            }

            const chunksToGenerate: Chunk[] = [];
            const chunksNeedingFullHydration = new Set<bigint>();

            try {
              const [nearLoadedDataMap, farLoadedDataMap] = await Promise.all([
                nearChunks.length > 0
                  ? WorldStorage.loadChunks(
                      nearChunks.map((chunk) => chunk.id),
                      { includeVoxelData: true },
                    )
                  : Promise.resolve(new Map<bigint, SavedChunkData>()),
                farChunks.length > 0
                  ? WorldStorage.loadChunks(
                      farChunks.map((chunk) => chunk.id),
                      { includeVoxelData: false },
                    )
                  : Promise.resolve(new Map<bigint, SavedChunkData>()),
              ]);

              for (const chunk of validBatch) {
                // Chunk may have been unscheduled while awaiting storage.
                if (!chunk.isTerrainScheduled) {
                  continue;
                }

                const currentLod = chunk.lodLevel ?? 0;
                const savedData =
                  currentLod <= 1
                    ? nearLoadedDataMap.get(chunk.id)
                    : farLoadedDataMap.get(chunk.id);

                if (savedData) {
                  const expectedLodCacheVersion = getCurrentLodCacheVersion();
                  if (savedData.lodCacheVersion !== expectedLodCacheVersion) {
                    lodCacheVersionMismatchCount++;
                  }
                  loadedFromStorageCount++;
                  const savedLODMesh = this.pickBestSavedMesh(
                    savedData,
                    currentLod,
                  );
                  const exactSavedMesh = this.getSavedMeshForLod(
                    savedData,
                    currentLod,
                  );

                  const hasDesiredMesh =
                    !!savedLODMesh &&
                    (!!savedLODMesh.opaque || !!savedLODMesh.transparent);
                  const hasExactDesiredMesh =
                    !!exactSavedMesh &&
                    (!!exactSavedMesh.opaque || !!exactSavedMesh.transparent);

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

                  // Far LOD: show best available saved mesh immediately.
                  // Missing exact ring meshes are only rebuilt for newly
                  // created/edited chunks in this session.
                  if (currentLod >= 2) {
                    if (hasDesiredMesh) {
                      chunk.loadLodOnlyFromStorage(false);
                      ChunkMesher.createMeshFromData(chunk, {
                        opaque: savedLODMesh!.opaque,
                        transparent: savedLODMesh!.transparent,
                      });
                    }

                    // Only rebuild missing coarse LOD meshes for chunks that were
                    // changed/newly generated in this session. Persisted chunks
                    // should not re-run simplification work on every movement/load.
                    if (!hasExactDesiredMesh && chunk.isModified) {
                      chunksNeedingFullHydration.add(chunk.id);
                    }
                  } else {
                    chunk.loadFromStorage(
                      savedData.blocks,
                      savedData.palette,
                      savedData.isUniform,
                      savedData.uniformBlockId,
                      savedData.light_array,
                      !hasExactDesiredMesh,
                    );

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
                  }
                } else {
                  chunksToGenerate.push(chunk);
                }
              }

              if (chunksNeedingFullHydration.size > 0) {
                hydratedCount += chunksNeedingFullHydration.size;
                const hydrateIds = Array.from(chunksNeedingFullHydration);
                const hydrateMap = await WorldStorage.loadChunks(hydrateIds, {
                  includeVoxelData: true,
                });

                for (const chunk of validBatch) {
                  if (!chunksNeedingFullHydration.has(chunk.id)) continue;
                  if (!chunk.isTerrainScheduled) continue;

                  const savedData = hydrateMap.get(chunk.id);
                  if (!savedData) {
                    chunksToGenerate.push(chunk);
                    continue;
                  }

                  const currentLod = chunk.lodLevel ?? 0;
                  const savedLODMesh = this.pickBestSavedMesh(
                    savedData,
                    currentLod,
                  );
                  const exactSavedMesh = this.getSavedMeshForLod(
                    savedData,
                    currentLod,
                  );
                  const hasDesiredMesh =
                    !!savedLODMesh &&
                    (!!savedLODMesh.opaque || !!savedLODMesh.transparent);
                  const hasExactDesiredMesh =
                    !!exactSavedMesh &&
                    (!!exactSavedMesh.opaque || !!exactSavedMesh.transparent);

                  chunk.loadFromStorage(
                    savedData.blocks,
                    savedData.palette,
                    savedData.isUniform,
                    savedData.uniformBlockId,
                    savedData.light_array,
                    !hasExactDesiredMesh,
                  );

                  if (hasDesiredMesh) {
                    ChunkMesher.createMeshFromData(chunk, {
                      opaque: savedLODMesh!.opaque,
                      transparent: savedLODMesh!.transparent,
                    });
                  }
                }
              }

              if (chunksToGenerate.length > 0) {
                generatedCount += chunksToGenerate.length;
                ChunkWorkerPool.getInstance().scheduleTerrainGenerationBatch(
                  chunksToGenerate,
                );
              }
            } catch (e) {
              console.warn("Failed to load chunks from storage", e);

              // Important: always clear scheduling so chunks can be retried.
              // Loaded mesh-only chunks can otherwise get stuck with
              // isTerrainScheduled=true but no queue entry.
              for (const chunk of validBatch) {
                chunk.isTerrainScheduled = false;
              }
            }
          }
        }

        const loopElapsedMs = performance.now() - loopStartMs;
        this.debugStats.lastProcessMs = loopElapsedMs;
        this.debugStats.totalProcessLoops += 1;
        this.debugStats.lastLoadedFromStorage = loadedFromStorageCount;
        this.debugStats.lastGenerated = generatedCount;
        this.debugStats.lastHydrated = hydratedCount;
        this.debugStats.lastUnloaded = unloadedCount;
        this.debugStats.lastSaved = savedCount;
        this.debugStats.lastLodCacheVersionMismatches =
          lodCacheVersionMismatchCount;
        this.debugStats.totalLoadedFromStorage += loadedFromStorageCount;
        this.debugStats.totalGenerated += generatedCount;
        this.debugStats.totalHydrated += hydratedCount;
        this.debugStats.totalUnloaded += unloadedCount;
        this.debugStats.totalSaved += savedCount;
        this.debugStats.totalLodCacheVersionMismatches +=
          lodCacheVersionMismatchCount;
        this.refreshQueueDebugSnapshot();

        if (this.loadQueue.length > 0 || this.unloadQueueSet.size > 0) {
          const frameBudgetMs = this.getProcessFrameBudgetMs();
          if (loopElapsedMs < frameBudgetMs) {
            queueMicrotask(() => {
              void processLoop();
            });
          } else {
            requestAnimationFrame(() => {
              void processLoop();
            });
          }
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

  public static areChunksLod0ReadyAround(
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
          if (!chunk.hasVoxelData) {
            return false;
          }
          if ((chunk.lodLevel ?? 0) !== 0) {
            return false;
          }
        }
      }
    }
    return true;
  }
}
