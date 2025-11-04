import { Chunk } from "./Chunk";
import { ChunkMesher } from "./ChunckMesher";
import { MeshData } from "./MeshData";
import { ChunkWorker } from "./chunkWorker";

export class ChunkWorkerPool {
  private static instance: ChunkWorkerPool;
  private workers: Worker[] = [];
  private taskQueue: Chunk[] = [];
  private workerStatus: boolean[] = [];

  private constructor(poolSize: number) {
    for (let i = 0; i < poolSize; i++) {
      const onMessage = (event: MessageEvent<MeshData>) => {
        // The worker has finished, apply the mesh data.
        const { chunkId, ...meshData } = event.data;
        const chunk = Chunk.chunkInstances.get(chunkId as string);
        if (chunk) {
          ChunkMesher.createMeshFromData(chunk, meshData);
        }

        // Mark this worker as idle and process the next task in the queue.
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

  public scheduleRemesh(chunk: Chunk) {
    // Add the chunk to the queue and try to process it.
    if (!this.taskQueue.includes(chunk)) {
      this.taskQueue.push(chunk);
    }
    this.processQueue();
  }

  private processQueue() {
    if (this.taskQueue.length === 0) return;

    const idleWorkerIndex = this.workerStatus.findIndex((status) => !status);
    if (idleWorkerIndex !== -1) {
      const chunk = this.taskQueue.shift();
      if (!chunk) return;
      this.workerStatus[idleWorkerIndex] = true; // Mark worker as busy
      const worker = this.workers[idleWorkerIndex];
      (worker as unknown as ChunkWorker).postMessage(chunk);
    }
  }
}
