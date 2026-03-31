import { ChunkMesher } from "./ChunckMesher";
import { Chunk } from "./Chunk";
import { ChunkWorker } from "./chunkWorker";
import { MeshData } from "./DataStructures/MeshData";

import {
  DistantTerrainTask,
  DistantTerrainGeneratedMessage,
  FullMeshMessage,
  TerrainGeneratedMessage,
  WorkerResponseData,
  WorkerTaskType,
} from "./DataStructures/WorkerMessageType";

export type WorkerMessageData = WorkerResponseData;

export class ChunkWorkerPool {
  private static instance: ChunkWorkerPool;
  private workers: ChunkWorker[] = [];
  private taskQueue: Chunk[] = [];
  private pendingRemeshQueue: Map<Chunk, boolean> = new Map();
  private terrainTaskQueue: Set<Chunk> = new Set();
  private distantTerrainTaskQueue: DistantTerrainTask[] = [];
  private idleWorkerIndices: number[] = [];
  private meshResultQueue: FullMeshMessage[] = [];
  private remeshFlushScheduled = false;

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

  private constructor(poolSize: number) {
    for (let i = 0; i < poolSize; i++) {
      const onMessage = (event: MessageEvent<WorkerMessageData>) => {
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

            // Mark dirty and defer persistence to unload to avoid write stutter.
            chunk.isModified = true;
          }
        } else if (type === WorkerTaskType.GenerateDistantTerrain_Generated) {
          const distantData: DistantTerrainGeneratedMessage = data;
          this.onDistantTerrainGenerated?.(distantData);
        }

        // Mark worker idle and try to process pending tasks (prefer terrain tasks)
        this.idleWorkerIndices.push(i);
        this.processQueue();
      };
      ``;

      const workerWrapper = new ChunkWorker(onMessage);
      this.workers.push(workerWrapper);
      this.idleWorkerIndices.push(i); // Initially all workers are idle.
    }

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
    // Process meshes for up to 4ms per frame to prevent stutter
    while (this.meshResultQueue.length > 0 && performance.now() - start < 4) {
      const data = this.meshResultQueue.shift();
      if (data) {
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
          }
        }
      }
    }
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

  private tryApplyCachedLODMesh(chunk: Chunk): boolean {
    // Never reuse cache for a chunk that was explicitly marked for remesh.
    // Border edits and light changes set isDirty via scheduleRemesh().
    if (chunk.isDirty) {
      return false;
    }

    const cached = chunk.getCachedLODMesh(chunk.lodLevel);
    if (!cached) {
      return false;
    }

    ChunkMesher.createMeshFromData(chunk, {
      opaque: cached.opaque,
      transparent: cached.transparent,
    });

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

    // Process tasks as long as there are idle workers and tasks in queues
    while (this.idleWorkerIndices.length > 0) {
      let taskChunk: Chunk | undefined;
      let distantTask: DistantTerrainTask | undefined;
      let taskType: "terrain" | "remesh" | "distantTerrain";

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
      // 3) Then distant terrain
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

        const workerIndex = this.idleWorkerIndices.shift()!;
        const worker = this.workers[workerIndex];

        if (taskType === "terrain") {
          worker.postTerrainGeneration(taskChunk!);
        } else if (taskType === "remesh") {
          worker.postFullRemesh(taskChunk!);
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
        }
      } else {
        break;
      }
    }
  }
}
