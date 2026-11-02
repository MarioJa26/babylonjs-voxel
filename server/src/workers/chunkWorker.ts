/**
 * chunkWorker.ts — Node.js worker thread for parallel chunk generation.
 *
 * Each worker owns one WorldGenerator instance. It generates terrain,
 * compresses block data, and transfers finalized buffers back without copies
 * whenever the underlying buffers are transferable ArrayBuffers.
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

type GenRequest = ChunkCoord & {
	id: number;
	seed: string;
	wasmEnabled: boolean;
	kind: PendingTaskKindType.SINGLE;
};

type GenBatchRequest = {
	id: number;
	seed: string;
	wasmEnabled: boolean;
	kind: PendingTaskKindType.BATCH;
	items: ChunkCoord[];
};

type RelightRequest = ChunkCoord & {
	id: number;
	blocks: Uint8Array | Uint16Array;
	topSunlightMask?: Uint8Array;
	neighborLight?: (Uint8Array | null)[];
	seed: string;
	wasmEnabled: boolean;
};

type WorkerRequest = GenRequest | GenBatchRequest | RelightRequest;

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

/*
 * Capture the validated port once. This avoids repeated non-null assertions
 * and optional chaining throughout hot request paths.
 */
const workerPort = port;

let generationRuntimePromise: Promise<GenerationRuntime> | null = null;
let generator: Generator | null = null;
let currentSeed = "";

let wasmRequested = false;
let wasmLoadPromise: Promise<void> | null = null;
let wasmLoadAttempted = false;
let jsBackendLogged = false;

let initPromise: Promise<void> | null = null;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function postError(id: number, error: unknown): void {
	const message: GenError = {
		id,
		error: errorMessage(error),
	};

	workerPort.postMessage(message);
}

/**
 * Loads seed-independent generation modules once per worker.
 *
 * A rejected load is removed from the cache so a later request can retry.
 */
function loadGenerationRuntime(): Promise<GenerationRuntime> {
	if (generationRuntimePromise !== null) {
		return generationRuntimePromise;
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

		await blockShapesModule.shapeInitPromise;

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

	void loading.catch(() => {
		if (generationRuntimePromise === loading) {
			generationRuntimePromise = null;
		}
	});

	return loading;
}

/**
 * Performs the worker's only WASM loading attempt.
 */
async function loadWasmBackend(): Promise<void> {
	wasmLoadAttempted = true;

	const loaded = await loadWasmNoiseFromFile();

	console.log(
		loaded
			? "[chunk-worker] WASM noise backend active"
			: "[chunk-worker] JS noise backend (WASM unavailable)",
	);
}

/**
 * Requests WASM initialization without treating an earlier JS-only request as
 * a permanent decision.
 */
function ensureWasm(wasmEnabled: boolean): Promise<void> | null {
	if (wasmEnabled) {
		wasmRequested = true;
	}

	if (!wasmRequested) {
		if (!jsBackendLogged) {
			jsBackendLogged = true;
			console.log("[chunk-worker] JS noise backend (wasm-enabled=false)");
		}

		return null;
	}

	if (wasmLoadAttempted) {
		return null;
	}

	if (wasmLoadPromise === null) {
		wasmLoadPromise = loadWasmBackend();
	}

	return wasmLoadPromise;
}

/**
 * Constructs a generator for the supplied seed.
 *
 * Runtime loading and optional WASM initialization run concurrently.
 */
async function initializeGenerator(
	seed: string,
	wasmEnabled: boolean,
): Promise<void> {
	const runtimePromise = loadGenerationRuntime();
	const wasmPromise = ensureWasm(wasmEnabled);

	const runtime =
		wasmPromise === null
			? await runtimePromise
			: (await Promise.all([runtimePromise, wasmPromise]))[0];

	setTerrainSeed(seed);

	generator = new runtime.WorldGenerator({
		...runtime.GenerationParams,
		SEED: seed,
	});

	currentSeed = seed;
}

/**
 * Serializes generator initialization and makes the fast path aware of a late
 * request to enable WASM.
 */
async function ensureInit(
	seed: string,
	wasmEnabled: boolean,
): Promise<Generator> {
	for (;;) {
		/*
		 * Check WASM before accepting the existing generator. Otherwise, a
		 * worker initialized by a JS-only request would ignore a later
		 * wasmEnabled request for the same seed.
		 */
		const wasmPromise = ensureWasm(wasmEnabled);

		if (wasmPromise !== null) {
			await wasmPromise;
		}

		const activeGenerator = generator;

		if (activeGenerator !== null && currentSeed === seed) {
			return activeGenerator;
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
		} finally {
			if (initPromise === initialization) {
				initPromise = null;
			}
		}

		const initializedGenerator = generator;

		if (initializedGenerator !== null && currentSeed === seed) {
			return initializedGenerator;
		}
	}
}

function isTransferableBuffer(buffer: ArrayBufferLike): buffer is ArrayBuffer {
	return buffer instanceof ArrayBuffer;
}

/**
 * Collects unique transferable buffers in O(n).
 */
function collectBatchTransferables(
	items: readonly FinalizedChunk[],
): ArrayBuffer[] {
	const transfer: ArrayBuffer[] = [];
	const seen = new Set<ArrayBuffer>();

	for (let i = 0; i < items.length; i++) {
		const item = items[i];

		const blocksBuffer = item.blocks.buffer;

		if (isTransferableBuffer(blocksBuffer) && !seen.has(blocksBuffer)) {
			seen.add(blocksBuffer);
			transfer.push(blocksBuffer);
		}

		const lightBuffer = item.light.buffer;

		if (isTransferableBuffer(lightBuffer) && !seen.has(lightBuffer)) {
			seen.add(lightBuffer);
			transfer.push(lightBuffer);
		}
	}

	return transfer;
}

/**
 * Posts a message with two potentially transferable typed-array buffers.
 */
function postWithBuffers(
	message: GenSuccess,
	firstBuffer: ArrayBufferLike,
	secondBuffer: ArrayBufferLike,
): void {
	const firstTransferable = isTransferableBuffer(firstBuffer);
	const secondTransferable = isTransferableBuffer(secondBuffer);

	if (firstTransferable) {
		if (secondTransferable && secondBuffer !== firstBuffer) {
			workerPort.postMessage(message, [firstBuffer, secondBuffer]);
		} else {
			workerPort.postMessage(message, [firstBuffer]);
		}

		return;
	}

	if (secondTransferable) {
		workerPort.postMessage(message, [secondBuffer]);
		return;
	}

	workerPort.postMessage(message);
}

async function handleRequest(request: GenRequest): Promise<void> {
	try {
		const activeGenerator = await ensureInit(request.seed, request.wasmEnabled);

		const raw = activeGenerator.generateChunkData(
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

		postWithBuffers(message, message.blocks.buffer, message.light.buffer);
	} catch (error: unknown) {
		postError(request.id, error);
	}
}

async function handleBatchRequest(request: GenBatchRequest): Promise<void> {
	try {
		const activeGenerator = await ensureInit(request.seed, request.wasmEnabled);

		const requestItems = request.items;
		const itemCount = requestItems.length;
		const items = new Array<FinalizedChunk>(itemCount);

		/*
		 * Preserve caller-provided ordering for terrain column-cache locality.
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
			workerPort.postMessage(message);
		} else {
			workerPort.postMessage(message, transfer);
		}
	} catch (error: unknown) {
		postError(request.id, error);
	}
}

async function handleRelightRequest(request: RelightRequest): Promise<void> {
	try {
		const activeGenerator = await ensureInit(request.seed, request.wasmEnabled);

		const light = activeGenerator.relightChunk(
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

		if (isTransferableBuffer(buffer)) {
			workerPort.postMessage(message, [buffer]);
		} else {
			workerPort.postMessage(message);
		}
	} catch (error: unknown) {
		postError(request.id, error);
	}
}

function isRelightRequest(message: WorkerRequest): message is RelightRequest {
	return !("kind" in message) && "blocks" in message;
}

workerPort.on("message", (message: WorkerRequest) => {
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
