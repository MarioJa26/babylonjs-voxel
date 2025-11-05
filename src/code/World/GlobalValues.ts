import { Vector3 } from "@babylonjs/core";

export class GlobalValues {
  public static DEBUG = false;
  public static readonly CREATE_ATLAS = false;

  public static readonly ENABLE_SSAO = false;

  public static skyLightDirection = new Vector3(-1, -2, -1);
  public static GLOBAL_TIME = 0;
  public static DAY_DURATION_MS = 10 * 60 * 1000;
}
