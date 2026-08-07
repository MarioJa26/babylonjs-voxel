/**
 * chunkWorker.ts — Node.js worker thread for parallel chunk generation.
 *
 * Each worker owns one WorldGenerator instance. Receives chunk requests,
 * generates terrain, and posts results back with zero-copy buffer transfers.
 */
import { parentPort } from "node:worker_threads";

type GenRequest = {
	id: number;
	seed: string;
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

async function ensureInit(seed: string): Promise<void> {
	if (generator && currentSeed === seed) return;

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
	ensureInit(req.seed)
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
