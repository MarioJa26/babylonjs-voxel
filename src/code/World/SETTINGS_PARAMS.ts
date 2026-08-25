export const SETTING_PARAMS = {
	// --- World Generation & Loading ---
	RENDER_DISTANCE: 3,
	VERTICAL_RENDER_DISTANCE: 5,
	// Max chunks below y=0 that render caves while on the surface.
	// While isInCave, the cave-mode rule set widens this instead.
	CAVE_VERTICAL_RENDER_DISTANCE: 2,
	MIN_CHUNK_Y: -32,
	MAX_CHUNK_HEIGHT: 64,
	CHUNK_UNLOAD_DISTANCE_BUFFER: 1, // How many extra chunks to keep before unloading
	// 0 = auto (render-distance based), >0 = explicit per-cycle cap
	CHUNK_LOAD_BATCH_LIMIT: 255,
	CHUNK_UNLOAD_BATCH_LIMIT: 255,
	// Soft budget used by chunk loading scheduler to decide whether to continue
	// work in microtasks or yield to next frame.
	CHUNK_LOADING_FRAME_BUDGET_MS: 2.0,
	VERTICAL_CHUNK_CULLING_FACTOR: 6, // Multiplier for CHUNK_SIZE to cull chunks above/below terrain
	CAMERA_FOV: 90, // Default camera field of view in degrees

	// --- LOD Settings ---
	LOD_0_OFFSET: 0,
	LOD_1_OFFSET: 2,
	LOD_2_OFFSET: 4,
	LOD_3_OFFSET: 6,
	// Geometric downsampling begins at LOD4 (step = 1 << (lod - 3)).
	LOD_4_OFFSET: 10,
	LOD_5_OFFSET: 18,
	LOD_VERTICAL_0_OFFSET: 0,
	LOD_VERTICAL_1_OFFSET: 2,
	LOD_VERTICAL_2_OFFSET: 4,
	LOD_VERTICAL_3_OFFSET: 6,
	LOD_VERTICAL_4_OFFSET: 8,
	LOD_VERTICAL_5_OFFSET: 12,
	LOD_PRECOMPUTE_HORIZONTAL_OFFSET: 14,
	LOD_PRECOMPUTE_VERTICAL_OFFSET: 4,

	DISTANT_RENDER_DISTANCE: 128, //128,
	// Far-tile LOD system (LOD6-9): real decimated voxel geometry out to this
	// many chunks in every direction. 0 disables far tiles.
	FAR_TILE_DISTANCE: 512,
	LOD_PRECOMPUTE_SCHEDULE_THROTTLE_MS: 120, //120
	LOD_PRECOMPUTE_MAX_ENQUEUE_PER_UPDATE: 48,
	// 0 = unlimited dispatch while workers are idle
	CHUNK_WORKER_DISPATCH_BUDGET_PER_TICK: 0,
	// 0 = auto (derived from hardware concurrency); >0 = explicit worker pool size
	CHUNK_WORKER_POOL_SIZE: 0,

	// --- Day/Night Cycle ---
	DAY_DURATION_MS: 10 * 60 * 2000, // 20 minutes for a full day

	// --- Block Highlighter ---
	HIGHLIGHT_ALPHA: 0.0,
	HIGHLIGHT_COLOR: [0, 0.33, 0], // Stored as array [r, g, b]
	HIGHLIGHT_EDGE_WIDTH: 1.1,
	HIGHLIGHT_EDGE_COLOR: [0, 0.33, 0, 0.7], // Stored as array [r, g, b, a]

	// --- Lighting ---
	HEMISPHERIC_LIGHT_INTENSITY: 1.0,

	// --- Rendering quality / GPU load ---
	// Multiplier applied to window.devicePixelRatio for the WebGPU canvas.
	// 1 = native resolution; 0.75/0.5 render fewer pixels (biggest single
	// fragment-cost lever on HiDPI displays).
	RENDER_SCALE: 1,
	// 4x MSAA on the main surface. Costly (~4x raster + resolve); voxel
	// geometry barely benefits AND measured profiling shows it starves the
	// GPU so hard that DOM UI (inventory palette) scrolling drops to ~20fps
	// even while the world render is throttled. Keep false unless edges look
	// jaggy on a beefy GPU.
	ENABLE_MSAA: true,
	// Frame-rate cap. The engine loop is an uncapped requestAnimationFrame,
	// so on 120Hz+ monitors the GPU renders flat-out even when each frame is
	// cheap. 60 is a good default; 0 = uncapped.
	FPS_CAP: 60,
	// Aggregate cap (MiB) on face-arena storage across ALL arenas (CPU+GPU
	// each). Without it, every arena may legally grow to its own 128 MiB
	// binding cap (~0.8 GB total with the usual 6 arenas).
	ARENA_BUDGET_MB: 192,
};
