import { Chunk, getChunk } from "./Chunk";
import {
	type GenerateDistantTerrainRequest,
	type GenerateFarTileRequest,
	type GenerateFullMeshRequest,
	type InitDistantTerrainSharedRequest,
	type InitLightSharedRequest,
	type LightAddEmissionRequest,
	type LightMutateRequest,
	type LightPropagateDeferredRequest,
	type LightRegisterChunkBatchRequest,
	type LightSetClosedFaceMaskRequest,
	type LightSkyReconcileRequest,
	type MeshWorkerResponse,
	type RelightMeshRequest,
	type SetWorldSeedRequest,
	type VoxelRecycleBuffersRequest,
	type VoxelRegisterChunkBatchRequest,
	type WorkerResponseData,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";

// Offset order must match the voxel worker's NEIGHBOR_OFFSETS table
// (slot i = mask bit i): dz outer → dx inner, center (0,0,0) omitted.
export const NEIGHBOR_OFFSETS_26: readonly {
	readonly dx: number;
	readonly dy: number;
	readonly dz: number;
}[] = (() => {
	const out: { dx: number; dy: number; dz: number }[] = [];
	for (let z = -1; z <= 1; z++) {
		for (let y = -1; y <= 1; y++) {
			for (let x = -1; x <= 1; x++) {
				if (x === 0 && y === 0 && z === 0) continue;
				out.push({ dx: x, dy: y, dz: z });
			}
		}
	}
	return out;
})();

// Cached 26-bit neighbor presence masks, keyed by chunk. Invalidation is
// exact: a mask only depends on each neighbor's isLoaded && hasVoxelData,
// both of which flip solely on load/dispose (the pool's onLightChunkLoaded /
// onLightChunkDisposed hooks delete the affected entries). WeakMap = no leaks.
export const neighborMaskCache = new WeakMap<Chunk, number>();

/** Mirrors MeshBuildSession's lodStep derivation. */
function lodStepOfLod(lod: number | null | undefined): number {
	return lod !== null && lod !== undefined && lod >= 4 ? 1 << (lod - 3) : 1;
}

const SKIRT_SIDE_ALL = 0xf;

/**
 * Decide which horizontal borders this chunk owns skirts for, so two chunks
 * never wall the same boundary plane (coplanar z-fighting). A side gets a
 * skirt only when its neighbor is MISSING or FINER; same-level boundaries
 * are seamless via padded slabs and coarser neighbors own their own side.
 */
export function computeBorderSkirtMasks(chunk: Chunk): {
	sides: number;
	nearInset: number;
} {
	const myStep = lodStepOfLod(chunk.lodLevel);
	if (myStep <= 1) return { sides: 0, nearInset: 0 };

	let sides = 0;
	let nearInset = 0;

	const check = (
		dx: number,
		dz: number,
		bit: number,
		isNearSide: boolean,
	): void => {
		const n = getChunk(chunk.chunkX + dx, chunk.chunkY, chunk.chunkZ + dz);

		if (!n?.isLoaded) {
			sides |= bit;
			return;
		}

		if (lodStepOfLod(n.lodLevel) < myStep) {
			sides |= bit;
			// Near planes coincide with the greedy mesher's slice=-1
			// boundary walls when a neighbor exists — inset by one block.
			if (isNearSide) nearInset |= bit;
		}
	};

	check(-1, 0, 1, true);
	check(1, 0, 2, false);
	check(0, -1, 4, true);
	check(0, 1, 8, false);

	return { sides, nearInset };
}

export class ChunkWorker {
	private terrainWorker: Worker; // terrain + distant terrain + light
	private voxelWorker: Worker; // voxel mesh

	private distantTerrainSharedInitialized = false;
	private lightSharedInitialized = false;

	// Pre-allocated message objects for light dispatch — avoids spread allocation per call.
	readonly #lightMutateMsg: LightMutateRequest = {
		type: WorkerTaskType.LightMutate,
		chunkId: 0n,
		headerSlot: 0,
		x: 0,
		y: 0,
		z: 0,
		oldPacked: 0,
		newPacked: 0,
		seq: 0,
	};
	readonly #lightEmissionMsg: LightAddEmissionRequest = {
		type: WorkerTaskType.LightAddEmission,
		chunkId: 0n,
		headerSlot: 0,
		x: 0,
		y: 0,
		z: 0,
		level: 0,
		seq: 0,
	};
	readonly #lightSkyReconcileMsg: LightSkyReconcileRequest = {
		type: WorkerTaskType.LightSkyReconcile,
		chunkId: 0n,
		headerSlot: 0,
		seq: 0,
	};
	readonly #lightPropagateMsg: LightPropagateDeferredRequest = {
		type: WorkerTaskType.LightPropagateDeferred,
		chunkId: 0n,
		headerSlot: 0,
		seedQueue: new Uint16Array(0),
		seedLength: 0,
		seq: 0,
	};

	// PERF: same "preallocate + mutate fields" pattern as the light messages
	// above, applied to the voxel-mesh remesh dispatch. postMessage performs
	// structured clone synchronously before returning, so mutating this
	// object again on the next call (after the previous postMessage already
	// returned) is safe — it's the same reasoning already relied on for
	// #lightMutateMsg etc. Saves one object allocation per remesh dispatch.
	// SAB-direct: the payload is metadata only — the worker reads center grid
	// and neighbor borders from the registered SharedArrayBuffers.
	readonly #voxelMeshMsg: GenerateFullMeshRequest = {
		type: WorkerTaskType.GenerateFullMesh,
		chunkId: 0n,
		meshRevision: 0,
		lod: 0,
		chunk_size: Chunk.SIZE,
		generation: -1,
		blockRevision: -1,
		chunkX: 0,
		chunkY: 0,
		chunkZ: 0,
		neighborMask: 0,
		uniformBlockId: undefined,
	};

	readonly #relightMeshMsg: RelightMeshRequest = {
		type: WorkerTaskType.RelightMesh,
		chunkId: 0n,
		meshRevision: 0,
		lod: 0,
		chunk_size: Chunk.SIZE,
		generation: -1,
		blockRevision: -1,
		chunkX: 0,
		chunkY: 0,
		chunkZ: 0,
		neighborMask: 0,
	};

	constructor(
		workerIndex: number,
		onMessageTerrain: (event: MessageEvent<WorkerResponseData>) => void,
		onMessageMesh: (event: MessageEvent<MeshWorkerResponse>) => void,
	) {
		// Terrain / distant terrain / lighting worker
		this.terrainWorker = new Worker(
			new URL("./chunk.worker.ts", import.meta.url),
			{ type: "module", name: `chunk-terrain-${workerIndex}` },
		);
		this.terrainWorker.onmessage = onMessageTerrain;

		// Voxel mesh worker
		this.voxelWorker = new Worker(
			new URL("./voxel.worker.ts", import.meta.url),
			{ type: "module", name: `chunk-voxel-${workerIndex}` },
		);
		this.voxelWorker.onmessage = (e) => onMessageMesh(e);
	}

	public setOnError(handler: (ev: ErrorEvent | Event) => void): void {
		this.terrainWorker.onerror = handler;
		this.voxelWorker.onerror = handler;
	}

	public terminate(): void {
		this.distantTerrainSharedInitialized = false;
		this.terrainWorker.terminate();
		this.voxelWorker.terminate();
	}

	private static readonly _REMESH_OFFSETS = NEIGHBOR_OFFSETS_26;

	/**
	 * 26-bit presence snapshot for the voxel worker: slot i (same offset order
	 * as the worker's NEIGHBOR_OFFSETS table) is set when the neighbor passed
	 * the loaded + hasVoxelData gate — the exact set of borders the old
	 * transfer path would have sent. The worker reads those borders directly
	 * from its voxel-registration map.
	 */
	private static _buildNeighborMask(chunk: Chunk): number {
		const cached = neighborMaskCache.get(chunk);
		if (cached !== undefined) return cached;

		const cx = chunk.chunkX;
		const cy = chunk.chunkY;
		const cz = chunk.chunkZ;
		let mask = 0;
		for (let i = 0; i < ChunkWorker._REMESH_OFFSETS.length; i++) {
			const { dx, dy, dz } = ChunkWorker._REMESH_OFFSETS[i];
			// Number-keyed lookup instead of Chunk.chunkInstances (BigInt-keyed).
			// Also removes a fresh packCoords() BigInt alloc for all 20 edge/corner
			// offsets — same cost class as the neighborIds laziness fix.
			const neighbor = getChunk(cx + dx, cy + dy, cz + dz);
			if (neighbor?.isLoaded && neighbor.hasVoxelData) {
				mask |= 1 << i;
			}
		}
		neighborMaskCache.set(chunk, mask);
		return mask;
	}

	public postFullRemesh(chunk: Chunk, forcedLod?: number): void {
		const size = Chunk.SIZE;

		const msg = this.#voxelMeshMsg;
		msg.chunkId = chunk.id;
		msg.meshRevision = chunk.meshRevision;
		msg.lod = forcedLod ?? chunk.lodLevel ?? 0;
		msg.chunk_size = size;
		msg.generation = chunk.generation;
		msg.blockRevision = chunk.blockRevision;
		msg.chunkX = chunk.chunkX;
		msg.chunkY = chunk.chunkY;
		msg.chunkZ = chunk.chunkZ;
		msg.neighborMask = ChunkWorker._buildNeighborMask(chunk);
		msg.uniformBlockId = chunk.isUniform ? chunk.uniformBlockId : undefined;

		const skirts = computeBorderSkirtMasks(chunk);
		msg.borderSkirtSides = skirts.sides;
		msg.borderSkirtNearInset = skirts.nearInset;

		// SAB-direct: no payload buffers, no transfer list. The worker reads
		// the center grid and the 26 neighbor borders straight from the
		// SharedArrayBuffers registered via VoxelRegisterChunk.
		this.voxelWorker.postMessage(msg);
	}

	/**
	 * Return consumed mesh output buffers to this worker's voxel worker so it
	 * can reuse them instead of slicing fresh ones per response. The buffers
	 * are transferred (detached here); only call for results whose data is no
	 * longer referenced anywhere on the main thread.
	 */
	public postVoxelRecycleBuffers(buffers: ArrayBuffer[]): void {
		if (buffers.length === 0) return;
		this.voxelWorker.postMessage(
			{
				type: WorkerTaskType.VoxelRecycleBuffers,
				buffers,
			} satisfies VoxelRecycleBuffersRequest,
			buffers,
		);
	}

	/**
	 * Light-only remesh dispatch (T2-8). Metadata only: the worker reuses its
	 * cached block grid (validated via generation/blockRevision) and reads
	 * fresh center + neighbor light directly from the registered light
	 * SharedArrayBuffers, so the block-border extraction, block/palette/light
	 * copies and all their transfers are skipped entirely. Falls back to a
	 * full remesh on cache miss (RelightMeshMissMessage).
	 */
	public postRelightMesh(chunk: Chunk): void {
		const msg = this.#relightMeshMsg;
		msg.chunkId = chunk.id;
		msg.meshRevision = chunk.meshRevision;
		msg.lod = chunk.lodLevel ?? 0;
		msg.chunk_size = Chunk.SIZE;
		msg.generation = chunk.generation;
		msg.blockRevision = chunk.blockRevision;
		msg.chunkX = chunk.chunkX;
		msg.chunkY = chunk.chunkY;
		msg.chunkZ = chunk.chunkZ;
		msg.neighborMask = ChunkWorker._buildNeighborMask(chunk);

		const skirts = computeBorderSkirtMasks(chunk);
		msg.borderSkirtSides = skirts.sides;
		msg.borderSkirtNearInset = skirts.nearInset;

		this.voxelWorker.postMessage(msg);
	}

	// Terrain generation stays on terrainWorker
	public postTerrainGeneration(
		chunk: Chunk,
		deferLighting: boolean = true,
	): void {
		this.terrainWorker.postMessage({
			type: WorkerTaskType.GenerateTerrain,
			chunkId: chunk.id,
			chunkX: chunk.chunkX,
			chunkY: chunk.chunkY,
			chunkZ: chunk.chunkZ,
			deferLighting,
		});
	}

	// ---------------------------------------------------------------------
	// One-time SharedArrayBuffer init for distant terrain
	// Call this BEFORE the first distant terrain generation request.
	// ---------------------------------------------------------------------
	public initDistantTerrainShared(
		positionsBuffer: SharedArrayBuffer,
		normalsBuffer: SharedArrayBuffer,
		surfaceTilesBuffer: SharedArrayBuffer,
		radius: number,
		gridStep: number,
	): void {
		const message: InitDistantTerrainSharedRequest = {
			type: WorkerTaskType.InitDistantTerrainShared,
			positionsBuffer,
			normalsBuffer,
			surfaceTilesBuffer,
			radius,
			gridStep,
		};

		// SharedArrayBuffer is shared, not transferred.
		this.terrainWorker.postMessage(message);
		this.distantTerrainSharedInitialized = true;
	}

	// Distant terrain generation also stays on terrainWorker
	// No oldData, no transferables, no large typed-array payloads.
	public postGenerateDistantTerrain(
		requestId: number,
		centerChunkX: number,
		centerChunkZ: number,
		radius: number,
		gridStep: number,
		renderDistance: number,
	): void {
		if (!this.distantTerrainSharedInitialized) {
			throw new Error(
				"ChunkWorker.postGenerateDistantTerrain called before initDistantTerrainShared().",
			);
		}
		const message: GenerateDistantTerrainRequest = {
			type: WorkerTaskType.GenerateDistantTerrain,
			requestId,
			centerChunkX,
			centerChunkZ,
			radius,
			gridStep,
			renderDistance,
		};

		this.terrainWorker.postMessage(message);
	}

	public postGenerateFarTile(
		requestId: number,
		levelIndex: number,
		tileX: number,
		tileZ: number,
	): void {
		const message: GenerateFarTileRequest = {
			type: WorkerTaskType.GenerateFarTile,
			requestId,
			levelIndex,
			tileX,
			tileZ,
		};

		this.terrainWorker.postMessage(message);
	}

	// ---------------------------------------------------------------------
	// Light-task post helpers.  The terrain worker (chunk.worker.ts) owns
	// the light registry and BFS, and the post helpers simply forward
	// messages.  SharedArrayBuffers for chunk state are not transferred —
	// they live for the lifetime of the page and are referenced by all
	// workers via the registration messages posted by the pool.
	// ---------------------------------------------------------------------

	public initWorkerChannel(port: MessagePort): void {
		this.terrainWorker.postMessage(
			{ type: WorkerTaskType.InitWorkerChannel, port },
			[port],
		);
	}

	/**
	 * Same worker-to-worker channel wiring as initWorkerChannel, but for the
	 * voxel worker: the OPFS worker forwards chunk SAB refs ("voxelData")
	 * straight to every voxel worker, bypassing the main thread.
	 */
	public initVoxelWorkerChannel(port: MessagePort): void {
		this.voxelWorker.postMessage(
			{ type: WorkerTaskType.InitWorkerChannel, port },
			[port],
		);
	}

	public initLightShared(headerBuffer: SharedArrayBuffer): void {
		if (this.lightSharedInitialized) return;
		const message: InitLightSharedRequest = {
			type: WorkerTaskType.InitLightShared,
			headerBuffer,
		};
		this.terrainWorker.postMessage(message);
		this.lightSharedInitialized = true;
	}

	/**
	 * Set the world-name-derived generator seed on the terrain worker. Must be
	 * posted before the first generation task (the pool does this right after
	 * creating each worker).
	 */
	public setWorldSeed(seed: string): void {
		this.terrainWorker.postMessage({
			type: WorkerTaskType.SetWorldSeed,
			seed,
		} satisfies SetWorldSeedRequest);
	}

	public postLightSetClosedFaceMask(maskBuffer: SharedArrayBuffer): void {
		const message: LightSetClosedFaceMaskRequest = {
			type: WorkerTaskType.LightSetClosedFaceMask,
			maskBuffer,
		};
		this.terrainWorker.postMessage(message);
	}

	public postLightRegisterChunk(req: {
		seq: number;
		chunkId: bigint;
		chunkX: number;
		chunkY: number;
		chunkZ: number;
		headerSlot: number;
		blockSAB: SharedArrayBuffer | null;
		lightSAB: SharedArrayBuffer | null;
		paletteSAB: SharedArrayBuffer | null;
		blockStorageBytesPerElement: 1 | 2;
	}): void {
		this.terrainWorker.postMessage({
			type: WorkerTaskType.LightRegisterChunk,
			...req,
		});
	}

	public postLightRegisterChunkBatch(
		chunks: LightRegisterChunkBatchRequest["chunks"],
	): void {
		if (chunks.length === 0) return;
		this.terrainWorker.postMessage({
			type: WorkerTaskType.LightRegisterChunkBatch,
			chunks,
		});
	}

	public postLightUnregisterChunk(chunkId: bigint): void {
		this.terrainWorker.postMessage({
			type: WorkerTaskType.LightUnregisterChunk,
			chunkId,
		});
	}

	public postLightUnregisterChunkBatch(chunkIds: bigint[]): void {
		if (chunkIds.length === 0) return;
		this.terrainWorker.postMessage({
			type: WorkerTaskType.LightUnregisterChunkBatch,
			chunkIds,
		});
	}

	public postLightUpdateBuffers(req: {
		chunkId: bigint;
		headerSlot: number;
		blockSAB: SharedArrayBuffer | null;
		paletteSAB: SharedArrayBuffer | null;
		lightSAB: SharedArrayBuffer | null;
		blockStorageBytesPerElement: 1 | 2;
	}): void {
		this.terrainWorker.postMessage({
			type: WorkerTaskType.LightUpdateChunkBuffers,
			...req,
		});
	}

	public postLightMutate(req: {
		chunkId: bigint;
		headerSlot: number;
		x: number;
		y: number;
		z: number;
		oldPacked: number;
		newPacked: number;
		seq: number;
	}): void {
		const msg = this.#lightMutateMsg;
		msg.chunkId = req.chunkId;
		msg.headerSlot = req.headerSlot;
		msg.x = req.x;
		msg.y = req.y;
		msg.z = req.z;
		msg.oldPacked = req.oldPacked;
		msg.newPacked = req.newPacked;
		msg.seq = req.seq;
		this.terrainWorker.postMessage(msg);
	}

	public postLightAddEmission(req: {
		chunkId: bigint;
		headerSlot: number;
		x: number;
		y: number;
		z: number;
		level: number;
		seq: number;
	}): void {
		const msg = this.#lightEmissionMsg;
		msg.chunkId = req.chunkId;
		msg.headerSlot = req.headerSlot;
		msg.x = req.x;
		msg.y = req.y;
		msg.z = req.z;
		msg.level = req.level;
		msg.seq = req.seq;
		this.terrainWorker.postMessage(msg);
	}

	public postLightSkyReconcile(req: {
		chunkId: bigint;
		headerSlot: number;
		seq: number;
	}): void {
		const msg = this.#lightSkyReconcileMsg;
		msg.chunkId = req.chunkId;
		msg.headerSlot = req.headerSlot;
		msg.seq = req.seq;
		this.terrainWorker.postMessage(msg);
	}

	public postLightPropagateDeferred(req: {
		chunkId: bigint;
		headerSlot: number;
		seedQueue: Uint16Array;
		seedLength: number;
		seq: number;
	}): void {
		const msg = this.#lightPropagateMsg;
		msg.chunkId = req.chunkId;
		msg.headerSlot = req.headerSlot;
		msg.seedQueue = req.seedQueue;
		msg.seedLength = req.seedLength;
		msg.seq = req.seq;
		// PERF: the seed queue is exclusively owned by the caller (the pool
		// deletes its deferredLightingSeedStates entry before posting), so it
		// is transferred instead of structured-cloned — otherwise postMessage
		// would copy up to 6144 Uint16s a second time.
		this.terrainWorker.postMessage(msg, [req.seedQueue.buffer]);
	}

	// ---------------------------------------------------------------------
	// Voxel-registration post helpers (SAB-direct mesh borders).  The voxel
	// worker reads center grids and neighbor borders straight from the
	// registered SharedArrayBuffers on every mesh task, so the main thread
	// posts registration metadata only — the SAB handles come inline
	// (direct=true, fresh generation / layout change / restart) or through
	// the OPFS worker-to-worker channel (direct=false).
	// ---------------------------------------------------------------------

	public postVoxelRegisterChunk(req: {
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
	}): void {
		this.voxelWorker.postMessage({
			type: WorkerTaskType.VoxelRegisterChunk,
			...req,
		});
	}

	public postVoxelRegisterChunkBatch(
		req: Omit<VoxelRegisterChunkBatchRequest, "type">,
	): void {
		if (req.chunkIds.length === 0) return;
		this.voxelWorker.postMessage({
			type: WorkerTaskType.VoxelRegisterChunkBatch,
			...req,
		});
	}

	public postVoxelUnregisterChunk(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): void {
		this.voxelWorker.postMessage({
			type: WorkerTaskType.VoxelUnregisterChunk,
			chunkX,
			chunkY,
			chunkZ,
		});
	}

	public postVoxelUnregisterChunkBatch(coords: Int32Array): void {
		if (coords.length === 0) return;
		this.voxelWorker.postMessage({
			type: WorkerTaskType.VoxelUnregisterChunkBatch,
			coords,
		});
	}

	public postVoxelUpdateBuffers(req: {
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
	}): void {
		this.voxelWorker.postMessage({
			type: WorkerTaskType.VoxelUpdateChunkBuffers,
			...req,
		});
	}
}
