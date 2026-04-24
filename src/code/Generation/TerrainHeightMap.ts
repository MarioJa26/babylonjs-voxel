import Alea from "alea";
import { getBiomeFor } from "./Biome/Biomes";
import type { Biome } from "./Biome/BiomeTypes";
import { createFastNoise2D } from "./NoiseAndParameters/FastNoise/FastNoiseFactory";
import { FractalType } from "./NoiseAndParameters/FastNoise/FastNoiseLite";
import {
	GenerationParams,
	type GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
import { Spline } from "./NoiseAndParameters/Spline";
import { Squirrel3 } from "./NoiseAndParameters/Squirrel13";
import { RiverGenerator } from "./RiverGeneration";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChunkTerrainSample = {
	baseHeight: number;
	continent: number;
	temperature: number;
	humidity: number;
	riverAbs: number;
	biome: Biome;
};

// ---------------------------------------------------------------------------
// Small hot‑path LRU cache
// ---------------------------------------------------------------------------

class LRUCache<K, V> {
	private map = new Map<K, V>();
	constructor(private readonly maxSize: number) {}

	get(key: K): V | undefined {
		const value = this.map.get(key);
		if (value !== undefined) {
			this.map.delete(key);
			this.map.set(key, value);
		}
		return value;
	}

	set(key: K, value: V): void {
		if (this.map.has(key)) {
			this.map.delete(key);
		} else if (this.map.size >= this.maxSize) {
			const firstKey = this.map.keys().next().value;
			this.map.delete(firstKey!);
		}
		this.map.set(key, value);
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const params: GenerationParamsType = GenerationParams;

const CHUNK_SHIFT = 4; // 16×16 chunks
const MAX_CHUNKS = 4096;

const encodeChunkKey = (cx: number, cz: number): number =>
	(((cx & 0xffff) << 16) | (cz & 0xffff)) >>> 0;

// ---------------------------------------------------------------------------
// One‑time initialization
// ---------------------------------------------------------------------------

const riverGenerator = new RiverGenerator(params);
const prng = Alea(params.SEED);

const temperatureNoise = createFastNoise2D({
	seed: Squirrel3.get(1, (prng() * 0xffffffff) | 0),
	fractalType: FractalType.None,
	frequency: GenerationParams.TEMPERATURE_NOISE_SCALE,
});

const humidityNoise = createFastNoise2D({
	seed: Squirrel3.get(2, (prng() * 0xffffffff) | 0),
	fractalType: FractalType.None,
	frequency: GenerationParams.HUMIDITY_NOISE_SCALE,
});

const continentalnessNoise = createFastNoise2D({
	seed: Squirrel3.get(3, (prng() * 0xffffffff) | 0),
	fractalType: FractalType.Ridged,
	frequency: GenerationParams.CONTINENTALNESS_NOISE_SCALE,
});

const erosionNoise = createFastNoise2D({
	seed: Squirrel3.get(4, (prng() * 0xffffffff) | 0),
	frequency: GenerationParams.EROSION_NOISE_SCALE,
});

const peaksAndValleysNoise = createFastNoise2D({
	seed: Squirrel3.get(5, (prng() * 0xffffffff) | 0),
	frequency: GenerationParams.PV_NOISE_SCALE,
});

const continentalnessSpline = new Spline([
	{ t: -0.995, v: -90 },
	{ t: -0.366, v: -74 },
	{ t: -0.315, v: -70 },
	{ t: -0.294, v: -62 },
	{ t: -0.238, v: -51 },
	{ t: -0.195, v: -11 },
	{ t: -0.179, v: 0 },
	{ t: -0.113, v: 1 },
	{ t: -0.051, v: 33 },
	{ t: -0.029, v: 43 },
	{ t: 0.088, v: 43 },
	{ t: 0.116, v: 81 },
	{ t: 0.17, v: 143 },
	{ t: 0.246, v: 170 },
	{ t: 0.374, v: 230 },
	{ t: 0.435, v: 296 },
	{ t: 0.513, v: 318 },
	{ t: 0.578, v: 321 },
	{ t: 0.704, v: 391 },
	{ t: 0.738, v: 429 },
	{ t: 0.771, v: 458 },
	{ t: 0.822, v: 492 },
	{ t: 0.924, v: 550 },
	{ t: 0.968, v: 560 },
	{ t: 0.988, v: 560 },
	{ t: 1.0, v: 562 },
]);

const erosionSpline = new Spline([
	{ t: -1.0, v: 11.0 },
	{ t: -0.8, v: 0.8 },
	{ t: -0.5, v: 0.6 },
	{ t: 0.0, v: 0.4 },
	{ t: 0.5, v: 0.2 },
	{ t: 0.8, v: 0.1 },
	{ t: 1.0, v: 0 },
]);

const peaksAndValleysSpline = new Spline([
	{ t: -1.0, v: -60 },
	{ t: -0.6, v: -25 },
	{ t: -0.2, v: -15 },
	{ t: 0.2, v: 15 },
	{ t: 0.5, v: 30 },
	{ t: 0.8, v: 60 },
	{ t: 1.0, v: 80 },
]);

// ---------------------------------------------------------------------------
// Chunk cache
// ---------------------------------------------------------------------------

const chunkCache = new LRUCache<number, ChunkTerrainSample>(MAX_CHUNKS);

// ---------------------------------------------------------------------------
// Chunk sampling (heavy work ONCE per chunk)
// ---------------------------------------------------------------------------

function getChunkSample(worldX: number, worldZ: number): ChunkTerrainSample {
	const cx = worldX >> CHUNK_SHIFT;
	const cz = worldZ >> CHUNK_SHIFT;
	const key = encodeChunkKey(cx, cz);

	const cached = chunkCache.get(key);
	if (cached) return cached;

	const baseX = cx << CHUNK_SHIFT;
	const baseZ = cz << CHUNK_SHIFT;

	const continent = continentalnessNoise(baseX, baseZ);
	const temperature = (temperatureNoise(baseX, baseZ) + 1) * 0.5;
	const humidity = (humidityNoise(baseX, baseZ) + 1) * 0.5;

	const riverAbs = Math.abs(riverGenerator.getRiverNoise(baseX, baseZ));

	const baseHeight =
		GenerationParams.SEA_LEVEL + continentalnessSpline.getValue(continent);

	const effectiveRiver = continent > 0.07 ? 1.0 : riverAbs;

	const biome = getBiomeFor(
		temperature,
		humidity,
		continent,
		effectiveRiver,
		baseHeight,
	);

	const sample: ChunkTerrainSample = {
		baseHeight,
		continent,
		temperature,
		humidity,
		riverAbs,
		biome,
	};

	chunkCache.set(key, sample);
	return sample;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getFinalTerrainHeight(x: number, z: number): number {
	const continent = continentalnessNoise(x, z);

	const baseHeight =
		GenerationParams.SEA_LEVEL + continentalnessSpline.getValue(continent);

	const riverAbs = Math.abs(riverGenerator.getRiverNoise(x, z));

	const detail = computeDetail(x, z, baseHeight, riverAbs);

	return Math.floor(baseHeight + detail);
}

export function getBiome(x: number, z: number): Biome {
	return getChunkSample(x, z).biome;
}

export function getCachedRiverNoise(x: number, z: number): number {
	return getChunkSample(x, z).riverAbs;
}

export function getOctaveNoise(x: number, z: number): number {
	return getFinalTerrainHeight(x, z);
}

// ---------------------------------------------------------------------------
// Detail (cheap, per‑block)
// ---------------------------------------------------------------------------

function computeDetail(
	x: number,
	z: number,
	baseHeight: number,
	riverAbs: number,
): number {
	const erosion = erosionNoise(x, z);
	const pv = peaksAndValleysNoise(x, z);

	const riverFactor = riverAbs < 0.1 ? riverAbs * 10 : 1;

	const roughness = erosionSpline.getValue(erosion) * riverFactor;

	const detail = peaksAndValleysSpline.getValue(pv) * roughness;

	const riverDepth = riverGenerator.getRiverDepth(riverAbs);

	return detail + riverDepth;
}
