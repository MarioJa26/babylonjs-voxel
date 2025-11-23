import { Chunk } from "./Chunk";
import { ChunkMesher } from "./ChunckMesher";
import { ChunkWorker } from "./chunkWorker";

export class ChunkWorkerPool {
  private static instance: ChunkWorkerPool;
  private workers: Worker[] = [];
  private taskQueue: Chunk[] = [];
  private terrainTaskQueue: Chunk[] = [];
  private workerStatus: boolean[] = [];

  private constructor(poolSize: number) {
    for (let i = 0; i < poolSize; i++) {
      const onMessage = (event: MessageEvent<any>) => {
        const data = event.data;
        const { type, chunkId } = data;

        if (type === "full-mesh") {
          const { opaque, transparent } = data;
          const chunk = Chunk.chunkInstances.get(chunkId as string);
          if (chunk) {
            ChunkMesher.createMeshFromData(chunk, { opaque, transparent });
          }
        } else if (type === "terrain-generated") {
          // Apply generated block array to the chunk and schedule remesh
          const chunk = Chunk.chunkInstances.get(chunkId as string);
          if (chunk) {
            chunk.block_array = data.block_array as Uint8Array;
            this.scheduleRemesh(chunk);
          }
        }

        // Mark worker idle and try to process pending tasks (prefer terrain tasks)
        this.workerStatus[i] = false;
        this.processQueue();
      };

      const workerWrapper = new ChunkWorker(onMessage);
      this.workers.push(workerWrapper as unknown as Worker);
      this.workerStatus.push(false); // Initially all workers are idle.
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
    if (!this.taskQueue.includes(chunk)) {
      this.taskQueue.push(chunk);
    }
    this.processQueue();
  }

  // New: schedule terrain generation via the pool
  public scheduleTerrainGeneration(chunk: Chunk) {
    // try direct dispatch to idle worker
    const idleWorkerIndex = this.workerStatus.findIndex((s) => !s);
    if (idleWorkerIndex !== -1) {
      this.workerStatus[idleWorkerIndex] = true;
      const worker = this.workers[idleWorkerIndex] as unknown as ChunkWorker;
      worker.postTerrainGeneration(chunk);
      return;
    }
    // otherwise queue
    if (!this.terrainTaskQueue.includes(chunk)) {
      this.terrainTaskQueue.push(chunk);
    }
  }

  private processQueue() {
    // prefer terrain tasks
    const idleWorkerIndex = this.workerStatus.findIndex((status) => !status);
    if (idleWorkerIndex === -1) return;

    // terrain tasks first
    const terrainChunk = this.terrainTaskQueue.shift();
    if (terrainChunk) {
      this.workerStatus[idleWorkerIndex] = true;
      const worker = this.workers[idleWorkerIndex] as unknown as ChunkWorker;
      worker.postTerrainGeneration(terrainChunk);
      return;
    }

    // then remesh tasks
    const chunk = this.taskQueue.shift();
    if (!chunk) return;
    this.workerStatus[idleWorkerIndex] = true;
    const worker = this.workers[idleWorkerIndex] as unknown as ChunkWorker;
    (worker as unknown as ChunkWorker).postMessage(chunk, true);
  }
}
