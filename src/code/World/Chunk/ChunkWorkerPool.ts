import { Chunk } from "./Chunk";
import { ChunkMesher } from "./ChunckMesher";
import { ChunkWorker } from "./chunkWorker";
import {
  DistantTerrainTask,
  FullMeshMessage,
  TerrainGeneratedMessage,
  DistantTerrainGeneratedMessage,
} from "./DataStructures/WorkerMessageType";
import { WorldStorage } from "../WorldStorage";

export type WorkerMessageData =
  | FullMeshMessage
  | TerrainGeneratedMessage
  | DistantTerrainGeneratedMessage;

export class ChunkWorkerPool {
  private static instance: ChunkWorkerPool;
  private workers: Worker[] = [];
  private taskQueue: Chunk[] = [];
  private terrainTaskQueue: Set<Chunk> = new Set();
  private distantTerrainTaskQueue: DistantTerrainTask[] = [];
  private idleWorkerIndices: number[] = [];

  public onDistantTerrainGenerated:
    | ((data: DistantTerrainGeneratedMessage) => void)
    | null = null;

  private constructor(poolSize: number) {
    for (let i = 0; i < poolSize; i++) {
      const onMessage = (event: MessageEvent<WorkerMessageData>) => {
        const data = event.data;
        const { type } = data;

        if (type === "full-mesh") {
          const { chunkId } = data;
          const { opaque, water, glass } = data;
          const chunk = Chunk.chunkInstances.get(chunkId);
          if (chunk) {
            ChunkMesher.createMeshFromData(chunk, { opaque, water, glass });
          }
        } else if (type === "terrain-generated") {
          const { chunkId } = data;
          // Apply generated block array to the chunk and schedule remesh
          const chunk = Chunk.chunkInstances.get(chunkId);
          if (chunk) {
            chunk.populate(
              data.block_array as Uint8Array,
              data.light_array as Uint8Array,
            );
            // Save the newly generated chunk to the database
            WorldStorage.saveChunk(chunk);
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
      this.workers.push(workerWrapper as unknown as Worker);
      // Add this to see why they are "busy" (crashed)
      (workerWrapper as any).worker.onerror = (err: any) => {
        console.error("🔥 Worker Pipeline Crash:", err);
      };
      this.idleWorkerIndices.push(i); // Initially all workers are idle.
    }
  }

  public static getInstance(
    poolSize = navigator.hardwareConcurrency || 4,
  ): ChunkWorkerPool {
    if (!ChunkWorkerPool.instance) {
      ChunkWorkerPool.instance = new ChunkWorkerPool(poolSize);
    }
    return ChunkWorkerPool.instance;
  }

  // existing remesh scheduling
  public scheduleRemesh(chunk: Chunk, priority = false) {
    const index = this.taskQueue.indexOf(chunk);
    if (priority) {
      if (index !== -1) {
        this.taskQueue.splice(index, 1);
      }
      this.taskQueue.unshift(chunk);
    } else {
      if (index === -1) {
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
        const worker = this.workers[workerIndex] as unknown as ChunkWorker;
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
