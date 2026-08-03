/**
 * SIMD noise comparison test: JS backend (FastNoiseLite f64) vs wasm SIMD
 * backend (AssemblyScript f32 kernels, src/code/wasm/kernels.wasm).
 *
 * Run with: npx tsx tests/chunk-simd.test.ts
 *
 * Two passes over the exact same chunk list with the exact same seed:
 *   1. JS backend   -> benchmarks/simd-baseline.json
 *   2. wasm backend -> benchmarks/simd-after.json
 *
 * The wasm pass is skipped (exit 0, baseline still written) when
 * src/code/wasm/kernels.wasm is absent — the intended way to record the
 * pure-JS baseline before the first wasm build.
 *
 * Assertions (both passes present):
 *   - noise orthogonality: max |js - wasm| < 3e-3 over 30k samples
 *     (f32 wasm vs f64 JS; typical worst ~1.2e-3)
 *   - per chunk: air fraction within 0.5%, cave volume within 1%, block
 *     histogram per id within 1% of chunk volume
 *   - per column: top solid Y within 1 block for >= 99% of columns
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GenerationParams } from "../src/code/Generation/NoiseAndParameters/GenerationParams";
import {
	createFastNoise,
	getNoiseBackend,
	setNoiseBackend,
} from "../src/code/Generation/NoiseAndParameters/FastNoise/FastNoiseFactory";
import { setTerrainSeed } from "../src/code/Generation/TerrainHeightMap";
import { WorldGenerator } from "../src/code/Generation/WorldGenerator";
import { createWasmNoiseBackend } from "../src/code/Lib/WasmKernels";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = join(root, "src/code/wasm/kernels.wasm");

const SEED = GenerationParams.SEED;
const CS = GenerationParams.CHUNK_SIZE;
// The backend active at module load is the default JS backend.
const jsBackend = getNoiseBackend();

// Spread across biomes: surface chunks, mid-depth cave chunks, deep chunks.
const CHUNKS: Array<[number, number, number]> = [
	[0, 0, 0],
	[1, 0, 0],
	[0, 0, 1],
	[1, 0, 1],
	[2, 0, 2],
	[-1, 0, 0],
	[0, 0, -1],
	[3, 0, -2],
	[-2, 0, 3],
	[0, -1, 0],
	[1, -1, 1],
	[-1, -1, -1],
	[2, -1, -2],
	[0, -2, 0],
	[2, -2, 2],
	[-3, -2, -3],
];

interface ChunkStat {
	x: number;
	y: number;
	z: number;
	ms: number;
	airRatio: number;
	caveRatio: number;
	histogram: Record<number, number>;
	topSolidY: number[];
}

function fnv1a(data: Uint8Array): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < data.length; i++) {
		h ^= data[i];
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

let sink = 0;
function consume(out: Float32Array): void {
	for (let i = 0; i < out.length; i += 1024) sink += out[i];
}

interface PassResult {
	backend: string;
	chunks: ChunkStat[];
	totalMs: number;
	avgMsPerChunk: number;
	fill2dMs: number;
	fill3dMs: number;
	hash: string;
}

function runPass(wasmBytes: Uint8Array | null): PassResult {
	if (wasmBytes) {
		setNoiseBackend(createWasmNoiseBackend(wasmBytes));
	}
	setTerrainSeed(SEED);

	const generator = new WorldGenerator(GenerationParams);

	const chunks: ChunkStat[] = [];
	const t0 = performance.now();
	for (const [cx, cy, cz] of CHUNKS) {
		const ct0 = performance.now();
		const result = generator.generateChunkData(cx, cy, cz, {
			deferLighting: true,
			skipDecorations: true,
		});
		const ms = performance.now() - ct0;

		const volume = CS * CS * CS;
		const histogram: Record<number, number> = {};
		let air = 0;
		let cave = 0;
		// topSolidY[z*CS+x] = world Y of highest solid in that column (within chunk)
		const topSolidY = new Array<number>(CS * CS).fill(0);
		// solidBelow[z*CS+x] = true once a solid has been seen going down the column
		const solidBelow = new Array<boolean>(CS * CS).fill(false);
		const blocks = result.blocks;
		for (let z = 0; z < CS; z++) {
			for (let y = CS - 1; y >= 0; y--) {
				for (let x = 0; x < CS; x++) {
					const idx = x + y * CS + z * CS * CS;
					const id = blocks[idx];
					const col = z * CS + x;
					if (id === 0) {
						air++;
						if (solidBelow[col]) cave++;
					} else {
						histogram[id] = (histogram[id] ?? 0) + 1;
						if (!solidBelow[col]) {
							solidBelow[col] = true;
							topSolidY[col] = cy * CS + y;
						}
					}
				}
			}
		}
		chunks.push({
			x: cx,
			y: cy,
			z: cz,
			ms,
			airRatio: air / volume,
			caveRatio: cave / volume,
			histogram,
			topSolidY,
		});
	}
	const totalMs = performance.now() - t0;

	// Micro-benchmarks (4-lane noise, the actual SIMD hot path). Offsets vary
	// every iteration so neither JIT can hoist the (otherwise invariant) fill
	// out of the timed loop; inputs are consumed so nothing is eliminated.
	const fillInst2d = createFastNoise({
		seed: 1337,
		frequency: GenerationParams.CONTINENTALNESS_NOISE_SCALE,
	});
	const out2d = new Float32Array(CS * CS);
	const iters2d = 500;
	for (let i = 0; i < 50; i++) {
		fillInst2d.FillNoise2D(out2d, CS, CS, -40 + (i % 5), -40 + (i % 3) * 7);
	}
	const t2 = performance.now();
	for (let i = 0; i < iters2d; i++) {
		fillInst2d.FillNoise2D(out2d, CS, CS, -40 + (i % 5), -40 + (i % 3) * 7);
		consume(out2d);
	}
	const fill2dMs = (performance.now() - t2) / iters2d;

	const fillInst3d = createFastNoise({
		seed: 1337,
		frequency: GenerationParams.CAVE_CHEESE_FREQ,
	});
	fillInst3d.SetFractalOctaves(2);
	const out3d = new Float32Array(CS * CS * CS);
	const iters3d = 200;
	for (let i = 0; i < 20; i++) {
		fillInst3d.FillNoise3D(out3d, CS, CS, CS, -40 + (i % 7), -20, -40 + (i % 5));
	}
	const t3 = performance.now();
	for (let i = 0; i < iters3d; i++) {
		fillInst3d.FillNoise3D(out3d, CS, CS, CS, -40 + (i % 7), -20, -40 + (i % 5));
		consume(out3d);
	}
	const fill3dMs = (performance.now() - t3) / iters3d;

	// Concatenate a compact byte view of every chunk for the hash.
	const hashParts: Uint8Array[] = [];
	for (const c of chunks) {
		for (const [id, count] of Object.entries(c.histogram)) {
			const b = new Uint8Array(3);
			b[0] = Number(id);
			b[1] = count & 0xff;
			b[2] = (count >> 8) & 0xff;
			hashParts.push(b);
		}
	}
	const hashBuf = new Uint8Array(
		hashParts.reduce((n, x) => n + x.length, 0),
	);
	let offset = 0;
	for (const part of hashParts) {
		hashBuf.set(part, offset);
		offset += part.length;
	}

	return {
		backend: wasmBytes ? "wasm" : "js",
		chunks,
		totalMs,
		avgMsPerChunk: totalMs / CHUNKS.length,
		fill2dMs,
		fill3dMs,
		hash: fnv1a(hashBuf),
	};
}

function noiseOrthogonalityCheck(wasmBytes: Uint8Array): void {
	const cfgs: Array<{ freq: number; octaves: number }> = [
		{ freq: GenerationParams.CONTINENTALNESS_NOISE_SCALE, octaves: 3 },
		{ freq: GenerationParams.TEMPERATURE_NOISE_SCALE, octaves: 3 },
	];
	setNoiseBackend(jsBackend);
	const js2d = cfgs.map((c) => createFastNoise({ seed: 4242, frequency: c.freq }));
	const js3d = createFastNoise({ seed: 4242, frequency: GenerationParams.CAVE_CHEESE_FREQ });
	js3d.SetFractalOctaves(2);

	setNoiseBackend(createWasmNoiseBackend(wasmBytes));
	const wm2d = cfgs.map((c) => createFastNoise({ seed: 4242, frequency: c.freq }));
	const wm3d = createFastNoise({ seed: 4242, frequency: GenerationParams.CAVE_CHEESE_FREQ });
	wm3d.SetFractalOctaves(2);

	let worst = 0;
	let worstCfg = "";
	let worstPt = "";
	let n = 0;
	for (let i = 0; i < 100; i++) {
		for (let j = 0; j < 100; j++) {
			const x = (i - 50) * 0.7;
			const z = (j - 50) * 0.9;
			for (let c = 0; c < cfgs.length; c++) {
				const d = Math.abs(js2d[c].GetNoise2D(x, z) - wm2d[c].GetNoise2D(x, z));
				if (d > worst) {
					worst = d;
					worstCfg = `2d[${c}] freq=${cfgs[c].freq}`;
					worstPt = `(${x},${z})`;
				}
				n++;
			}
			const y = (i % 40) - 20;
			const d3 = Math.abs(js3d.GetNoise3D(x, y, z) - wm3d.GetNoise3D(x, y, z));
			if (d3 > worst) {
				worst = d3;
				worstCfg = "3d cave";
				worstPt = `(${x},${y},${z})`;
			}
			n++;
		}
	}
	console.log(
		`noise orthogonality: ${n} samples, worst |diff| = ${worst.toExponential(3)} ` +
			`(cfg=${worstCfg} @${worstPt}, threshold 3e-3)`,
	);
	if (worst >= 3e-3) {
		console.error(`FAIL: noise divergence ${worst} >= 3e-3`);
		process.exit(1);
	}
}

function compare(jsPass: PassResult, wmPass: PassResult): void {
	let failed = 0;
	const fail = (msg: string) => {
		failed++;
		console.error(`  FAIL: ${msg}`);
	};

	for (let i = 0; i < CHUNKS.length; i++) {
		const a = jsPass.chunks[i];
		const b = wmPass.chunks[i];
		const [cx, cy, cz] = CHUNKS[i];
		const vol = CS * CS * CS;

		if (Math.abs(a.airRatio - b.airRatio) > 0.005) {
			fail(`chunk (${cx},${cy},${cz}): air ratio ${a.airRatio} vs ${b.airRatio}`);
		}
		if (Math.abs(a.caveRatio - b.caveRatio) > 0.01) {
			fail(
				`chunk (${cx},${cy},${cz}): cave ratio ${a.caveRatio.toFixed(4)} vs ${b.caveRatio.toFixed(4)}`,
			);
		}

		const ids = new Set<string>([
			...Object.keys(a.histogram),
			...Object.keys(b.histogram),
		]);
		for (const id of ids) {
			const da = a.histogram[Number(id)] ?? 0;
			const db = b.histogram[Number(id)] ?? 0;
			if (Math.abs(da - db) > vol * 0.01) {
				fail(
					`chunk (${cx},${cy},${cz}): block ${id} ${da} vs ${db} ` +
						`(${((Math.abs(da - db) / vol) * 100).toFixed(2)}%)`,
				);
			}
		}

		let within = 0;
		for (let col = 0; col < a.topSolidY.length; col++) {
			if (Math.abs(a.topSolidY[col] - b.topSolidY[col]) <= 1) within++;
		}
		const ratio = within / a.topSolidY.length;
		if (ratio < 0.99) {
			fail(
				`chunk (${cx},${cy},${cz}): top-solid-Y within 1 block on ` +
					`${(ratio * 100).toFixed(1)}% of columns (needs >= 99%)`,
			);
		}
	}

	console.log(
		`fill2d 32^2: JS ${jsPass.fill2dMs.toFixed(3)}ms vs wasm ${wmPass.fill2dMs.toFixed(3)}ms — ` +
			`${(jsPass.fill2dMs / wmPass.fill2dMs).toFixed(2)}x`,
	);
	console.log(
		`fill3d 32^3: JS ${jsPass.fill3dMs.toFixed(3)}ms vs wasm ${wmPass.fill3dMs.toFixed(3)}ms — ` +
			`${(jsPass.fill3dMs / wmPass.fill3dMs).toFixed(2)}x`,
	);
	console.log(
		`chunks: JS ${jsPass.totalMs.toFixed(1)}ms vs wasm ${wmPass.totalMs.toFixed(1)}ms — ` +
			`${(wmPass.totalMs / jsPass.totalMs).toFixed(2)}x`,
	);

	if (failed > 0) {
		console.error(`\n${failed} comparison failure(s)`);
		process.exit(1);
	}
	console.log("\nall comparisons passed");
}

async function main(): Promise<void> {
	const wasmBytes = existsSync(wasmPath) ? new Uint8Array(readFileSync(wasmPath)) : null;

	// Pass 1 — JS backend (default at module load).
	const jsPass = runPass(null);

	// Pass 2 — wasm backend.
	const wmPass = wasmBytes ? runPass(wasmBytes) : null;

	// Orthogonality check needs both backends switchable within the process.
	if (wasmBytes) {
		noiseOrthogonalityCheck(wasmBytes);
	}

	const benchDir = join(root, "benchmarks");
	mkdirSync(benchDir, { recursive: true });
	const strip = (p: PassResult) => ({
		backend: p.backend,
		chunks: p.chunks.map((c) => ({
			x: c.x,
			y: c.y,
			z: c.z,
			ms: Number(c.ms.toFixed(3)),
			airRatio: Number(c.airRatio.toFixed(4)),
			caveRatio: Number(c.caveRatio.toFixed(4)),
		})),
		totalMs: Number(p.totalMs.toFixed(1)),
		avgMsPerChunk: Number(p.avgMsPerChunk.toFixed(2)),
		fill2dMs: Number(p.fill2dMs.toFixed(2)),
		fill3dMs: Number(p.fill3dMs.toFixed(2)),
		hash: p.hash,
	});
	writeFileSync(
		join(benchDir, "simd-baseline.json"),
		JSON.stringify(strip(jsPass), null, 2),
	);
	if (wmPass) {
		writeFileSync(
			join(benchDir, "simd-after.json"),
			JSON.stringify(strip(wmPass), null, 2),
		);
	}

	console.log(`JS pass: ${jsPass.totalMs.toFixed(1)}ms total (hash ${jsPass.hash})`);

	if (!wmPass) {
		console.log("kernels.wasm not found — wasm pass skipped (baseline written).");
		return;
	}

	console.log(`wasm pass: ${wmPass.totalMs.toFixed(1)}ms total (hash ${wmPass.hash})`);
	compare(jsPass, wmPass);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});