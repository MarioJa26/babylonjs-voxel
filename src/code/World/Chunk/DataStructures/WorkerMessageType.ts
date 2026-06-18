import type { MeshData } from "./MeshData";

export enum WorkerTaskType {
	GenerateTerrain,
	GenerateFullMesh,
	GenerateDistantTerrain_Generated,
	GenerateDistantTerrain,
	InitDistantTerrainShared,
	WorkerReady,
	// --- Light worker tasks ---
	InitLightShared,
	LightRegisterChunk,
	LightUnregisterChunk,
	LightUpdateChunkBuffers,
	LightMutate,
	LightAddEmission,
	LightSkyReconcile,
	LightPropagateDeferred,
	LightDirty,
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

export interface SerializedLightSeedState {
	queue: Uint16Array;
	length: number;
}

export type GenerateTerrainRequest = {
	type: WorkerTaskType.GenerateTerrain;
	chunkId: bigint;
	chunkX: number;
	chunkY: number;
	chunkZ: number;

	/**
	 * If true, terrain generation should only seed initial light and return
	 * the queue snapshot for later propagation.
	 *
	 * If false/omitted, worker returns fully lit chunk data.
	 */
	deferLighting?: boolean;

	/**
	 * If true, skip underground biome decoration and aquifer flooding.
	 * Used alongside deferLighting to defer non-critical work.
	 * Caller must call refineBlocks on the returned blocks to complete decoration.
	 */
	skipDecorations?: boolean;
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

export type DistantTerrainTask = {
	requestId: number;
	centerChunkX: number;
	centerChunkZ: number;
	radius: number;
	renderDistance: number;
	gridStep: number;
};

export type InitDistantTerrainSharedRequest = {
	type: WorkerTaskType.InitDistantTerrainShared;
	positionsBuffer: SharedArrayBuffer;
	normalsBuffer: SharedArrayBuffer;
	surfaceTilesBuffer: SharedArrayBuffer;
	radius: number;
	gridStep: number;
};

export type GenerateDistantTerrainRequest = {
	type: WorkerTaskType.GenerateDistantTerrain;
	requestId: number;
	centerChunkX: number;
	centerChunkZ: number;
	radius: number;
	renderDistance: number;
	gridStep: number;
};

export type WorkerRequestData =
	| GenerateTerrainRequest
	| GenerateFullMeshRequest
	| GenerateDistantTerrainRequest
	| InitDistantTerrainSharedRequest
	| InitLightSharedRequest
	| LightRegisterChunkRequest
	| LightUnregisterChunkRequest
	| LightUpdateChunkBuffersRequest
	| LightMutateRequest
	| LightAddEmissionRequest
	| LightSkyReconcileRequest
	| LightPropagateDeferredRequest;

/* =========================================================
 * Light-task messages
 * ========================================================= */

export type InitLightSharedRequest = {
	type: WorkerTaskType.InitLightShared;
	headerBuffer: SharedArrayBuffer;
};

export type LightRegisterChunkRequest = {
	type: WorkerTaskType.LightRegisterChunk;
	seq: number;
	chunkId: bigint;
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	headerSlot: number;
	blockSAB: SharedArrayBuffer | null;
	lightSAB: SharedArrayBuffer;
	paletteSAB: SharedArrayBuffer | null;
	blockStorageBytesPerElement: 1 | 2;
};

export type LightUnregisterChunkRequest = {
	type: WorkerTaskType.LightUnregisterChunk;
	chunkId: bigint;
};

export type LightUpdateChunkBuffersRequest = {
	type: WorkerTaskType.LightUpdateChunkBuffers;
	chunkId: bigint;
	headerSlot: number;
	blockSAB: SharedArrayBuffer | null;
	paletteSAB: SharedArrayBuffer | null;
	lightSAB: SharedArrayBuffer;
	blockStorageBytesPerElement: 1 | 2;
};

export type LightMutateRequest = {
	type: WorkerTaskType.LightMutate;
	chunkId: bigint;
	headerSlot: number;
	x: number;
	y: number;
	z: number;
	oldPacked: number;
	newPacked: number;
	seq: number;
};

export type LightAddEmissionRequest = {
	type: WorkerTaskType.LightAddEmission;
	chunkId: bigint;
	headerSlot: number;
	x: number;
	y: number;
	z: number;
	level: number;
	seq: number;
};

export type LightSkyReconcileRequest = {
	type: WorkerTaskType.LightSkyReconcile;
	chunkId: bigint;
	headerSlot: number;
	seq: number;
};

export type LightPropagateDeferredRequest = {
	type: WorkerTaskType.LightPropagateDeferred;
	chunkId: bigint;
	headerSlot: number;
	seedQueue: Uint16Array;
	seedLength: number;
	seq: number;
};

export type LightDirtyMessage = {
	type: WorkerTaskType.LightDirty;
	seq: number;
	dirtySlots: Uint32Array;
};

/* =========================================================
 * Responses sent FROM the worker
 * ========================================================= */
export type FullMeshMessage = {
	type: WorkerTaskType.GenerateFullMesh;
	chunkId: bigint;
	lod: number;
	opaque: MeshData | null;
	transparent: MeshData | null;
};

export type TerrainGeneratedMessage = {
	type: WorkerTaskType.GenerateTerrain;
	chunkId: bigint;
	block_array: Uint8Array | Uint16Array | null;
	light_array: Uint8Array;
	isUniform: boolean;
	uniformBlockId: number;
	palette?: Uint8Array | Uint16Array | null;
	/**
	 * Optional seeded-light queue snapshot used for deferred BFS propagation.
	 * Present only when request.deferLighting === true.
	 */
	lightSeedQueue?: Uint16Array;
	lightSeedLength?: number;
};

export type DistantTerrainGeneratedMessage = {
	type: WorkerTaskType.GenerateDistantTerrain_Generated;
	requestId: number;
	centerChunkX: number;
	centerChunkZ: number;
};

export type WorkerResponseData =
	| FullMeshMessage
	| TerrainGeneratedMessage
	| DistantTerrainGeneratedMessage
	| { type: WorkerTaskType.InitDistantTerrainShared } // ← ack only, no payload
	| { type: WorkerTaskType.InitLightShared } // ← ack only
	| { type: WorkerTaskType.WorkerReady }
	| LightDirtyMessage;

export type MeshWorkerResponse = {
	chunkId: bigint;
	lod: number;
	opaque: MeshData | null;
	transparent: MeshData | null;
};
