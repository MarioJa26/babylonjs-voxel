import { MeshData } from "./MeshData";

export type FullMeshMessage = {
  type: "full-mesh";
  chunkId: bigint;
  opaque: MeshData;
  transparent: MeshData;
};

export type TerrainGeneratedMessage = {
  type: "terrain-generated";
  chunkId: bigint;
  block_array: Uint8Array;
  light_array: Uint8Array;
};

export type DistantTerrainGeneratedMessage = {
  type: "distant-terrain-generated";
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
