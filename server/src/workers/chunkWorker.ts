/**
 * chunkWorker.ts — Node.js worker thread for parallel chunk generation.
 *
 * Each worker owns one WorldGenerator instance. Receives single or batch
 * chunk requests, generates terrain, compresses blocks, computes the hash,
 * and posts finalized results back with zero-copy buffer transfers.
 *
 * Compression + hashing happen here so the main event loop is never blocked
 * by per-chunk CPU work, and the IPC payload is smaller.
 *
 * When wasmEnabled is true, loads the WASM SIMD noise backend before
 * constructing the WorldGenerator.
 */
import { parentPort } from "node:worker_threads";
import { setTerrainSeed } from "@/code/Generation/TerrainHeightMap";
import { loadWasmNoiseFromFile } from "@/code/Lib/WasmNoise";
import { hashChunk } from "@/code/Network/protocol/encoder.ts";
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
	blocks: Uint8Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
	hash: number;
};

type RelightRequest = {
	id: number;
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	blocks: Uint8Array;
	seed: string;
	wasmEnabled: boolean;
};

type RelightResult = {
	id: number;
	light: Uint8Array;
};

type GenResultMessage = {
	id: number;
	kind: PendingTaskKindType.SINGLE;
	blocks: Uint8Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
	hash: number;
};

type GenSuccess = GenResultMessage;

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

let generator: {
	generateChunkData: (x: number, y: number, z: number) => ChunkResult;
	relightChunk: (
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		blocks: Uint8Array,
	) => Uint8Array;
} | null = null;

let currentSeed = "";
let wasmEnabledConfig = false;
let wasmLoadPromise: Promise<void> | null = null;
let wasmLoadAttempted = false;
let jsBackendLogged = false;
let initPromise: Promise<void> | null = null;

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Load the WASM backend at most once, but do not memoize a disabled request
 * as a permanent "no WASM" decision. This preserves the ability for a later
 * wasmEnabled=true request to upgrade a worker that first handled relight or
 * startup traffic with wasmEnabled=false.
 */
async function ensureWasm(wasmEnabled: boolean): Promise<void> {
	wasmEnabledConfig = wasmEnabledConfig || wasmEnabled;

	if (!wasmEnabledConfig) {
		if (!jsBackendLogged) {
			jsBackendLogged = true;
			console.log("[chunk-worker] JS noise backend (wasm-enabled=false)");
		}
		return;
	}

	if (wasmLoadAttempted) return;

	if (!wasmLoadPromise) {
		wasmLoadPromise = (async () => {
			wasmLoadAttempted = true;

			const ok = await loadWasmNoiseFromFile();
			if (ok) {
				console.log("[chunk-worker] WASM noise backend active");
			} else {
				console.log("[chunk-worker] JS noise backend (WASM unavailable)");
			}
		})();
	}

	return wasmLoadPromise;
}

async function ensureInit(seed: string, wasmEnabled: boolean): Promise<void> {
	if (generator && currentSeed === seed) return;

	const pending = initPromise;
	if (pending) {
		await pending;
		if (generator && currentSeed === seed) return;
	}

	initPromise = (async () => {
		await ensureWasm(wasmEnabled);

		setTerrainSeed(seed);

		const { WorldGenerator: WG } = await import(
			"@/code/Generation/WorldGenerator"
		);
		const { GenerationParams } = await import(
			"@/code/Generation/NoiseAndParameters/GenerationParams"
		);

		const params = { ...GenerationParams, SEED: seed };
		generator = new WG(params as any);
		currentSeed = seed;
	})().finally(() => {
		initPromise = null;
	});

	return initPromise;
}

function pushTransferable(
	transfer: ArrayBuffer[],
	seen: Set<ArrayBuffer> | null,
	value: Uint8Array,
): Set<ArrayBuffer> | null {
	const buffer = value.buffer;

	if (buffer instanceof SharedArrayBuffer) {
		return seen;
	}

	const arrayBuffer = buffer as ArrayBuffer;

	if (transfer.length === 0) {
		transfer.push(arrayBuffer);
		return seen;
	}

	if (seen) {
		if (!seen.has(arrayBuffer)) {
			seen.add(arrayBuffer);
			transfer.push(arrayBuffer);
		}
		return seen;
	}

	for (let i = 0; i < transfer.length; i++) {
		if (transfer[i] === arrayBuffer) {
			const created = new Set<ArrayBuffer>(transfer);
			return created;
		}
	}

	transfer.push(arrayBuffer);
	return seen;
}

function collectFinalizedTransferable(
	items: readonly FinalizedChunk[],
): ArrayBuffer[] {
	const transfer: ArrayBuffer[] = [];
	let seen: Set<ArrayBuffer> | null = null;

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		seen = pushTransferable(transfer, seen, item.blocks);
		seen = pushTransferable(transfer, seen, item.light);
	}

	return transfer;
}

function collectSingleTransferable(item: FinalizedChunk): ArrayBuffer[] {
	const transfer: ArrayBuffer[] = [];
	let seen: Set<ArrayBuffer> | null = null;

	seen = pushTransferable(transfer, seen, item.blocks);
	pushTransferable(transfer, seen, item.light);

	return transfer;
}

function collectLightTransferable(light: Uint8Array): ArrayBuffer[] {
	return light.buffer instanceof SharedArrayBuffer
		? []
		: [light.buffer as ArrayBuffer];
}

function generateOne(c: ChunkCoord): ChunkResult {
	return generator!.generateChunkData(c.chunkX, c.chunkY, c.chunkZ);
}

function finalizeOne(raw: ChunkResult): FinalizedChunk {
	const compressed = compressBlocks(raw.blocks);

	return {
		blocks: compressed.data,
		light: raw.light,
		palette: compressed.palette,
		isUniform: compressed.isUniform,
		uniformBlockId: compressed.uniformBlockId,
		hash: hashChunk(compressed.data, raw.light, compressed.palette),
	};
}

async function handleRequest(req: GenRequest): Promise<void> {
	try {
		await ensureInit(req.seed, req.wasmEnabled);

		const finalized = finalizeOne(generateOne(req));
		const msg: GenSuccess = {
			id: req.id,
			kind: PendingTaskKindType.SINGLE,
			blocks: finalized.blocks,
			light: finalized.light,
			palette: finalized.palette,
			isUniform: finalized.isUniform,
			uniformBlockId: finalized.uniformBlockId,
			hash: finalized.hash,
		};

		parentPort!.postMessage(msg, collectSingleTransferable(finalized));
	} catch (err: unknown) {
		const msg: GenError = {
			id: req.id,
			error: errorMessage(err),
		};
		parentPort!.postMessage(msg);
	}
}

async function handleBatchRequest(req: GenBatchRequest): Promise<void> {
	try {
		await ensureInit(req.seed, req.wasmEnabled);

		const itemCount = req.items.length;
		const items = new Array<FinalizedChunk>(itemCount);

		// Items arrive sorted by (chunkX, chunkZ, chunkY) from the server.
		// Process them in order to maximize SurfaceGenerator.columnCache hits.
		for (let i = 0; i < itemCount; i++) {
			items[i] = finalizeOne(generateOne(req.items[i]));
		}

		const msg: GenBatchSuccess = {
			id: req.id,
			kind: PendingTaskKindType.BATCH,
			items,
		};

		parentPort!.postMessage(msg, collectFinalizedTransferable(items));
	} catch (err: unknown) {
		const msg: GenError = {
			id: req.id,
			error: errorMessage(err),
		};
		parentPort!.postMessage(msg);
	}
}

async function handleRelightRequest(req: RelightRequest): Promise<void> {
	try {
		if (!generator || currentSeed !== req.seed) {
			await ensureInit(req.seed, req.wasmEnabled);
		}

		doRelight(req);
	} catch (err: unknown) {
		const msg: GenError = {
			id: req.id,
			error: errorMessage(err),
		};
		parentPort!.postMessage(msg);
	}
}

function doRelight(req: RelightRequest): void {
	const light = generator!.relightChunk(
		req.chunkX,
		req.chunkY,
		req.chunkZ,
		req.blocks,
	);

	const msg: RelightResult = { id: req.id, light };
	parentPort!.postMessage(msg, collectLightTransferable(light));
}

function isRelightRequest(msg: WorkerRequest): msg is RelightRequest {
	return "blocks" in msg && "chunkX" in msg && !("kind" in msg);
}

parentPort!.on("message", (msg: WorkerRequest) => {
	if (isRelightRequest(msg)) {
		void handleRelightRequest(msg);
	} else if (msg.kind === PendingTaskKindType.BATCH) {
		void handleBatchRequest(msg);
	} else {
		void handleRequest(msg);
	}
});
