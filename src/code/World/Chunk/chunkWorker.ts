import { Chunk } from "./Chunk";

export class ChunkWorker {
  private worker: Worker;

  constructor(onMessage: (event: MessageEvent) => void) {
    this.worker = new Worker(new URL("./chunk.worker.ts", import.meta.url));
    this.worker.onmessage = onMessage;
  }

  public postMessage(chunk: Chunk, isRemesh = false): void {
    const neighbors = {
      px: chunk.getNeighbor(1, 0, 0)?.block_array,
      nx: chunk.getNeighbor(-1, 0, 0)?.block_array,
      py: chunk.getNeighbor(0, 1, 0)?.block_array,
      ny: chunk.getNeighbor(0, -1, 0)?.block_array,
      pz: chunk.getNeighbor(0, 0, 1)?.block_array,
      nz: chunk.getNeighbor(0, 0, -1)?.block_array,
    };

    this.worker.postMessage({
      type: "full-remesh",
      chunkId: chunk.id,
      block_array: chunk.block_array,
      CHUNK_SIZE: Chunk.SIZE,
      neighbors,
    });
  }
}
