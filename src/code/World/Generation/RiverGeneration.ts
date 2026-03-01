import {
  createFastNoise2D,
  createFastNoise3D,
} from "./NoiseAndParameters/FastNoise/FastNoiseFactory";
import Alea from "alea";
import {
  GenerationParams,
  GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
import { Spline } from "./NoiseAndParameters/Spline";

export class RiverGenerator {
  private params: GenerationParamsType;
  private readonly TUNNEL_RADIUS = 4;
  private readonly TUNNEL_CENTER_Y: number;

  private static riverNoise: (x: number, z: number) => number;
  private static wallNoise: (x: number, y: number, z: number) => number;

  private riverSpline: Spline;
  private riverDepthSpline: Spline;

  constructor(params: GenerationParamsType) {
    this.params = params;
    this.TUNNEL_CENTER_Y = this.params.SEA_LEVEL;
    const prng = Alea(this.params.SEED + "_river_walls");
    const seed = (prng() * 0xffffffff) | 0;

    RiverGenerator.wallNoise = createFastNoise3D({
      seed,
      frequency: 0.1,
    });
    RiverGenerator.riverNoise = createFastNoise2D({
      seed,
      frequency: GenerationParams.RIVER_SCALE,
    });

    this.riverSpline = new Spline([
      { t: 0, v: this.TUNNEL_RADIUS },
      { t: 0.02, v: this.TUNNEL_RADIUS * 0.9 },
      { t: 0.04, v: this.TUNNEL_RADIUS * 0.3 },
      { t: 0.045, v: 0 },
    ]);
    this.riverDepthSpline = new Spline([
      { t: 0, v: -7 },
      { t: 0.02, v: -5 },
      { t: 0.05, v: 0 },
    ]);
  }

  public isRiver(
    worldX: number,
    worldY: number,
    worldZ: number,
    riverNoise: number,
  ): boolean {
    //TODO
    /*
    const radiusAtLocation = this.riverSpline.getValue(Math.abs(riverNoise));

    if (radiusAtLocation <= 0) return false;
    const dy = worldY - this.TUNNEL_CENTER_Y;

    // Optimization: Early exit if outside max possible radius (radius + max noise margin)
    if (Math.abs(dy) > radiusAtLocation + 2) return false;

    const noise = RiverGenerator.wallNoise(worldX, worldY, worldZ);

    if (Math.abs(dy) <= radiusAtLocation + noise) {
      return true;
    }*/
    return false;
  }

  public getRiverNoise(x: number, z: number): number {
    return RiverGenerator.riverNoise(x, z);
  }

  public getRiverDepth(riverValue: number): number {
    return this.riverDepthSpline.getValue(riverValue);
  }
}
