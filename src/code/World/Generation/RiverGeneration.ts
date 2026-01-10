import { createNoise3D } from "simplex-noise";
import Alea from "alea";
import {
  GenerationParams,
  GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
import { TerrainHeightMap } from "./TerrainHeightMap";

export class RiverGenerator {
  private params: GenerationParamsType;
  private readonly TUNNEL_RADIUS = 7;
  private readonly TUNNEL_CENTER_Y: number;
  private readonly RIVER_WIDTH_THRESHOLD = 0.06;
  private wallNoise: ReturnType<typeof createNoise3D>;

  constructor(params: GenerationParamsType) {
    this.params = params;
    this.TUNNEL_CENTER_Y = this.params.SEA_LEVEL + 1;
    const prng = Alea(this.params.SEED + "_river_walls");
    this.wallNoise = createNoise3D(prng);
  }

  public getRiverNoise(worldX: number, worldZ: number): number {
    return RiverGenerator.getRiverNoiseValue(worldX, worldZ);
  }

  public isRiver(
    worldX: number,
    worldZ: number,
    riverNoise: number,
    worldY: number
  ): boolean {
    if (riverNoise < this.RIVER_WIDTH_THRESHOLD) {
      const normalizedX = riverNoise / this.RIVER_WIDTH_THRESHOLD;
      const normalizedY = (worldY - this.TUNNEL_CENTER_Y) / this.TUNNEL_RADIUS;

      const noise = this.wallNoise(worldX * 0.1, worldY * 0.1, worldZ * 0.1);
      if (normalizedX * normalizedX + normalizedY * normalizedY <= 1 + noise) {
        return true;
      }
    }
    return false;
  }

  public static getRiverNoiseValue(worldX: number, worldZ: number): number {
    const riverScale = GenerationParams.RIVER_SCALE * 2.0;
    return TerrainHeightMap.temperatureNoise(
      worldX * riverScale,
      worldZ * riverScale
    );
  }
}
