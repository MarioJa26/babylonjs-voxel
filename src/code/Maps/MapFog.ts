import { Color3, Scene } from "@babylonjs/core";

export default class MapFog {
  public static readonly fogStartUnderWater = 1;
  public static readonly fogEndUnderWater = 100;

  public static readonly fogStartAboveWater = 1;
  public static readonly fogEndAboveWater = 1100;
  constructor(private scene: Scene) {
    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogStart = MapFog.fogStartUnderWater;
    scene.fogEnd = MapFog.fogEndUnderWater;
    // scene.fogColor = new Color3(1.0, 0.0, 0.1);
    scene.fogDensity = 0.9;
  }
}
