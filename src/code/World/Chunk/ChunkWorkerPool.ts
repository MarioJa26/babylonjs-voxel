import { Chunk } from "./Chunk";
import { ChunkMesher } from "./ChunckMesher";
import { ChunkWorker } from "./chunkWorker";
import {
  DistantTerrainTask,
  FullMeshMessage,
  TerrainGeneratedMessage,
  DistantTerrainGeneratedMessage,
} from "./DataStructures/WorkerMessageType";

export type WorkerMessageData =
  | FullMeshMessage
  | TerrainGeneratedMessage
  | DistantTerrainGeneratedMessage;

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

  public onDistantTerrainGenerated:
    | ((data: DistantTerrainGeneratedMessage) => void)
    | null = null;

  private constructor(poolSize: number) {
    for (let i = 0; i < poolSize; i++) {
      const onMessage = (event: MessageEvent<WorkerMessageData>) => {
        const data = event.data;
        const { type } = data;

        if (type === "full-mesh") {
          this.meshResultQueue.push(data);
        } else if (type === "terrain-generated") {
          const { chunkId } = data;
          const {
            block_array,
            light_array,
            isUniform,
            uniformBlockId,
            palette,
          } = data as any;
          // Apply generated block array to the chunk and schedule remesh
          const chunk = Chunk.chunkInstances.get(chunkId);
          if (chunk) {
            let blocks = block_array as Uint8Array | Uint16Array | null;
            let light = light_array as Uint8Array;

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
              palette,
              isUniform,
              uniformBlockId,
              light,
              false,
            );
            this.scheduleRemesh(chunk);
            this.scheduleRemesh(chunk.getNeighbor(-1, 0, 0));
            this.scheduleRemesh(chunk.getNeighbor(0, 0, -1));
            this.scheduleRemesh(chunk.getNeighbor(0, -1, 0));
            this.scheduleRemesh(chunk.getNeighbor(1, 0, 0));
            this.scheduleRemesh(chunk.getNeighbor(0, 0, 1));
            this.scheduleRemesh(chunk.getNeighbor(0, 1, 0));
            // Mark dirty and defer persistence to unload to avoid write stutter.
            chunk.isModified = true;
          }
        } else if (type === "distant-terrain-generated") {
          this.onDistantTerrainGenerated?.(
            data as DistantTerrainGeneratedMessage,
          );
        }

        // Mark worker idle and try to process pending tasks (prefer terrain tasks)
        this.idleWorkerIndices.push(i);
        this.processQueue();
      };

      const workerWrapper = new ChunkWorker(onMessage);
      this.workers.push(workerWrapper);
      this.idleWorkerIndices.push(i); // Initially all workers are idle.
    }

    this.processMeshQueueLoop();
  }

  private processMeshQueueLoop = () => {
    const start = performance.now();
    // Process meshes for up to 4ms per frame to prevent stutter
    while (this.meshResultQueue.length > 0 && performance.now() - start < 4) {
      const data = this.meshResultQueue.shift();
      if (data) {
        const { chunkId, opaque, water, glass } = data;
        const chunk = Chunk.chunkInstances.get(chunkId);
        if (chunk) {
          ChunkMesher.createMeshFromData(chunk, { opaque, water, glass });
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
      Chunk.onRequestRemesh = (chunk, priority) => {
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

    const existingPriority = this.pendingRemeshQueue.get(chunk) ?? false;
    this.pendingRemeshQueue.set(chunk, existingPriority || priority);
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

    for (const [chunk, priority] of pending) {
      if (!chunk.isLoaded) continue;
      const index = this.taskQueue.indexOf(chunk);
      if (priority) {
        if (index !== -1) {
          this.taskQueue.splice(index, 1);
        }
        this.taskQueue.unshift(chunk);
      } else if (index === -1) {
        this.taskQueue.push(chunk);
      }
    }

    this.processQueue();
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

  public scheduleDistantTerrain(
    centerChunkX: number,
    centerChunkZ: number,
    radius: number,
    renderDistance: number,
    gridStep: number,
    oldData?: {
      positions: Int16Array;
      colors: Uint8Array;
      normals: Int8Array;
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
    // Process tasks as long as there are idle workers and tasks in queues
    while (this.idleWorkerIndices.length > 0) {
      let taskChunk: Chunk | undefined;
      let distantTask: DistantTerrainTask | undefined;
      let taskType: "terrain" | "remesh" | "distantTerrain";

      // --- 1. Prioritize Terrain Generation ---
      if (this.terrainTaskQueue.size > 0) {
        taskChunk = this.terrainTaskQueue.values().next().value;
        this.terrainTaskQueue.delete(taskChunk!);
        taskType = "terrain";
      } else if (this.taskQueue.length > 0) {
        // --- 2. Process Remesh Tasks ---
        taskChunk = this.taskQueue.shift();
        taskType = "remesh";
      } else if (this.distantTerrainTaskQueue.length > 0) {
        distantTask = this.distantTerrainTaskQueue.shift();
        taskType = "distantTerrain";
      } else {
        break; // No more tasks to process
      }

      if (taskChunk || distantTask) {
        const workerIndex = this.idleWorkerIndices.shift()!;
        const worker = this.workers[workerIndex];
        if (taskType === "terrain") {
          worker.postTerrainGeneration(taskChunk!);
        } else if (taskType === "remesh") {
          worker.postFullRemesh(taskChunk!);
        } else if (taskType === "distantTerrain") {
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
