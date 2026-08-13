/**
 * chunkWorker.ts — Node.js worker thread for parallel chunk generation.
 *
 * Each worker owns one WorldGenerator instance. Receives single or batch
 * chunk requests, generates terrain, compresses blocks, computes the hash,
 * and posts finalized results back with zero-copy buffer transfers.
 *
 * Compression + hashing happen here (not on the main thread) so the event
 * loop is never blocked by per-chunk CPU work, and the IPC payload is
 * smaller (compressed blocks instead of raw 32768-byte arrays).
 *
 * When wasmEnabled is true, loads the WASM SIMD noise backend before
 * constructing the WorldGenerator — same backend the client uses.
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

type GenSuccess = GenResultMessage;
type GenBatchSuccess = {
	id: number;
	kind: PendingTaskKindType.BATCH;
	items: FinalizedChunk[];
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

type GenError = {
	id: number;
	error: string;
};

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

async function ensureWasm(wasmEnabled: boolean): Promise<void> {
	// Once a worker has been told a request wants WASM, it stays WASM for
	// its lifetime — relight requests must never downgrade a WASM worker to
	// the JS noise backend (which is 2-5x slower and a huge spawn stall).
	wasmEnabledConfig = wasmEnabledConfig || wasmEnabled;

	// Memoize the load so a burst of concurrent requests shares one load.
	if (wasmLoadPromise) return wasmLoadPromise;

	wasmLoadPromise = (async () => {
		if (wasmEnabledConfig) {
			const ok = await loadWasmNoiseFromFile();
			if (ok) {
				console.log("[chunk-worker] WASM noise backend active");
			} else {
				console.log("[chunk-worker] JS noise backend (WASM unavailable)");
			}
		} else {
			console.log("[chunk-worker] JS noise backend (wasm-enabled=false)");
		}
	})();

	return wasmLoadPromise;
}

let initPromise: Promise<void> | null = null;

async function ensureInit(seed: string, wasmEnabled: boolean): Promise<void> {
	if (generator && currentSeed === seed) return;

	// A relight with a different seed must re-initialize instead of racing
	// the generation task: the old code seeded with "" + no WASM, which
	// permanently downgraded the worker AND could persist wrong-seed terrain.
	const pending = initPromise;
	if (pending) {
		await pending;
		if (generator && currentSeed === seed) return;
	}

	initPromise = (async () => {
		// Initialize WASM backend before first WorldGenerator construction
		await ensureWasm(wasmEnabled);

		// Re-seed the shared TerrainHeightMap module (continentalness, temperature,
		// humidity, erosion, peaks-and-valleys noise) so that getBiome() and
		// getFinalTerrainHeight() used by SurfaceGenerator / WorldGenerator produce
		// the same results as the client.
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

/**
 * Collect transfer list for a result. Buffers allocated as SharedArrayBuffer
 * are shared (not transferable) — plain ArrayBuffers are moved zero-copy.
 */
function collectTransferable(results: ChunkResult[]): ArrayBuffer[] {
	const transfer: ArrayBuffer[] = [];
	for (const r of results) {
		if (r.blocks.buffer instanceof SharedArrayBuffer === false) {
			transfer.push(r.blocks.buffer);
		}
		if (r.light.buffer instanceof SharedArrayBuffer === false) {
			transfer.push(r.light.buffer);
		}
	}
	return transfer;
}

function generateOne(c: ChunkCoord): ChunkResult {
	const gen = generator!;
	return gen.generateChunkData(c.chunkX, c.chunkY, c.chunkZ);
}

function finalizeOne(raw: ChunkResult): FinalizedChunk {
	const compressed = compressBlocks(raw.blocks);
	const hash = hashChunk(compressed.data, raw.light, compressed.palette);
	return {
		blocks: compressed.data,
		light: raw.light,
		palette: compressed.palette,
		isUniform: compressed.isUniform,
		uniformBlockId: compressed.uniformBlockId,
		hash,
	};
}

function handleRequest(req: GenRequest): void {
	ensureInit(req.seed, req.wasmEnabled)
		.then(() => {
			const raw = generateOne(req);
			const finalized = finalizeOne(raw);
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
			parentPort!.postMessage(msg, collectTransferable([raw]));
		})
		.catch((err: unknown) => {
			const msg: GenError = {
				id: req.id,
				error: err instanceof Error ? err.message : String(err),
			};
			parentPort!.postMessage(msg);
		});
}

function handleBatchRequest(req: GenBatchRequest): void {
	ensureInit(req.seed, req.wasmEnabled)
		.then(() => {
			// Items arrive sorted by (chunkX, chunkZ, chunkY) from the server.
			// Process them in order so same-column chunks are generated
			// consecutively, maximizing hits in SurfaceGenerator.columnCache
			// (which caches per-column prepasses keyed by chunkX, chunkZ).
			const raws: ChunkResult[] = new Array(req.items.length);
			for (let i = 0; i < req.items.length; i++) {
				raws[i] = generateOne(req.items[i]);
			}
			const items: FinalizedChunk[] = new Array(raws.length);
			for (let i = 0; i < raws.length; i++) {
				items[i] = finalizeOne(raws[i]);
			}
			const msg: GenBatchSuccess = {
				id: req.id,
				kind: PendingTaskKindType.BATCH,
				items,
			};
			parentPort!.postMessage(msg, collectTransferable(raws));
		})
		.catch((err: unknown) => {
			const msg: GenError = {
				id: req.id,
				error: err instanceof Error ? err.message : String(err),
			};
			parentPort!.postMessage(msg);
		});
}

function handleRelightRequest(req: RelightRequest): void {
	// Re-init if the worker has no generator yet OR was seeded differently
	// (relight must not clobber the generation seed or downgrade to JS noise).
	if (!generator || currentSeed !== req.seed) {
		ensureInit(req.seed, req.wasmEnabled)
			.then(() => doRelight(req))
			.catch((err: unknown) => {
				console.error("[chunk-worker] relight init failed:", err);
			});
	} else {
		doRelight(req);
	}
}

function doRelight(req: RelightRequest): void {
	const gen = generator!;
	const light = gen.relightChunk(
		req.chunkX,
		req.chunkY,
		req.chunkZ,
		req.blocks,
	);
	const msg: RelightResult = { id: req.id, light };
	const transfer: ArrayBuffer[] =
		light.buffer instanceof SharedArrayBuffer
			? []
			: [light.buffer as ArrayBuffer];
	parentPort!.postMessage(msg, transfer);
}

parentPort!.on(
	"message",
	(msg: GenRequest | GenBatchRequest | RelightRequest) => {
		if ("blocks" in msg && "chunkX" in msg && !("kind" in msg)) {
			handleRelightRequest(msg as RelightRequest);
		} else if ((msg as GenBatchRequest).kind === PendingTaskKindType.BATCH) {
			handleBatchRequest(msg as GenBatchRequest);
		} else {
			handleRequest(msg as GenRequest);
		}
	},
);
