// import { Color3, Color4 } from "@babylonjs/core"; // Removed to prevent worker crash

export class SettingParams {
  // --- World Generation & Loading ---
  public static RENDER_DISTANCE = 6;
  public static VERTICAL_RENDER_DISTANCE = 12;
  public static MAX_CHUNK_HEIGHT = 32;
  public static CHUNK_UNLOAD_DISTANCE_BUFFER = 6; // How many extra chunks to keep before unloading
  public static CHUNK_SORT_DISTANCE_THRESHOLD_SQ = 16; // Squared distance under which to sort chunks for loading
  public static VERTICAL_CHUNK_CULLING_FACTOR = 6; // Multiplier for CHUNK_SIZE to cull chunks above/below terrain
  public static CAMERA_FOV = 90; // Default camera field of view in degrees

  public static DISTANT_RENDER_DISTANCE = 216;

  // --- Day/Night Cycle ---
  public static DAY_DURATION_MS = 10 * 60 * 1000; // 10 minutes for a full day

  // --- Graphics & Rendering ---
  public static ENABLE_SSAO = false;
  public static SSAO_RATIO = 0.5;
  public static SSAO_COMBINE_RATIO = 2.0;

  // --- Block Highlighter ---
  public static HIGHLIGHT_ALPHA = 0.0;
  public static HIGHLIGHT_COLOR = [0, 0.1, 0]; // Stored as array [r, g, b]
  public static HIGHLIGHT_EDGE_WIDTH = 1.1;
  public static HIGHLIGHT_EDGE_COLOR = [0, 0.1, 0, 0.7]; // Stored as array [r, g, b, a]

  // --- Lighting ---
  public static HEMISPHERIC_LIGHT_INTENSITY = 10.5;
  public static DIRECTIONAL_LIGHT_INTENSITY = 1;
}
