/**
 * chunkWorker.ts — Node.js worker thread for parallel chunk generation.
 *
 * Each worker owns one WorldGenerator instance. Receives chunk requests,
 * generates terrain, and posts results back with zero-copy buffer transfers.
 *
 * When wasmEnabled is true, loads the WASM SIMD noise backend before
 * constructing the WorldGenerator — same backend the client uses.
 */
import { parentPort } from "node:worker_threads";
import { loadWasmNoiseFromFile } from "@/code/Lib/WasmNoise";

type GenRequest = {
	id: number;
	seed: string;
	wasmEnabled: boolean;
	chunkX: number;
	chunkY: number;
	chunkZ: number;
};

type GenSuccess = {
	id: number;
	blocks: Uint8Array;
	light: Uint8Array;
};

type GenError = {
	id: number;
	error: string;
};

let generator: {
	generateChunkData: (
		x: number,
		y: number,
		z: number,
	) => { blocks: Uint8Array; light: Uint8Array };
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

function handleRequest(req: GenRequest): void {
	ensureInit(req.seed, req.wasmEnabled)
		.then(() => {
			const gen = generator!;
			const result = gen.generateChunkData(req.chunkX, req.chunkY, req.chunkZ);

			const blocksCopy = new Uint8Array(result.blocks);
			const lightCopy = new Uint8Array(result.light);

			const msg: GenSuccess = {
				id: req.id,
				blocks: blocksCopy,
				light: lightCopy,
			};

			parentPort!.postMessage(msg, [blocksCopy.buffer, lightCopy.buffer]);
		})
		.catch((err: unknown) => {
			const msg: GenError = {
				id: req.id,
				error: err instanceof Error ? err.message : String(err),
			};
			parentPort!.postMessage(msg);
		});
}

parentPort!.on("message", (msg: GenRequest) => {
	handleRequest(msg);
});
