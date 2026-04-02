// import { Color3, Color4 } from "@babylonjs/core"; // Removed to prevent worker crash

export class SettingParams {
  // --- World Generation & Loading ---
  public static RENDER_DISTANCE = 6;
  public static VERTICAL_RENDER_DISTANCE = 6;
  public static MAX_CHUNK_HEIGHT = 32;
  public static CHUNK_UNLOAD_DISTANCE_BUFFER = 1; // How many extra chunks to keep before unloading
  // 0 = auto (render-distance based), >0 = explicit per-cycle cap
  public static CHUNK_LOAD_BATCH_LIMIT = 0;
  public static CHUNK_UNLOAD_BATCH_LIMIT = 0;
  // Soft budget used by chunk loading scheduler to decide whether to continue
  // work in microtasks or yield to next frame.
  public static CHUNK_LOADING_FRAME_BUDGET_MS = 5.0;
  public static VERTICAL_CHUNK_CULLING_FACTOR = 6; // Multiplier for CHUNK_SIZE to cull chunks above/below terrain
  public static CAMERA_FOV = 93; // Default camera field of view in degrees

  public static DISTANT_RENDER_DISTANCE = 128;
  public static LOD_PRECOMPUTE_SCHEDULE_THROTTLE_MS = 120;
  public static LOD_PRECOMPUTE_MAX_ENQUEUE_PER_UPDATE = 48;
  // 0 = unlimited dispatch while workers are idle
  public static CHUNK_WORKER_DISPATCH_BUDGET_PER_TICK = 8;

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
  public static HEMISPHERIC_LIGHT_INTENSITY = 1.0;
}
