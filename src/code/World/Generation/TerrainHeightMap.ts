import { createNoise2D } from "simplex-noise";
import Alea from "alea";
import { GenerationParams } from "./GenerationParams";

/**
 * A static utility class to calculate terrain height at any world coordinate.
 * This is used to determine if chunks are fully underground before generating them.
 */
export class TerrainHeightMap {
  private static terrainNoise: ReturnType<typeof createNoise2D>;

  static {
    // Initialize with a consistent seed to match the world generator
    const prng = Alea(GenerationParams.SEED);
    this.terrainNoise = createNoise2D(prng);
  }

  public static getOctaveNoise(x: number, z: number): number {
    const {
      TERRAIN_SCALE,
      OCTAVES,
      PERSISTENCE,
      LACUNARITY,
      TERRAIN_HEIGHT_BASE,
      TERRAIN_HEIGHT_AMPLITUDE,
    } = GenerationParams;

    let total = 0;
    let frequency = TERRAIN_SCALE;
    let amplitude = 1.5;
    let maxValue = 0;
    for (let i = 0; i < OCTAVES; i++) {
      total += this.terrainNoise(x * frequency, z * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= PERSISTENCE;
      frequency *= LACUNARITY;
    }
    const normalizedHeight = (total / maxValue + 1) / 2;
    return TERRAIN_HEIGHT_BASE + normalizedHeight * TERRAIN_HEIGHT_AMPLITUDE;
  }
}
