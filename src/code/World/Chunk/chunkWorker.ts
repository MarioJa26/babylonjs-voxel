import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";
import { Chunk } from "./Chunk";
import {
  GenerateDistantTerrainRequest,
  GenerateFullMeshRequest,
  GenerateTerrainRequest,
  WorkerResponseData,
  WorkerTaskType,
} from "./DataStructures/WorkerMessageType";

export class ChunkWorker {
  private worker: Worker;
  private warnedNonSharedRemeshPayload = false;

  constructor(onMessage: (event: MessageEvent<WorkerResponseData>) => void) {
    this.worker = new Worker(new URL("./chunk.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = onMessage;
  }

  public setOnError(handler: (ev: ErrorEvent | Event) => void): void {
    this.worker.onerror = handler;
  }

  public terminate(): void {
    this.worker.terminate();
  }
  private readonly paletteToTyped = (
    palette: Uint8Array | Uint16Array | null | undefined,
  ): Uint8Array | Uint16Array | null | undefined => {
    if (!palette || palette.length === 0) return palette;
    return palette;
  };
  public postFullRemesh(chunk: Chunk, forcedLod?: number): void {
    const neighbors: (Uint8Array | Uint16Array | null | undefined)[] = [];
    const neighborLights: (Uint8Array | undefined)[] = [];
    const neighborUniformIds: (number | undefined)[] = [];
    const neighborPalettes: (Uint8Array | Uint16Array | null | undefined)[] =
      [];

    for (let z = -1; z <= 1; z++) {
      for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
          if (x === 0 && y === 0 && z === 0) continue;

          const neighbor = chunk.getNeighbor(x, y, z);
          if (neighbor && neighbor.isLoaded) {
            neighbors.push(neighbor.block_array);
            neighborLights.push(neighbor.light_array);
            neighborUniformIds.push(
              neighbor.isUniform ? neighbor.uniformBlockId : undefined,
            );
            neighborPalettes.push(this.paletteToTyped(neighbor.palette));
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

    const message: GenerateFullMeshRequest = {
      type: WorkerTaskType.GenerateFullMesh,
      chunkId: chunk.id,
      lod: forcedLod ?? ((chunk as any).lodLevel ?? 0),
      block_array: chunk.block_array,
      uniformBlockId: chunk.isUniform ? chunk.uniformBlockId : undefined,
      palette: this.paletteToTyped(chunk.palette),
      light_array: chunk.light_array,
      chunk_size: Chunk.SIZE,
      neighbors,
      neighborLights,
      neighborUniformIds,
      neighborPalettes,
    };

    this.worker.postMessage(message);
  }

  public postTerrainGeneration(chunk: Chunk): void {
    const message: GenerateTerrainRequest = {
      type: WorkerTaskType.GenerateTerrain,
      chunkId: chunk.id,
      chunkX: chunk.chunkX,
      chunkY: chunk.chunkY,
      chunkZ: chunk.chunkZ,
    };

    this.worker.postMessage({
      ...message,
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

    const message: GenerateDistantTerrainRequest = {
      type: WorkerTaskType.GenerateDistantTerrain,
      centerChunkX,
      centerChunkZ,
      radius,
      renderDistance,
      gridStep,
      oldData,
      oldCenterChunkX,
      oldCenterChunkZ,
    };

    this.worker.postMessage(message, transferables);
  }
}
