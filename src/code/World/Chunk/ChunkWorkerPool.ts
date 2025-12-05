import { Chunk } from "./Chunk";
import { ChunkMesher } from "./ChunckMesher";
import { ChunkWorker } from "./chunkWorker";
import { WorkerMessageData } from "./WorkerMessageType";

export class ChunkWorkerPool {
  private static instance: ChunkWorkerPool;
  private workers: Worker[] = [];
  // Generation pipeline queues
  private terrainTaskQueue: Set<Chunk> = new Set();
  private structureTaskQueue: Set<Chunk> = new Set();
  private floraTaskQueue: Set<Chunk> = new Set();
  // Remesh queue
  private remeshTaskQueue: Set<Chunk> = new Set();
  private idleWorkerIndices: number[] = [];

  private constructor(poolSize: number) {
    for (let i = 0; i < poolSize; i++) {
      const onMessage = (event: MessageEvent<WorkerMessageData>) => {
        const data = event.data;
        const { type, chunkId } = data;

        if (type === "full-mesh") {
          const { opaque, transparent } = data;
          const chunk = Chunk.chunkInstances.get(chunkId);
          if (chunk) {
            ChunkMesher.createMeshFromData(chunk, { opaque, transparent });
          }
        } else if (type === "terrain-generated") {
          const chunk = Chunk.chunkInstances.get(chunkId);
          if (chunk) {
            chunk.populate("terrain-generated", data.block_array as Uint8Array);
          }
        } else if (type === "structures-generated") {
          const chunk = Chunk.chunkInstances.get(chunkId);
          if (chunk) {
            chunk.populate(
              "structures-generated",
              data.block_array as Uint8Array
            );
          }
        } else if (type === "flora-generated") {
          const chunk = Chunk.chunkInstances.get(chunkId);
          if (chunk) {
            chunk.populate("flora-generated", data.block_array as Uint8Array);
          }
        }

        // Mark worker idle and try to process pending tasks (prefer terrain tasks)
        this.idleWorkerIndices.push(i);
        this.processQueue();
      };

      const workerWrapper = new ChunkWorker(onMessage);
      this.workers.push(workerWrapper as unknown as Worker);
      this.idleWorkerIndices.push(i); // Initially all workers are idle.
    }
  }

  public static getInstance(
    poolSize = navigator.hardwareConcurrency || 4
  ): ChunkWorkerPool {
    if (!ChunkWorkerPool.instance) {
      ChunkWorkerPool.instance = new ChunkWorkerPool(poolSize);
    }
    return ChunkWorkerPool.instance;
  }

  // existing remesh scheduling
  public scheduleRemesh(chunk: Chunk) {
    this.remeshTaskQueue.add(chunk);
    this.processQueue();
  }

  // --- Generation Pipeline Scheduling ---
  public scheduleTerrainGeneration(chunk: Chunk) {
    this.terrainTaskQueue.add(chunk);
    this.processQueue();
  }

  public scheduleStructureGeneration(chunk: Chunk) {
    this.structureTaskQueue.add(chunk);
    this.processQueue();
  }

  public scheduleFloraGeneration(chunk: Chunk) {
    this.floraTaskQueue.add(chunk);
    this.processQueue();
  }

  private processQueue() {
    // Process tasks as long as there are idle workers and tasks in queues
    while (this.idleWorkerIndices.length > 0) {
      let taskChunk: Chunk | undefined;
      let taskType: "terrain" | "structures" | "flora" | "remesh";

      // --- Prioritize tasks in pipeline order ---
      if (this.terrainTaskQueue.size > 0) {
        taskChunk = this.terrainTaskQueue.values().next().value;
        this.terrainTaskQueue.delete(taskChunk!);
        taskType = "terrain";
      } else if (this.structureTaskQueue.size > 0) {
        taskChunk = this.structureTaskQueue.values().next().value;
        this.structureTaskQueue.delete(taskChunk!);
        taskType = "structures";
      } else if (this.floraTaskQueue.size > 0) {
        taskChunk = this.floraTaskQueue.values().next().value;
        this.floraTaskQueue.delete(taskChunk!);
        taskType = "flora";
      } else if (this.remeshTaskQueue.size > 0) {
        taskChunk = this.remeshTaskQueue.values().next().value;
        this.remeshTaskQueue.delete(taskChunk!);
        taskType = "remesh";
      } else {
        break; // No more tasks to process
      }

      if (taskChunk) {
        const workerIndex = this.idleWorkerIndices.shift()!;
        const worker = this.workers[workerIndex] as unknown as ChunkWorker;

        if (taskType === "terrain") worker.postTerrainGeneration(taskChunk);
        else if (taskType === "structures")
          worker.postStructureGeneration(taskChunk);
        else if (taskType === "flora") worker.postFloraGeneration(taskChunk);
        else if (taskType === "remesh") worker.postMessage(taskChunk);
      }
    }
  }
}
