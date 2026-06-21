import { Chunk } from "./Chunk";
import { packCoords } from "./DataStructures/ChunkCoords";
import {
	type GenerateDistantTerrainRequest,
	type InitDistantTerrainSharedRequest,
	type InitLightSharedRequest,
	type LightAddEmissionRequest,
	type LightMutateRequest,
	type LightPropagateDeferredRequest,
	type LightSetClosedFaceMaskRequest,
	type LightSkyReconcileRequest,
	type MeshWorkerResponse,
	type WorkerResponseData,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";

export class ChunkWorker {
	private terrainWorker: Worker; // terrain + distant terrain + light
	private voxelWorker: Worker; // voxel mesh

	private warnedNonSharedRemeshPayload = false;
	private distantTerrainSharedInitialized = false;
	private lightSharedInitialized = false;
	// Pre-allocated arrays for remesh dispatch — avoids 4 allocations per call.
	private readonly _neighborScratch: (
		| Uint8Array
		| Uint16Array
		| null
		| undefined
	)[] = new Array(27);
	private readonly _neighborLightScratch: (Uint8Array | undefined)[] =
		new Array(27);
	private readonly _neighborUniformIdScratch: (number | undefined)[] =
		new Array(27);
	private readonly _neighborPaletteScratch: (
		| Uint8Array
		| Uint16Array
		| null
		| undefined
	)[] = new Array(27);
	private static readonly EMPTY_NEIGHBOR_BLOCKS =
		typeof SharedArrayBuffer !== "undefined"
			? new Uint16Array(new SharedArrayBuffer(0))
			: new Uint16Array(0);
	private static readonly EMPTY_NEIGHBOR_LIGHTS =
		typeof SharedArrayBuffer !== "undefined"
			? new Uint8Array(new SharedArrayBuffer(0))
			: new Uint8Array(0);

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

	private readonly paletteToTyped = (
		palette: Uint8Array | Uint16Array | null | undefined,
	) => {
		if (!palette || palette.length === 0) return palette;
		return palette;
	};

	private static readonly _REMESH_OFFSETS: readonly {
		readonly dx: number;
		readonly dy: number;
		readonly dz: number;
		readonly faceIdx: number;
	}[] = (() => {
		const out: { dx: number; dy: number; dz: number; faceIdx: number }[] = [];
		for (let z = -1; z <= 1; z++) {
			for (let y = -1; y <= 1; y++) {
				for (let x = -1; x <= 1; x++) {
					if (x === 0 && y === 0 && z === 0) continue;
					const nz = (x !== 0 ? 1 : 0) + (y !== 0 ? 1 : 0) + (z !== 0 ? 1 : 0);
					let faceIdx = -1;
					if (nz === 1)
						faceIdx =
							x === 1
								? 0
								: x === -1
									? 1
									: y === 1
										? 2
										: y === -1
											? 3
											: z === 1
												? 4
												: 5;
					out.push({ dx: x, dy: y, dz: z, faceIdx });
				}
			}
		}
		return out;
	})();

	public postFullRemesh(chunk: Chunk, forcedLod?: number): void {
		const neighbors = this._neighborScratch;
		const neighborLights = this._neighborLightScratch;
		const neighborUniformIds = this._neighborUniformIdScratch;
		const neighborPalettes = this._neighborPaletteScratch;
		const inst = Chunk.chunkInstances;
		const neighborIds = chunk.neighborIds;
		const cx = chunk.chunkX;
		const cy = chunk.chunkY;
		const cz = chunk.chunkZ;

		for (let i = 0; i < ChunkWorker._REMESH_OFFSETS.length; i++) {
			const { dx, dy, dz, faceIdx } = ChunkWorker._REMESH_OFFSETS[i];
			const neighbor =
				faceIdx >= 0
					? inst.get(neighborIds[faceIdx])
					: inst.get(packCoords(cx + dx, cy + dy, cz + dz));

			if (neighbor?.isLoaded) {
				if (!neighbor.hasVoxelData) {
					neighbors[i] = ChunkWorker.EMPTY_NEIGHBOR_BLOCKS;
					neighborLights[i] = ChunkWorker.EMPTY_NEIGHBOR_LIGHTS;
					neighborUniformIds[i] = undefined;
					neighborPalettes[i] = undefined;
					continue;
				}

				neighbors[i] = neighbor.block_array;
				neighborLights[i] = neighbor.light_array;
				neighborUniformIds[i] = neighbor.isUniform
					? neighbor.uniformBlockId
					: undefined;
				neighborPalettes[i] = this.paletteToTyped(neighbor.palette);
			} else {
				neighbors[i] = undefined;
				neighborLights[i] = undefined;
				neighborUniformIds[i] = undefined;
				neighborPalettes[i] = undefined;
			}
		}

		// Warn once if structured cloning may copy instead of sharing
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

		/**
		 * IMPORTANT:
		 * We do NOT send MeshContext/getBlock/getLight from the main thread.
		 * The worker reconstructs those from the raw payload.
		 *
		 * We also send the same rich shape your old mesh worker pipeline used,
		 * so the worker can expand:
		 *  - uniform chunks
		 *  - palette-packed chunks
		 *  - uniform neighbors
		 *  - palette-packed neighbors
		 */
		this.voxelWorker.postMessage({
			task: "voxelMesh",

			chunkId: chunk.id,
			lod: forcedLod ?? chunk.lodLevel ?? 0,
			chunk_size: Chunk.SIZE,

			block_array: chunk.block_array,
			uniformBlockId: chunk.isUniform ? chunk.uniformBlockId : undefined,
			palette: this.paletteToTyped(chunk.palette),
			light_array: chunk.light_array,

			neighbors,
			neighborLights,
			neighborUniformIds,
			neighborPalettes,
		});
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
		renderDistance: number,
		gridStep: number,
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
			renderDistance,
			gridStep,
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

	public initLightShared(headerBuffer: SharedArrayBuffer): void {
		if (this.lightSharedInitialized) return;
		const message: InitLightSharedRequest = {
			type: WorkerTaskType.InitLightShared,
			headerBuffer,
		};
		this.terrainWorker.postMessage(message);
		this.lightSharedInitialized = true;
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

	public postLightUnregisterChunk(chunkId: bigint): void {
		this.terrainWorker.postMessage({
			type: WorkerTaskType.LightUnregisterChunk,
			chunkId,
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
		this.terrainWorker.postMessage(msg);
	}
}
