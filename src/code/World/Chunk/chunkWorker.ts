import { Chunk } from "./Chunk";

export class ChunkWorker {
  private worker: Worker;

  constructor(onMessage: (event: MessageEvent) => void) {
    this.worker = new Worker(new URL("./chunk.worker.ts", import.meta.url));
    this.worker.onmessage = onMessage;
  }

  public postMessage(chunk: Chunk): void {
    this.worker.postMessage({
      chunkId: chunk.id,
      block_array: chunk.block_array,
      CHUNK_SIZE: Chunk.SIZE,
    });
  }
}
