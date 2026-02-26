import { Scene } from "@babylonjs/core";

export default class MapFog {
  public static readonly fogStartUnderWater = 1;
  public static readonly fogEndUnderWater = 100;

  public static readonly fogStartAboveWater = 1;
  public static readonly fogEndAboveWater = 1100;
  private static fogStartOverride: number | null = null;
  private static fogEndOverride: number | null = null;

  public static setFogStartOverride(value: number | null): void {
    this.fogStartOverride = value;
  }

  public static setFogEndOverride(value: number | null): void {
    this.fogEndOverride = value;
  }

  public static getFogStart(isUnderWater: boolean): number {
    if (this.fogStartOverride !== null) return this.fogStartOverride;
    return isUnderWater ? this.fogStartUnderWater : this.fogStartAboveWater;
  }

  public static getFogEnd(isUnderWater: boolean): number {
    if (this.fogEndOverride !== null) return this.fogEndOverride;
    return isUnderWater ? this.fogEndUnderWater : this.fogEndAboveWater;
  }

  public static applyToScene(scene: Scene, isUnderWater: boolean): void {
    const nextStart = this.getFogStart(isUnderWater);
    const nextEnd = this.getFogEnd(isUnderWater);
    if (scene.fogStart !== nextStart) scene.fogStart = nextStart;
    if (scene.fogEnd !== nextEnd) scene.fogEnd = nextEnd;
  }

  constructor(private scene: Scene) {
    scene.fogMode = Scene.FOGMODE_LINEAR;
    MapFog.applyToScene(scene, true);
    // scene.fogColor = new Color3(1.0, 0.0, 0.1);
    scene.fogDensity = 0.9;
  }
}
