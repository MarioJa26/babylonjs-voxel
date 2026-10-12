/**
 * chunkWorker.ts — Node.js worker thread for parallel chunk generation.
 *
 * Each worker owns one WorldGenerator instance. Receives single or batch
 * chunk requests, generates terrain, compresses blocks, and posts finalized
 * results back with zero-copy buffer transfers.
 *
 * Compression happens here so the main event loop is never blocked by
 * per-chunk CPU work, and the IPC payload is smaller.
 *
 * When wasmEnabled is true, loads the WASM SIMD noise backend before
 * constructing the WorldGenerator.
 */

import { parentPort } from "node:worker_threads";
import { setTerrainSeed } from "@/code/Generation/TerrainHeightMap";
import { loadWasmNoiseFromFile } from "@/code/Lib/WasmNoise";
import { compressBlocks } from "../world/ChunkCompression.ts";
import { PendingTaskKindType } from "./workerProtocol.ts";

type ChunkCoord = {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
};
type GenerationRuntime = {
	WorldGenerator: new (params: unknown) => Generator;
	GenerationParams: Record<string, unknown>;
};

type GenRequest = {
	id: number;
	seed: string;
	wasmEnabled: boolean;
	kind: PendingTaskKindType.SINGLE;
} & ChunkCoord;

type GenBatchRequest = {
	id: number;
	seed: string;
	wasmEnabled: boolean;
	kind: PendingTaskKindType.BATCH;
	items: ChunkCoord[];
};

type ChunkResult = {
	blocks: Uint8Array;
	light: Uint8Array;
};

type FinalizedChunk = {
	blocks: Uint8Array | Uint16Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
};

type RelightRequest = {
	id: number;
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	blocks: Uint8Array | Uint16Array;
	topSunlightMask?: Uint8Array;
	neighborLight?: (Uint8Array | null)[];
	seed: string;
	wasmEnabled: boolean;
};

type RelightResult = {
	id: number;
	light: Uint8Array;
};

type GenSuccess = {
	id: number;
	kind: PendingTaskKindType.SINGLE;
	blocks: Uint8Array | Uint16Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
};

type GenBatchSuccess = {
	id: number;
	kind: PendingTaskKindType.BATCH;
	items: FinalizedChunk[];
};

type GenError = {
	id: number;
	error: string;
};

type WorkerRequest = GenRequest | GenBatchRequest | RelightRequest;

type Generator = {
	generateChunkData: (x: number, y: number, z: number) => ChunkResult;

	relightChunk: (
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		blocks: Uint8Array | Uint16Array,
		topSunlightMask?: Uint8Array,
		neighborLight?: ReadonlyArray<Uint8Array | null>,
	) => Uint8Array;
};

const port = parentPort;

if (port === null) {
	throw new Error("chunkWorker must run inside a worker thread");
}
let generationRuntimePromise: Promise<GenerationRuntime> | null = null;

let generator: Generator | null = null;
let currentSeed = "";

let wasmEnabledConfig = false;
let wasmLoadPromise: Promise<void> | null = null;
let wasmLoadAttempted = false;
let jsBackendLogged = false;

let initPromise: Promise<void> | null = null;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
} /**
 * Load and initialize the seed-independent generation runtime once.
 *
 * Dynamic imports, shape initialization, and closed-face-mask generation do
 * not depend on the world seed. Repeating them whenever the seed changes adds
 * unnecessary module coordination and LUT generation work.
 */
async function loadGenerationRuntime(): Promise<GenerationRuntime> {
	const existing = generationRuntimePromise;

	if (existing !== null) {
		return existing;
	}

	const loading = (async (): Promise<GenerationRuntime> => {
		const [
			worldGeneratorModule,
			generationParamsModule,
			faceMasksModule,
			lightGeneratorModule,
			blockShapesModule,
		] = await Promise.all([
			import("@/code/Generation/WorldGenerator"),
			import("@/code/Generation/NoiseAndParameters/GenerationParams"),
			import("@/code/World/Chunk/Meshing/ChunkFaceMasks"),
			import("@/code/Generation/LightGenerator"),
			import("@/code/World/Shape/BlockShapes"),
		]);

		/*
		 * Shape-aware lighting depends on the asynchronous shape registry.
		 * This completes once for the lifetime of the worker.
		 */
		await blockShapesModule.shapeInitPromise;

		/*
		 * The closed-face LUT is seed-independent and relatively expensive to
		 * derive. Build and publish it only once per worker.
		 */
		lightGeneratorModule.LightGenerator.setClosedFaceMaskLUT(
			faceMasksModule.precomputeClosedFaceMasks(),
		);

		return {
			WorldGenerator: worldGeneratorModule.WorldGenerator as new (
				params: unknown,
			) => Generator,
			GenerationParams: generationParamsModule.GenerationParams as Record<
				string,
				unknown
			>,
		};
	})();

	generationRuntimePromise = loading;

	try {
		return await loading;
	} catch (error) {
		/*
		 * Permit retry after a transient module or shape-initialization failure.
		 * Clear only when this promise still owns the cache slot.
		 */
		if (generationRuntimePromise === loading) {
			generationRuntimePromise = null;
		}

		throw error;
	}
}

/**
 * Performs the single WASM loading attempt.
 *
 * Kept outside ensureWasm() so a new async closure is not allocated when the
 * first WASM-enabled request arrives.
 */
async function loadWasmBackend(): Promise<void> {
	wasmLoadAttempted = true;

	const loaded = await loadWasmNoiseFromFile();

	if (loaded) {
		console.log("[chunk-worker] WASM noise backend active");
	} else {
		console.log("[chunk-worker] JS noise backend (WASM unavailable)");
	}
}

/**
 * Load the WASM backend at most once, but do not memoize a disabled request
 * as a permanent "no WASM" decision.
 */
function ensureWasm(wasmEnabled: boolean): Promise<void> | undefined {
	if (wasmEnabled) {
		wasmEnabledConfig = true;
	}

	if (!wasmEnabledConfig) {
		if (!jsBackendLogged) {
			jsBackendLogged = true;
			console.log("[chunk-worker] JS noise backend (wasm-enabled=false)");
		}

		return undefined;
	}

	if (wasmLoadAttempted) {
		return undefined;
	}

	if (wasmLoadPromise === null) {
		wasmLoadPromise = loadWasmBackend();
	}

	return wasmLoadPromise;
}

/**
 * Construct the generator for one seed.
 *
 * WASM initialization and seed-independent module initialization may run in
 * parallel. Generator construction waits until both are ready.
 */
async function initializeGenerator(
	seed: string,
	wasmEnabled: boolean,
): Promise<void> {
	const wasmReady = ensureWasm(wasmEnabled);
	const runtimePromise = loadGenerationRuntime();

	const runtime = wasmReady
		? (await Promise.all([runtimePromise, wasmReady]))[0]
		: await runtimePromise;

	/*
	 * TerrainHeightMap contains module-global seed-dependent state. This write
	 * occurs only after ensureInit has given this initialization exclusive
	 * ownership.
	 */
	setTerrainSeed(seed);

	/*
	 * Preserve the original isolation from the shared GenerationParams object.
	 * Only one shallow copy is made for each actual seed change.
	 */
	const params = {
		...runtime.GenerationParams,
		SEED: seed,
	};

	generator = new runtime.WorldGenerator(params);
	currentSeed = seed;
}

/**
 * Ensure that exactly one generator initialization runs at a time.
 *
 * Message handlers are asynchronous and can overlap while awaiting imports or
 * WASM loading. The loop is important: after waiting for another request's
 * initialization, this request must re-check both the active seed and the
 * initialization slot before starting work of its own.
 */
async function ensureInit(seed: string, wasmEnabled: boolean): Promise<void> {
	for (;;) {
		if (generator !== null && currentSeed === seed) {
			return;
		}

		const pending = initPromise;

		if (pending !== null) {
			await pending;
			continue;
		}

		const initialization = initializeGenerator(seed, wasmEnabled);

		initPromise = initialization;

		try {
			await initialization;
			return;
		} finally {
			/*
			 * Retain identity protection in case initialization ownership is
			 * changed by future code.
			 */
			if (initPromise === initialization) {
				initPromise = null;
			}
		}
	}
}

/**
 * Collect unique transferable result buffers in linear time.
 *
 * Large batches contain two buffers per generated chunk. Repeatedly scanning
 * the growing transfer array for duplicates is O(n²), even though duplicates
 * are uncommon. A Set makes collection O(n) with one short-lived allocation
 * per batch.
 */
function collectBatchTransferables(
	items: readonly FinalizedChunk[],
): ArrayBuffer[] {
	const itemCount = items.length;
	const transfer: ArrayBuffer[] = [];
	const seen = new Set<ArrayBuffer>();

	for (let i = 0; i < itemCount; i++) {
		const item = items[i];

		const blocksBuffer = item.blocks.buffer;

		if (blocksBuffer instanceof ArrayBuffer) {
			if (!seen.has(blocksBuffer)) {
				seen.add(blocksBuffer);
				transfer.push(blocksBuffer);
			}
		}

		const lightBuffer = item.light.buffer;

		if (lightBuffer instanceof ArrayBuffer && !seen.has(lightBuffer)) {
			seen.add(lightBuffer);
			transfer.push(lightBuffer);
		}
	}

	return transfer;
}

/**
 * Posts a single generated chunk.
 *
 * This path builds the response directly instead of first allocating a
 * FinalizedChunk and then copying all of its properties into a second object.
 */
async function handleRequest(request: GenRequest): Promise<void> {
	try {
		await ensureInit(request.seed, request.wasmEnabled);

		const raw = generator!.generateChunkData(
			request.chunkX,
			request.chunkY,
			request.chunkZ,
		);

		const compressed = compressBlocks(raw.blocks);

		const message: GenSuccess = {
			id: request.id,
			kind: PendingTaskKindType.SINGLE,
			blocks: compressed.data,
			light: raw.light,
			palette: compressed.palette,
			isUniform: compressed.isUniform,
			uniformBlockId: compressed.uniformBlockId,
		};

		const blocksBuffer = message.blocks.buffer;
		const lightBuffer = message.light.buffer;

		const blocksTransferable = !(blocksBuffer instanceof SharedArrayBuffer);

		const lightTransferable = !(lightBuffer instanceof SharedArrayBuffer);

		if (blocksTransferable) {
			const blocksArrayBuffer = blocksBuffer as ArrayBuffer;

			if (lightTransferable && lightBuffer !== blocksArrayBuffer) {
				port!.postMessage(message, [
					blocksArrayBuffer,
					lightBuffer as ArrayBuffer,
				]);
			} else {
				port!.postMessage(message, [blocksArrayBuffer]);
			}
		} else if (lightTransferable) {
			port!.postMessage(message, [lightBuffer as ArrayBuffer]);
		} else {
			/*
			 * Omitting the transfer list avoids allocating an empty array when
			 * both views use shared memory.
			 */
			port!.postMessage(message);
		}
	} catch (error: unknown) {
		const message: GenError = {
			id: request.id,
			error: errorMessage(error),
		};

		port!.postMessage(message);
	}
}

/**
 * Generate and finalize one worker-owned batch.
 */
async function handleBatchRequest(request: GenBatchRequest): Promise<void> {
	try {
		await ensureInit(request.seed, request.wasmEnabled);

		const activeGenerator = generator;

		if (activeGenerator === null) {
			throw new Error("Chunk generator was not initialized");
		}

		const requestItems = request.items;
		const itemCount = requestItems.length;
		const items = new Array<FinalizedChunk>(itemCount);

		/*
		 * Preserve the supplied column/Y ordering for terrain column-cache
		 * locality.
		 */
		for (let i = 0; i < itemCount; i++) {
			const coordinate = requestItems[i];

			const raw = activeGenerator.generateChunkData(
				coordinate.chunkX,
				coordinate.chunkY,
				coordinate.chunkZ,
			);

			const compressed = compressBlocks(raw.blocks);

			items[i] = {
				blocks: compressed.data,
				light: raw.light,
				palette: compressed.palette,
				isUniform: compressed.isUniform,
				uniformBlockId: compressed.uniformBlockId,
			};
		}

		const message: GenBatchSuccess = {
			id: request.id,
			kind: PendingTaskKindType.BATCH,
			items,
		};

		const transfer = collectBatchTransferables(items);

		if (transfer.length === 0) {
			port?.postMessage(message);
		} else {
			port?.postMessage(message, transfer);
		}
	} catch (error: unknown) {
		const message: GenError = {
			id: request.id,
			error: errorMessage(error),
		};

		port?.postMessage(message);
	}
}

async function handleRelightRequest(request: RelightRequest): Promise<void> {
	try {
		if (generator === null || currentSeed !== request.seed) {
			await ensureInit(request.seed, request.wasmEnabled);
		}

		const light = generator!.relightChunk(
			request.chunkX,
			request.chunkY,
			request.chunkZ,
			request.blocks,
			request.topSunlightMask,
			request.neighborLight,
		);

		const message: RelightResult = {
			id: request.id,
			light,
		};

		const buffer = light.buffer;

		if (buffer instanceof SharedArrayBuffer) {
			/*
			 * Structured cloning preserves the SharedArrayBuffer reference.
			 */
			port!.postMessage(message);
		} else {
			port!.postMessage(message, [buffer as ArrayBuffer]);
		}
	} catch (error: unknown) {
		const message: GenError = {
			id: request.id,
			error: errorMessage(error),
		};

		port!.postMessage(message);
	}
}

function isRelightRequest(message: WorkerRequest): message is RelightRequest {
	return "blocks" in message && "chunkX" in message && !("kind" in message);
}

port.on("message", (message: WorkerRequest) => {
	if (isRelightRequest(message)) {
		void handleRelightRequest(message);
		return;
	}

	if (message.kind === PendingTaskKindType.BATCH) {
		void handleBatchRequest(message);
		return;
	}

	void handleRequest(message);
});
