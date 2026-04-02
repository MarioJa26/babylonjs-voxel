import { ChunkMesher } from "./ChunckMesher";
import { Chunk } from "./Chunk";
import { ChunkWorker } from "./chunkWorker";
import { MeshData } from "./DataStructures/MeshData";
import { SettingParams } from "../SettingParams";
import { WorldStorage } from "../WorldStorage";

import {
  DistantTerrainTask,
  DistantTerrainGeneratedMessage,
  FullMeshMessage,
  TerrainGeneratedMessage,
  WorkerResponseData,
  WorkerTaskType,
} from "./DataStructures/WorkerMessageType";

export type WorkerMessageData = WorkerResponseData;

export type ChunkWorkerPoolDebugStats = {
  workerCount: number;
  idleWorkers: number;
  remeshQueueLength: number;
  terrainQueueLength: number;
  lodPrecomputeQueueLength: number;
  distantTerrainQueueLength: number;
  meshResultQueueLength: number;
  dispatchBudgetPerTick: number;
  lastDispatchCount: number;
  totalDispatchCount: number;
  lastMeshDrainMs: number;
  lastMeshProcessed: number;
  totalMeshProcessed: number;
  totalTerrainDispatches: number;
  totalRemeshDispatches: number;
  totalLodPrecomputeDispatches: number;
  totalDistantDispatches: number;
};

export class ChunkWorkerPool {
  private static instance: ChunkWorkerPool;
  private static readonly WORKER_ERROR_COOLDOWN_MS = 120;
  private workers: ChunkWorker[] = [];
  private workerTaskContext: Array<
    | {
        taskType: "terrain" | "remesh" | "lodPrecompute" | "distantTerrain";
        chunk?: Chunk;
        lod?: number;
        distantTask?: DistantTerrainTask;
      }
    | null
  > = [];
  private workerRestartAtMs: number[] = [];
  private taskQueue: Chunk[] = [];
  private pendingRemeshQueue: Map<Chunk, boolean> = new Map();
  private terrainTaskQueue: Set<Chunk> = new Set();
  private distantTerrainTaskQueue: DistantTerrainTask[] = [];
  private lodPrecomputeQueue: Array<{ chunk: Chunk; lod: number }> = [];
  private pendingLodPrecomputeKeys = new Set<string>();
  private lastPrecomputeScheduleTs = 0;
  private idleWorkerIndices: number[] = [];
  private meshResultQueue: FullMeshMessage[] = [];
  private remeshFlushScheduled = false;
  private processQueuePumpScheduled = false;
  private debugStats: ChunkWorkerPoolDebugStats = {
    workerCount: 0,
    idleWorkers: 0,
    remeshQueueLength: 0,
    terrainQueueLength: 0,
    lodPrecomputeQueueLength: 0,
    distantTerrainQueueLength: 0,
    meshResultQueueLength: 0,
    dispatchBudgetPerTick: 0,
    lastDispatchCount: 0,
    totalDispatchCount: 0,
    lastMeshDrainMs: 0,
    lastMeshProcessed: 0,
    totalMeshProcessed: 0,
    totalTerrainDispatches: 0,
    totalRemeshDispatches: 0,
    totalLodPrecomputeDispatches: 0,
    totalDistantDispatches: 0,
  };

  private getDispatchBudgetPerTick(): number {
    const configured = Math.floor(
      SettingParams.CHUNK_WORKER_DISPATCH_BUDGET_PER_TICK,
    );
    return configured <= 0 ? Number.POSITIVE_INFINITY : configured;
  }

  private hasPendingTasks(): boolean {
    return (
      this.terrainTaskQueue.size > 0 ||
      this.taskQueue.length > 0 ||
      this.lodPrecomputeQueue.length > 0 ||
      this.distantTerrainTaskQueue.length > 0
    );
  }

  private scheduleProcessQueuePump(): void {
    if (this.processQueuePumpScheduled) {
      return;
    }
    this.processQueuePumpScheduled = true;
    requestAnimationFrame(() => {
      this.processQueuePumpScheduled = false;
      this.processQueue();
    });
  }

  private updateQueueDebugStats(): void {
    this.debugStats.workerCount = this.workers.length;
    this.debugStats.idleWorkers = this.idleWorkerIndices.length;
    this.debugStats.remeshQueueLength = this.taskQueue.length;
    this.debugStats.terrainQueueLength = this.terrainTaskQueue.size;
    this.debugStats.lodPrecomputeQueueLength = this.lodPrecomputeQueue.length;
    this.debugStats.distantTerrainQueueLength = this.distantTerrainTaskQueue.length;
    this.debugStats.meshResultQueueLength = this.meshResultQueue.length;
    const dispatchBudget = this.getDispatchBudgetPerTick();
    this.debugStats.dispatchBudgetPerTick = Number.isFinite(dispatchBudget)
      ? dispatchBudget
      : 0;
  }

  public getDebugStats(): ChunkWorkerPoolDebugStats {
    this.updateQueueDebugStats();
    return { ...this.debugStats };
  }

  private resolveChunkByMessageId(chunkId: unknown): Chunk | undefined {
    if (typeof chunkId === "bigint") {
      return Chunk.chunkInstances.get(chunkId);
    }
    if (typeof chunkId === "string") {
      try {
        return Chunk.chunkInstances.get(BigInt(chunkId));
      } catch {
        return undefined;
      }
    }
    if (typeof chunkId === "number" && Number.isInteger(chunkId)) {
      return Chunk.chunkInstances.get(BigInt(chunkId));
    }
    return undefined;
  }

  public onDistantTerrainGenerated:
    | ((data: DistantTerrainGeneratedMessage) => void)
    | null = null;

  private handleWorkerFailure(workerIndex: number, reason: unknown): void {
    const context = this.workerTaskContext[workerIndex];
    this.workerTaskContext[workerIndex] = null;

    if (context?.taskType === "terrain" && context.chunk) {
      this.terrainTaskQueue.add(context.chunk);
    } else if (
      context?.taskType === "remesh" &&
      context.chunk &&
      context.chunk.isLoaded
    ) {
      this.scheduleRemesh(context.chunk, true);
    } else if (
      context?.taskType === "lodPrecompute" &&
      context.chunk &&
      typeof context.lod === "number"
    ) {
      const key = this.getLodPrecomputeKey(context.chunk, context.lod);
      if (!this.pendingLodPrecomputeKeys.has(key)) {
        this.pendingLodPrecomputeKeys.add(key);
        this.lodPrecomputeQueue.push({ chunk: context.chunk, lod: context.lod });
      }
    } else if (context?.taskType === "distantTerrain" && context.distantTask) {
      this.distantTerrainTaskQueue.unshift(context.distantTask);
    }

    const failedWorker = this.workers[workerIndex];
    this.idleWorkerIndices = this.idleWorkerIndices.filter(
      (idx) => idx !== workerIndex,
    );
    try {
      failedWorker?.terminate();
    } catch {
      // Ignore teardown errors.
    }

    const now = performance.now();
    const earliestRestart = (this.workerRestartAtMs[workerIndex] ?? 0) + ChunkWorkerPool.WORKER_ERROR_COOLDOWN_MS;
    const delay = Math.max(0, earliestRestart - now);

    const restart = () => {
      let replacement: ChunkWorker;
      const onMessage = (event: MessageEvent<WorkerMessageData>) => {
        let failed = false;
        try {
          const data = event.data;
          const { type } = data;

          if (type === WorkerTaskType.GenerateFullMesh) {
            const meshData: FullMeshMessage = data;
            this.meshResultQueue.push(meshData);
          } else if (type === WorkerTaskType.GenerateTerrain) {
            const terrainData: TerrainGeneratedMessage = data;
            const {
              chunkId,
              block_array,
              light_array,
              isUniform,
              uniformBlockId,
              palette,
            } = terrainData;

            const chunk = this.resolveChunkByMessageId(chunkId);
            if (chunk) {
              let blocks: Uint8Array | Uint16Array | null = block_array;
              let light: Uint8Array = light_array;

              // Terrain-generation palettes are produced as Uint16Array | null by the worker.
              const typedPalette: Uint16Array | null =
                palette instanceof Uint16Array ? palette : null;

              // Ensure we are using SharedArrayBuffer to avoid copying during remesh
              if (blocks && !(blocks.buffer instanceof SharedArrayBuffer)) {
                const shared = new SharedArrayBuffer(blocks.byteLength);
                if (blocks instanceof Uint16Array) {
                  new Uint16Array(shared).set(blocks);
                  blocks = new Uint16Array(shared);
                } else {
                  new Uint8Array(shared).set(blocks);
                  blocks = new Uint8Array(shared);
                }
              }

              if (!(light.buffer instanceof SharedArrayBuffer)) {
                const shared = new SharedArrayBuffer(light.byteLength);
                new Uint8Array(shared).set(light);
                light = new Uint8Array(shared);
              }

              chunk.populate(
                blocks,
                typedPalette,
                isUniform,
                uniformBlockId,
                light,
                false,
              );

              this.scheduleChunkAndNeighborsRemesh(chunk);

              // Mark dirty and persist immediately through WorldStorage lanes.
              chunk.isModified = true;
              void WorldStorage.saveChunk(chunk).catch((error) => {
                console.error("Initial generated chunk persistence failed:", error);
              });
            }
          } else if (type === WorkerTaskType.GenerateDistantTerrain_Generated) {
            const distantData: DistantTerrainGeneratedMessage = data;
            this.onDistantTerrainGenerated?.(distantData);
          }
        } catch (messageError) {
          failed = true;
          console.error(
            `Chunk worker ${workerIndex} onmessage failed; respawning worker`,
            messageError,
          );
          this.handleWorkerFailure(workerIndex, messageError);
          return;
        } finally {
          if (failed) {
            return;
          }
          // If handleWorkerFailure already replaced this worker, avoid mutating
          // queue state from the stale callback.
          if (this.workers[workerIndex] !== replacement) {
            return;
          }
          this.workerTaskContext[workerIndex] = null;
          if (!this.idleWorkerIndices.includes(workerIndex)) {
            this.idleWorkerIndices.push(workerIndex);
          }
          this.processQueue();
        }
      };

      const onError = (ev: ErrorEvent | Event) => {
        console.error(`Chunk worker ${workerIndex} error`, ev, reason);
        this.handleWorkerFailure(workerIndex, ev);
      };

      replacement = new ChunkWorker(onMessage);
      replacement.setOnError(onError);
      this.workers[workerIndex] = replacement;
      this.workerRestartAtMs[workerIndex] = performance.now();
      this.workerTaskContext[workerIndex] = null;
      if (!this.idleWorkerIndices.includes(workerIndex)) {
        this.idleWorkerIndices.push(workerIndex);
      }
      this.processQueue();
    };

    if (delay > 0) {
      window.setTimeout(restart, delay);
    } else {
      restart();
    }
  }

  private constructor(poolSize: number) {
    for (let i = 0; i < poolSize; i++) {
      let workerWrapper: ChunkWorker;
      const onMessage = (event: MessageEvent<WorkerMessageData>) => {
        let failed = false;
        try {
          const data = event.data;
          const { type } = data;

          if (type === WorkerTaskType.GenerateFullMesh) {
            const meshData: FullMeshMessage = data;
            this.meshResultQueue.push(meshData);
          } else if (type === WorkerTaskType.GenerateTerrain) {
            const terrainData: TerrainGeneratedMessage = data;
            const {
              chunkId,
              block_array,
              light_array,
              isUniform,
              uniformBlockId,
              palette,
            } = terrainData;

            const chunk = this.resolveChunkByMessageId(chunkId);
            if (chunk) {
              let blocks: Uint8Array | Uint16Array | null = block_array;
              let light: Uint8Array = light_array;

              // Terrain-generation palettes are produced as Uint16Array | null by the worker.
              const typedPalette: Uint16Array | null =
                palette instanceof Uint16Array ? palette : null;

              // Ensure we are using SharedArrayBuffer to avoid copying during remesh
              if (blocks && !(blocks.buffer instanceof SharedArrayBuffer)) {
                const shared = new SharedArrayBuffer(blocks.byteLength);
                if (blocks instanceof Uint16Array) {
                  new Uint16Array(shared).set(blocks);
                  blocks = new Uint16Array(shared);
                } else {
                  new Uint8Array(shared).set(blocks);
                  blocks = new Uint8Array(shared);
                }
              }

              if (!(light.buffer instanceof SharedArrayBuffer)) {
                const shared = new SharedArrayBuffer(light.byteLength);
                new Uint8Array(shared).set(light);
                light = new Uint8Array(shared);
              }

              chunk.populate(
                blocks,
                typedPalette,
                isUniform,
                uniformBlockId,
                light,
                false,
              );

              this.scheduleChunkAndNeighborsRemesh(chunk);

              // Mark dirty and persist immediately through WorldStorage lanes.
              chunk.isModified = true;
              void WorldStorage.saveChunk(chunk).catch((error) => {
                console.error("Initial generated chunk persistence failed:", error);
              });
            }
          } else if (type === WorkerTaskType.GenerateDistantTerrain_Generated) {
            const distantData: DistantTerrainGeneratedMessage = data;
            this.onDistantTerrainGenerated?.(distantData);
          }
        } catch (messageError) {
          failed = true;
          console.error(
            `Chunk worker ${i} onmessage failed; respawning worker`,
            messageError,
          );
          this.handleWorkerFailure(i, messageError);
          return;
        } finally {
          if (failed) {
            return;
          }
          if (this.workers[i] !== workerWrapper) {
            return;
          }
          this.workerTaskContext[i] = null;
          if (!this.idleWorkerIndices.includes(i)) {
            this.idleWorkerIndices.push(i);
          }
          this.processQueue();
        }
      };
      const onError = (ev: ErrorEvent | Event) => {
        console.error(`Chunk worker ${i} error`, ev);
        this.handleWorkerFailure(i, ev);
      };

      workerWrapper = new ChunkWorker(onMessage);
      workerWrapper.setOnError(onError);
      this.workers.push(workerWrapper);
      this.idleWorkerIndices.push(i); // Initially all workers are idle.
      this.workerTaskContext.push(null);
      this.workerRestartAtMs.push(0);
    }

    this.updateQueueDebugStats();
    this.processMeshQueueLoop();
  }

  private isCompletelyEmptyChunk(chunk: Chunk): boolean {
    return chunk.isUniform && chunk.uniformBlockId === 0;
  }

  private clearChunkMeshIfPresent(chunk: Chunk): void {
    if (
      chunk.mesh ||
      chunk.transparentMesh ||
      chunk.opaqueMeshData ||
      chunk.transparentMeshData ||
      chunk.colliderDirty
    ) {
      ChunkMesher.createMeshFromData(chunk, {
        opaque: null,
        transparent: null,
      });
    }
  }

  private processMeshQueueLoop = () => {
    const start = performance.now();
    let processed = 0;
    // Process meshes for up to 4ms per frame to prevent stutter
    while (this.meshResultQueue.length > 0 && performance.now() - start < 4) {
      const data = this.meshResultQueue.shift();
      if (data) {
        processed++;
        const { chunkId, lod, opaque, transparent } = data;
        const chunk = this.resolveChunkByMessageId(chunkId);
        if (chunk) {
          this.storeReturnedLODMesh(
            chunk,
            lod,
            opaque ?? null,
            transparent ?? null,
          );

          // Only apply immediately if the chunk is still on the same LOD
          // that produced this worker result.
          if ((chunk.lodLevel ?? 0) === lod) {
            ChunkMesher.createMeshFromData(chunk, {
              opaque,
              transparent,
            });
            chunk.isDirty = false;
          }
        }
      }
    }
    this.debugStats.lastMeshProcessed = processed;
    this.debugStats.totalMeshProcessed += processed;
    this.debugStats.lastMeshDrainMs = performance.now() - start;
    this.updateQueueDebugStats();
    requestAnimationFrame(this.processMeshQueueLoop);
  };

  public static getInstance(
    poolSize = navigator.hardwareConcurrency || 4,
  ): ChunkWorkerPool {
    if (!ChunkWorkerPool.instance) {
      ChunkWorkerPool.instance = new ChunkWorkerPool(poolSize);
      Chunk.onRequestRemesh = (chunk: Chunk, priority: boolean) => {
        ChunkWorkerPool.instance.scheduleRemesh(chunk, priority);
      };
    }
    return ChunkWorkerPool.instance;
  }

  // existing remesh scheduling
  public scheduleRemesh(chunk: Chunk | undefined, priority = false) {
    if (!chunk || !chunk.isLoaded) {
      return;
    }

    // Mesh-only far LOD chunks do not carry voxel data, so worker remesh would
    // collapse to empty geometry. Keep cached mesh instead until hydrated.
    if (!chunk.hasVoxelData) {
      this.tryApplyCachedLODMesh(chunk, true);
      return;
    }

    if (this.isCompletelyEmptyChunk(chunk)) {
      this.pendingRemeshQueue.delete(chunk);

      const queuedIndex = this.taskQueue.indexOf(chunk);
      if (queuedIndex !== -1) {
        this.taskQueue.splice(queuedIndex, 1);
      }

      this.clearChunkMeshIfPresent(chunk);
      return;
    }

    const lodPriority = this.getChunkLodLevel(chunk) === 0;
    const existingPriority = this.pendingRemeshQueue.get(chunk) ?? false;

    // LOD0 chunks automatically get promoted
    this.pendingRemeshQueue.set(
      chunk,
      existingPriority || priority || lodPriority,
    );
    this.scheduleRemeshFlush();
  }

  private scheduleRemeshFlush() {
    if (this.remeshFlushScheduled) {
      return;
    }
    this.remeshFlushScheduled = true;
    requestAnimationFrame(() => {
      this.remeshFlushScheduled = false;
      this.flushPendingRemeshQueue();
    });
  }

  private flushPendingRemeshQueue() {
    if (this.pendingRemeshQueue.size === 0) {
      return;
    }

    const pending = Array.from(this.pendingRemeshQueue.entries());
    this.pendingRemeshQueue.clear();

    // Sort before inserting so LOD0 + explicit priority goes first
    pending.sort(([chunkA, priorityA], [chunkB, priorityB]) =>
      this.compareRemeshPriority(chunkA, priorityA, chunkB, priorityB),
    );

    for (const [chunk, priority] of pending) {
      if (!chunk.isLoaded) {
        continue;
      }

      if (this.isCompletelyEmptyChunk(chunk)) {
        this.clearChunkMeshIfPresent(chunk);
        continue;
      }

      this.insertChunkIntoRemeshQueue(chunk, priority);
    }

    this.processQueue();
  }
  private storeReturnedLODMesh(
    chunk: Chunk,
    lod: number,
    opaque: MeshData | null,
    transparent: MeshData | null,
  ): void {
    chunk.setCachedLODMesh(lod, {
      opaque: opaque ?? null,
      transparent: transparent ?? null,
    });
  }

  private tryApplyCachedLODMesh(
    chunk: Chunk,
    allowDirtyReuse = false,
  ): boolean {
    // Never reuse cache for a chunk that was explicitly marked for remesh.
    // Border edits and light changes set isDirty via scheduleRemesh().
    if (!allowDirtyReuse && chunk.isDirty) {
      return false;
    }

    const cached = chunk.getCachedLODMesh(chunk.lodLevel);
    if (!cached) {
      return false;
    }
    if (!cached.opaque && !cached.transparent) {
      return false;
    }

    ChunkMesher.createMeshFromData(chunk, {
      opaque: cached.opaque,
      transparent: cached.transparent,
    });
    chunk.isDirty = false;

    return true;
  }

  private getChunkLodLevel(chunk: Chunk | undefined): number {
    return chunk?.lodLevel ?? 0;
  }

  private compareRemeshPriority(
    aChunk: Chunk,
    aPriority: boolean,
    bChunk: Chunk,
    bPriority: boolean,
  ): number {
    // Explicit priority always wins first
    if (aPriority !== bPriority) {
      return aPriority ? -1 : 1;
    }

    // Then prefer lower LOD value (LOD0 before LOD1)
    const aLod = this.getChunkLodLevel(aChunk);
    const bLod = this.getChunkLodLevel(bChunk);
    if (aLod !== bLod) {
      return aLod - bLod;
    }

    // Then prefer modified chunks
    if (aChunk.isModified !== bChunk.isModified) {
      return aChunk.isModified ? -1 : 1;
    }

    return 0;
  }

  private insertChunkIntoRemeshQueue(chunk: Chunk, priority: boolean): void {
    // Remove if already present so we can reinsert in the right position
    const existingIndex = this.taskQueue.indexOf(chunk);
    if (existingIndex !== -1) {
      this.taskQueue.splice(existingIndex, 1);
    }

    let insertIndex = this.taskQueue.length;

    for (let i = 0; i < this.taskQueue.length; i++) {
      const queuedChunk = this.taskQueue[i];
      const queuedPriority = false; // queued items no longer carry explicit flag
      if (
        this.compareRemeshPriority(
          chunk,
          priority,
          queuedChunk,
          queuedPriority,
        ) < 0
      ) {
        insertIndex = i;
        break;
      }
    }

    this.taskQueue.splice(insertIndex, 0, chunk);
  }

  public scheduleTerrainGeneration(chunk: Chunk) {
    this.terrainTaskQueue.add(chunk);
    this.processQueue();
  }

  public scheduleTerrainGenerationBatch(chunks: Chunk[]) {
    for (const chunk of chunks) {
      this.terrainTaskQueue.add(chunk);
    }
    this.processQueue();
  }

  private getLodPrecomputeKey(chunk: Chunk, lod: number): string {
    return `${chunk.id.toString()}:${lod}`;
  }

  public scheduleBackgroundLodPrecompute(
    centerChunkX: number,
    centerChunkY: number,
    centerChunkZ: number,
  ): void {
    const now = performance.now();
    const throttleMs = Math.max(
      0,
      Math.floor(SettingParams.LOD_PRECOMPUTE_SCHEDULE_THROTTLE_MS),
    );
    // Throttle precompute scheduling to keep traversal overhead low.
    if (throttleMs > 0 && now - this.lastPrecomputeScheduleTs < throttleMs) {
      return;
    }
    this.lastPrecomputeScheduleTs = now;

    const horizontalRadius = SettingParams.RENDER_DISTANCE + 14;
    const verticalRadius = SettingParams.VERTICAL_RENDER_DISTANCE + 4;
    const targetLods = [2, 3];
    const candidates: Array<{ chunk: Chunk; lod: number; score: number }> = [];

    for (const chunk of Chunk.chunkInstances.values()) {
      if (!chunk.isLoaded || !chunk.hasVoxelData) continue;
      if (chunk.isDirty) continue;
      // Only precompute coarse LODs for chunks that were created/edited in this
      // session. Persisted chunks should reuse stored LOD meshes without
      // rebuilding simplified arrays during movement.
      if (!chunk.isModified) continue;

      const horizontalDist = Math.max(
        Math.abs(chunk.chunkX - centerChunkX),
        Math.abs(chunk.chunkZ - centerChunkZ),
      );
      const verticalDist = Math.abs(chunk.chunkY - centerChunkY);
      if (
        horizontalDist > horizontalRadius ||
        verticalDist > verticalRadius
      ) {
        continue;
      }

      for (const lod of targetLods) {
        if (chunk.hasCachedLODMesh(lod)) continue;
        const key = this.getLodPrecomputeKey(chunk, lod);
        if (this.pendingLodPrecomputeKeys.has(key)) continue;

        const score = horizontalDist * 100 + verticalDist * 10 + lod;
        candidates.push({ chunk, lod, score });
      }
    }

    if (candidates.length === 0) {
      return;
    }

    candidates.sort((a, b) => a.score - b.score);

    const maxEnqueue = Math.max(
      1,
      Math.floor(SettingParams.LOD_PRECOMPUTE_MAX_ENQUEUE_PER_UPDATE),
    );
    let added = 0;
    for (const candidate of candidates) {
      if (added >= maxEnqueue) break;
      const key = this.getLodPrecomputeKey(candidate.chunk, candidate.lod);
      if (this.pendingLodPrecomputeKeys.has(key)) continue;
      this.pendingLodPrecomputeKeys.add(key);
      this.lodPrecomputeQueue.push({
        chunk: candidate.chunk,
        lod: candidate.lod,
      });
      added++;
    }

    if (added > 0) {
      this.updateQueueDebugStats();
      this.processQueue();
    }
  }

  private scheduleChunkAndNeighborsRemesh(chunk: Chunk): void {
    const targets: (Chunk | undefined)[] = [
      chunk,
      chunk.getNeighbor(-1, 0, 0),
      chunk.getNeighbor(0, 0, -1),
      chunk.getNeighbor(0, -1, 0),
      chunk.getNeighbor(1, 0, 0),
      chunk.getNeighbor(0, 0, 1),
      chunk.getNeighbor(0, 1, 0),
    ];

    for (const target of targets) {
      if (!target) continue;
      this.scheduleRemesh(target, this.getChunkLodLevel(target) === 0);
    }
  }

  public scheduleDistantTerrain(
    centerChunkX: number,
    centerChunkZ: number,
    radius: number,
    renderDistance: number,
    gridStep: number,
    oldData?: {
      positions: Int16Array;
      normals: Int8Array;
      surfaceTiles: Uint8Array;
    },
    oldCenterChunkX?: number,
    oldCenterChunkZ?: number,
  ) {
    // Cancel pending distant terrain tasks by clearing the queue.
    // We only care about the most recent request.
    this.distantTerrainTaskQueue = [
      {
        centerChunkX,
        centerChunkZ,
        radius,
        renderDistance,
        gridStep,
        oldData,
        oldCenterChunkX,
        oldCenterChunkZ,
      },
    ];
    this.processQueue();
  }

  private processQueue() {
    this.updateQueueDebugStats();

    // Keep remesh queue stable and LOD-aware before dispatching
    if (this.taskQueue.length > 1) {
      this.taskQueue.sort((a, b) =>
        this.compareRemeshPriority(
          a,
          this.getChunkLodLevel(a) === 0,
          b,
          this.getChunkLodLevel(b) === 0,
        ),
      );
    }

    const dispatchBudget = this.getDispatchBudgetPerTick();
    let dispatchedThisTick = 0;

    // Process tasks as long as there are idle workers and tasks in queues
    while (
      this.idleWorkerIndices.length > 0 &&
      dispatchedThisTick < dispatchBudget
    ) {
      let taskChunk: Chunk | undefined;
      let distantTask: DistantTerrainTask | undefined;
      let precomputeLod: number | undefined;
      let taskType: "terrain" | "remesh" | "lodPrecompute" | "distantTerrain";

      // 1) Terrain generation first
      if (this.terrainTaskQueue.size > 0) {
        taskChunk = this.terrainTaskQueue.values().next().value;
        this.terrainTaskQueue.delete(taskChunk!);
        taskType = "terrain";
      }
      // 2) Then remesh, already sorted by LOD priority
      else if (this.taskQueue.length > 0) {
        taskChunk = this.taskQueue.shift();
        taskType = "remesh";
      }
      // 3) Then background LOD cache precompute
      else if (this.lodPrecomputeQueue.length > 0) {
        const task = this.lodPrecomputeQueue.shift()!;
        taskChunk = task.chunk;
        precomputeLod = task.lod;
        this.pendingLodPrecomputeKeys.delete(
          this.getLodPrecomputeKey(task.chunk, task.lod),
        );
        taskType = "lodPrecompute";
      }
      // 4) Then distant terrain
      else if (this.distantTerrainTaskQueue.length > 0) {
        distantTask = this.distantTerrainTaskQueue.shift();
        taskType = "distantTerrain";
      } else {
        break;
      }

      if (taskChunk || distantTask) {
        if (
          taskType === "remesh" &&
          taskChunk &&
          this.isCompletelyEmptyChunk(taskChunk)
        ) {
          this.clearChunkMeshIfPresent(taskChunk);
          continue;
        }

        if (taskType === "remesh" && taskChunk) {
          if (this.tryApplyCachedLODMesh(taskChunk)) {
            continue;
          }
        }

        if (taskType === "lodPrecompute" && taskChunk) {
          if (
            !taskChunk.isLoaded ||
            !taskChunk.hasVoxelData ||
            precomputeLod === undefined ||
            taskChunk.hasCachedLODMesh(precomputeLod)
          ) {
            continue;
          }
        }

        const workerIndex = this.idleWorkerIndices.shift()!;
        const worker = this.workers[workerIndex];
        this.workerTaskContext[workerIndex] = {
          taskType,
          chunk: taskChunk,
          lod: precomputeLod,
          distantTask,
        };

        try {
          if (taskType === "terrain") {
            worker.postTerrainGeneration(taskChunk!);
            this.debugStats.totalTerrainDispatches += 1;
          } else if (taskType === "remesh") {
            worker.postFullRemesh(taskChunk!);
            this.debugStats.totalRemeshDispatches += 1;
          } else if (taskType === "lodPrecompute") {
            worker.postFullRemesh(taskChunk!, precomputeLod);
            this.debugStats.totalLodPrecomputeDispatches += 1;
          } else {
            worker.postGenerateDistantTerrain(
              distantTask!.centerChunkX,
              distantTask!.centerChunkZ,
              distantTask!.radius,
              distantTask!.renderDistance,
              distantTask!.gridStep,
              distantTask!.oldData,
              distantTask!.oldCenterChunkX,
              distantTask!.oldCenterChunkZ,
            );
            this.debugStats.totalDistantDispatches += 1;
          }
          dispatchedThisTick += 1;
        } catch (dispatchError) {
          console.error(
            `Failed to dispatch worker task (${taskType}) on worker ${workerIndex}`,
            dispatchError,
          );
          this.handleWorkerFailure(workerIndex, dispatchError);
        }
      } else {
        break;
      }
    }

    this.debugStats.lastDispatchCount = dispatchedThisTick;
    this.debugStats.totalDispatchCount += dispatchedThisTick;
    this.updateQueueDebugStats();

    if (this.idleWorkerIndices.length > 0 && this.hasPendingTasks()) {
      this.scheduleProcessQueuePump();
    }
  }
}
