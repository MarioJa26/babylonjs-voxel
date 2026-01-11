import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";
import { Chunk } from "./Chunk";

export class ChunkWorker {
  private worker: Worker;

  constructor(onMessage: (event: MessageEvent) => void) {
    this.worker = new Worker(new URL("./chunk.worker.ts", import.meta.url));
    this.worker.onmessage = onMessage;
  }

  public postMessage(chunk: Chunk): void {
    const neighbors = {
      px: chunk.getNeighbor(1, 0, 0)?.block_array,
      nx: chunk.getNeighbor(-1, 0, 0)?.block_array,
      py: chunk.getNeighbor(0, 1, 0)?.block_array,
      ny: chunk.getNeighbor(0, -1, 0)?.block_array,
      pz: chunk.getNeighbor(0, 0, 1)?.block_array,
      nz: chunk.getNeighbor(0, 0, -1)?.block_array,
    };

    const neighborLights = {
      px: chunk.getNeighbor(1, 0, 0)?.light_array,
      nx: chunk.getNeighbor(-1, 0, 0)?.light_array,
      py: chunk.getNeighbor(0, 1, 0)?.light_array,
      ny: chunk.getNeighbor(0, -1, 0)?.light_array,
      pz: chunk.getNeighbor(0, 0, 1)?.light_array,
      nz: chunk.getNeighbor(0, 0, -1)?.light_array,
    };

    this.worker.postMessage({
      type: "full-remesh",
      chunkId: chunk.id,
      block_array: chunk.block_array,
      light_array: chunk.light_array,
      chunk_size: Chunk.SIZE,
      neighbors,
      neighborLights,
    });
  }

  public postTerrainGeneration(chunk: Chunk): void {
    this.worker.postMessage({
      type: "generate-terrain",
      chunkId: chunk.id,
      chunkX: chunk.chunkX,
      chunkY: chunk.chunkY,
      chunkZ: chunk.chunkZ,
      ...GenerationParams,
    });
  }

  public postGenerateDistantTerrain(
    centerChunkX: number,
    centerChunkZ: number,
    radius: number,
    renderDistance: number,
    gridStep: number,
    oldData?: {
      positions: Int16Array;
      colors: Uint8Array;
      normals: Uint8Array;
    },
    oldCenterChunkX?: number,
    oldCenterChunkZ?: number
  ): void {
    const transferables: Transferable[] = [];
    if (oldData) {
      transferables.push(oldData.positions.buffer);
      transferables.push(oldData.colors.buffer);
      transferables.push(oldData.normals.buffer);
    }

    this.worker.postMessage(
      {
        type: "generate-distant-terrain",
        centerChunkX,
        centerChunkZ,
        radius,
        renderDistance,
        gridStep,
        oldData,
        oldCenterChunkX,
        oldCenterChunkZ,
      },
      transferables
    );
  }
}
