import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";
import { Chunk } from "./Chunk";

export class ChunkWorker {
  private worker: Worker;

  constructor(onMessage: (event: MessageEvent) => void) {
    this.worker = new Worker(new URL("./chunk.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = onMessage;
  }

  public postFullRemesh(chunk: Chunk): void {
    const neighbors: (Uint8Array | undefined)[] = [];
    const neighborLights: (Uint8Array | undefined)[] = [];

    for (let z = -1; z <= 1; z++) {
      for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
          // We include the center chunk (0,0,0) in the array to keep indexing simple,
          // even though we send the center block_array separately.
          const neighbor = chunk.getNeighbor(x, y, z);
          if (neighbor && neighbor.isLoaded) {
            neighbors.push(neighbor.block_array);
            neighborLights.push(neighbor.light_array);
          } else {
            neighbors.push(undefined);
            neighborLights.push(undefined);
          }
        }
      }
    }

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
      normals: Int8Array;
    },
    oldCenterChunkX?: number,
    oldCenterChunkZ?: number,
  ): void {
    const transferables: Transferable[] = [];
    if (oldData) {
      transferables.push(oldData.positions.buffer);
      transferables.push(oldData.colors.buffer);
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
      transferables,
    );
  }
}
