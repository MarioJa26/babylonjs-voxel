import { MeshData } from "./MeshData";

export enum WorkerTaskType {
  GenerateTerrain,
  GenerateFullMesh,
  GenerateDistantTerrain_Generated,
  GenerateDistantTerrain,
}

export type FullMeshMessage = {
  type: WorkerTaskType.GenerateFullMesh;
  chunkId: bigint;
  opaque: MeshData;
  transparent: MeshData;
};

export type TerrainGeneratedMessage = {
  type: WorkerTaskType.GenerateTerrain;
  chunkId: bigint;
  block_array: Uint8Array;
  light_array: Uint8Array;
};

export type DistantTerrainGeneratedMessage = {
  type: WorkerTaskType.GenerateDistantTerrain_Generated;
  centerChunkX: number;
  centerChunkZ: number;
  positions: Int16Array;
  normals: Int8Array;
  surfaceTiles: Uint8Array;
};

export interface DistantTerrainTask {
  centerChunkX: number;
  centerChunkZ: number;
  radius: number;
  renderDistance: number;
  gridStep: number;
  oldData?: {
    positions: Int16Array;
    normals: Int8Array;
    surfaceTiles: Uint8Array;
  };
  oldCenterChunkX?: number;
  oldCenterChunkZ?: number;
}
