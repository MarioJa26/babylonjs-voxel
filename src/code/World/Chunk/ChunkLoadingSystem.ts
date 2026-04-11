import { Chunk } from "./Chunk";
import { ChunkWorkerPool } from "./ChunkWorkerPool";
import { SettingParams } from "../SettingParams";
import type { SavedChunkData, SavedChunkEntityData } from "../WorldStorage";
import { ChunkMesher } from "./ChunckMesher";
import { getCurrentLodCacheVersion } from "./LOD/LodCacheVersion";
import type { MeshData } from "./DataStructures/MeshData";

import { ChunkEntityRegistry } from "./Loading/ChunkEntityRegistry";
import { ChunkHydration } from "./Loading/ChunkHydration";
import { ChunkWorldMutations } from "./Loading/ChunkWorldMutations";
import { ChunkLoadingDebug } from "./Loading/ChunkLoadingDebug";
import { ChunkPersistenceCoordinator } from "./Loading/ChunkPersistenceCoordinator";
import { ChunkReadiness } from "./Loading/ChunkReadinessAdapter";
import { ChunkBoundEntity, ChunkLoadingDebugStats } from "./Loading/ChunkTypes";
import { InFlightProcessState } from "./Loading/ChunkTypes";
import { ChunkProcessScheduler } from "./Loading/ChunkProcessScheduler";
import {
  ChunkStreamingController,
  QueuedChunkRequest,
} from "./Loading/ChunkStreamingController";

export class ChunkLoadingSystem {
  private static loadQueue: QueuedChunkRequest[] = [];
  private static unloadQueueSet: Set<Chunk> = new Set();

  private static pendingRemeshChunks: Chunk[] = [];
  private static pendingRemeshChunkIds: Set<bigint> = new Set();

  private static debug = new ChunkLoadingDebug();

  private static chunkEntityRegistry =
    new ChunkEntityRegistry<ChunkBoundEntity>({
      getChunkId: (entity) => {
        if (entity.isAlive && !entity.isAlive()) {
          return null;
        }

        const worldPos = entity.getWorldPosition();
        const chunkX = ChunkLoadingSystem.worldToChunkCoord(worldPos.x);
        const chunkY = ChunkLoadingSystem.worldToChunkCoord(worldPos.y);
        const chunkZ = ChunkLoadingSystem.worldToChunkCoord(worldPos.z);
        return Chunk.packCoords(chunkX, chunkY, chunkZ);
      },

      serialize: (entity) => {
        if (entity.isAlive && !entity.isAlive()) {
          return null;
        }
        return entity.serializeForChunkReload?.() ?? null;
      },

      dispose: (entity) => {
        entity.unload();
      },
    });
  private static processScheduler = new ChunkProcessScheduler({
    getLoadQueue: () => ChunkLoadingSystem.loadQueue,
    getUnloadQueueSet: () => ChunkLoadingSystem.unloadQueueSet,

    getLoadBatchSize: () => ChunkLoadingSystem.getLoadBatchSize(),
    getUnloadBatchSize: () => ChunkLoadingSystem.getUnloadBatchSize(),
    getProcessFrameBudgetMs: () => ChunkLoadingSystem.getProcessFrameBudgetMs(),

    getDesiredState: (chunkId) =>
      ChunkLoadingSystem.streamingController.getDesiredState(chunkId),

    unloadChunkBoundEntitiesForChunk: (chunk) =>
      ChunkLoadingSystem.unloadChunkBoundEntitiesForChunk(chunk),

    applyLoadedChunkFromSavedData: (state, request, savedData) =>
      ChunkLoadingSystem.applyLoadedChunkFromSavedData(
        state,
        request,
        savedData,
      ),

    applyHydratedChunkFromSavedData: (chunk, savedData) =>
      ChunkLoadingSystem.applyHydratedChunkFromSavedData(chunk, savedData),

    scheduleTerrainGenerationBatch: (chunks) =>
      ChunkWorkerPool.getInstance().scheduleTerrainGenerationBatch(chunks),

    updateSliceDebugStats: (state) =>
      ChunkLoadingSystem.updateSliceDebugStats(state),

    finalizeProcessState: (state) =>
      ChunkLoadingSystem.finalizeProcessState(state),

    onQueueSnapshotChanged: () =>
      ChunkLoadingSystem.refreshQueueDebugSnapshot(),
    onLoadRequestsDequeued: (requests) =>
      ChunkLoadingSystem.streamingController.onLoadRequestsDequeued(requests),
  });

  private static _neighborBuffer: (Chunk | undefined)[] = new Array(6);

  private static getNeighbors(chunk: Chunk): (Chunk | undefined)[] {
    const n = this._neighborBuffer;

    n[0] = chunk.getNeighbor(-1, 0, 0);
    n[1] = chunk.getNeighbor(1, 0, 0);
    n[2] = chunk.getNeighbor(0, -1, 0);
    n[3] = chunk.getNeighbor(0, 1, 0);
    n[4] = chunk.getNeighbor(0, 0, -1);
    n[5] = chunk.getNeighbor(0, 0, 1);

    return n;
  }
  private static chunkHydration = new ChunkHydration({
    getStoragePayload: (savedData) => ({
      blocks: savedData.blocks,
      palette: savedData.palette,
      isUniform: savedData.isUniform,
      uniformBlockId: savedData.uniformBlockId,
      lightArray: savedData.light_array,
    }),

    getSavedMeshForLod: (savedData, lod) => {
      if (lod === 0) {
        if (!savedData.opaqueMesh && !savedData.transparentMesh) {
          return null;
        }

        return {
          opaque: savedData.opaqueMesh ?? null,
          transparent: savedData.transparentMesh ?? null,
        };
      }

      const entry = savedData.lodMeshes?.[lod];
      if (!entry) {
        return null;
      }

      return {
        opaque: entry.opaque ?? null,
        transparent: entry.transparent ?? null,
      };
    },

    getAvailableMeshLods: (savedData) => {
      const lods: number[] = [];

      if (
        savedData.opaqueMesh ||
        savedData.transparentMesh ||
        savedData.lodMeshes?.[0]
      ) {
        lods.push(0);
      }

      if (savedData.lodMeshes) {
        for (const key of Object.keys(savedData.lodMeshes)) {
          const lod = Number(key);
          if (!Number.isFinite(lod)) continue;

          const entry = savedData.lodMeshes[lod];
          if (entry?.opaque || entry?.transparent) {
            lods.push(lod);
          }
        }
      }

      return lods;
    },

    getSerializedLodCache: (savedData) => savedData.lodMeshes,
  });

  private static streamingController = new ChunkStreamingController({
    getLoadQueue: () => ChunkLoadingSystem.loadQueue,
    getUnloadQueueSet: () => ChunkLoadingSystem.unloadQueueSet,
    onQueueSnapshotChanged: () =>
      ChunkLoadingSystem.refreshQueueDebugSnapshot(),
  });

  private static worldMutations = new ChunkWorldMutations({
    onBoundaryMutation: ({ chunk }) => {
      if (chunk) {
        ChunkLoadingSystem.scheduleChunkAndNeighborsRemesh(chunk);
      }
    },
  });

  private static readiness = new ChunkReadiness({
    isChunkLoaded: (chunk: Chunk) => chunk.isLoaded,
    isChunkLod0Ready: (chunk: Chunk) => {
      // If lodLevel is null/undefined, it's definitely not ready yet
      if (chunk.lodLevel === undefined || chunk.lodLevel === null) return false;
      return chunk.isLoaded && chunk.hasVoxelData && chunk.lodLevel === 0;
    },
  });

  private static persistenceCoordinator = new ChunkPersistenceCoordinator({
    getModifiedChunks: () => Chunk.chunkInstances.values(),

    getChunkEntityPayloads: () =>
      ChunkLoadingSystem.collectChunkEntityPayloads(),

    getChunkSaveBatchSize: () => ChunkLoadingSystem.getUnloadBatchSize(),
    getChunkEntitySaveBatchSize: () => ChunkLoadingSystem.getUnloadBatchSize(),
  });

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
    this.debug.refreshQueueSnapshot({
      loadQueueLength: this.loadQueue.length,
      unloadQueueLength: this.unloadQueueSet.size,
      pendingChunkEntityReloadCount:
        this.chunkEntityRegistry.getPendingReloadCount(),
      registeredChunkEntityCount:
        this.chunkEntityRegistry.getRegisteredEntityCount(),
    });

    this.debugStats.loadQueueLength = this.loadQueue.length;
    this.debugStats.unloadQueueLength = this.unloadQueueSet.size;
    this.debugStats.loadBatchLimit = this.getLoadBatchSize();
    this.debugStats.unloadBatchLimit = this.getUnloadBatchSize();
    this.debugStats.frameBudgetMs = this.getProcessFrameBudgetMs();
  }
  private static readonly MAX_TRACE_EVENTS_PER_CHUNK = 80;

  private static chunkTrace = new Map<
    bigint,
    Array<{
      t: number;
      event: string;
      data?: Record<string, unknown>;
    }>
  >();

  public static traceChunk(
    chunkId: bigint,
    event: string,
    data?: Record<string, unknown>,
  ): void {
    const list = this.chunkTrace.get(chunkId) ?? [];

    list.push({
      t: performance.now(),
      event,
      data,
    });

    if (list.length > this.MAX_TRACE_EVENTS_PER_CHUNK) {
      list.splice(0, list.length - this.MAX_TRACE_EVENTS_PER_CHUNK);
    }

    this.chunkTrace.set(chunkId, list);
  }

  public static getChunkTrace(chunkId: bigint): Array<{
    t: number;
    event: string;
    data?: Record<string, unknown>;
  }> {
    return [...(this.chunkTrace.get(chunkId) ?? [])];
  }

  public static clearChunkTrace(chunkId?: bigint): void {
    if (chunkId === undefined) {
      this.chunkTrace.clear();
      return;
    }

    this.chunkTrace.delete(chunkId);
  }

  public static dumpChunkTrace(chunkId: bigint): void {
    const entries = this.chunkTrace.get(chunkId) ?? [];
    console.group(`[ChunkTrace ${chunkId.toString()}]`);
    for (const entry of entries) {
      console.log(
        `${entry.t.toFixed(2)}ms :: ${entry.event}`,
        entry.data ?? {},
      );
    }
    console.groupEnd();
  }

  public static dumpChunkTraceByCoords(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
  ): void {
    const chunkId = Chunk.packCoords(chunkX, chunkY, chunkZ);
    this.dumpChunkTrace(chunkId);
  }

  public static validateChunksAround(
    centerChunkX: number,
    centerChunkY: number,
    centerChunkZ: number,
    horizontalRadius = SettingParams.RENDER_DISTANCE,
    verticalRadius = SettingParams.VERTICAL_RENDER_DISTANCE,
  ): void {
    const queuedIds = this.buildQueuedIdSet();
    const missing: Array<{
      chunkX: number;
      chunkY: number;
      chunkZ: number;
      chunkId: bigint;
      isLoaded: boolean;
      isQueued: boolean;
      isUnloading: boolean;
      hasDesiredState: boolean;
    }> = [];

    const minChunkY = 0;
    const maxChunkY = SettingParams.MAX_CHUNK_HEIGHT - 1;

    for (
      let y = Math.max(minChunkY, centerChunkY - verticalRadius);
      y <= Math.min(maxChunkY, centerChunkY + verticalRadius);
      y++
    ) {
      for (
        let x = centerChunkX - horizontalRadius;
        x <= centerChunkX + horizontalRadius;
        x++
      ) {
        for (
          let z = centerChunkZ - horizontalRadius;
          z <= centerChunkZ + horizontalRadius;
          z++
        ) {
          const chunk = Chunk.getChunk(x, y, z);
          const chunkId = Chunk.packCoords(x, y, z);

          const isLoaded = !!chunk?.isLoaded;
          const isQueued = queuedIds.has(chunkId);
          const isUnloading = !!chunk && this.unloadQueueSet.has(chunk);
          const hasDesiredState =
            this.streamingController.getDesiredState(chunkId) !== undefined;

          // Only consider a chunk 'missing' if the streaming controller
          // actually desires it. This avoids false positives for cells
          // outside the streamer window.
          if (hasDesiredState && !isLoaded && !isQueued && !isUnloading) {
            missing.push({
              chunkX: x,
              chunkY: y,
              chunkZ: z,
              chunkId,
              isLoaded,
              isQueued,
              isUnloading,
              hasDesiredState,
            });

            this.traceChunk(chunkId, "missing-desired-in-validate-window", {
              chunkX: x,
              chunkY: y,
              chunkZ: z,
              centerChunkX,
              centerChunkY,
              centerChunkZ,
              horizontalRadius,
              verticalRadius,
              hasDesiredState,
            });
          }
        }
      }
    }

    if (missing.length > 0) {
      console.warn("[ChunkLoadingSystem] Missing desired chunks:", missing);
    }
  }

  private static scheduleChunkBorderRemeshOnLoad(chunk: Chunk): void {
    const pool = ChunkWorkerPool.getInstance();

    // Always remesh the chunk that just became ready.
    pool.scheduleRemesh(chunk, true);

    // Only reconcile already-loaded detailed neighbors.
    const neighbors = this.getNeighbors(chunk);

    for (const neighbor of neighbors) {
      if (!neighbor) continue;
      if (!neighbor.isLoaded) continue;
      if (!neighbor.hasVoxelData) continue;
      if ((neighbor.lodLevel ?? 0) !== 0) continue;
      pool.scheduleRemesh(neighbor, true);
    }
  }

  private static _queuedIdSet: Set<bigint> = new Set();

  private static buildQueuedIdSet(): Set<bigint> {
    const set = this._queuedIdSet;
    set.clear();

    for (let i = 0; i < this.loadQueue.length; i++) {
      set.add(this.loadQueue[i].chunk.id);
    }

    return set;
  }

  public static getDebugStats(): ChunkLoadingDebugStats {
    this.refreshQueueDebugSnapshot();
    return { ...this.debugStats };
  }

  private static ensureChunkLoadedHook(): void {
    this.chunkEntityRegistry.ensureChunkLoadedHook();
  }
  public static enqueueChunkRemesh(chunk: Chunk): void {
    if (this.pendingRemeshChunkIds.has(chunk.id)) {
      return;
    }

    this.pendingRemeshChunkIds.add(chunk.id);
    this.pendingRemeshChunks.push(chunk);

    this.traceChunk(chunk.id, "remesh-enqueued", {
      chunkX: chunk.chunkX,
      chunkY: chunk.chunkY,
      chunkZ: chunk.chunkZ,
    });
  }

  public static processPendingRemeshes(maxChunks = 2): void {
    const pool = ChunkWorkerPool.getInstance();

    let processed = 0;
    while (processed < maxChunks && this.pendingRemeshChunks.length > 0) {
      const chunk = this.pendingRemeshChunks.shift()!;
      this.pendingRemeshChunkIds.delete(chunk.id);

      pool.scheduleRemesh(chunk, true);

      this.traceChunk(chunk.id, "remesh-dispatched", {
        chunkX: chunk.chunkX,
        chunkY: chunk.chunkY,
        chunkZ: chunk.chunkZ,
      });

      processed++;
    }
  }

  public static processFrameBudgetedStreamingWork(
    playerChunkX: number,
    playerChunkY: number,
    playerChunkZ: number,
  ): void {
    // Incrementally refresh a few already-loaded chunks whose LOD may need updating.
    this.streamingController.processLoadedRefreshQueue(
      playerChunkX,
      playerChunkY,
      playerChunkZ,
      SettingParams.RENDER_DISTANCE,
      SettingParams.VERTICAL_RENDER_DISTANCE,
      8,
    );

    // Incrementally dispatch remesh work instead of submitting a burst in one frame.
    this.processPendingRemeshes(2);
  }

  public static registerChunkEntityLoader(
    type: string,
    loader: (payload: unknown, chunk: Chunk) => void,
  ): void {
    this.ensureChunkLoadedHook();
    this.chunkEntityRegistry.registerLoader(type, loader);

    for (const chunk of Chunk.chunkInstances.values()) {
      if (chunk.isLoaded) {
        void this.chunkEntityRegistry.restoreEntitiesForChunk(chunk);
      }
    }
  }

  public static registerChunkBoundEntity(entity: ChunkBoundEntity): symbol {
    this.ensureChunkLoadedHook();
    return this.chunkEntityRegistry.registerEntity(entity);
  }

  public static unregisterChunkBoundEntity(handle: symbol | undefined): void {
    this.chunkEntityRegistry.unregisterEntity(handle);
  }

  private static async unloadChunkBoundEntitiesForChunk(
    chunk: Chunk,
  ): Promise<void> {
    await this.chunkEntityRegistry.unloadEntitiesForChunk(chunk);
  }

  public static flushModifiedChunks(
    maxChunks = ChunkLoadingSystem.getUnloadBatchSize(),
  ): Promise<void> {
    return this.persistenceCoordinator.flushModifiedChunks(maxChunks);
  }

  public static flushChunkBoundEntities(): Promise<void> {
    return this.persistenceCoordinator.flushChunkBoundEntities(
      this.getUnloadBatchSize(),
    );
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
    prevChunkX?: number,
    prevChunkY?: number,
    prevChunkZ?: number,
  ) {
    this.ensureChunkLoadedHook();

    await this.streamingController.updateChunksAround(
      chunkX,
      chunkY,
      chunkZ,
      renderDistance,
      verticalRadius,
      prevChunkX,
      prevChunkY,
      prevChunkZ,
    );

    if (!this.processScheduler.processing) {
      void this.processScheduler.processQueues();
    }
  }

  private static getSavedMeshForLod(
    savedData: SavedChunkData,
    lod: number,
  ): { opaque: MeshData | null; transparent: MeshData | null } | null {
    const selected = this.chunkHydration.getSavedMeshForLod(savedData, lod);
    if (!selected) return null;

    return {
      opaque: selected.opaque,
      transparent: selected.transparent,
    };
  }

  private static pickBestSavedMesh(
    savedData: SavedChunkData,
    desiredLod: number,
  ): { opaque: MeshData | null; transparent: MeshData | null } | null {
    const selected = this.chunkHydration.pickBestSavedMesh(
      savedData,
      desiredLod,
    );
    if (!selected) return null;

    return {
      opaque: selected.opaque,
      transparent: selected.transparent,
    };
  }

  private static updateSliceDebugStats(state: InFlightProcessState): void {
    this.debugStats.lastProcessMs = performance.now() - state.sliceStartMs;
    this.debugStats.lastLoadedFromStorage = state.loadedFromStorageCount;
    this.debugStats.lastGenerated = state.generatedCount;
    this.debugStats.lastHydrated = state.hydratedCount;
    this.debugStats.lastUnloaded = state.unloadedCount;
    this.debugStats.lastSaved = state.savedCount;
    this.debugStats.lastLodCacheVersionMismatches =
      state.lodCacheVersionMismatchCount;

    this.refreshQueueDebugSnapshot();
  }

  private static finalizeProcessState(state: InFlightProcessState): void {
    this.updateSliceDebugStats(state);

    this.debugStats.totalProcessLoops += 1;
    this.debugStats.totalLoadedFromStorage += state.loadedFromStorageCount;
    this.debugStats.totalGenerated += state.generatedCount;
    this.debugStats.totalHydrated += state.hydratedCount;
    this.debugStats.totalUnloaded += state.unloadedCount;
    this.debugStats.totalSaved += state.savedCount;
    this.debugStats.totalLodCacheVersionMismatches +=
      state.lodCacheVersionMismatchCount;
  }

  private static _meshData: {
    opaque: MeshData | null;
    transparent: MeshData | null;
  } = { opaque: null, transparent: null };

  private static getReusableMeshData(
    opaque: MeshData | null,
    transparent: MeshData | null,
  ) {
    const m = this._meshData;
    m.opaque = opaque;
    m.transparent = transparent;
    return m;
  }

  private static applyLoadedChunkFromSavedData(
    state: InFlightProcessState,
    request: QueuedChunkRequest,
    savedData: SavedChunkData,
  ): void {
    const chunk = request.chunk;
    const targetLod = request.desiredLod;

    const expectedLodCacheVersion = getCurrentLodCacheVersion();
    if (savedData.lodCacheVersion !== expectedLodCacheVersion) {
      state.lodCacheVersionMismatchCount++;
    }

    state.loadedFromStorageCount++;

    const savedLODMesh = this.pickBestSavedMesh(savedData, targetLod);
    const exactSavedMesh = this.getSavedMeshForLod(savedData, targetLod);

    const hasDesiredMesh =
      !!savedLODMesh && (!!savedLODMesh.opaque || !!savedLODMesh.transparent);
    const hasExactDesiredMesh =
      !!exactSavedMesh &&
      (!!exactSavedMesh.opaque || !!exactSavedMesh.transparent);

    chunk.lodLevel = targetLod;

    chunk.restoreLODMeshCache(savedData.lodMeshes);

    if (savedData.opaqueMesh || savedData.transparentMesh) {
      chunk.setCachedLODMesh(0, {
        opaque: savedData.opaqueMesh ?? null,
        transparent: savedData.transparentMesh ?? null,
      });
      chunk.isLODMeshCacheDirty = false;
    }

    if (targetLod >= 2) {
      if (hasDesiredMesh) {
        chunk.loadLodOnlyFromStorage(false);
        ChunkMesher.createMeshFromData(chunk, {
          opaque: savedLODMesh!.opaque,
          transparent: savedLODMesh!.transparent,
        });

        this.traceChunk(chunk.id, "far-mesh-applied", {
          targetLod,
        });
        return;
      }

      // If we do not have a usable far mesh, do NOT silently unschedule.
      // Fall back to hydration so the chunk can still become visible.
      state.chunksNeedingFullHydration.add(chunk.id);

      this.traceChunk(chunk.id, "far-no-mesh-needs-hydration", {
        targetLod,
        isModified: chunk.isModified,
      });
      return;
    }

    chunk.loadFromStorage(
      savedData.blocks,
      savedData.palette,
      savedData.isUniform,
      savedData.uniformBlockId,
      savedData.light_array,
      !hasExactDesiredMesh,
    );

    if (hasDesiredMesh) {
      ChunkMesher.createMeshFromData(
        chunk,
        this.getReusableMeshData(
          savedLODMesh!.opaque,
          savedLODMesh!.transparent,
        ),
      );

      if (targetLod === 0) {
        this.scheduleChunkBorderRemeshOnLoad(chunk);
      }
    }
  }

  private static applyHydratedChunkFromSavedData(
    chunk: Chunk,
    savedData: SavedChunkData,
  ): void {
    const currentLod = chunk.lodLevel ?? 0;

    const selectedMesh = this.chunkHydration.pickBestSavedMesh(
      savedData,
      currentLod,
    );
    const exactSavedMesh = this.chunkHydration.getSavedMeshForLod(
      savedData,
      currentLod,
    );

    const hasDesiredMesh =
      !!selectedMesh && (!!selectedMesh.opaque || !!selectedMesh.transparent);
    const hasExactDesiredMesh =
      !!exactSavedMesh &&
      (!!exactSavedMesh.opaque || !!exactSavedMesh.transparent);

    this.chunkHydration.applyHydratedChunkFromSavedData(
      chunk,
      savedData,
      !hasExactDesiredMesh,
    );

    if (hasDesiredMesh) {
      ChunkMesher.createMeshFromData(chunk, {
        opaque: selectedMesh!.opaque,
        transparent: selectedMesh!.transparent,
      });
    }
  }

  public static deleteBlock(worldX: number, worldY: number, worldZ: number) {
    this.worldMutations.deleteBlock(worldX, worldY, worldZ);
  }

  public static setBlock(
    worldX: number,
    worldY: number,
    worldZ: number,
    blockId: number,
    state = 0,
  ) {
    this.worldMutations.setBlock(worldX, worldY, worldZ, blockId, state);
  }

  public static getBlockByWorldCoords(
    worldX: number,
    worldY: number,
    worldZ: number,
  ): number {
    return this.worldMutations.getBlockByWorldCoords(worldX, worldY, worldZ);
  }

  public static getBlockStateByWorldCoords(
    worldX: number,
    worldY: number,
    worldZ: number,
  ): number {
    return this.worldMutations.getBlockStateByWorldCoords(
      worldX,
      worldY,
      worldZ,
    );
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

    return this.worldMutations.getLightByWorldCoords(worldX, worldY, worldZ);
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
    return this.readiness.areChunksLoadedAround(
      chunkX,
      chunkY,
      chunkZ,
      horizontalRadius,
      verticalRadius,
    );
  }

  public static areChunksLod0ReadyAround(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    horizontalRadius = 1,
    verticalRadius = 0,
  ): boolean {
    return this.readiness.areChunksLod0ReadyAround(
      chunkX,
      chunkY,
      chunkZ,
      horizontalRadius,
      verticalRadius,
    );
  }

  private static getRuntimeEntityChunkId(
    entity: ChunkBoundEntity,
  ): bigint | null {
    if (entity.isAlive && !entity.isAlive()) {
      return null;
    }

    const worldPos = entity.getWorldPosition();
    const chunkX = this.worldToChunkCoord(worldPos.x);
    const chunkY = this.worldToChunkCoord(worldPos.y);
    const chunkZ = this.worldToChunkCoord(worldPos.z);
    return Chunk.packCoords(chunkX, chunkY, chunkZ);
  }

  private static serializeRuntimeEntity(
    entity: ChunkBoundEntity,
  ): SavedChunkEntityData | null {
    if (entity.isAlive && !entity.isAlive()) {
      return null;
    }

    return entity.serializeForChunkReload?.() ?? null;
  }

  private static collectChunkEntityPayloads(): ReadonlyMap<
    bigint,
    SavedChunkEntityData[]
  > {
    const entitiesByChunk = new Map<bigint, SavedChunkEntityData[]>();

    for (const entity of this.chunkEntityRegistry
      .getRegisteredEntities()
      .values()) {
      const chunkId = this.getRuntimeEntityChunkId(entity);
      const serialized = this.serializeRuntimeEntity(entity);

      if (chunkId === null || !serialized) {
        continue;
      }

      const list = entitiesByChunk.get(chunkId);
      if (list) {
        list.push(serialized);
      } else {
        entitiesByChunk.set(chunkId, [serialized]);
      }
    }

    return entitiesByChunk;
  }
}
