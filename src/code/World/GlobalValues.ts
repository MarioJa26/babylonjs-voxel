import { Vector3 } from "@babylonjs/core";

export class GlobalValues {
  public static DEBUG = false;
  public static readonly CREATE_ATLAS = false;

  public static readonly INIT_CONNECTION = false;
  public static readonly CACHE_TEXTURES = true;
  public static readonly TEXTURE_VERSION = 1;

  // When true, prevents chunks from being saved to IndexedDB. Useful for testing generation.
  public static readonly DISABLE_CHUNK_SAVING = true;
  public static readonly DISABLE_CHUNK_LOADING = true;

  public static skyLightDirection = new Vector3(-1, -2, -1);
  public static GLOBAL_TIME = 0;
  public static DAY_DURATION_MS = 10 * 60 * 1000;
}
