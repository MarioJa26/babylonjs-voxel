import { Chunk } from "./Chunk";
import {
	type GenerateDistantTerrainRequest,
	type InitDistantTerrainSharedRequest,
	type InitLightSharedRequest,
	type LightAddEmissionRequest,
	type LightMutateRequest,
	type LightPropagateDeferredRequest,
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

	public postFullRemesh(chunk: Chunk, forcedLod?: number): void {
		const neighbors = this._neighborScratch;
		const neighborLights = this._neighborLightScratch;
		const neighborUniformIds = this._neighborUniformIdScratch;
		const neighborPalettes = this._neighborPaletteScratch;
		let idx = 0;

		for (let z = -1; z <= 1; z++) {
			for (let y = -1; y <= 1; y++) {
				for (let x = -1; x <= 1; x++) {
					if (x === 0 && y === 0 && z === 0) continue;

					const neighbor = chunk.getNeighbor(x, y, z);
					if (neighbor?.isLoaded) {
						if (!neighbor.hasVoxelData) {
							neighbors[idx] = ChunkWorker.EMPTY_NEIGHBOR_BLOCKS;
							neighborLights[idx] = ChunkWorker.EMPTY_NEIGHBOR_LIGHTS;
							neighborUniformIds[idx] = undefined;
							neighborPalettes[idx] = undefined;
							idx++;
							continue;
						}

						neighbors[idx] = neighbor.block_array;
						neighborLights[idx] = neighbor.light_array;
						neighborUniformIds[idx] = neighbor.isUniform
							? neighbor.uniformBlockId
							: undefined;
						neighborPalettes[idx] = this.paletteToTyped(neighbor.palette);
					} else {
						neighbors[idx] = undefined;
						neighborLights[idx] = undefined;
						neighborUniformIds[idx] = undefined;
						neighborPalettes[idx] = undefined;
					}
					idx++;
				}
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

	public postLightRegisterChunk(req: {
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
		const message: LightMutateRequest = {
			type: WorkerTaskType.LightMutate,
			...req,
		};
		this.terrainWorker.postMessage(message);
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
		const message: LightAddEmissionRequest = {
			type: WorkerTaskType.LightAddEmission,
			...req,
		};
		this.terrainWorker.postMessage(message);
	}

	public postLightSkyReconcile(req: {
		chunkId: bigint;
		headerSlot: number;
		seq: number;
	}): void {
		const message: LightSkyReconcileRequest = {
			type: WorkerTaskType.LightSkyReconcile,
			...req,
		};
		this.terrainWorker.postMessage(message);
	}

	public postLightPropagateDeferred(req: {
		chunkId: bigint;
		headerSlot: number;
		seedQueue: Uint16Array;
		seedLength: number;
		seq: number;
	}): void {
		const message: LightPropagateDeferredRequest = {
			type: WorkerTaskType.LightPropagateDeferred,
			...req,
		};
		this.terrainWorker.postMessage(message);
	}
}
