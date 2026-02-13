import { createNoise3D } from "simplex-noise";
import { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { NoiseSampler } from "./NoiseAndParameters/NoiseSampler";

export class UndergroundGenerator {
  private params: GenerationParamsType;
  private caveNoise: ReturnType<typeof createNoise3D>;

  constructor(
    params: GenerationParamsType,
    caveNoise: ReturnType<typeof createNoise3D>,
  ) {
    this.params = params;
    this.caveNoise = caveNoise;
  }

  public generate(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow?: boolean,
    ) => void,
  ) {
    const { CHUNK_SIZE } = this.params;
    const chunkWorldX = chunkX * CHUNK_SIZE;
    const chunkWorldZ = chunkZ * CHUNK_SIZE;
    const chunkWorldY = chunkY * CHUNK_SIZE;

    const CAVE_SCALE = 0.013;

    const MIN_CAVE_DENSITY = 0.00000001;
    const MAX_CAVE_DENSITY = 1.0;

    const DENSITY_TRANSITION_DEPTH = -32;
    const LAVA_LEVEL = -16 * 100;

    // Optimization: Use NoiseSampler for trilinear interpolation
    const sampler = new NoiseSampler(
      chunkX,
      chunkY,
      chunkZ,
      CHUNK_SIZE,
      16, // Sample every 4 blocks
      CAVE_SCALE,
      0.67, // XZ skeew factor
      this.caveNoise,
    );

    for (let localY = 0; localY < CHUNK_SIZE; localY++) {
      const worldY = chunkWorldY + localY;
      if (worldY >= -2) continue; // Optimization: skip if above cave level

      const t = Math.min(1, worldY / DENSITY_TRANSITION_DEPTH);
      const caveDensity = MIN_CAVE_DENSITY * t + MAX_CAVE_DENSITY * (1 - t);

      for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
        for (let localX = 0; localX < CHUNK_SIZE; localX++) {
          const noiseValue = sampler.get(localX, localY, localZ);

          if (noiseValue > caveDensity) {
            const worldX = chunkWorldX + localX;
            const worldZ = chunkWorldZ + localZ;
            const blockId = worldY < LAVA_LEVEL ? 24 : 0; // Lava or Air
            placeBlock(worldX, worldY, worldZ, blockId, true);
          }
        }
      }
    }
  }
}
