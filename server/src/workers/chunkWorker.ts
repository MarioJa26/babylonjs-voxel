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
import { loadWasmNoiseFromFile } from "@/code/Lib/WasmNoise";
import { hashChunk } from "@/code/Network/protocol/encoder.ts";
import { compressBlocks } from "../world/ChunkCompression.ts";

type ChunkCoord = {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
};

type GenRequest = {
	id: number;
	seed: string;
	wasmEnabled: boolean;
	kind: "single";
} & ChunkCoord;

type GenBatchRequest = {
	id: number;
	seed: string;
	wasmEnabled: boolean;
	kind: "batch";
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

type GenSuccess = GenResultMessage;
type GenBatchSuccess = {
	id: number;
	kind: "batch";
	items: FinalizedChunk[];
};

type GenResultMessage = {
	id: number;
	kind: "single";
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
} | null = null;

let currentSeed = "";
let wasmInitialized = false;

async function ensureWasm(wasmEnabled: boolean): Promise<void> {
	if (wasmInitialized) return;
	wasmInitialized = true;

	if (wasmEnabled) {
		const ok = await loadWasmNoiseFromFile();
		if (ok) {
			console.log("[chunk-worker] WASM noise backend active");
		} else {
			console.log("[chunk-worker] JS noise backend (WASM unavailable)");
		}
	} else {
		console.log("[chunk-worker] JS noise backend (wasm-enabled=false)");
	}
}

async function ensureInit(seed: string, wasmEnabled: boolean): Promise<void> {
	if (generator && currentSeed === seed) return;

	// Initialize WASM backend before first WorldGenerator construction
	await ensureWasm(wasmEnabled);

	const { WorldGenerator: WG } = await import(
		"@/code/Generation/WorldGenerator"
	);
	const { GenerationParams } = await import(
		"@/code/Generation/NoiseAndParameters/GenerationParams"
	);

	const params = { ...GenerationParams, SEED: seed };
	generator = new WG(params as any);
	currentSeed = seed;
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
				kind: "single",
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
			const raws: ChunkResult[] = [];
			for (const c of req.items) {
				raws.push(generateOne(c));
			}
			const items: FinalizedChunk[] = new Array(raws.length);
			for (let i = 0; i < raws.length; i++) {
				items[i] = finalizeOne(raws[i]);
			}
			const msg: GenBatchSuccess = { id: req.id, kind: "batch", items };
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

parentPort!.on("message", (msg: GenRequest | GenBatchRequest) => {
	if (msg.kind === "batch") {
		handleBatchRequest(msg);
	} else {
		handleRequest(msg);
	}
});
