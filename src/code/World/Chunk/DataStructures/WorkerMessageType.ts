import { MeshData } from "./MeshData";

export enum WorkerTaskType {
  GenerateTerrain,
  GenerateFullMesh,
  GenerateDistantTerrain_Generated,
  GenerateDistantTerrain,
}

/* =========================================================
 * Shared helper types
 * ========================================================= */

export type PackedBlockArray = Uint8Array | Uint16Array | null | undefined;
export type PackedPalette = Uint8Array | Uint16Array | null | undefined;
export type NeighborBlockArray = Uint8Array | Uint16Array | undefined;
export type NeighborLightArray = Uint8Array | undefined;

/* =========================================================
 * Requests sent TO the worker
 * ========================================================= */

export type GenerateTerrainRequest = {
  type: WorkerTaskType.GenerateTerrain;
  chunkId: bigint;
  chunkX: number;
  chunkY: number;
  chunkZ: number;
};

export type GenerateFullMeshRequest = {
  type: WorkerTaskType.GenerateFullMesh;
  chunkId: bigint;

  // NEW: LOD level sent from ChunkWorker -> worker
  lod?: number;

  // Center chunk payload
  block_array: PackedBlockArray;
  uniformBlockId?: number;
  palette?: PackedPalette;
  light_array?: Uint8Array;

  chunk_size: number;

  // Neighbor payloads (26 neighbors, center omitted)
  neighbors: (NeighborBlockArray | null | undefined)[];
  neighborLights?: NeighborLightArray[];
  neighborUniformIds?: (number | undefined)[];
  neighborPalettes?: (PackedPalette | undefined)[];
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

export type GenerateDistantTerrainRequest = {
  type: WorkerTaskType.GenerateDistantTerrain;
} & DistantTerrainTask;

export type WorkerRequestData =
  | GenerateTerrainRequest
  | GenerateFullMeshRequest
  | GenerateDistantTerrainRequest;

/* =========================================================
 * Responses sent FROM the worker
 * ========================================================= */

export type FullMeshMessage = {
  type: WorkerTaskType.GenerateFullMesh;
  chunkId: bigint;
  opaque: MeshData;
  transparent: MeshData;
};

export type TerrainGeneratedMessage = {
  type: WorkerTaskType.GenerateTerrain;
  chunkId: bigint;
  block_array: Uint8Array | Uint16Array | null;
  light_array: Uint8Array;
  isUniform: boolean;
  uniformBlockId: number;
  palette?: Uint8Array | Uint16Array | null;
};

export type DistantTerrainGeneratedMessage = {
  type: WorkerTaskType.GenerateDistantTerrain_Generated;
  centerChunkX: number;
  centerChunkZ: number;
  positions: Int16Array;
  normals: Int8Array;
  surfaceTiles: Uint8Array;
};

export type WorkerResponseData =
  | FullMeshMessage
  | TerrainGeneratedMessage
  | DistantTerrainGeneratedMessage;
