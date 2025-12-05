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

export type StructuresGeneratedMessage = {
  type: "structures-generated";
  chunkId: bigint;
  block_array: Uint8Array;
};

export type FloraGeneratedMessage = {
  type: "flora-generated";
  chunkId: bigint;
  block_array: Uint8Array;
};

export type WorkerMessageData =
  | FullMeshMessage
  | TerrainGeneratedMessage
  | StructuresGeneratedMessage
  | FloraGeneratedMessage;
