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

let generator: Generator | null = null;
let currentSeed = "";

let wasmEnabledConfig = false;
let wasmLoadPromise: Promise<void> | null = null;
let wasmLoadAttempted = false;
let jsBackendLogged = false;

let initPromise: Promise<void> | null = null;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
 * Constructs a generator for the supplied seed.
 *
 * Dynamic imports remain intentional because they defer loading the generation
 * stack until the worker receives its first request.
 */
async function initializeGenerator(
	seed: string,
	wasmEnabled: boolean,
): Promise<void> {
	await ensureWasm(wasmEnabled);

	setTerrainSeed(seed);

	const [
		worldGeneratorModule,
		generationParamsModule,
		faceMasksModule,
		lightGeneratorModule,
		blockShapesModule,
	] = await Promise.all([
		import("@/code/Generation/WorldGenerator"),
		import("@/code/Generation/NoiseAndParameters/GenerationParams"),
		import("@/code/World/Chunk/ChunkFaceMasks"),
		import("@/code/Generation/LightGenerator"),
		import("@/code/World/Shape/BlockShapes"),
	]);

	/*
	 * Shape-aware lighting depends on the asynchronous shape registry.
	 * Waiting here preserves the original lighting behavior.
	 */
	await blockShapesModule.shapeInitPromise;

	lightGeneratorModule.LightGenerator.setClosedFaceMaskLUT(
		faceMasksModule.precomputeClosedFaceMasks(),
	);

	/*
	 * This object copy is retained intentionally. Mutating GenerationParams
	 * directly could leak the seed into other module consumers.
	 */
	const params = {
		...generationParamsModule.GenerationParams,
		SEED: seed,
	};

	generator = new worldGeneratorModule.WorldGenerator(params as any);
	currentSeed = seed;
}

/**
 * Ensures generator initialization remains serialized.
 *
 * A request for a different seed waits for the current initialization and then
 * performs its own initialization, matching the original behavior.
 */
async function ensureInit(seed: string, wasmEnabled: boolean): Promise<void> {
	if (generator !== null && currentSeed === seed) {
		return;
	}

	const pending = initPromise;

	if (pending !== null) {
		await pending;

		if (generator !== null && currentSeed === seed) {
			return;
		}
	}

	const initialization = initializeGenerator(seed, wasmEnabled);
	initPromise = initialization;

	try {
		await initialization;
	} finally {
		/*
		 * Do not clear a newer initialization if overlapping requests started
		 * another one after this promise completed.
		 */
		if (initPromise === initialization) {
			initPromise = null;
		}
	}
}

function finalizeOne(raw: ChunkResult): FinalizedChunk {
	const compressed = compressBlocks(raw.blocks);

	return {
		blocks: compressed.data,
		light: raw.light,
		palette: compressed.palette,
		isUniform: compressed.isUniform,
		uniformBlockId: compressed.uniformBlockId,
	};
}

/**
 * Adds a non-shared ArrayBuffer to a transfer list.
 *
 * A Set is allocated only when the first duplicate is actually encountered.
 * Most batches have unique buffers and therefore avoid the Set entirely.
 */
function pushTransferable(
	transfer: ArrayBuffer[],
	seen: Set<ArrayBuffer> | null,
	value: Uint8Array | Uint16Array,
): Set<ArrayBuffer> | null {
	const buffer = value.buffer;

	if (buffer instanceof SharedArrayBuffer) {
		return seen;
	}

	const arrayBuffer = buffer as ArrayBuffer;

	if (seen !== null) {
		if (!seen.has(arrayBuffer)) {
			seen.add(arrayBuffer);
			transfer.push(arrayBuffer);
		}

		return seen;
	}

	for (let i = 0; i < transfer.length; i++) {
		if (transfer[i] === arrayBuffer) {
			/*
			 * The duplicate is already present. Constructing from transfer also
			 * seeds the Set with every previously collected buffer.
			 */
			return new Set(transfer);
		}
	}

	transfer.push(arrayBuffer);
	return null;
}

function collectBatchTransferables(
	items: readonly FinalizedChunk[],
): ArrayBuffer[] {
	/*
	 * Each item contributes at most two buffers. Preallocating with length would
	 * create invalid empty entries, so normal push growth is used here.
	 */
	const transfer: ArrayBuffer[] = [];
	let seen: Set<ArrayBuffer> | null = null;

	for (let i = 0; i < items.length; i++) {
		const item = items[i];

		seen = pushTransferable(transfer, seen, item.blocks);
		seen = pushTransferable(transfer, seen, item.light);
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

async function handleBatchRequest(request: GenBatchRequest): Promise<void> {
	try {
		await ensureInit(request.seed, request.wasmEnabled);

		const requestItems = request.items;
		const itemCount = requestItems.length;
		const items = new Array<FinalizedChunk>(itemCount);
		const activeGenerator = generator!;

		/*
		 * Items arrive sorted by column and Y level. Process them in order to
		 * retain SurfaceGenerator.columnCache locality.
		 */
		for (let i = 0; i < itemCount; i++) {
			const coord = requestItems[i];

			const raw = activeGenerator.generateChunkData(
				coord.chunkX,
				coord.chunkY,
				coord.chunkZ,
			);

			items[i] = finalizeOne(raw);
		}

		const message: GenBatchSuccess = {
			id: request.id,
			kind: PendingTaskKindType.BATCH,
			items,
		};

		const transfer = collectBatchTransferables(items);

		if (transfer.length === 0) {
			/*
			 * Avoid passing an allocated empty list when every result uses
			 * SharedArrayBuffer storage.
			 */
			port!.postMessage(message);
		} else {
			port!.postMessage(message, transfer);
		}
	} catch (error: unknown) {
		const message: GenError = {
			id: request.id,
			error: errorMessage(error),
		};

		port!.postMessage(message);
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
