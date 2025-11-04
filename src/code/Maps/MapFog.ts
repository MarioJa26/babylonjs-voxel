import { Color3, Scene } from "@babylonjs/core";

export default class MapFog {
  public static readonly fogEndUnderWater = 130;
  public static readonly fogEndAboveWater = 33000;

  public static readonly fogStartUnderWater = 50;
  public static readonly fogStartAboveWater = 33000;

  constructor(private scene: Scene) {
    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogStart = MapFog.fogStartUnderWater;
    scene.fogEnd = MapFog.fogEndUnderWater;
    scene.fogColor = new Color3(0.0, 0.0, 0.1);
    scene.fogDensity = 0.9;
  }
}
