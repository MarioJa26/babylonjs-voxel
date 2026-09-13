import type { MeshData } from "./MeshData";

export const enum TaskType {
	Terrain,
	Remesh,
	LodPrecompute,
	DistantTerrain,
	Relight,
	FarTile,
}

export const enum WorkerTaskType {
	GenerateTerrain,
	GenerateFullMesh,
	RelightMesh,
	GenerateDistantTerrain_Generated,
	GenerateDistantTerrain,
	InitDistantTerrainShared,
	WorkerReady,
	// --- Far-tile LOD tasks (LOD6+) ---
	GenerateFarTile,
	// --- Light worker tasks ---
	InitLightShared,
	LightSetClosedFaceMask,
	LightRegisterChunk,
	LightRegisterChunkBatch,
	LightUnregisterChunk,
	LightUnregisterChunkBatch,
	LightUpdateChunkBuffers,
	LightMutate,
	LightMutateBatch,
	LightAddEmission,
	LightSkyReconcile,
	LightPropagateDeferred,
	LightDirty,
	InitWorkerChannel,
	// --- Voxel-worker registration (SAB-direct mesh borders) ---
	VoxelRegisterChunk,
	VoxelRegisterChunkBatch,
	VoxelUnregisterChunk,
	VoxelUnregisterChunkBatch,
	VoxelUpdateChunkBuffers,
	VoxelRecycleBuffers,
	// --- World bootstrap ---
	SetWorldSeed,
}

/* =========================================================
 * Shared helper types
 * ========================================================= */

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
	meshRevision: number;

	// NEW: LOD level sent from ChunkWorker -> worker
	lod?: number;

	// Content versioning for the worker-side relight cache: a relight task
	// reuses the cached block grid only when both match the chunk's current
	// state.
	generation?: number;
	blockRevision?: number;

	// SAB-direct context. The worker derives the 26 neighbor coords from the
	// center coords and looks each up in its voxel-registration map (see
	// VoxelRegisterChunk); no border data is transferred anymore.
	chunkX: number;
	chunkY: number;
	chunkZ: number;

	// 26-bit presence snapshot taken at dispatch time (slot i = bit i, same
	// offset order as the worker's NEIGHBOR_OFFSETS table). Bits are set for
	// every neighbor that passed the loaded + hasVoxelData gate, matching the
	// borders the old transfer path would have sent.
	neighborMask: number;

	// Uniform chunks carry no dense grid — pass the fill id so the padded
	// grid is filled directly (no 64-512 KiB dense materialization).
	uniformBlockId?: number;

	chunk_size: number;

	/**
	 * Border-skirt ownership for downsampled builds (bit per side:
	 * 1=-X, 2=+X, 4=-Z, 8=+Z). Computed on the main thread from neighbor
	 * LODs so exactly one chunk owns each boundary plane's skirt.
	 */
	borderSkirtSides?: number;
	borderSkirtNearInset?: number;
};

/**
 * Light-only remesh request. The worker re-runs the full greedy pipeline
 * against its cached block grid (validated via generation/blockRevision) with
 * fresh light read directly from the registered light SharedArrayBuffers, so
 * the main thread sends metadata only. A cache miss is answered with a
 * RelightMeshMissMessage and the main thread falls back to a full remesh.
 */
export type RelightMeshRequest = {
	type: WorkerTaskType.RelightMesh;
	chunkId: bigint;
	meshRevision: number;
	lod: number;
	chunk_size: number;

	generation: number;
	blockRevision: number;

	chunkX: number;
	chunkY: number;
	chunkZ: number;
	neighborMask: number;

	borderSkirtSides?: number;
	borderSkirtNearInset?: number;
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
	gridStep: number;
	renderDistance: number;
};

export type GenerateFarTileRequest = {
	type: WorkerTaskType.GenerateFarTile;
	requestId: number;
	levelIndex: number;
	tileX: number;
	tileZ: number;
};

export type FarTileGeneratedMessage = {
	type: WorkerTaskType.GenerateFarTile;
	requestId: number;
	levelIndex: number;
	tileX: number;
	tileZ: number;
	opaqueFaces: Uint32Array;
	waterFaces: Uint32Array;
};

export type SetWorldSeedRequest = {
	type: WorkerTaskType.SetWorldSeed;
	/** Seed string fed to the generator (world name derived). */
	seed: string;
};

export type WorkerRequestData =
	| GenerateTerrainRequest
	| GenerateFullMeshRequest
	| RelightMeshRequest
	| GenerateDistantTerrainRequest
	| InitDistantTerrainSharedRequest
	| GenerateFarTileRequest
	| InitLightSharedRequest
	| LightSetClosedFaceMaskRequest
	| LightRegisterChunkRequest
	| LightRegisterChunkBatchRequest
	| LightUnregisterChunkRequest
	| LightUnregisterChunkBatchRequest
	| LightUpdateChunkBuffersRequest
	| LightMutateRequest
	| LightMutateBatchRequest
	| LightAddEmissionRequest
	| LightSkyReconcileRequest
	| LightPropagateDeferredRequest
	| VoxelRegisterChunkRequest
	| VoxelRegisterChunkBatchRequest
	| VoxelUnregisterChunkRequest
	| VoxelUnregisterChunkBatchRequest
	| VoxelUpdateChunkBuffersRequest
	| VoxelRecycleBuffersRequest
	| SetWorldSeedRequest;

/* =========================================================
 * Light-task messages
 * ========================================================= */

export type InitLightSharedRequest = {
	type: WorkerTaskType.InitLightShared;
	headerBuffer: SharedArrayBuffer;
};

export type LightSetClosedFaceMaskRequest = {
	type: WorkerTaskType.LightSetClosedFaceMask;
	maskBuffer: SharedArrayBuffer;
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
	// True when a deferred-lighting refinement is already queued for this
	// chunk: its BFS is always followed by an explicit sky-reconcile request,
	// so running the O(volume) sky scan at registration time as well just
	// doubles the most expensive pass on the light worker.
	skipSkyReconcile?: boolean;
};

export type LightRegisterChunkBatchRequest = {
	type: WorkerTaskType.LightRegisterChunkBatch;
	chunks: Array<Omit<LightRegisterChunkRequest, "type">>;
};

export type LightUnregisterChunkRequest = {
	type: WorkerTaskType.LightUnregisterChunk;
	chunkId: bigint;
};

export type LightUnregisterChunkBatchRequest = {
	type: WorkerTaskType.LightUnregisterChunkBatch;
	chunkIds: bigint[];
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

/**
 * Batched light mutations for a single chunk: flat [x,y,z,oldPacked,
 * newPacked] quintuples sharing one chunkId/headerSlot/seq. Posted
 * zero-copy (transferred buffer). Handled by looping the same lightMutate
 * core as single requests, with a single LightDirty reply per chunk.
 */
export type LightMutateBatchRequest = {
	type: WorkerTaskType.LightMutateBatch;
	chunkId: bigint;
	headerSlot: number;
	muts: Uint32Array;
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
 * Voxel-worker registration messages (SAB-direct mesh data)
 * ========================================================= */

/**
 * Register a chunk's voxel/light SharedArrayBuffers with a mesh worker so it
 * can extract the center grid and the 26 neighbor border slabs directly from
 * shared memory instead of receiving transferred copies per remesh.
 *
 * When `direct` is true the SAB fields are authoritative (fresh generation,
 * storage layout change, worker restart). When `direct` is false the SAB
 * fields must be null and the handles arrive via the OPFS worker-to-worker
 * channel; the worker merges the two halves (mirror of the light-worker
 * registration path).
 */
export type VoxelRegisterChunkRequest = {
	type: WorkerTaskType.VoxelRegisterChunk;
	chunkId: bigint;
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	isUniform: boolean;
	uniformBlockId: number;
	blockStorageBytesPerElement: 1 | 2;
	direct: boolean;
	blockSAB: SharedArrayBuffer | null;
	paletteSAB: SharedArrayBuffer | null;
	lightSAB: SharedArrayBuffer | null;
};

export type VoxelRegisterChunkBatchRequest = {
	type: WorkerTaskType.VoxelRegisterChunkBatch;
	chunkIds: BigInt64Array;
	// SoA batch: flat chunkX, chunkY, chunkZ per entry (Int32 — coords can be negative).
	coords: Int32Array;
	// isUniform(0|1), uniformBlockId, blockStorageBytesPerElement per entry.
	meta: Uint32Array;
	blockSABs: Array<SharedArrayBuffer | null>;
	paletteSABs: Array<SharedArrayBuffer | null>;
	lightSABs: Array<SharedArrayBuffer | null>;
};

export type VoxelUnregisterChunkRequest = {
	type: WorkerTaskType.VoxelUnregisterChunk;
	chunkX: number;
	chunkY: number;
	chunkZ: number;
};

export type VoxelUnregisterChunkBatchRequest = {
	type: WorkerTaskType.VoxelUnregisterChunkBatch;
	// SoA batch: flat chunkX, chunkY, chunkZ per entry (Int32 — coords can be negative).
	coords: Int32Array;
};

export type VoxelUpdateChunkBuffersRequest = {
	type: WorkerTaskType.VoxelUpdateChunkBuffers;
	chunkId: bigint;
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	isUniform: boolean;
	uniformBlockId: number;
	blockStorageBytesPerElement: 1 | 2;
	blockSAB: SharedArrayBuffer | null;
	paletteSAB: SharedArrayBuffer | null;
	lightSAB: SharedArrayBuffer | null;
};

/**
 * Main thread → voxel worker: mesh output buffers whose consumers are done
 * with them, transferred back so the worker can reuse them instead of
 * slicing fresh ones per response. Only ever sent for results the main
 * thread DROPPED (stale revision / unknown chunk / LOD skip) — applied
 * results stay alive in the LOD caches and must never be recycled.
 */
export type VoxelRecycleBuffersRequest = {
	type: WorkerTaskType.VoxelRecycleBuffers;
	buffers: ArrayBuffer[];
};

/* =========================================================
 * Responses sent FROM the worker
 * ========================================================= */
export type FullMeshMessage = {
	type: WorkerTaskType.GenerateFullMesh;
	chunkId: bigint;
	meshRevision: number;
	lod: number;
	opaque: MeshData | null;
	water: MeshData | null;
	cutout: MeshData | null;
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

/**
 * Relight cache-miss response: the worker has no valid block grid for this
 * chunk, so the main thread must fall back to a full GenerateFullMesh.
 */
export type RelightMeshMissMessage = {
	type: WorkerTaskType.RelightMesh;
	chunkId: bigint;
	meshRevision: number;
	lod: number;
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
	| RelightMeshMissMessage
	| DistantTerrainGeneratedMessage
	| FarTileGeneratedMessage
	| { type: WorkerTaskType.InitDistantTerrainShared } // ← ack only, no payload
	| { type: WorkerTaskType.InitLightShared } // ← ack only
	| { type: WorkerTaskType.LightSetClosedFaceMask } // ← ack only
	| { type: WorkerTaskType.WorkerReady }
	| LightDirtyMessage;

export type MeshWorkerResponse = {
	chunkId: bigint;
	meshRevision: number;
	lod: number;
	opaque: MeshData | null;
	water: MeshData | null;
	cutout: MeshData | null;
};
