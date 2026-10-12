import Alea from "alea";
import { CHUNK_SHIFT, CHUNK_SIZE } from "@/code/Lib/VoxelMath";
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
type BiomeTerrainCell = {
	gx: number;
	gz: number;

	base00: number;
	base10: number;
	base01: number;
	base11: number;

	amp00: number;
	amp10: number;
	amp01: number;
	amp11: number;

	scale00: number;
	scale10: number;
	scale01: number;
	scale11: number;

	exp00: number;
	exp10: number;
	exp01: number;
	exp11: number;

	pvScale00: number;
	pvScale10: number;
	pvScale01: number;
	pvScale11: number;

	erosionScale00: number;
	erosionScale10: number;
	erosionScale01: number;
	erosionScale11: number;
};

const cachedBiomeTerrainCell: BiomeTerrainCell = {
	gx: Number.NaN,
	gz: Number.NaN,

	base00: 0,
	base10: 0,
	base01: 0,
	base11: 0,

	amp00: 0,
	amp10: 0,
	amp01: 0,
	amp11: 0,

	scale00: 0,
	scale10: 0,
	scale01: 0,
	scale11: 0,

	exp00: 0,
	exp10: 0,
	exp01: 0,
	exp11: 0,

	pvScale00: 0,
	pvScale10: 0,
	pvScale01: 0,
	pvScale11: 0,

	erosionScale00: 0,
	erosionScale10: 0,
	erosionScale01: 0,
	erosionScale11: 0,
};

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

	cachedBiomeTerrainCell.gx = Number.NaN;
	cachedBiomeTerrainCell.gz = Number.NaN;
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
function loadBiomeTerrainCell(
	gx: number,
	gz: number,
	x0: number,
	z0: number,
): BiomeTerrainCell {
	const cell = cachedBiomeTerrainCell;

	if (cell.gx === gx && cell.gz === gz) {
		return cell;
	}

	/*
	 * Copy each corner immediately after ensureCorner().
	 *
	 * The underlying cache is direct-mapped, so a later ensureCorner call
	 * could theoretically overwrite an earlier slot after a hash collision.
	 */
	const s00 = ensureCorner(gx, gz, x0, z0);

	cell.base00 = cornerBase[s00];
	cell.amp00 = cornerAmp[s00];
	cell.scale00 = cornerScale[s00];
	cell.exp00 = cornerExp[s00];
	cell.pvScale00 = cornerPvScale[s00];
	cell.erosionScale00 = cornerErosionScale[s00];

	const s10 = ensureCorner(gx + 1, gz, x0 + BIOME_TERRAIN_GRID, z0);

	cell.base10 = cornerBase[s10];
	cell.amp10 = cornerAmp[s10];
	cell.scale10 = cornerScale[s10];
	cell.exp10 = cornerExp[s10];
	cell.pvScale10 = cornerPvScale[s10];
	cell.erosionScale10 = cornerErosionScale[s10];

	const s01 = ensureCorner(gx, gz + 1, x0, z0 + BIOME_TERRAIN_GRID);

	cell.base01 = cornerBase[s01];
	cell.amp01 = cornerAmp[s01];
	cell.scale01 = cornerScale[s01];
	cell.exp01 = cornerExp[s01];
	cell.pvScale01 = cornerPvScale[s01];
	cell.erosionScale01 = cornerErosionScale[s01];

	const s11 = ensureCorner(
		gx + 1,
		gz + 1,
		x0 + BIOME_TERRAIN_GRID,
		z0 + BIOME_TERRAIN_GRID,
	);

	cell.base11 = cornerBase[s11];
	cell.amp11 = cornerAmp[s11];
	cell.scale11 = cornerScale[s11];
	cell.exp11 = cornerExp[s11];
	cell.pvScale11 = cornerPvScale[s11];
	cell.erosionScale11 = cornerErosionScale[s11];

	/*
	 * Publish the key only after all values have been populated, keeping the
	 * cache valid if corner generation throws.
	 */
	cell.gx = gx;
	cell.gz = gz;

	return cell;
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

	const cell = loadBiomeTerrainCell(gx, gz, x0, z0);

	const itx = 1 - tx;
	const itz = 1 - tz;

	/*
	 * Keep the original interpolation expression and operation order. Using
	 * precomputed four-corner weights would require fewer operations, but can
	 * change floating-point rounding near integer height boundaries.
	 */
	const sBase =
		(cell.base00 * itx + cell.base10 * tx) * itz +
		(cell.base01 * itx + cell.base11 * tx) * tz;

	const sAmp =
		(cell.amp00 * itx + cell.amp10 * tx) * itz +
		(cell.amp01 * itx + cell.amp11 * tx) * tz;

	const sScale =
		(cell.scale00 * itx + cell.scale10 * tx) * itz +
		(cell.scale01 * itx + cell.scale11 * tx) * tz;

	const sExp =
		(cell.exp00 * itx + cell.exp10 * tx) * itz +
		(cell.exp01 * itx + cell.exp11 * tx) * tz;

	const sPvScale =
		(cell.pvScale00 * itx + cell.pvScale10 * tx) * itz +
		(cell.pvScale01 * itx + cell.pvScale11 * tx) * tz;

	const sErosionScale =
		(cell.erosionScale00 * itx + cell.erosionScale10 * tx) * itz +
		(cell.erosionScale01 * itx + cell.erosionScale11 * tx) * tz;

	const shapedNoise = shapeHeightNoise(
		heightNoise(x * sScale, z * sScale),
		sExp,
	);

	const noiseHeight = shapedNoise * sAmp;
	const riverFactor = riverAbs < 0.1 ? riverAbs * 10 : 1;

	const roughness =
		erosionSpline.getValue(erosion) * riverFactor * sErosionScale;

	const detail =
		peaksAndValleysSpline.getValue(pv) * roughness * sPvScale +
		riverGenerator.getRiverDepth(riverAbs);

	const continent = applyRidged(rawContinent);

	const splineBaseHeight =
		GenerationParams.SEA_LEVEL + continentalnessSpline.getValue(continent);

	return Math.floor(splineBaseHeight + sBase + noiseHeight + detail);
}

/**
 * Effective column top (exclusive: first chunk fully above the surface) for
 * the streaming allocation guard. Pure function of terrain height, headless-
 * importable for unit tests.
 *
 * The heightmap reports SOLID height (seabed in ocean), but water fills every
 * column up to SEA_LEVEL. Without the water term, deep columns (seabed below
 * y=0) fail the `y > top+1` guard for the y=1 surface-water chunk (32..63,
 * contains the water surface) — deep-ocean water never loads. In a trench
 * even the y=0 water chunk is dropped.
 */
export function effectiveColumnTopChunkY(terrainHeight: number): number {
	const solidTop = Math.ceil(terrainHeight / CHUNK_SIZE);
	if (terrainHeight < GenerationParams.SEA_LEVEL) {
		const waterTop = Math.floor(GenerationParams.SEA_LEVEL / CHUNK_SIZE);
		if (waterTop > solidTop) return waterTop;
	}
	return solidTop;
}

/**
 * Minimum solid height over a chunk column's 32×32 footprint — the same
 * 5-sample min `buriedTopChunkY` uses (corners + center). Deliberately shares
 * no cache with it: `getFinalTerrainHeight` already memoizes per-coordinate
 * in a slot array, so these are cheap hits after warmup.
 */
export function columnMinHeight(chunkX: number, chunkZ: number): number {
	const wx = chunkX * CHUNK_SIZE;
	const wz = chunkZ * CHUNK_SIZE;
	const mid = CHUNK_SIZE >> 1;
	let minH = getFinalTerrainHeight(wx, wz);
	minH = Math.min(minH, getFinalTerrainHeight(wx + CHUNK_SIZE, wz));
	minH = Math.min(minH, getFinalTerrainHeight(wx, wz + CHUNK_SIZE));
	minH = Math.min(
		minH,
		getFinalTerrainHeight(wx + CHUNK_SIZE, wz + CHUNK_SIZE),
	);
	minH = Math.min(minH, getFinalTerrainHeight(wx + mid, wz + mid));
	return minH;
}

/**
 * True when (chunkX, chunkY, chunkZ) lies in the solid band of an ocean
 * column, from the chunk containing the seabed surface up to y=-1. Open water
 * above is visible from the sky, so this band must render like surface
 * terrain — never be subjected to sealed-cave vertical windows. Everything
 * below the seabed chunk keeps the existing burial culls.
 */
export function isOceanFloorBandChunk(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
): boolean {
	if (chunkY >= 0) return false;
	const minH = columnMinHeight(chunkX, chunkZ);
	if (minH >= GenerationParams.SEA_LEVEL) return false;
	return chunkY >= Math.floor(minH / CHUNK_SIZE);
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
