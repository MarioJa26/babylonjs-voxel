import { createNoise3D, createNoise2D } from "simplex-noise";
import Alea from "alea";
import {
  GenerationParams,
  GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
import { Spline } from "./NoiseAndParameters/Spline";

export class RiverGenerator {
  private params: GenerationParamsType;
  private readonly TUNNEL_RADIUS = 14;
  private readonly TUNNEL_CENTER_Y: number;

  private riverNoise: ReturnType<typeof createNoise2D>;
  private wallNoise: ReturnType<typeof createNoise3D>;
  private riverSpline: Spline;
  private riverDepthSpline: Spline;

  constructor(params: GenerationParamsType) {
    this.params = params;
    this.TUNNEL_CENTER_Y = this.params.SEA_LEVEL;
    const prng = Alea(this.params.SEED + "_river_walls");
    this.wallNoise = createNoise3D(prng);
    this.riverNoise = createNoise2D(prng);
    this.riverSpline = new Spline([
      { t: 0, v: this.TUNNEL_RADIUS },
      { t: 0.04, v: this.TUNNEL_RADIUS * 0.9 },
      { t: 0.08, v: this.TUNNEL_RADIUS * 0.5 },
      { t: 0.1, v: 0 },
    ]);
    this.riverDepthSpline = new Spline([
      { t: 0, v: -25 },
      { t: 0.02, v: -20 },
      { t: 0.1, v: 0 },
      { t: 1.0, v: 125 },
    ]);
  }

  public isRiver(
    worldX: number,
    worldY: number,
    worldZ: number,
    riverNoise: number,
  ): boolean {
    const radiusAtLocation = this.riverSpline.getValue(Math.abs(riverNoise));

    if (radiusAtLocation <= 0) return false;
    const dy = worldY - this.TUNNEL_CENTER_Y;

    // Optimization: Early exit if outside max possible radius (radius + max noise margin)
    if (Math.abs(dy) > radiusAtLocation + 2) return false;

    const noise = this.wallNoise(worldX * 0.1, worldY * 0.1, worldZ * 0.1);

    if (Math.abs(dy) <= radiusAtLocation + noise) {
      return true;
    }
    return false;
  }

  public getRiverNoise(x: number, z: number): number {
    return this.riverNoise(
      x * GenerationParams.RIVER_SCALE,
      z * GenerationParams.RIVER_SCALE,
    );
  }

  public getRiverDepth(riverValue: number): number {
    return this.riverDepthSpline.getValue(riverValue);
  }
}
