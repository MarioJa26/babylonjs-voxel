import Alea from "alea";
import { getBiomeFor } from "./Biome/Biomes";
import type { Biome } from "./Biome/BiomeTypes";
import { BIOME_ID } from "./Biome/BiomeTypes";
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
// Small hot-path LRU cache
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
			this.map.delete(this.map.keys().next().value!);
		}
		this.map.set(key, value);
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const params: GenerationParamsType = GenerationParams;

const CHUNK_SHIFT = 5; // 32×32 chunks
const MAX_CHUNKS = 4096;

// Wider grid = fewer corner cache misses, imperceptible difference at this scale
const BIOME_TERRAIN_GRID = 192;
const INV_BIOME_TERRAIN_GRID = 1 / BIOME_TERRAIN_GRID;

const MAX_BIOME_CORNERS = 8192;

const encodeChunkKey = (cx: number, cz: number): number =>
	(((cx & 0xffff) << 16) | (cz & 0xffff)) >>> 0;

const encodeCornerKey = (gx: number, gz: number): number =>
	(((gx & 0xffff) << 16) | (gz & 0xffff)) >>> 0;

// ---------------------------------------------------------------------------
// One-time initialization
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

// Dedicated height noise — cheap FBm, separate from continentalness.
// With octaves=1 this is just a single simplex sample per block.
const heightNoise = createFastNoise2D({
	seed: Squirrel3.get(6, (prng() * 0xffffffff) | 0),
	fractalType: FractalType.None,
	frequency: GenerationParams.TERRAIN_SCALE,
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
// Caches
// ---------------------------------------------------------------------------

const chunkCache = new LRUCache<number, ChunkTerrainSample>(MAX_CHUNKS);

// Biome-corner settings — 5 scalars per corner (dropped octaves/persistence/lacunarity
// since octaves=1 makes them irrelevant).
// Layout: [base, amplitude, scale, exponent, isOcean]
// isOcean stored as 0/1 float so we can read it without a separate cache lookup.
const SETTINGS_STRIDE = 4;
const biomeCornerCache = new LRUCache<number, Float64Array>(MAX_BIOME_CORNERS);

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
	const riverAbs = Math.abs(riverGenerator.getRiverNoise(x, z));
	const settings = getBlendedBiomeTerrainSettings(x, z);
	const baseHeight = computeHeightFromSettings(x, z, settings);
	const detail = computeDetail(x, z, riverAbs);
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
// Detail (cheap, per-block)
// ---------------------------------------------------------------------------

function computeDetail(x: number, z: number, riverAbs: number): number {
	const erosion = erosionNoise(x, z);
	const pv = peaksAndValleysNoise(x, z);

	const riverFactor = riverAbs < 0.1 ? riverAbs * 10 : 1;
	const roughness = erosionSpline.getValue(erosion) * riverFactor;
	const detail = peaksAndValleysSpline.getValue(pv) * roughness;
	const riverDepth = riverGenerator.getRiverDepth(riverAbs);

	return detail + riverDepth;
}

// ---------------------------------------------------------------------------
// Biome terrain settings — pooled Float64Array, zero GC on the hot path
// Layout: [base, amplitude, scale, exponent, isOcean]
// ---------------------------------------------------------------------------

function fillBiomeTerrainSettings(biome: Biome, out: Float64Array): void {
	const b = biome as unknown as Record<string, unknown>;

	out[0] =
		typeof b.terrainHeightBase === "number"
			? b.terrainHeightBase
			: params.TERRAIN_HEIGHT_BASE;
	out[1] =
		typeof b.terrainHeightAmplitude === "number"
			? b.terrainHeightAmplitude
			: params.TERRAIN_HEIGHT_AMPLITUDE;
	out[2] =
		typeof b.terrainScale === "number" ? b.terrainScale : params.TERRAIN_SCALE;
	out[3] = typeof b.heightExponent === "number" ? b.heightExponent : 1;
}

// Scratch arrays — module-level singletons, never allocated on the hot path.
const _s00 = new Float64Array(SETTINGS_STRIDE);
const _s10 = new Float64Array(SETTINGS_STRIDE);
const _s01 = new Float64Array(SETTINGS_STRIDE);
const _s11 = new Float64Array(SETTINGS_STRIDE);
const _out = new Float64Array(SETTINGS_STRIDE);

function getBlendedBiomeTerrainSettings(x: number, z: number): Float64Array {
	const gx = Math.floor(x * INV_BIOME_TERRAIN_GRID);
	const gz = Math.floor(z * INV_BIOME_TERRAIN_GRID);

	const x0 = gx * BIOME_TERRAIN_GRID;
	const z0 = gz * BIOME_TERRAIN_GRID;
	const x1 = x0 + BIOME_TERRAIN_GRID;
	const z1 = z0 + BIOME_TERRAIN_GRID;

	// Smootherstep inline
	let tx = (x - x0) * INV_BIOME_TERRAIN_GRID;
	tx = tx < 0 ? 0 : tx > 1 ? 1 : tx;
	tx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);

	let tz = (z - z0) * INV_BIOME_TERRAIN_GRID;
	tz = tz < 0 ? 0 : tz > 1 ? 1 : tz;
	tz = tz * tz * tz * (tz * (tz * 6 - 15) + 10);

	fillCorner(gx, gz, x0, z0, _s00);
	fillCorner(gx + 1, gz, x1, z0, _s10);
	fillCorner(gx, gz + 1, x0, z1, _s01);
	fillCorner(gx + 1, gz + 1, x1, z1, _s11);

	// Bilinear blend — unrolled for the 5-element stride, no inner loop overhead
	const itx = 1 - tx;
	const itz = 1 - tz;

	_out[0] =
		(_s00[0] * itx + _s10[0] * tx) * itz + (_s01[0] * itx + _s11[0] * tx) * tz;
	_out[1] =
		(_s00[1] * itx + _s10[1] * tx) * itz + (_s01[1] * itx + _s11[1] * tx) * tz;
	_out[2] =
		(_s00[2] * itx + _s10[2] * tx) * itz + (_s01[2] * itx + _s11[2] * tx) * tz;
	_out[3] =
		(_s00[3] * itx + _s10[3] * tx) * itz + (_s01[3] * itx + _s11[3] * tx) * tz;

	return _out;
}

function fillCorner(
	gx: number,
	gz: number,
	worldX: number,
	worldZ: number,
	out: Float64Array,
): void {
	const key = encodeCornerKey(gx, gz);
	const cached = biomeCornerCache.get(key);

	if (cached) {
		out.set(cached);
		return;
	}

	const continent = continentalnessNoise(worldX, worldZ);
	const temperature = (temperatureNoise(worldX, worldZ) + 1) * 0.5;
	const humidity = (humidityNoise(worldX, worldZ) + 1) * 0.5;
	const riverAbs = Math.abs(riverGenerator.getRiverNoise(worldX, worldZ));
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

	fillBiomeTerrainSettings(biome, out);
	biomeCornerCache.set(key, new Float64Array(out));
}

// ---------------------------------------------------------------------------
// Height from blended settings
// Layout: [base, amplitude, scale, exponent, isOcean]
//
// With octaves=1 the entire accumulation loop collapses to a single noise
// sample — no amplitude/frequency tracking needed at all.
// ---------------------------------------------------------------------------

function computeHeightFromSettings(
	x: number,
	z: number,
	s: Float64Array,
): number {
	const noise = heightNoise(x * s[2], z * s[2]);

	// normalize01 inline
	let n01 = (noise + 1) * 0.5;
	n01 = n01 < 0 ? 0 : n01 > 1 ? 1 : n01;

	const shaped = s[3] === 1 ? n01 : n01 ** s[3];

	return s[0] + shaped * s[1]; // base + shaped * amplitude
}
