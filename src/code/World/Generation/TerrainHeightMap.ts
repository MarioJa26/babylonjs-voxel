import { createNoise2D } from "simplex-noise";
import Alea from "alea";
import { Squirrel3 } from "./NoiseAndParameters/Squirrel13";
import { Biome, getBiomeFor } from "./Biome/Biomes";
import {
  GenerationParams,
  GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
import { Voronoi } from "./NoiseAndParameters/Voronoi";

/**
 * A static utility class to calculate terrain height at any world coordinate.
 * This is used to determine if chunks are fully underground before generating them.
 */
export class TerrainHeightMap {
  private static params: GenerationParamsType;
  private static detailNoise: ReturnType<typeof createNoise2D>;
  private static continentalNoise: Voronoi;
  public static temperatureNoise: ReturnType<typeof createNoise2D>;
  private static humidityNoise: ReturnType<typeof createNoise2D>;

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

    this.temperatureNoise = createNoise2D(tempPrng);
    this.humidityNoise = createNoise2D(humidityPrng);
    this.detailNoise = createNoise2D(detailPrng);
    this.continentalNoise = new Voronoi(TerrainHeightMap.seedAsInt, 5555);
  }

  public static getBiome(x: number, z: number): Biome {
    const noiseScale = GenerationParams.BIOME_NOISE_SCALE; // Scale down coordinates for biome noise
    const temperature =
      (this.temperatureNoise(x * noiseScale, z * noiseScale) + 1) / 2;
    const humidity =
      (this.humidityNoise(x * noiseScale, z * noiseScale) + 1) / 2;
    return getBiomeFor(temperature, humidity);
  }

  private static getBiomeParams(x: number, z: number) {
    const biome = this.getBiome(x, z);
    return {
      scale: biome.terrainScale ?? GenerationParams.TERRAIN_SCALE,
      octaves: biome.octaves ?? GenerationParams.OCTAVES,
      persistence: biome.persistence ?? GenerationParams.PERSISTENCE,
      lacunarity: biome.lacunarity ?? GenerationParams.LACUNARITY,
      heightExponent: biome.heightExponent ?? 1.0,
      terrainHeightBase:
        biome.terrainHeightBase ?? GenerationParams.TERRAIN_HEIGHT_BASE,
      terrainHeightAmplitude:
        biome.terrainHeightAmplitude ??
        GenerationParams.TERRAIN_HEIGHT_AMPLITUDE,
    };
  }

  private static getBlendedParams(x: number, z: number) {
    const SAMPLE_DISTANCE = 32;

    const x0 = Math.floor(x / SAMPLE_DISTANCE) * SAMPLE_DISTANCE;
    const z0 = Math.floor(z / SAMPLE_DISTANCE) * SAMPLE_DISTANCE;
    const x1 = x0 + SAMPLE_DISTANCE;
    const z1 = z0 + SAMPLE_DISTANCE;

    const tx = (x - x0) / SAMPLE_DISTANCE;
    const tz = (z - z0) / SAMPLE_DISTANCE;

    const p00 = this.getBiomeParams(x0, z0);
    const p10 = this.getBiomeParams(x1, z0);
    const p01 = this.getBiomeParams(x0, z1);
    const p11 = this.getBiomeParams(x1, z1);

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    const interpolate = (
      v00: number,
      v10: number,
      v01: number,
      v11: number
    ) => {
      const top = lerp(v00, v10, tx);
      const bottom = lerp(v01, v11, tx);
      return lerp(top, bottom, tz);
    };

    return {
      scale: interpolate(p00.scale, p10.scale, p01.scale, p11.scale),
      octaves: interpolate(p00.octaves, p10.octaves, p01.octaves, p11.octaves),
      persistence: interpolate(
        p00.persistence,
        p10.persistence,
        p01.persistence,
        p11.persistence
      ),
      lacunarity: interpolate(
        p00.lacunarity,
        p10.lacunarity,
        p01.lacunarity,
        p11.lacunarity
      ),
      heightExponent: interpolate(
        p00.heightExponent,
        p10.heightExponent,
        p01.heightExponent,
        p11.heightExponent
      ),
      terrainHeightBase: interpolate(
        p00.terrainHeightBase,
        p10.terrainHeightBase,
        p01.terrainHeightBase,
        p11.terrainHeightBase
      ),
      terrainHeightAmplitude: interpolate(
        p00.terrainHeightAmplitude,
        p10.terrainHeightAmplitude,
        p01.terrainHeightAmplitude,
        p11.terrainHeightAmplitude
      ),
    };
  }

  public static getOctaveNoise(x: number, z: number, biome?: Biome): number {
    // OTG-Style: Allow biomes to override noise parameters
    const params = biome
      ? {
          scale: biome.terrainScale ?? GenerationParams.TERRAIN_SCALE,
          octaves: biome.octaves ?? GenerationParams.OCTAVES,
          persistence: biome.persistence ?? GenerationParams.PERSISTENCE,
          lacunarity: biome.lacunarity ?? GenerationParams.LACUNARITY,
          heightExponent: biome.heightExponent ?? 1.0,
          terrainHeightBase:
            biome.terrainHeightBase ?? GenerationParams.TERRAIN_HEIGHT_BASE,
          terrainHeightAmplitude:
            biome.terrainHeightAmplitude ??
            GenerationParams.TERRAIN_HEIGHT_AMPLITUDE,
        }
      : this.getBlendedParams(x, z);

    let total = 0;
    let frequency = params.scale;
    let amplitude = 1;
    let maxValue = 0;
    for (let i = 0; i < params.octaves; i++) {
      total += this.detailNoise(x * frequency, z * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= params.persistence;
      frequency *= params.lacunarity;
    }
    let normalizedHeight = total / (maxValue + 1);

    // OTG-Style: Apply curve to flatten valleys or sharpen peaks
    if (params.heightExponent !== 1.0) {
      const val01 = Math.max(0, (normalizedHeight + 1) * 0.5);
      normalizedHeight = Math.pow(val01, params.heightExponent) * 2 - 1;
    }

    return (
      params.terrainHeightBase +
      normalizedHeight * params.terrainHeightAmplitude
    );
  }

  public static getFinalTerrainHeight(
    worldX: number,
    worldZ: number,
    biome?: Biome
  ): number {
    const potentialHeight = this.getOctaveNoise(worldX, worldZ, biome);

    let finalHeight = potentialHeight;
    finalHeight = Math.max(17, finalHeight);
    return Math.abs(Math.floor(finalHeight));
  }
}
