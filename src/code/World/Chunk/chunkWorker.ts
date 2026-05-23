import { Chunk } from "./Chunk";
import {
	type GenerateDistantTerrainRequest,
	type InitDistantTerrainSharedRequest,
	type MeshWorkerResponse,
	type WorkerResponseData,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";

export class ChunkWorker {
	private terrainWorker: Worker;
	private voxelWorker: Worker;
	private waterWorker: Worker;

	private warnedNonSharedRemeshPayload = false;
	private distantTerrainSharedInitialized = false;
	private readonly _neighborScratch: (Uint16Array | null | undefined)[] =
		new Array(27);
	private readonly _neighborLightScratch: (Uint8Array | undefined)[] =
		new Array(27);
	private static readonly EMPTY_NEIGHBOR_VOXELS =
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

		// Water mesh worker
		this.waterWorker = new Worker(
			new URL("./water.worker.ts", import.meta.url),
			{ type: "module", name: `chunk-water-${workerIndex}` },
		);
		this.waterWorker.onmessage = (e) => onMessageMesh(e);
	}

	public setOnError(handler: (ev: ErrorEvent | Event) => void): void {
		this.terrainWorker.onerror = handler;
		this.voxelWorker.onerror = handler;
		this.waterWorker.onerror = handler;
	}

	public terminate(): void {
		this.distantTerrainSharedInitialized = false;
		this.terrainWorker.terminate();
		this.voxelWorker.terminate();
		this.waterWorker.terminate();
	}

	public postFullRemesh(chunk: Chunk, forcedLod?: number): void {
		const neighbors = this._neighborScratch;
		const neighborLights = this._neighborLightScratch;
		let idx = 0;

		for (let z = -1; z <= 1; z++) {
			for (let y = -1; y <= 1; y++) {
				for (let x = -1; x <= 1; x++) {
					if (x === 0 && y === 0 && z === 0) continue;

					const neighbor = chunk.getNeighbor(x, y, z);
					if (neighbor?.isLoaded) {
						if (!neighbor.hasVoxelData) {
							neighbors[idx] = ChunkWorker.EMPTY_NEIGHBOR_VOXELS;
							neighborLights[idx] = ChunkWorker.EMPTY_NEIGHBOR_LIGHTS;
							idx++;
							continue;
						}

						neighbors[idx] = neighbor.block_array;
						neighborLights[idx] = neighbor.light_array;
					} else {
						neighbors[idx] = undefined;
						neighborLights[idx] = undefined;
					}
				}
			}
		}

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

		this.voxelWorker.postMessage({
			task: "voxelMesh",

			chunkId: chunk.id,
			lod: forcedLod ?? chunk.lodLevel ?? 0,
			chunk_size: Chunk.SIZE,

			voxels: chunk.block_array,
			light_array: chunk.light_array,

			neighbors,
			neighborLights,
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
}
