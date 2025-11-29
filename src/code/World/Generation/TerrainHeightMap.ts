import { createNoise2D } from "simplex-noise";
import Alea from "alea";
import { Squirrel3 } from "./Squirrel13";
import { Biome, getBiomeFor } from "./Biomes";
import { GenerationParams, GenerationParamsType } from "./GenerationParams";
import { Voronoi } from "./Voronoi";

/**
 * A static utility class to calculate terrain height at any world coordinate.
 * This is used to determine if chunks are fully underground before generating them.
 */
export class TerrainHeightMap {
  private static params: GenerationParamsType;
  private static detailNoise: ReturnType<typeof createNoise2D>;
  private static continentalNoise: Voronoi;
  private static temperatureNoise: ReturnType<typeof createNoise2D>;
  private static humidityNoise: ReturnType<typeof createNoise2D>;

  // Static initializer block. This runs once when the class is loaded.
  static {
    this.params = GenerationParams;
    const prng = Alea(this.params.SEED);

    // Separate PRNGs for different noise types to avoid correlation
    const seedAsInt = Squirrel3.get(0, prng() * 0xffffffff);
    const tempPrng = Alea(prng());
    const humidityPrng = Alea(prng());
    const detailPrng = Alea(prng());

    this.temperatureNoise = createNoise2D(tempPrng);
    this.humidityNoise = createNoise2D(humidityPrng);
    this.detailNoise = createNoise2D(detailPrng);
    this.continentalNoise = new Voronoi(seedAsInt, 5555);
  }

  public static getBiome(x: number, z: number): Biome {
    const noiseScale = 1 / 5000; // Scale down coordinates for biome noise
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
    let amplitude = 0.1;
    let maxValue = 0;
    for (let i = 0; i < OCTAVES; i++) {
      total += this.detailNoise(x * frequency, z * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= PERSISTENCE;
      frequency *= LACUNARITY;
    }
    const normalizedHeight = (total / maxValue + 1) / 2;
    return terrainHeightBase + normalizedHeight * terrainHeightAmplitude;
  }

  public static getFinalTerrainHeight(
    worldX: number,
    worldZ: number,
    biome: Biome
  ): number {
    // 1. Calculate the full potential terrain height with all its detail.
    const potentialHeight = this.getOctaveNoise(worldX, worldZ, biome);

    // 2. Get the Voronoi value to define continents.
    // This value is 0 at the center of a landmass and increases towards the edges.
    const continentalness = this.continentalNoise.getF1Value(
      potentialHeight,
      potentialHeight
    );

    // 3. Create a multiplier from the Voronoi value.
    // This will be 1.0 at the center of continents and smoothly drop to 0.0 at the coastlines.
    // The '2.5' controls how sharp the transition is (i.e., how steep the coasts are).
    let landMultiplier = Math.max(0, 1.0 - continentalness * 2.5);

    // To make the drop-off sharper, we can apply a power to the multiplier.
    // A higher exponent will result in a steeper transition.

    landMultiplier = landMultiplier ** 2;

    // 4. Smoothly interpolate between the full terrain height and the sea floor.
    // When landMultiplier is 1, we get the full potentialHeight.
    // When landMultiplier is 0, we get a value slightly below sea level.
    const finalHeight = potentialHeight * landMultiplier;

    return Math.floor(finalHeight);
  }
}
