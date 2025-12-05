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
};
