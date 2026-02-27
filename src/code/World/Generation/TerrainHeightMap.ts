import Alea from "alea";
import { Squirrel3 } from "./NoiseAndParameters/Squirrel13";
import {
  GenerationParams,
  GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
import { createFastNoise2D } from "./NoiseAndParameters/FastNoise/FastNoiseFactory";
import { Spline } from "./NoiseAndParameters/Spline";
import { RiverGenerator } from "./RiverGeneration";
import { Biome } from "./Biome/BiomeTypes";
import { getBiomeFor } from "./Biome/Biomes";
import { FractalType } from "./NoiseAndParameters/FastNoise/FastNoiseLite";

/** Combined result of a single full terrain sample — avoids re-computing noise. */
export type TerrainSample = {
  height: number;
  biome: Biome;
  riverNoise: number; // raw river noise value (pre-abs)
};

/**
 * A static utility class to calculate terrain height at any world coordinate.
 *
 * OPTIMIZATION NOTES:
 *  - getBiome() and getFinalTerrainHeight() previously duplicated every noise call.
 *    They now share a single `getTerrainSample()` path backed by a unified cache.
 *  - River noise is stored in the cache so callers (SurfaceGenerator, LightGenerator)
 *    can retrieve it for free instead of re-sampling.
 *  - String key allocation is replaced with a compact integer hash for hot paths.
 */
export class TerrainHeightMap {
  private static params: GenerationParamsType;
  private static riverGenerator: RiverGenerator;
  private static temperatureNoise: (x: number, z: number) => number;
  private static humidityNoise: (x: number, z: number) => number;
  private static continentalnessNoise: (x: number, z: number) => number;
  private static erosionNoise: (x: number, z: number) => number;
  private static peaksAndValleysNoise: (x: number, z: number) => number;
  private static continentalnessSpline: Spline;
  private static erosionSpline: Spline;
  private static peaksAndValleysSpline: Spline;

  private static seedAsInt: number;

  // Unified cache: stores the full TerrainSample so height + biome + river are
  // computed once and shared by all callers.
  private static sampleCache = new Map<number, TerrainSample>();
  private static readonly MAX_CACHE_SIZE = 50000;

  // Static initializer block. This runs once when the class is loaded.
  static {
    this.params = GenerationParams;
    this.riverGenerator = new RiverGenerator(this.params);
    const prng = Alea(this.params.SEED);

    this.temperatureNoise = createFastNoise2D({
      seed: Squirrel3.get(1, (prng() * 0xffffffff) | 0),
      fractalType: FractalType.None,
      frequency: GenerationParams.TEMPERATURE_NOISE_SCALE,
    });
    this.humidityNoise = createFastNoise2D({
      seed: Squirrel3.get(2, (prng() * 0xffffffff) | 0),
      fractalType: FractalType.None,
      frequency: GenerationParams.HUMIDITY_NOISE_SCALE,
    });
    this.continentalnessNoise = createFastNoise2D({
      seed: Squirrel3.get(3, (prng() * 0xffffffff) | 0),
      fractalType: FractalType.Ridged,
      frequency: GenerationParams.CONTINENTALNESS_NOISE_SCALE,
    });
    this.erosionNoise = createFastNoise2D({
      seed: Squirrel3.get(4, (prng() * 0xffffffff) | 0),
      frequency: GenerationParams.EROSION_NOISE_SCALE,
    });
    this.peaksAndValleysNoise = createFastNoise2D({
      seed: Squirrel3.get(5, (prng() * 0xffffffff) | 0),
      frequency: GenerationParams.PV_NOISE_SCALE,
    });

    this.continentalnessSpline = new Spline([
      { t: -0.995, v: -90 },
      { t: -0.366, v: -74 },
      { t: -0.315, v: -70 },
      { t: -0.294, v: -62 },
      { t: -0.208, v: -51 },
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

    this.erosionSpline = new Spline([
      { t: -1.0, v: 11.0 },
      { t: -0.8, v: 0.8 },
      { t: -0.5, v: 0.6 },
      { t: 0.0, v: 0.4 },
      { t: 0.5, v: 0.2 },
      { t: 0.8, v: 0.1 },
      { t: 1.0, v: 0 },
    ]);

    this.peaksAndValleysSpline = new Spline([
      { t: -1.0, v: -60 },
      { t: -0.6, v: -25 },
      { t: -0.2, v: -15 },
      { t: 0.2, v: 15 },
      { t: 0.5, v: 30 },
      { t: 0.8, v: 60 },
      { t: 1.0, v: 80 },
    ]);
  }

  // ---------------------------------------------------------------------------
  // Cache key helpers
  // ---------------------------------------------------------------------------

  /**
   * Encode a world (x, z) pair into a single 32-bit integer key.
   * Assumes coordinates fit in ±32767 (signed 16-bit range).
   * Much cheaper than template-string allocation.
   */
  private static encodeKey(x: number, z: number): number {
    // Shift x into high 16 bits, z into low 16 bits (both masked to 16 bits)
    return (((x & 0xffff) << 16) | (z & 0xffff)) >>> 0;
  }

  // ---------------------------------------------------------------------------
  // Core sample — all noise evaluated ONCE per (x, z)
  // ---------------------------------------------------------------------------

  /**
   * Returns the full terrain sample for a world coordinate.
   * Height, biome, and river noise are all computed here and cached together,
   * so every downstream caller (getBiome, getFinalTerrainHeight, getRiverNoise)
   * hits the same cache entry.
   */
  public static getTerrainSample(
    worldX: number,
    worldZ: number,
  ): TerrainSample {
    const key = this.encodeKey(worldX, worldZ);
    const cached = this.sampleCache.get(key);
    if (cached !== undefined) return cached;

    // --- Noise evaluation (each function called exactly once) ---
    const continentalness = this.continentalnessNoise(worldX, worldZ);
    const temperature = (this.temperatureNoise(worldX, worldZ) + 1) / 2;
    const humidity = (this.humidityNoise(worldX, worldZ) + 1) / 2;
    const riverNoise = this.riverGenerator.getRiverNoise(worldX, worldZ);
    const riverAbs = Math.abs(riverNoise);

    // --- Height computation ---
    const baseHeight =
      GenerationParams.SEA_LEVEL +
      this.continentalnessSpline.getValue(continentalness);
    const detail = this.computeDetail(worldX, worldZ, baseHeight, riverAbs);
    const height = Math.floor(baseHeight + detail);

    // --- Biome determination ---
    // Mountains push the river underground — skip expensive recalc.
    const effectiveRiver = continentalness > 0.07 ? 1.0 : riverAbs;
    const terrainShapedHeight = baseHeight + detail;
    const biome = getBiomeFor(
      temperature,
      humidity,
      continentalness,
      effectiveRiver,
      terrainShapedHeight,
    );

    const sample: TerrainSample = { height, biome, riverNoise };

    if (this.sampleCache.size > this.MAX_CACHE_SIZE) {
      this.sampleCache.clear();
    }
    this.sampleCache.set(key, sample);
    return sample;
  }

  // ---------------------------------------------------------------------------
  // Public accessors — thin wrappers around getTerrainSample
  // ---------------------------------------------------------------------------

  /** Returns the biome for a world (x, z) coordinate. */
  public static getBiome(x: number, z: number): Biome {
    return this.getTerrainSample(x, z).biome;
  }

  /** Returns the terrain height for a world (x, z) coordinate. */
  public static getFinalTerrainHeight(worldX: number, worldZ: number): number {
    return this.getTerrainSample(worldX, worldZ).height;
  }

  /**
   * Returns the raw river noise value (NOT abs) for a world coordinate.
   * Callers that need Math.abs() should compute it themselves.
   * This avoids a redundant getRiverNoise() call when height is already cached.
   */
  public static getCachedRiverNoise(worldX: number, worldZ: number): number {
    return this.getTerrainSample(worldX, worldZ).riverNoise;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private static computeDetail(
    x: number,
    z: number,
    baseHeight: number,
    riverAbs: number, // pre-computed Math.abs(riverNoise) — no re-sample needed
  ): number {
    // erosion and pv noise are only needed here — sample them now
    const erosion = this.erosionNoise(x, z);
    const pv = this.peaksAndValleysNoise(x, z);

    // Dampen detail inside river channel
    const riverEdge = 0.1;
    const riverFactor = riverAbs < riverEdge ? riverAbs / riverEdge : 1.0;

    // --- Tunnel / Roof Logic ---
    const TUNNEL_THRESHOLD =
      GenerationParams.SEA_LEVEL +
      GenerationParams.RIVER_TUNNEL_THRESHOLD_OFFSET;
    const TRANSITION_RANGE = GenerationParams.RIVER_TRANSITION_RANGE;

    let surfaceRiverInfluence = 1.0;
    if (baseHeight > TUNNEL_THRESHOLD + TRANSITION_RANGE) {
      surfaceRiverInfluence = 0.0;
    } else if (baseHeight > TUNNEL_THRESHOLD) {
      surfaceRiverInfluence =
        1.0 - (baseHeight - TUNNEL_THRESHOLD) / TRANSITION_RANGE;
    }

    const effectiveRiverFactor =
      riverFactor + (1.0 - riverFactor) * (1.0 - surfaceRiverInfluence);

    const roughness =
      this.erosionSpline.getValue(erosion) * effectiveRiverFactor;
    const detail = this.peaksAndValleysSpline.getValue(pv) * roughness;
    const riverDepth =
      this.riverGenerator.getRiverDepth(riverAbs) * surfaceRiverInfluence;

    return detail + riverDepth;
  }

  /** Used by SurfaceGenerator for its internal density field. */
  public static getOctaveNoise(x: number, z: number): number {
    const sample = this.getTerrainSample(x, z);
    return sample.height; // already = floor(base + detail), so return directly
  }
}
