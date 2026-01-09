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

  public static getOctaveNoise(x: number, z: number, biome?: Biome): number {
    const { TERRAIN_SCALE, OCTAVES, PERSISTENCE, LACUNARITY } =
      GenerationParams;

    const terrainHeightBase =
      biome?.terrainHeightBase ?? GenerationParams.TERRAIN_HEIGHT_BASE;
    const terrainHeightAmplitude =
      biome?.terrainHeightAmplitude ??
      GenerationParams.TERRAIN_HEIGHT_AMPLITUDE;
    let total = 0;
    let frequency = TERRAIN_SCALE;
    let amplitude = 1;
    let maxValue = 1;
    for (let i = 0; i < OCTAVES; i++) {
      total += this.detailNoise(x * frequency, z * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= PERSISTENCE;
      frequency *= LACUNARITY;
    }
    const normalizedHeight = total / maxValue;
    return terrainHeightBase + normalizedHeight * terrainHeightAmplitude;
  }

  public static getFinalTerrainHeight(
    worldX: number,
    worldZ: number,
    biome: Biome
  ): number {
    const potentialHeight = this.getOctaveNoise(worldX, worldZ, biome);

    let finalHeight = potentialHeight;
    finalHeight = Math.max(17, finalHeight);
    return Math.floor(finalHeight);
  }
}
