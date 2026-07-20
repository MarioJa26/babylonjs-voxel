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

const BIOME_TERRAIN_GRID = 192;
const INV_BIOME_TERRAIN_GRID = 1 / BIOME_TERRAIN_GRID;

const MAX_BIOME_CORNERS = 8192;
const MAX_CHUNK_CACHE = 4096;

// Mask arithmetic is safe only when sizes are powers of two — assert that
// at module load time rather than silently producing wrong cache indices.
if ((MAX_BIOME_CORNERS & (MAX_BIOME_CORNERS - 1)) !== 0)
	throw new Error("MAX_BIOME_CORNERS must be a power of two");
if ((MAX_CHUNK_CACHE & (MAX_CHUNK_CACHE - 1)) !== 0)
	throw new Error("MAX_CHUNK_CACHE must be a power of two");

// Single >>> 0 coercion is sufficient; the second was a no-op.
const encodeChunkKey = (cx: number, cz: number): number =>
	(((cx & 0xffff) << 16) | (cz & 0xffff)) >>> 0;

const encodeCornerKey = (gx: number, gz: number): number =>
	(((gx & 0xffff) << 16) | (gz & 0xffff)) >>> 0;

// ---------------------------------------------------------------------------
// One-time initialization
// ---------------------------------------------------------------------------

const riverGenerator = new RiverGenerator(params);
const prng = Alea(params.SEED);

const _t = createFastNoise2DWithInstance({
	seed: getPRNGBySeed(1, (prng() * 0xffffffff) | 0),
	fractalType: FractalType.None,
	frequency: GenerationParams.TEMPERATURE_NOISE_SCALE,
});
const temperatureNoise = _t.fn;
const temperatureInst = _t.instance;

const _h = createFastNoise2DWithInstance({
	seed: getPRNGBySeed(2, (prng() * 0xffffffff) | 0),
	fractalType: FractalType.None,
	frequency: GenerationParams.HUMIDITY_NOISE_SCALE,
});
const humidityNoise = _h.fn;
const humidityInst = _h.instance;

const _c = createFastNoise2DWithInstance({
	seed: getPRNGBySeed(3, (prng() * 0xffffffff) | 0),
	fractalType: FractalType.Ridged,
	frequency: GenerationParams.CONTINENTALNESS_NOISE_SCALE,
});
const continentalnessNoise = _c.fn;
const continentalnessInst = _c.instance;

const erosionNoise = createFastNoise2D({
	seed: getPRNGBySeed(4, (prng() * 0xffffffff) | 0),
	frequency: GenerationParams.EROSION_NOISE_SCALE,
});

const peaksAndValleysNoise = createFastNoise2D({
	seed: getPRNGBySeed(5, (prng() * 0xffffffff) | 0),
	frequency: GenerationParams.PV_NOISE_SCALE,
});

const heightNoise = createFastNoise2D({
	seed: getPRNGBySeed(6, (prng() * 0xffffffff) | 0),
	fractalType: FractalType.None,
	frequency: GenerationParams.TERRAIN_SCALE,
});

// Inline — avoids a function call on every noise sample on the hot path.
// raw is in [-1, 1]; result maps it to [1, -1] with abs.
// @inline candidate for bundlers that support it.
function applyRidged(raw: number): number {
	return 1 - Math.abs(raw) * 2;
}

const continentalnessSpline = new Spline([
	// Deep ocean trenches
	{ t: -1.0, v: -150 },
	{ t: -0.8, v: -120 },
	{ t: -0.6, v: -90 },
	{ t: -0.4, v: -70 },
	{ t: -0.3, v: -60 },
	{ t: -0.25, v: -50 },
	// Coastline / sea level
	{ t: -0.18, v: -42 },
	// Lowlands / plains
	{ t: -0.1, v: 5 },
	{ t: 0.0, v: 15 },
	{ t: 0.1, v: 40 },
	{ t: 0.2, v: 80 },
	// Hills
	{ t: 0.3, v: 130 },
	{ t: 0.4, v: 200 },
	{ t: 0.5, v: 280 },
	// Mountains
	{ t: 0.6, v: 380 },
	{ t: 0.7, v: 500 },
	{ t: 0.8, v: 550 },
	/*
	// High peaks
	{ t: 0.85, v: 750 },
	{ t: 0.9, v: 850 },
	{ t: 0.95, v: 950 },
	{ t: 1.0, v: 1000 },
	 */
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
// Biome terrain settings — packed Float32 arrays, direct-mapped cache.
// Layout per slot: [base, amplitude, scale, exponent, pvNoiseScale, erosionNoiseScale]
// ---------------------------------------------------------------------------

const SETTINGS_STRIDE = 6;
const CORNER_CACHE_MASK = MAX_BIOME_CORNERS - 1;
const cornerKey = new Uint32Array(MAX_BIOME_CORNERS);
const cornerValid = new Uint8Array(MAX_BIOME_CORNERS);
const cornerBase = new Float32Array(MAX_BIOME_CORNERS);
const cornerAmp = new Float32Array(MAX_BIOME_CORNERS);
const cornerScale = new Float32Array(MAX_BIOME_CORNERS);
const cornerExp = new Float32Array(MAX_BIOME_CORNERS);
const cornerPvScale = new Float32Array(MAX_BIOME_CORNERS);
const cornerErosionScale = new Float32Array(MAX_BIOME_CORNERS);

// ---------------------------------------------------------------------------
// Chunk sample cache — direct-mapped.
// cx/cz stored in separate Int32 arrays to avoid any object allocation and
// to keep the hot comparison branch on adjacent typed-array memory.
// ---------------------------------------------------------------------------

const CHUNK_CACHE_MASK = MAX_CHUNK_CACHE - 1;
const chunkCacheKeyX = new Int32Array(MAX_CHUNK_CACHE);
const chunkCacheKeyZ = new Int32Array(MAX_CHUNK_CACHE);
const chunkCacheValid = new Uint8Array(MAX_CHUNK_CACHE);

// Terrain sample values stored flat — no object allocation in the hot path.
// Public reads go through getChunkSample*() accessors below.
const _ccBaseHeight = new Float32Array(MAX_CHUNK_CACHE);
const _ccContinent = new Float32Array(MAX_CHUNK_CACHE);
const _ccTemperature = new Float32Array(MAX_CHUNK_CACHE);
const _ccHumidity = new Float32Array(MAX_CHUNK_CACHE);
const _ccRiverAbs = new Float32Array(MAX_CHUNK_CACHE);
// Biome is a reference type — kept in a parallel object array.
const _ccBiome: (Biome | undefined)[] = new Array(MAX_CHUNK_CACHE);

// ---------------------------------------------------------------------------
// Internal chunk-sample fill — computes and stores all fields for (cx, cz).
// Returns the cache slot so callers can read directly without a second lookup.
// ---------------------------------------------------------------------------

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
	const effectiveRiver = continent > 0.07 ? 1.0 : riverAbs;
	const biome = getBiomeFor(
		temperature,
		humidity,
		continent,
		effectiveRiver,
		baseHeight,
	);

	chunkCacheKeyX[idx] = cx;
	chunkCacheKeyZ[idx] = cz;
	chunkCacheValid[idx] = 1;
	_ccBaseHeight[idx] = baseHeight;
	_ccContinent[idx] = continent;
	_ccTemperature[idx] = temperature;
	_ccHumidity[idx] = humidity;
	_ccRiverAbs[idx] = riverAbs;
	_ccBiome[idx] = biome;
}

// Returns cache slot — internal use only. O(1), no allocation.
function getChunkCacheIdx(worldX: number, worldZ: number): number {
	const cx = worldX >> CHUNK_SHIFT;
	const cz = worldZ >> CHUNK_SHIFT;
	const key = encodeChunkKey(cx, cz);
	const idx = key & CHUNK_CACHE_MASK;

	if (
		!chunkCacheValid[idx] ||
		chunkCacheKeyX[idx] !== cx ||
		chunkCacheKeyZ[idx] !== cz
	) {
		fillChunkCache(cx, cz, idx);
	}
	return idx;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-column final height cache.
//
// `getFinalTerrainHeight` performs ~3 noise samples + 2 splines + a biome
// blend per call. Callers like the flora loop invoke it 4 times per column
// (via isBeachLocation → isNearWater) and the structure features invoke it
// several times per chunk. Caching is behaviour-preserving: the function
// still returns the same deterministic value for any (x, z) pair.
//
// Implementation: direct-mapped typed-array cache with Int32 key storage.
// Replaces the previous Map<bigint, number> to eliminate BigInt allocation
// on every cache probe — BigInt(x) triggers a heap allocation in V8 even
// when the value is already a small integer (no SMI fast-path for bigint).
// A direct-mapped open-addressing scheme gives O(1) probe with zero GC
// pressure; collision rate is negligible for the spatially-coherent access
// pattern of chunk generation.
// ---------------------------------------------------------------------------
const MAX_FINAL_HEIGHT_CACHE = 131072; // power-of-two, ~2 MB of typed arrays
const _FHC_MASK = MAX_FINAL_HEIGHT_CACHE - 1;
const _fhcKeyX = new Int32Array(MAX_FINAL_HEIGHT_CACHE);
const _fhcKeyZ = new Int32Array(MAX_FINAL_HEIGHT_CACHE);
const _fhcValue = new Int32Array(MAX_FINAL_HEIGHT_CACHE); // floor() → always integer
const _fhcValid = new Uint8Array(MAX_FINAL_HEIGHT_CACHE);

export function getFinalTerrainHeight(x: number, z: number): number {
	const slot =
		(((Math.imul(x, 2246822519) ^ Math.imul(z, 3266489917)) >>> 0) &
			_FHC_MASK) >>>
		0;

	if (_fhcValid[slot] && _fhcKeyX[slot] === x && _fhcKeyZ[slot] === z) {
		return _fhcValue[slot];
	}

	// Inline getBlendedBiomeTerrainSettings to avoid shared-scratch Float32Array
	// indirection and extra function-call overhead on this already-hot path.
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

	fillCorner(gx, gz, x0, z0, _s00);
	fillCorner(gx + 1, gz, x0 + BIOME_TERRAIN_GRID, z0, _s10);
	fillCorner(gx, gz + 1, x0, z0 + BIOME_TERRAIN_GRID, _s01);
	fillCorner(
		gx + 1,
		gz + 1,
		x0 + BIOME_TERRAIN_GRID,
		z0 + BIOME_TERRAIN_GRID,
		_s11,
	);

	const itx = 1 - tx;
	const itz = 1 - tz;

	// Read all 6 blended settings as locals — keeps them in registers.
	const sBase =
		(_s00[0] * itx + _s10[0] * tx) * itz + (_s01[0] * itx + _s11[0] * tx) * tz;
	const sAmp =
		(_s00[1] * itx + _s10[1] * tx) * itz + (_s01[1] * itx + _s11[1] * tx) * tz;
	const sScale =
		(_s00[2] * itx + _s10[2] * tx) * itz + (_s01[2] * itx + _s11[2] * tx) * tz;
	const sExp =
		(_s00[3] * itx + _s10[3] * tx) * itz + (_s01[3] * itx + _s11[3] * tx) * tz;
	const sPvScale =
		(_s00[4] * itx + _s10[4] * tx) * itz + (_s01[4] * itx + _s11[4] * tx) * tz;
	const sErosScale =
		(_s00[5] * itx + _s10[5] * tx) * itz + (_s01[5] * itx + _s11[5] * tx) * tz;

	// computeHeightNoiseOnly — inline to avoid re-reading settings via Float32Array index.
	const rawNoise = heightNoise(x * sScale, z * sScale);
	let n01 = (rawNoise + 1) * 0.5;
	if (n01 < 0) n01 = 0;
	else if (n01 > 1) n01 = 1;
	let shaped: number;
	if (sExp === 1) {
		shaped = n01;
	} else if (sExp === 2) {
		shaped = n01 * n01;
	} else if (sExp === 0.5) {
		shaped = Math.sqrt(n01);
	} else {
		shaped = n01 === 0 ? 0 : Math.exp(sExp * Math.log(n01));
	}
	const noiseHeight = shaped * sAmp;

	const riverAbs = Math.abs(riverGenerator.getRiverNoise(x, z));

	// computeDetail — inline.
	const erosion = erosionNoise(x, z);
	const pv = peaksAndValleysNoise(x, z);
	const riverFactor = riverAbs < 0.1 ? riverAbs * 10 : 1;
	const roughness = erosionSpline.getValue(erosion) * riverFactor * sErosScale;
	const detail =
		peaksAndValleysSpline.getValue(pv) * roughness * sPvScale +
		riverGenerator.getRiverDepth(riverAbs);

	const rawContinent = continentalnessNoise(x, z);
	const continent = applyRidged(rawContinent);
	const splineBaseHeight =
		GenerationParams.SEA_LEVEL + continentalnessSpline.getValue(continent);

	const result = Math.floor(splineBaseHeight + sBase + noiseHeight + detail);

	_fhcKeyX[slot] = x;
	_fhcKeyZ[slot] = z;
	_fhcValue[slot] = result;
	_fhcValid[slot] = 1;
	return result;
}

export function getBiome(x: number, z: number): Biome {
	const idx = getChunkCacheIdx(x, z);
	return _ccBiome[idx]!;
}

export function getCachedRiverNoise(x: number, z: number): number {
	const idx = getChunkCacheIdx(x, z);
	return _ccRiverAbs[idx];
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
		continent: _ccContinent[idx],
		temperature: _ccTemperature[idx],
		humidity: _ccHumidity[idx],
		river: _ccRiverAbs[idx],
		erosion: erosionNoise(x, z),
		pv: peaksAndValleysNoise(x, z),
	};
}

// ---------------------------------------------------------------------------
// Biome terrain settings
// ---------------------------------------------------------------------------

// Read biome field with typed-array-friendly number check; avoids property
// access on the prototype chain when the field is missing.
const _biomeDefaultBase = params.TERRAIN_HEIGHT_BASE;
const _biomeDefaultAmplitude = params.TERRAIN_HEIGHT_AMPLITUDE;
const _biomeDefaultScale = params.TERRAIN_SCALE;

function getBiomeBase(b: Biome): number {
	return b.terrainHeightBase ?? _biomeDefaultBase;
}
function getBiomeAmp(b: Biome): number {
	return b.terrainHeightAmplitude ?? _biomeDefaultAmplitude;
}
function getBiomeScale(b: Biome): number {
	return b.terrainScale ?? _biomeDefaultScale;
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

// Module-level scratch arrays — zero allocation on the hot path.
const _s00 = new Float32Array(SETTINGS_STRIDE);
const _s10 = new Float32Array(SETTINGS_STRIDE);
const _s01 = new Float32Array(SETTINGS_STRIDE);
const _s11 = new Float32Array(SETTINGS_STRIDE);

function fillCorner(
	gx: number,
	gz: number,
	worldX: number,
	worldZ: number,
	out: Float32Array,
): void {
	const key = encodeCornerKey(gx, gz);
	const idx = key & CORNER_CACHE_MASK;

	if (cornerValid[idx] && cornerKey[idx] === key) {
		out[0] = cornerBase[idx];
		out[1] = cornerAmp[idx];
		out[2] = cornerScale[idx];
		out[3] = cornerExp[idx];
		out[4] = cornerPvScale[idx];
		out[5] = cornerErosionScale[idx];
		return;
	}

	// Cold path — compute and populate cache.
	const rawContinent = continentalnessNoise(worldX, worldZ);
	const continent = applyRidged(rawContinent);
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

	const base = getBiomeBase(biome);
	const amp = getBiomeAmp(biome);
	const scale = getBiomeScale(biome);
	const exp = getBiomeExp(biome);
	const pvScale = getBiomePvScale(biome);
	const erosionScale = getBiomeErosionScale(biome);

	cornerKey[idx] = key;
	cornerBase[idx] = base;
	cornerAmp[idx] = amp;
	cornerScale[idx] = scale;
	cornerExp[idx] = exp;
	cornerPvScale[idx] = pvScale;
	cornerErosionScale[idx] = erosionScale;
	cornerValid[idx] = 1;

	out[0] = base;
	out[1] = amp;
	out[2] = scale;
	out[3] = exp;
	out[4] = pvScale;
	out[5] = erosionScale;
}

// ---------------------------------------------------------------------------
// Prefetch — batch-fill corner cache for an entire chunk using FillNoise2D.
// Avoids per-corner noise function dispatch; all four noise fields computed
// as contiguous typed arrays in a single pass.
//
// Module-level scratch buffers eliminate repeated allocation on every call.
// Size is generous: a 32-wide chunk spans at most ceil(33 / 192) + 2 = 3
// grid cells per axis, so 9 corners max. We allocate for 16×16 = 256 to
// be safe without any runtime size check.
// ---------------------------------------------------------------------------

const _PREFETCH_MAX = 256;
const _prefetchContinentBuf = new Float32Array(_PREFETCH_MAX);
const _prefetchTempBuf = new Float32Array(_PREFETCH_MAX);
const _prefetchHumidBuf = new Float32Array(_PREFETCH_MAX);
const _prefetchRiverBuf = new Float32Array(_PREFETCH_MAX);

export function prefetchChunkCorners(
	chunkWorldX: number,
	chunkWorldZ: number,
): void {
	const gx0 = Math.floor(chunkWorldX * INV_BIOME_TERRAIN_GRID);
	const gz0 = Math.floor(chunkWorldZ * INV_BIOME_TERRAIN_GRID);
	const gx1 = Math.floor((chunkWorldX + 31) * INV_BIOME_TERRAIN_GRID) + 1;
	const gz1 = Math.floor((chunkWorldZ + 31) * INV_BIOME_TERRAIN_GRID) + 1;

	const width = gx1 - gx0 + 1;
	const height = gz1 - gz0 + 1;
	const total = width * height;

	// Guard against unexpectedly large grids overflowing our scratch buffers.
	if (total > _PREFETCH_MAX) {
		// Fall back to per-corner fills — correctness over speed.
		for (let gz = gz0; gz <= gz1; gz++) {
			for (let gx = gx0; gx <= gx1; gx++) {
				fillCorner(
					gx,
					gz,
					gx * BIOME_TERRAIN_GRID,
					gz * BIOME_TERRAIN_GRID,
					_s00,
				);
			}
		}
		return;
	}

	const offX = gx0 * BIOME_TERRAIN_GRID;
	const offZ = gz0 * BIOME_TERRAIN_GRID;

	// Batch noise — all four channels in a single FillNoise2D call each,
	// result written into pre-allocated module-level buffers.
	continentalnessInst.FillNoise2D(
		_prefetchContinentBuf,
		width,
		height,
		offX,
		offZ,
	);
	temperatureInst.FillNoise2D(_prefetchTempBuf, width, height, offX, offZ);
	humidityInst.FillNoise2D(_prefetchHumidBuf, width, height, offX, offZ);
	riverGenerator.fillRiverNoise2D(_prefetchRiverBuf, width, height, offX, offZ);

	// Walk the grid in row-major order (matches FillNoise2D layout).
	for (let gz = gz0; gz <= gz1; gz++) {
		const rowOff = (gz - gz0) * width;
		for (let gx = gx0; gx <= gx1; gx++) {
			const bufIdx = rowOff + (gx - gx0);
			const rawContinent = _prefetchContinentBuf[bufIdx];
			const continent = applyRidged(rawContinent);
			const temperature = (_prefetchTempBuf[bufIdx] + 1) * 0.5;
			const humidity = (_prefetchHumidBuf[bufIdx] + 1) * 0.5;
			const riverAbs = Math.abs(_prefetchRiverBuf[bufIdx]);
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

			const key = encodeCornerKey(gx, gz);
			const slot = key & CORNER_CACHE_MASK;

			cornerKey[slot] = key;
			cornerBase[slot] = getBiomeBase(biome);
			cornerAmp[slot] = getBiomeAmp(biome);
			cornerScale[slot] = getBiomeScale(biome);
			cornerExp[slot] = getBiomeExp(biome);
			cornerPvScale[slot] = getBiomePvScale(biome);
			cornerErosionScale[slot] = getBiomeErosionScale(biome);
			cornerValid[slot] = 1;
		}
	}
}
