import { createNoise2D } from "simplex-noise";
import Alea from "alea";
import { Squirrel3 } from "./NoiseAndParameters/Squirrel13";
import { Biome, getBiomeFor } from "./Biome/Biomes";
import {
  GenerationParams,
  GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
import { Voronoi } from "./NoiseAndParameters/Voronoi";
import { Spline } from "./NoiseAndParameters/Spline";

/**
 * A static utility class to calculate terrain height at any world coordinate.
 * This is used to determine if chunks are fully underground before generating them.
 */
export class TerrainHeightMap {
  private static params: GenerationParamsType;
  //private static continentalNoise: Voronoi;
  public static temperatureNoise: ReturnType<typeof createNoise2D>;
  private static humidityNoise: ReturnType<typeof createNoise2D>;
  private static continentalnessNoise: ReturnType<typeof createNoise2D>;
  private static erosionNoise: ReturnType<typeof createNoise2D>;
  private static peaksAndValleysNoise: ReturnType<typeof createNoise2D>;
  private static continentalnessSpline: Spline;
  private static erosionSpline: Spline;
  private static peaksAndValleysSpline: Spline;

  private static seedAsInt: number;

  // Static initializer block. This runs once when the class is loaded.
  static {
    this.params = GenerationParams;
    const prng = Alea(this.params.SEED);

    // Separate PRNGs for different noise types to avoid correlation
    TerrainHeightMap.seedAsInt = Squirrel3.get(0, (prng() * 0xffffffff) | 0);
    const tempPrng = Alea(prng());
    const humidityPrng = Alea(prng());
    const detailPrng = Alea(prng());
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
      { t: -1.0, v: -25 },
      { t: -0.3, v: -20 },
      { t: -0.25, v: 0 },
      { t: -0.1, v: 20 },
      { t: 0.0, v: 42 },
      { t: 0.3, v: 46 },
      { t: 0.45, v: 48 },
      { t: 0.5, v: 70 },
      { t: 0.55, v: 80 },

      { t: 0.59, v: 70 },

      { t: 0.595, v: 85 },
      { t: 0.6, v: 100 },
      { t: 0.7, v: 120 },
      { t: 0.8, v: 340 },
      { t: 0.9, v: 365 },
      { t: 0.98, v: 500 },
      { t: 1.0, v: 512 },
    ]);

    this.erosionSpline = new Spline([
      { t: -1.0, v: 1.0 },
      { t: -0.8, v: 0.8 },
      { t: -0.5, v: 0.6 },
      { t: 0.0, v: 0.4 },
      { t: 0.5, v: 0.2 },
      { t: 0.8, v: 0.1 },
      { t: 1.0, v: 0.0 },
    ]);

    this.peaksAndValleysSpline = new Spline([
      { t: -1.0, v: -36 },
      { t: -0.6, v: -15 },
      { t: -0.2, v: 0 },
      { t: 0.2, v: 5 },
      { t: 0.6, v: 10 },
      { t: 1.0, v: 33 },
    ]);
  }

  public static getBiome(x: number, z: number): Biome {
    const CONTINENTALNESS_NOISE_SCALE =
      GenerationParams.CONTINENTALNESS_NOISE_SCALE;

    const continentalness = this.continentalnessNoise(
      x * CONTINENTALNESS_NOISE_SCALE,
      z * CONTINENTALNESS_NOISE_SCALE
    );
    const temperature =
      (this.temperatureNoise(
        x * GenerationParams.TEMPERATURE_NOISE_SCALE,
        z * GenerationParams.TEMPERATURE_NOISE_SCALE
      ) +
        1) /
      2;
    const humidity =
      (this.humidityNoise(
        x * GenerationParams.HUMIDITY_NOISE_SCALE,
        z * GenerationParams.HUMIDITY_NOISE_SCALE
      ) +
        1) /
      2;
    return getBiomeFor(temperature, humidity, continentalness);
  }

  private static computeHeight(x: number, z: number): number {
    const continentalness = this.continentalnessNoise(
      x * GenerationParams.CONTINENTALNESS_NOISE_SCALE,
      z * GenerationParams.CONTINENTALNESS_NOISE_SCALE
    );
    const erosion = this.erosionNoise(
      x * GenerationParams.EROSION_NOISE_SCALE,
      z * GenerationParams.EROSION_NOISE_SCALE
    );
    const pv = this.peaksAndValleysNoise(
      x * GenerationParams.PV_NOISE_SCALE,
      z * GenerationParams.PV_NOISE_SCALE
    );

    const SEA_LEVEL = GenerationParams.SEA_LEVEL;
    // Continentalness Spline (Base Height)
    const height =
      SEA_LEVEL + this.continentalnessSpline.getValue(continentalness);

    // Erosion: Determines roughness/amplitude of local features
    const roughness = this.erosionSpline.getValue(erosion);

    // Peaks & Valleys: Determines local shape (valleys, peaks)
    const detail = this.peaksAndValleysSpline.getValue(pv) * roughness;

    return height + detail;
  }

  public static getOctaveNoise(x: number, z: number, biome?: Biome): number {
    const SAMPLE_DISTANCE = 32;

    const x0 = Math.floor(x / SAMPLE_DISTANCE) * SAMPLE_DISTANCE;
    const z0 = Math.floor(z / SAMPLE_DISTANCE) * SAMPLE_DISTANCE;
    const x1 = x0 + SAMPLE_DISTANCE;
    const z1 = z0 + SAMPLE_DISTANCE;

    const tx = (x - x0) / SAMPLE_DISTANCE;
    const tz = (z - z0) / SAMPLE_DISTANCE;

    // Compute height for (x,z) using each corner's definition
    const h00 = this.computeHeight(x0, z0);
    const h10 = this.computeHeight(x1, z0);
    const h01 = this.computeHeight(x0, z1);
    const h11 = this.computeHeight(x1, z1);

    // Bilinear interpolation of heights
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const top = lerp(h00, h10, tx);
    const bottom = lerp(h01, h11, tx);
    return lerp(top, bottom, tz);
  }

  public static getFinalTerrainHeight(
    worldX: number,
    worldZ: number,
    biome?: Biome
  ): number {
    const potentialHeight = this.getOctaveNoise(worldX, worldZ, biome);

    let finalHeight = potentialHeight;
    finalHeight = Math.max(17, finalHeight);
    return Math.floor(finalHeight);
  }
}
