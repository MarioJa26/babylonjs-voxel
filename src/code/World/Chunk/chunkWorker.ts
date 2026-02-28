import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";
import { Chunk } from "./Chunk";

export class ChunkWorker {
  private worker: Worker;
  private warnedNonSharedRemeshPayload = false;

  constructor(onMessage: (event: MessageEvent) => void) {
    this.worker = new Worker(new URL("./chunk.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = onMessage;
  }

  public setOnError(handler: (ev: ErrorEvent | Event) => void): void {
    this.worker.onerror = handler;
  }

  public postFullRemesh(chunk: Chunk): void {
    const neighbors: (Uint8Array | Uint16Array | null | undefined)[] = [];
    const neighborLights: (Uint8Array | undefined)[] = [];
    const neighborUniformIds: (number | undefined)[] = [];
    const neighborPalettes: (Uint16Array | null | undefined)[] = [];

    const paletteToTyped = (
      palette: Uint16Array | null | undefined,
    ): Uint16Array | null | undefined => {
      if (!palette || palette.length === 0) return palette;
      return palette;
    };

    for (let z = -1; z <= 1; z++) {
      for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
          // Center is sent separately as block_array/light_array.
          if (x === 0 && y === 0 && z === 0) continue;
          const neighbor = chunk.getNeighbor(x, y, z);
          if (neighbor && neighbor.isLoaded) {
            neighbors.push(neighbor.block_array);
            neighborLights.push(neighbor.light_array);
            neighborUniformIds.push(
              neighbor.isUniform ? neighbor.uniformBlockId : undefined,
            );
            neighborPalettes.push(paletteToTyped(neighbor.palette));
          } else {
            neighbors.push(undefined);
            neighborLights.push(undefined);
            neighborUniformIds.push(undefined);
            neighborPalettes.push(undefined);
          }
        }
      }
    }

    if (!this.warnedNonSharedRemeshPayload) {
      const centerBlocks = chunk.block_array;
      const centerLight = chunk.light_array;
      const hasNonSharedCenterBlocks =
        !!centerBlocks && !(centerBlocks.buffer instanceof SharedArrayBuffer);
      const hasNonSharedCenterLight =
        !!centerLight && !(centerLight.buffer instanceof SharedArrayBuffer);
      const hasNonSharedNeighborBlocks = neighbors.some(
        (n) => !!n && !(n.buffer instanceof SharedArrayBuffer),
      );
      const hasNonSharedNeighborLights = neighborLights.some(
        (n) => !!n && !(n.buffer instanceof SharedArrayBuffer),
      );
      if (
        hasNonSharedCenterBlocks ||
        hasNonSharedCenterLight ||
        hasNonSharedNeighborBlocks ||
        hasNonSharedNeighborLights
      ) {
        this.warnedNonSharedRemeshPayload = true;
        console.warn(
          "ChunkWorker remesh payload includes non-shared buffers; structured clone copy may occur.",
        );
      }
    }

    this.worker.postMessage({
      type: "full-remesh",
      chunkId: chunk.id,
      block_array: chunk.block_array,
      uniformBlockId: chunk.isUniform ? chunk.uniformBlockId : undefined,
      palette: paletteToTyped(chunk.palette),
      light_array: chunk.light_array,
      chunk_size: Chunk.SIZE,
      neighbors,
      neighborLights,
      neighborUniformIds,
      neighborPalettes,
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
      normals: Int8Array;
      surfaceTiles: Uint8Array;
    },
    oldCenterChunkX?: number,
    oldCenterChunkZ?: number,
  ): void {
    const transferables: Transferable[] = [];
    if (oldData) {
      transferables.push(oldData.positions.buffer);
      transferables.push(oldData.normals.buffer);
      transferables.push(oldData.surfaceTiles.buffer);
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
