import Alea from "alea";
import { CHUNK_SHIFT } from "@/code/Lib/VoxelMath";
import { getBiomeFor } from "./Biome/Biomes";
import type { Biome } from "./Biome/BiomeTypes";
import {
	createFastNoise2D,
	createFastNoise2DWithInstance,
} from "./NoiseAndParameters/FastNoise/FastNoiseFactory";
import { FractalType } from "./NoiseAndParameters/FastNoise/FastNoiseLite";
import {
	GenerationParams,
	type GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
import { Spline } from "./NoiseAndParameters/Spline";
import { getPRNGBySeed } from "./NoiseAndParameters/Squirrel13";
import { RiverGenerator } from "./RiverGeneration";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const params: GenerationParamsType = GenerationParams;

const CHUNK_SIZE = 1 << CHUNK_SHIFT;
const CHUNK_LAST_WORLD_OFFSET = CHUNK_SIZE - 1;

const BIOME_TERRAIN_GRID = 192;
const INV_BIOME_TERRAIN_GRID = 1 / BIOME_TERRAIN_GRID;

const MAX_BIOME_CORNERS = 8192;
const MAX_CHUNK_CACHE = 4096;
const MAX_FINAL_HEIGHT_CACHE = 131072;

if ((MAX_BIOME_CORNERS & (MAX_BIOME_CORNERS - 1)) !== 0) {
	throw new Error("MAX_BIOME_CORNERS must be a power of two");
}
if ((MAX_CHUNK_CACHE & (MAX_CHUNK_CACHE - 1)) !== 0) {
	throw new Error("MAX_CHUNK_CACHE must be a power of two");
}
if ((MAX_FINAL_HEIGHT_CACHE & (MAX_FINAL_HEIGHT_CACHE - 1)) !== 0) {
	throw new Error("MAX_FINAL_HEIGHT_CACHE must be a power of two");
}

const CORNER_CACHE_MASK = MAX_BIOME_CORNERS - 1;
const CHUNK_CACHE_MASK = MAX_CHUNK_CACHE - 1;
const FHC_MASK = MAX_FINAL_HEIGHT_CACHE - 1;

function hash2(x: number, z: number, mask: number): number {
	return ((Math.imul(x, 2246822519) ^ Math.imul(z, 3266489917)) >>> 0) & mask;
}

// ---------------------------------------------------------------------------
// One-time initialization
// ---------------------------------------------------------------------------

type TerrainNoiseSet = {
	riverGenerator: RiverGenerator;
	temperature: ReturnType<typeof createFastNoise2DWithInstance>;
	humidity: ReturnType<typeof createFastNoise2DWithInstance>;
	continentalness: ReturnType<typeof createFastNoise2DWithInstance>;
	erosion: ReturnType<typeof createFastNoise2DWithInstance>;
	peaksAndValleys: ReturnType<typeof createFastNoise2DWithInstance>;
	height: ReturnType<typeof createFastNoise2D>;
};

function createTerrainNoise(seed: string): TerrainNoiseSet {
	const prng = Alea(seed);

	const temperature = createFastNoise2DWithInstance({
		seed: getPRNGBySeed(420671337, (prng() * 0xffffffff) | 0),
		fractalType: FractalType.None,
		frequency: GenerationParams.TEMPERATURE_NOISE_SCALE,
	});

	const humidity = createFastNoise2DWithInstance({
		seed: getPRNGBySeed(94120401, (prng() * 0xffffffff) | 0),
		fractalType: FractalType.None,
		frequency: GenerationParams.HUMIDITY_NOISE_SCALE,
	});

	const continentalness = createFastNoise2DWithInstance({
		seed: getPRNGBySeed(15215211, (prng() * 0xffffffff) | 0),
		fractalType: FractalType.Ridged,
		frequency: GenerationParams.CONTINENTALNESS_NOISE_SCALE,
	});

	const erosion = createFastNoise2DWithInstance({
		seed: getPRNGBySeed(39322317412, (prng() * 0xffffffff) | 0),
		frequency: GenerationParams.EROSION_NOISE_SCALE,
	});

	const peaksAndValleys = createFastNoise2DWithInstance({
		seed: getPRNGBySeed(2048, (prng() * 0xffffffff) | 0),
		frequency: GenerationParams.PV_NOISE_SCALE,
	});

	const height = createFastNoise2D({
		seed: getPRNGBySeed(491290000, (prng() * 0xffffffff) | 0),
		fractalType: FractalType.None,
		frequency: GenerationParams.TERRAIN_SCALE,
	});

	return {
		riverGenerator: new RiverGenerator({
			...GenerationParams,
			SEED: seed,
		} as GenerationParamsType),
		temperature,
		humidity,
		continentalness,
		erosion,
		peaksAndValleys,
		height,
	};
}

let _noise = createTerrainNoise(GenerationParams.SEED);

let riverGenerator = _noise.riverGenerator;
let temperatureNoise = _noise.temperature.fn;
let humidityNoise = _noise.humidity.fn;

let continentalnessNoise = _noise.continentalness.fn;
let continentalnessInst = _noise.continentalness.instance;

let erosionNoise = _noise.erosion.fn;
let erosionInst = _noise.erosion.instance;

let peaksAndValleysNoise = _noise.peaksAndValleys.fn;
let peaksAndValleysInst = _noise.peaksAndValleys.instance;

let heightNoise = _noise.height;

/**
 * Rebuild every noise instance plus the river generator from a new seed string
 * and clear sampled caches so no pre-seed values leak.
 */
export function setTerrainSeed(seed: string): void {
	_noise = createTerrainNoise(seed);

	riverGenerator = _noise.riverGenerator;
	temperatureNoise = _noise.temperature.fn;
	humidityNoise = _noise.humidity.fn;

	continentalnessNoise = _noise.continentalness.fn;
	continentalnessInst = _noise.continentalness.instance;

	erosionNoise = _noise.erosion.fn;
	erosionInst = _noise.erosion.instance;

	peaksAndValleysNoise = _noise.peaksAndValleys.fn;
	peaksAndValleysInst = _noise.peaksAndValleys.instance;

	heightNoise = _noise.height;

	cornerValid.fill(0);
	chunkCacheValid.fill(0);
	fhcValid.fill(0);
}

function applyRidged(raw: number): number {
	const num = 1 - Math.abs(raw) * 2;
	return num < 0 ? -(num * num) : num * num;
}

const continentalnessSpline = new Spline([
	{ t: -1.0, v: -150 },
	{ t: -0.8, v: -120 },
	{ t: -0.6, v: -90 },
	{ t: -0.4, v: -70 },
	{ t: -0.3, v: -60 },
	{ t: -0.25, v: -50 },
	{ t: -0.18, v: -42 },
	{ t: -0.1, v: 5 },
	{ t: 0.0, v: 15 },
	{ t: 0.1, v: 40 },
	{ t: 0.2, v: 80 },
	{ t: 0.3, v: 130 },
	{ t: 0.4, v: 200 },
	{ t: 0.5, v: 300 },
	{ t: 0.6, v: 400 },
	{ t: 0.7, v: 500 },
	{ t: 0.8, v: 550 },
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
// Biome terrain settings cache
// ---------------------------------------------------------------------------

const cornerKeyX = new Int32Array(MAX_BIOME_CORNERS);
const cornerKeyZ = new Int32Array(MAX_BIOME_CORNERS);
const cornerValid = new Uint8Array(MAX_BIOME_CORNERS);

const cornerBase = new Float32Array(MAX_BIOME_CORNERS);
const cornerAmp = new Float32Array(MAX_BIOME_CORNERS);
const cornerScale = new Float32Array(MAX_BIOME_CORNERS);
const cornerExp = new Float32Array(MAX_BIOME_CORNERS);
const cornerPvScale = new Float32Array(MAX_BIOME_CORNERS);
const cornerErosionScale = new Float32Array(MAX_BIOME_CORNERS);

// ---------------------------------------------------------------------------
// Chunk sample cache
// ---------------------------------------------------------------------------

const chunkCacheKeyX = new Int32Array(MAX_CHUNK_CACHE);
const chunkCacheKeyZ = new Int32Array(MAX_CHUNK_CACHE);
const chunkCacheValid = new Uint8Array(MAX_CHUNK_CACHE);

const ccBaseHeight = new Float32Array(MAX_CHUNK_CACHE);
const ccContinent = new Float32Array(MAX_CHUNK_CACHE);
const ccTemperature = new Float32Array(MAX_CHUNK_CACHE);
const ccHumidity = new Float32Array(MAX_CHUNK_CACHE);
const ccRiverAbs = new Float32Array(MAX_CHUNK_CACHE);
const ccBiome: (Biome | undefined)[] = new Array(MAX_CHUNK_CACHE);

function fillChunkCache(cx: number, cz: number, idx: number): void {
	const baseX = cx << CHUNK_SHIFT;
	const baseZ = cz << CHUNK_SHIFT;

	const rawContinent = continentalnessNoise(baseX, baseZ);
	const continent = applyRidged(rawContinent);
	const temperature = (temperatureNoise(baseX, baseZ) + 1) * 0.5;
	const humidity = (humidityNoise(baseX, baseZ) + 1) * 0.5;
	const riverAbs = Math.abs(riverGenerator.getRiverNoise(baseX, baseZ));

	const baseHeight =
		GenerationParams.SEA_LEVEL + continentalnessSpline.getValue(continent);

	const biome = getBiomeFor(
		temperature,
		humidity,
		continent,
		continent > 0.07 ? 1.0 : riverAbs,
		baseHeight,
	);

	chunkCacheKeyX[idx] = cx;
	chunkCacheKeyZ[idx] = cz;
	ccBaseHeight[idx] = baseHeight;
	ccContinent[idx] = continent;
	ccTemperature[idx] = temperature;
	ccHumidity[idx] = humidity;
	ccRiverAbs[idx] = riverAbs;
	ccBiome[idx] = biome;

	chunkCacheValid[idx] = 1;
}

function getChunkCacheIdx(worldX: number, worldZ: number): number {
	const cx = worldX >> CHUNK_SHIFT;
	const cz = worldZ >> CHUNK_SHIFT;
	const idx = hash2(cx, cz, CHUNK_CACHE_MASK);

	if (
		chunkCacheValid[idx] === 0 ||
		chunkCacheKeyX[idx] !== cx ||
		chunkCacheKeyZ[idx] !== cz
	) {
		fillChunkCache(cx, cz, idx);
	}

	return idx;
}

// ---------------------------------------------------------------------------
// Final height cache
// ---------------------------------------------------------------------------

const fhcKeyX = new Int32Array(MAX_FINAL_HEIGHT_CACHE);
const fhcKeyZ = new Int32Array(MAX_FINAL_HEIGHT_CACHE);
const fhcValue = new Int32Array(MAX_FINAL_HEIGHT_CACHE);
const fhcValid = new Uint8Array(MAX_FINAL_HEIGHT_CACHE);

function fhcSlot(x: number, z: number): number {
	return hash2(x, z, FHC_MASK);
}

// ---------------------------------------------------------------------------
// Biome terrain settings helpers
// ---------------------------------------------------------------------------

const biomeDefaultBase = params.TERRAIN_HEIGHT_BASE;
const biomeDefaultAmplitude = params.TERRAIN_HEIGHT_AMPLITUDE;
const biomeDefaultScale = params.TERRAIN_SCALE;

function getBiomeBase(b: Biome): number {
	return b.terrainHeightBase ?? biomeDefaultBase;
}
function getBiomeAmp(b: Biome): number {
	return b.terrainHeightAmplitude ?? biomeDefaultAmplitude;
}
function getBiomeScale(b: Biome): number {
	return b.terrainScale ?? biomeDefaultScale;
}
function getBiomeExp(b: Biome): number {
	return b.heightExponent ?? 1;
}
function getBiomePvScale(b: Biome): number {
	return b.pvNoiseScale ?? 1;
}
function getBiomeErosionScale(b: Biome): number {
	return b.erosionNoiseScale ?? 1;
}

function getCornerSlot(gx: number, gz: number): number {
	return hash2(gx, gz, CORNER_CACHE_MASK);
}

function writeCornerSlot(
	slot: number,
	gx: number,
	gz: number,
	base: number,
	amp: number,
	scale: number,
	exp: number,
	pvScale: number,
	erosionScale: number,
): void {
	cornerKeyX[slot] = gx;
	cornerKeyZ[slot] = gz;

	cornerBase[slot] = base;
	cornerAmp[slot] = amp;
	cornerScale[slot] = scale;
	cornerExp[slot] = exp;
	cornerPvScale[slot] = pvScale;
	cornerErosionScale[slot] = erosionScale;

	cornerValid[slot] = 1;
}

function writeCornerFromSignals(
	gx: number,
	gz: number,
	rawContinent: number,
	rawTemperature: number,
	rawHumidity: number,
	rawRiver: number,
): number {
	const continent = applyRidged(rawContinent);
	const temperature = (rawTemperature + 1) * 0.5;
	const humidity = (rawHumidity + 1) * 0.5;
	const riverAbs = Math.abs(rawRiver);

	const baseHeight =
		GenerationParams.SEA_LEVEL + continentalnessSpline.getValue(continent);

	const biome = getBiomeFor(
		temperature,
		humidity,
		continent,
		continent > 0.07 ? 1.0 : riverAbs,
		baseHeight,
	);

	const slot = getCornerSlot(gx, gz);

	writeCornerSlot(
		slot,
		gx,
		gz,
		getBiomeBase(biome),
		getBiomeAmp(biome),
		getBiomeScale(biome),
		getBiomeExp(biome),
		getBiomePvScale(biome),
		getBiomeErosionScale(biome),
	);

	return slot;
}

function ensureCorner(
	gx: number,
	gz: number,
	worldX: number,
	worldZ: number,
): number {
	const slot = getCornerSlot(gx, gz);

	if (
		cornerValid[slot] !== 0 &&
		cornerKeyX[slot] === gx &&
		cornerKeyZ[slot] === gz
	) {
		return slot;
	}

	return writeCornerFromSignals(
		gx,
		gz,
		continentalnessNoise(worldX, worldZ),
		temperatureNoise(worldX, worldZ),
		humidityNoise(worldX, worldZ),
		riverGenerator.getRiverNoise(worldX, worldZ),
	);
}

function shapeHeightNoise(rawNoise: number, exp: number): number {
	const n01 = (rawNoise + 1) * 0.5;

	if (n01 <= 0) return 0;
	if (n01 >= 1) return 1;

	if (exp === 1) return n01;
	if (exp === 2) return n01 * n01;
	if (exp === 0.5) return Math.sqrt(n01);

	return Math.exp(exp * Math.log(n01));
}

/**
 * Core final-height computation. All 2D noise inputs are passed in so the
 * scalar path and batch-grid path stay bit-identical.
 */
function computeFinalTerrainHeight(
	x: number,
	z: number,
	riverAbs: number,
	erosion: number,
	pv: number,
	rawContinent: number,
): number {
	const gx = Math.floor(x * INV_BIOME_TERRAIN_GRID);
	const gz = Math.floor(z * INV_BIOME_TERRAIN_GRID);
	const x0 = gx * BIOME_TERRAIN_GRID;
	const z0 = gz * BIOME_TERRAIN_GRID;

	let tx = (x - x0) * INV_BIOME_TERRAIN_GRID;
	tx = tx < 0 ? 0 : tx > 1 ? 1 : tx;
	tx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);

	let tz = (z - z0) * INV_BIOME_TERRAIN_GRID;
	tz = tz < 0 ? 0 : tz > 1 ? 1 : tz;
	tz = tz * tz * tz * (tz * (tz * 6 - 15) + 10);

	const s00 = ensureCorner(gx, gz, x0, z0);
	const s00Base = cornerBase[s00];
	const s00Amp = cornerAmp[s00];
	const s00Scale = cornerScale[s00];
	const s00Exp = cornerExp[s00];
	const s00PvScale = cornerPvScale[s00];
	const s00ErosScale = cornerErosionScale[s00];

	const s10 = ensureCorner(gx + 1, gz, x0 + BIOME_TERRAIN_GRID, z0);
	const s10Base = cornerBase[s10];
	const s10Amp = cornerAmp[s10];
	const s10Scale = cornerScale[s10];
	const s10Exp = cornerExp[s10];
	const s10PvScale = cornerPvScale[s10];
	const s10ErosScale = cornerErosionScale[s10];

	const s01 = ensureCorner(gx, gz + 1, x0, z0 + BIOME_TERRAIN_GRID);
	const s01Base = cornerBase[s01];
	const s01Amp = cornerAmp[s01];
	const s01Scale = cornerScale[s01];
	const s01Exp = cornerExp[s01];
	const s01PvScale = cornerPvScale[s01];
	const s01ErosScale = cornerErosionScale[s01];

	const s11 = ensureCorner(
		gx + 1,
		gz + 1,
		x0 + BIOME_TERRAIN_GRID,
		z0 + BIOME_TERRAIN_GRID,
	);
	const s11Base = cornerBase[s11];
	const s11Amp = cornerAmp[s11];
	const s11Scale = cornerScale[s11];
	const s11Exp = cornerExp[s11];
	const s11PvScale = cornerPvScale[s11];
	const s11ErosScale = cornerErosionScale[s11];

	const itx = 1 - tx;
	const itz = 1 - tz;

	const sBase =
		(s00Base * itx + s10Base * tx) * itz + (s01Base * itx + s11Base * tx) * tz;

	const sAmp =
		(s00Amp * itx + s10Amp * tx) * itz + (s01Amp * itx + s11Amp * tx) * tz;

	const sScale =
		(s00Scale * itx + s10Scale * tx) * itz +
		(s01Scale * itx + s11Scale * tx) * tz;

	const sExp =
		(s00Exp * itx + s10Exp * tx) * itz + (s01Exp * itx + s11Exp * tx) * tz;

	const sPvScale =
		(s00PvScale * itx + s10PvScale * tx) * itz +
		(s01PvScale * itx + s11PvScale * tx) * tz;

	const sErosScale =
		(s00ErosScale * itx + s10ErosScale * tx) * itz +
		(s01ErosScale * itx + s11ErosScale * tx) * tz;

	const shaped = shapeHeightNoise(heightNoise(x * sScale, z * sScale), sExp);
	const noiseHeight = shaped * sAmp;

	const riverFactor = riverAbs < 0.1 ? riverAbs * 10 : 1;
	const roughness = erosionSpline.getValue(erosion) * riverFactor * sErosScale;
	const detail =
		peaksAndValleysSpline.getValue(pv) * roughness * sPvScale +
		riverGenerator.getRiverDepth(riverAbs);

	const continent = applyRidged(rawContinent);
	const splineBaseHeight =
		GenerationParams.SEA_LEVEL + continentalnessSpline.getValue(continent);

	return Math.floor(splineBaseHeight + sBase + noiseHeight + detail);
}

export function getFinalTerrainHeight(x: number, z: number): number {
	const slot = fhcSlot(x, z);

	if (fhcValid[slot] !== 0 && fhcKeyX[slot] === x && fhcKeyZ[slot] === z) {
		return fhcValue[slot];
	}

	const result = computeFinalTerrainHeight(
		x,
		z,
		Math.abs(riverGenerator.getRiverNoise(x, z)),
		erosionNoise(x, z),
		peaksAndValleysNoise(x, z),
		continentalnessNoise(x, z),
	);

	fhcKeyX[slot] = x;
	fhcKeyZ[slot] = z;
	fhcValue[slot] = result;
	fhcValid[slot] = 1;

	return result;
}

// ---------------------------------------------------------------------------
// Batch 2D column prepass
// ---------------------------------------------------------------------------

export type TerrainNoiseGrid = {
	river: Float32Array;
	erosion: Float32Array;
	pv: Float32Array;
	continentalness: Float32Array;
	width: number;
	height: number;
	offsetX: number;
	offsetZ: number;
};

export function fillTerrainNoiseGrid(
	chunkWorldX: number,
	chunkWorldZ: number,
	halo: number,
	chunkSize: number,
	out: TerrainNoiseGrid,
): void {
	const width = chunkSize + halo * 2;
	const height = chunkSize + halo * 2;
	const offsetX = chunkWorldX - halo;
	const offsetZ = chunkWorldZ - halo;

	riverGenerator.fillRiverNoise2D(out.river, width, height, offsetX, offsetZ);
	erosionInst.FillNoise2D(out.erosion, width, height, offsetX, offsetZ);
	peaksAndValleysInst.FillNoise2D(out.pv, width, height, offsetX, offsetZ);
	continentalnessInst.FillNoise2D(
		out.continentalness,
		width,
		height,
		offsetX,
		offsetZ,
	);

	out.width = width;
	out.height = height;
	out.offsetX = offsetX;
	out.offsetZ = offsetZ;
}

export function getFinalTerrainHeightFromGrid(
	x: number,
	z: number,
	grid: TerrainNoiseGrid,
): number {
	const col = x - grid.offsetX;
	const row = z - grid.offsetZ;

	if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) {
		return getFinalTerrainHeight(x, z);
	}

	const slot = fhcSlot(x, z);

	if (fhcValid[slot] !== 0 && fhcKeyX[slot] === x && fhcKeyZ[slot] === z) {
		return fhcValue[slot];
	}

	const idx = col + row * grid.width;

	const result = computeFinalTerrainHeight(
		x,
		z,
		Math.abs(grid.river[idx]),
		grid.erosion[idx],
		grid.pv[idx],
		grid.continentalness[idx],
	);

	fhcKeyX[slot] = x;
	fhcKeyZ[slot] = z;
	fhcValue[slot] = result;
	fhcValid[slot] = 1;

	return result;
}

export function getBiome(x: number, z: number): Biome {
	const idx = getChunkCacheIdx(x, z);
	return ccBiome[idx]!;
}

export function getCachedRiverNoise(x: number, z: number): number {
	const idx = getChunkCacheIdx(x, z);
	return ccRiverAbs[idx];
}

// Alias kept for call-site compatibility.
export function getOctaveNoise(x: number, z: number): number {
	return getFinalTerrainHeight(x, z);
}

export function getTerrainNoiseDebug(
	x: number,
	z: number,
): {
	continent: number;
	temperature: number;
	humidity: number;
	river: number;
	erosion: number;
	pv: number;
} {
	const idx = getChunkCacheIdx(x, z);

	return {
		continent: ccContinent[idx],
		temperature: ccTemperature[idx],
		humidity: ccHumidity[idx],
		river: ccRiverAbs[idx],
		erosion: erosionNoise(x, z),
		pv: peaksAndValleysNoise(x, z),
	};
}

// ---------------------------------------------------------------------------
// Prefetch
// ---------------------------------------------------------------------------

export function prefetchChunkCorners(
	chunkWorldX: number,
	chunkWorldZ: number,
): void {
	const gx0 = Math.floor(chunkWorldX * INV_BIOME_TERRAIN_GRID);
	const gz0 = Math.floor(chunkWorldZ * INV_BIOME_TERRAIN_GRID);
	const gx1 =
		Math.floor(
			(chunkWorldX + CHUNK_LAST_WORLD_OFFSET) * INV_BIOME_TERRAIN_GRID,
		) + 1;
	const gz1 =
		Math.floor(
			(chunkWorldZ + CHUNK_LAST_WORLD_OFFSET) * INV_BIOME_TERRAIN_GRID,
		) + 1;

	for (let gz = gz0; gz <= gz1; gz++) {
		const worldZ = gz * BIOME_TERRAIN_GRID;

		for (let gx = gx0; gx <= gx1; gx++) {
			const slot = getCornerSlot(gx, gz);

			if (
				cornerValid[slot] !== 0 &&
				cornerKeyX[slot] === gx &&
				cornerKeyZ[slot] === gz
			) {
				continue;
			}

			const worldX = gx * BIOME_TERRAIN_GRID;

			writeCornerFromSignals(
				gx,
				gz,
				continentalnessNoise(worldX, worldZ),
				temperatureNoise(worldX, worldZ),
				humidityNoise(worldX, worldZ),
				riverGenerator.getRiverNoise(worldX, worldZ),
			);
		}
	}
}
