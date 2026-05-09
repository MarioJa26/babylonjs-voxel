// import { Color3, Color4 } from "@babylonjs/core"; // Removed to prevent worker crash

export const SETTING_PARAMS = {
	// --- World Generation & Loading ---
	RENDER_DISTANCE: 12,
	VERTICAL_RENDER_DISTANCE: 6,
	MAX_CHUNK_HEIGHT: 32,
	CHUNK_UNLOAD_DISTANCE_BUFFER: 1, // How many extra chunks to keep before unloading
	// 0 = auto (render-distance based), >0 = explicit per-cycle cap
	CHUNK_LOAD_BATCH_LIMIT: 16,
	CHUNK_UNLOAD_BATCH_LIMIT: 16,
	// Soft budget used by chunk loading scheduler to decide whether to continue
	// work in microtasks or yield to next frame.
	CHUNK_LOADING_FRAME_BUDGET_MS: 8.0,
	VERTICAL_CHUNK_CULLING_FACTOR: 6, // Multiplier for CHUNK_SIZE to cull chunks above/below terrain
	CAMERA_FOV: 93, // Default camera field of view in degrees

	// --- LOD Settings ---
	LOD_0_OFFSET: 0,
	LOD_1_OFFSET: 0,
	LOD_2_OFFSET: 0,
	LOD_3_OFFSET: 0,
	LOD_VERTICAL_0_OFFSET: 0,
	LOD_VERTICAL_1_OFFSET: 2,
	LOD_VERTICAL_2_OFFSET: 4,
	LOD_VERTICAL_3_OFFSET: 6,
	LOD_PRECOMPUTE_HORIZONTAL_OFFSET: 14,
	LOD_PRECOMPUTE_VERTICAL_OFFSET: 4,

	DISTANT_RENDER_DISTANCE: 32, //128,
	LOD_PRECOMPUTE_SCHEDULE_THROTTLE_MS: 220, //120
	LOD_PRECOMPUTE_MAX_ENQUEUE_PER_UPDATE: 48,
	// 0 = unlimited dispatch while workers are idle
	CHUNK_WORKER_DISPATCH_BUDGET_PER_TICK: 12,
	// 0 = auto (derived from hardware concurrency); >0 = explicit worker pool size
	CHUNK_WORKER_POOL_SIZE: 0,

	// --- Day/Night Cycle ---
	DAY_DURATION_MS: 10 * 60 * 1000, // 10 minutes for a full day

	// --- Graphics & Rendering ---
	ENABLE_SSAO: false,
	SSAO_RATIO: 0.5,
	SSAO_COMBINE_RATIO: 2.0,

	// --- Block Highlighter ---
	HIGHLIGHT_ALPHA: 0.0,
	HIGHLIGHT_COLOR: [0, 0.33, 0], // Stored as array [r, g, b]
	HIGHLIGHT_EDGE_WIDTH: 1.1,
	HIGHLIGHT_EDGE_COLOR: [0, 0.33, 0, 0.7], // Stored as array [r, g, b, a]

	// --- Lighting ---
	HEMISPHERIC_LIGHT_INTENSITY: 1.0,
};
