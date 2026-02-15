import { createNoise2D } from "simplex-noise";
import Alea from "alea";
import { Squirrel3 } from "./NoiseAndParameters/Squirrel13";
import {
  GenerationParams,
  GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
//import { Voronoi } from "./NoiseAndParameters/Voronoi";
import { Spline } from "./NoiseAndParameters/Spline";
import { RiverGenerator } from "./RiverGeneration";
import { SettingParams } from "../SettingParams";
import { Biome } from "./Biome/BiomeTypes";
import { getBiomeFor } from "./Biome/Biomes";

/**
 * A static utility class to calculate terrain height at any world coordinate.
 * This is used to determine if chunks are fully underground before generating them.
 */
export class TerrainHeightMap {
  private static params: GenerationParamsType;
  //private static continentalNoise: Voronoi;
  private static riverGenerator: RiverGenerator;
  public static temperatureNoise: ReturnType<typeof createNoise2D>;
  private static humidityNoise: ReturnType<typeof createNoise2D>;
  private static continentalnessNoise: ReturnType<typeof createNoise2D>;
  private static erosionNoise: ReturnType<typeof createNoise2D>;
  private static peaksAndValleysNoise: ReturnType<typeof createNoise2D>;
  private static continentalnessSpline: Spline;
  private static erosionSpline: Spline;
  private static peaksAndValleysSpline: Spline;

  private static seedAsInt: number;

  private static heightCache = new Map<string, number>();
  private static biomeCache = new Map<string, Biome>();
  private static readonly MAX_CACHE_SIZE = 50000;

  // Static initializer block. This runs once when the class is loaded.
  static {
    this.params = GenerationParams;
    this.riverGenerator = new RiverGenerator(this.params);
    const prng = Alea(this.params.SEED);

    // Separate PRNGs for different noise types to avoid correlation
    TerrainHeightMap.seedAsInt = Squirrel3.get(0, (prng() * 0xffffffff) | 0);
    const tempPrng = Alea(prng());
    const humidityPrng = Alea(prng());
    //const detailPrng = Alea(prng());
    const continentalnessPrng = Alea(prng());
    const erosionPrng = Alea(prng());
    const pvPrng = Alea(prng());

    this.temperatureNoise = createNoise2D(tempPrng);
    this.humidityNoise = createNoise2D(humidityPrng);
    this.continentalnessNoise = createNoise2D(continentalnessPrng);
    this.erosionNoise = createNoise2D(erosionPrng);
    this.peaksAndValleysNoise = createNoise2D(pvPrng);
    // this.continentalNoise = new Voronoi(TerrainHeightMap.seedAsInt, 5555);

    this.continentalnessSpline = new Spline([
      { t: -1.0, v: -16 },
      { t: -0.327, v: -16 },
      { t: -0.319, v: -5 },
      { t: -0.312, v: 0 },
      { t: -0.306, v: 3 },
      { t: -0.299, v: 4 },
      { t: -0.29, v: 3 },
      { t: -0.181, v: 3 },
      { t: -0.123, v: 4 },
      { t: -0.037, v: 11 },
      { t: 0.009, v: 41 },
      { t: 0.023, v: 41 },
      { t: 0.041, v: 43 },
      { t: 0.063, v: 59 },
      { t: 0.126, v: 85 },
      { t: 0.247, v: 123 },
      { t: 0.283, v: 123 },
      { t: 0.321, v: 147 },
      { t: 0.366, v: 204 },
      { t: 0.463, v: 280 },
      { t: 0.545, v: 315 },
      { t: 0.63, v: 338 },
      { t: 0.706, v: 360 },
      { t: 0.763, v: 382 },
      { t: 0.9, v: 400 },
      { t: 0.957, v: 413 },
      /*
      {
        t: 1.0,
        v: GenerationParams.CHUNK_SIZE * SettingParams.MAX_CHUNK_HEIGHT,
      },
      */
    ]);

    this.erosionSpline = new Spline([
      { t: -1.0, v: 1.0 },
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
      { t: -0.2, v: -5 },
      { t: 0.2, v: 5 },
      { t: 0.5, v: 10 },
      { t: 0.8, v: 30 },
      { t: 1.0, v: 45 },
    ]);
  }

  public static getBiome(x: number, z: number): Biome {
    const key = `${x},${z}`;
    if (this.biomeCache.has(key)) {
      return this.biomeCache.get(key)!;
    }

    const CONTINENTALNESS_NOISE_SCALE =
      GenerationParams.CONTINENTALNESS_NOISE_SCALE;

    const continentalness = this.continentalnessNoise(
      x * CONTINENTALNESS_NOISE_SCALE,
      z * CONTINENTALNESS_NOISE_SCALE,
    );
    const temperature =
      (this.temperatureNoise(
        x * GenerationParams.TEMPERATURE_NOISE_SCALE,
        z * GenerationParams.TEMPERATURE_NOISE_SCALE,
      ) +
        1) /
      2;
    const humidity =
      (this.humidityNoise(
        x * GenerationParams.HUMIDITY_NOISE_SCALE,
        z * GenerationParams.HUMIDITY_NOISE_SCALE,
      ) +
        1) /
      2;
    const river = Math.abs(this.riverGenerator.getRiverNoise(x, z));

    // Fast approximation: If continentalness is high (mountains), the river is underground.
    // We skip the expensive spline calculation here.
    let effectiveRiver = river;
    if (continentalness > 0.07) {
      effectiveRiver = 1.0;
    }

    const biome = getBiomeFor(
      temperature,
      humidity,
      continentalness,
      effectiveRiver,
    );

    if (this.biomeCache.size > this.MAX_CACHE_SIZE) {
      this.biomeCache.clear();
    }
    this.biomeCache.set(key, biome);
    return biome;
  }

  private static computeBaseHeight(x: number, z: number): number {
    const continentalness = this.continentalnessNoise(
      x * GenerationParams.CONTINENTALNESS_NOISE_SCALE,
      z * GenerationParams.CONTINENTALNESS_NOISE_SCALE,
    );
    const SEA_LEVEL = GenerationParams.SEA_LEVEL;
    return SEA_LEVEL + this.continentalnessSpline.getValue(continentalness);
  }

  private static computeDetail(
    x: number,
    z: number,
    baseHeight: number,
  ): number {
    const erosion = this.erosionNoise(
      x * GenerationParams.EROSION_NOISE_SCALE,
      z * GenerationParams.EROSION_NOISE_SCALE,
    );
    const pv = this.peaksAndValleysNoise(
      x * GenerationParams.PV_NOISE_SCALE,
      z * GenerationParams.PV_NOISE_SCALE,
    );
    const river = Math.abs(this.riverGenerator.getRiverNoise(x, z));

    // Dampen detail in river
    const riverEdge = 0.1;
    const riverFactor = river < riverEdge ? river / riverEdge : 1.0;

    // --- Tunnel / Roof Logic ---
    // If the base terrain is high (mountain), we stop carving the surface river
    // so it becomes a tunnel underneath.
    const TUNNEL_THRESHOLD =
      GenerationParams.SEA_LEVEL +
      GenerationParams.RIVER_TUNNEL_THRESHOLD_OFFSET;
    const TRANSITION_RANGE = GenerationParams.RIVER_TRANSITION_RANGE;

    // 1.0 = Full Surface River, 0.0 = Full Tunnel (No surface carving)
    let surfaceRiverInfluence = 1.0;

    if (baseHeight > TUNNEL_THRESHOLD + TRANSITION_RANGE) {
      surfaceRiverInfluence = 0.0;
    } else if (baseHeight > TUNNEL_THRESHOLD) {
      surfaceRiverInfluence =
        1.0 - (baseHeight - TUNNEL_THRESHOLD) / TRANSITION_RANGE;
    }

    // If we are tunneling, we shouldn't flatten the mountain top (riverFactor should be 1)
    const effectiveRiverFactor =
      riverFactor + (1.0 - riverFactor) * (1.0 - surfaceRiverInfluence);

    // Erosion: Determines roughness/amplitude of local features
    const roughness =
      this.erosionSpline.getValue(erosion) * effectiveRiverFactor;

    // Peaks & Valleys: Determines local shape (valleys, peaks)
    const detail = this.peaksAndValleysSpline.getValue(pv) * roughness;

    // Only apply river depth if we are on the surface
    const riverDepth =
      this.riverGenerator.getRiverDepth(river) * surfaceRiverInfluence;
    return detail + riverDepth;
  }

  public static getInterpolatedBaseHeight(
    x: number,
    z: number,
    sampleDistance: number,
  ): number {
    const x0 = Math.floor(x / sampleDistance) * sampleDistance;
    const z0 = Math.floor(z / sampleDistance) * sampleDistance;
    const x1 = x0 + sampleDistance;
    const z1 = z0 + sampleDistance;

    const tx = (x - x0) / sampleDistance;
    const tz = (z - z0) / sampleDistance;

    // Compute height for (x,z) using each corner's definition
    const h00 = this.computeBaseHeight(x0, z0);
    const h10 = this.computeBaseHeight(x1, z0);
    const h01 = this.computeBaseHeight(x0, z1);
    const h11 = this.computeBaseHeight(x1, z1);

    // Bilinear interpolation of heights
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const top = lerp(h00, h10, tx);
    const bottom = lerp(h01, h11, tx);
    return lerp(top, bottom, tz);
  }

  public static getOctaveNoise(x: number, z: number): number {
    //const base = this.getInterpolatedBaseHeight(x, z, 1);
    const base = this.computeBaseHeight(x, z);
    const detail = this.computeDetail(x, z, base);
    return base + detail;
  }

  public static getFinalTerrainHeight(worldX: number, worldZ: number): number {
    const key = `${worldX},${worldZ}`;
    if (this.heightCache.has(key)) {
      return this.heightCache.get(key)!;
    }

    const potentialHeight = this.getOctaveNoise(worldX, worldZ);

    let finalHeight = potentialHeight;
    finalHeight = Math.max(17, finalHeight);
    finalHeight = Math.floor(finalHeight);

    if (this.heightCache.size > this.MAX_CACHE_SIZE) {
      this.heightCache.clear();
    }
    this.heightCache.set(key, finalHeight);
    return finalHeight;
  }
}
