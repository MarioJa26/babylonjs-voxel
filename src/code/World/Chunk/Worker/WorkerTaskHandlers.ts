import { WorldGenerator } from "@/code/Generation/WorldGenerator";
import { WorkerInternalMeshData } from "../DataStructures/WorkerInternalMeshData";
import {
  GenerateDistantTerrainRequest,
  GenerateTerrainRequest,
} from "../DataStructures/WorkerMessageType";
import { DistantTerrainGenerator } from "@/code/Generation/DistanTerrain/DistantTerrainGenerator";

export type MeshBuilderLike = {
  generateMesh(data: {
    block_array: Uint8Array | Uint16Array;
    chunk_size: number;
    light_array?: Uint8Array;
    neighbors: (Uint8Array | Uint16Array | undefined)[];
    neighborLights?: (Uint8Array | undefined)[];
    lod?: number;
  }): {
    opaque: WorkerInternalMeshData;
    transparent: WorkerInternalMeshData;
  };
  addQuad: (
    x: number,
    y: number,
    z: number,
    axis: number,
    width: number,
    height: number,
    blockId: number,
    isBackFace: boolean,
    faceName: string,
    lightLevel: number,
    packedAO: number,
    meshData: WorkerInternalMeshData,
  ) => void;
};

export type CompressBlocksFn = (blocks: Uint8Array) => {
  isUniform: boolean;
  uniformBlockId: number;
  palette: Uint16Array | null;
  packedBlocks: Uint8Array | Uint16Array | null;
};

export class WorkerTaskHandlers {
  public static handleGenerateTerrain(
    request: GenerateTerrainRequest,
    deps: {
      generator: WorldGenerator;
      compressBlocks: CompressBlocksFn;
    },
  ): {
    payload: {
      chunkId: bigint;
      type: number;
      block_array: Uint8Array | Uint16Array | null;
      light_array: Uint8Array;
      isUniform: boolean;
      uniformBlockId: number;
      palette: Uint16Array | null;
    };
    transferables: Transferable[];
  } {
    const { generator, compressBlocks } = deps;
    const { chunkId, chunkX, chunkY, chunkZ } = request;

    const { blocks, light } = generator.generateChunkData(
      chunkX,
      chunkY,
      chunkZ,
    );

    const { isUniform, uniformBlockId, palette, packedBlocks } =
      compressBlocks(blocks);

    const transferables: Transferable[] = [];

    if (
      packedBlocks &&
      !(
        packedBlocks.buffer instanceof
        (typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : Object)
      )
    ) {
      transferables.push(packedBlocks.buffer);
    }

    if (
      !(
        light.buffer instanceof
        (typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : Object)
      )
    ) {
      transferables.push(light.buffer);
    }

    return {
      payload: {
        chunkId,
        type: 0, // caller should overwrite with WorkerTaskType.GenerateTerrain if desired
        block_array: packedBlocks,
        light_array: light,
        isUniform,
        uniformBlockId,
        palette,
      },
      transferables,
    };
  }

  public static handleGenerateDistantTerrain(
    request: GenerateDistantTerrainRequest,
  ): {
    payload: {
      type: number;
      centerChunkX: number;
      centerChunkZ: number;
      positions: Int16Array;
      normals: Int8Array;
      surfaceTiles: Uint8Array;
    };
    transferables: Transferable[];
  } {
    const {
      centerChunkX,
      centerChunkZ,
      radius,
      renderDistance,
      gridStep,
      oldData,
      oldCenterChunkX,
      oldCenterChunkZ,
    } = request;

    const data = DistantTerrainGenerator.generate(
      centerChunkX,
      centerChunkZ,
      radius,
      renderDistance,
      gridStep,
      oldData,
      oldCenterChunkX,
      oldCenterChunkZ,
    );

    return {
      payload: {
        type: 0, // caller should overwrite with WorkerTaskType.GenerateDistantTerrain_Generated if desired
        centerChunkX,
        centerChunkZ,
        positions: data.positions,
        normals: data.normals,
        surfaceTiles: data.surfaceTiles,
      },
      transferables: [
        data.positions.buffer,
        data.normals.buffer,
        data.surfaceTiles.buffer,
      ],
    };
  }
}
