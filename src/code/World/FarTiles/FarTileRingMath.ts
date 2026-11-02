/**
 * Pure far-tile ring math: tile-key packing, ring-window arithmetic and the
 * tile-distance helper shared by the manager's three distance call sites.
 *
 * ZERO imports. Like FarTileFaceFormat, this module must stay dependency-free
 * so the self-test can compile and run it standalone (see
 * scripts/far-tile-selftest.ts).
 *
 * Ring windows
 * ------------
 * A ring is half-open in Chebyshev chunk distance: [inner, outer). Loading is
 * scheduled ONLY inside the official ring; eviction uses a wider retention
 * window (the ring plus a margin on BOTH edges) so hysteresis retains
 * tiles slightly past the boundary without ever scheduling new tiles there.
 * See UNLOAD_MARGIN_CHUNKS and farTileLoadWindow/farTileRetentionWindow.
 */

/**
 * Chunk-radius margin kept loaded PAST each ring boundary before a tile is
 * evicted. Hysteresis only widens eviction; the load window is never widened
 * (see the bug note in farTileLoadWindow).
 */
export const FAR_TILE_UNLOAD_MARGIN_CHUNKS = 16;

export interface FarTileWindow {
	/** Inclusive inner radius, in chunks. */
	inner: number;

	/** Exclusive outer radius, in chunks. */
	outer: number;
}

/**
 * The window in which a level SCHEDULES new tiles — exactly the ladder's
 * official ring, never extended by the margin.
 *
 * The old manager used `ringOuterChunks + UNLOAD_MARGIN_CHUNKS` as the load
 * cutoff, which let a level keep loading tiles past its official outer
 * radius (e.g. rings ending at 80 / starting at 80 could both load to 96).
 * Scheduling must use exactly [ringInnerChunks, ringOuterChunks).
 */
export function farTileLoadWindow(
	innerChunks: number,
	outerChunks: number,
): FarTileWindow {
	return { inner: innerChunks, outer: outerChunks };
}

/**
 * The window in which an already-resident tile may STAY loaded.
 *
 * Both edges get a margin: without the inner margin, movement TOWARD a tile
 * evicts it the moment its area crosses the inner boundary, destroying
 * hysteresis on that edge and causing churn.
 */
export function farTileRetentionWindow(
	innerChunks: number,
	outerChunks: number,
): FarTileWindow {
	return {
		inner: Math.max(0, innerChunks - FAR_TILE_UNLOAD_MARGIN_CHUNKS),
		outer: outerChunks + FAR_TILE_UNLOAD_MARGIN_CHUNKS,
	};
}

/**
 * Area-to-point Chebyshev distance from the player's chunk to a tile's full
 * block range, in chunk units.
 *
 * The tile's area covers chunk coordinates
 *   [tileIndex * size, tileIndex * size + size - 1]
 * on each axis (size chunks of 32 blocks each). The distance is zero while
 * the player is INSIDE the tile's area and grows to the nearest edge
 * boundary otherwise, which is exactly the notion a half-open ring test
 * needs: a tile is inside a ring iff any single chunk of it falls in
 * [ringInnerChunks, ringOuterChunks).
 *
 * Center-based distance (the previous helper, computed from
 * `tileIndex * size + size / 2`) blurs tile-boundary semantics across whole
 * tiles because one large tile spans several chunk distances. Keep all three
 * manager call sites (candidate discovery, loaded-tile eviction,
 * pending-result validation) and the tests on this one function so ring
 * coverage semantics can only drift by editing it — never independently.
 *
 * `tileSizeChunks` must be a positive integer (validated at ladder build
 * time); a non-positive size would make maxX < minX and silently widen the
 * window on that axis.
 */
export function tileChebyshevDistanceChunks(
	playerChunkX: number,
	playerChunkZ: number,
	tileX: number,
	tileZ: number,
	tileSizeChunks: number,
): number {
	const minWidth = tileX * tileSizeChunks;
	const minZ = tileZ * tileSizeChunks;
	const maxX = minWidth + tileSizeChunks - 1;
	const maxZ = minZ + tileSizeChunks - 1;

	const dx =
		playerChunkX < minWidth
			? minWidth - playerChunkX
			: playerChunkX > maxX
				? playerChunkX - maxX
				: 0;

	const dz =
		playerChunkZ < minZ
			? minZ - playerChunkZ
			: playerChunkZ > maxZ
				? playerChunkZ - maxZ
				: 0;

	return dx > dz ? dx : dz;
}

// ---------------------------------------------------------------------------
// Tile keys
// ---------------------------------------------------------------------------

/**
 * Collision-free key within JavaScript's safe-integer range:
 *
 * level: 4 bits at positions 48-51 (up to 16 LOD levels)
 * tx: 24 bits at positions 24-47
 * tz: 24 bits at positions 0-23
 *
 * Maximum key is 2**52 - 1, safely below MAX_SAFE_INTEGER (2**53 - 1).
 * The layout intentionally trades off per-axis tile range for level count.
 * The previous 26-bit-per-axis layout exceeded the safe-integer range for
 * level indices >= 2 (level * 2**52 with 52 coordinate bits), causing
 * precision loss and key collisions across the 4-level ladder. Coordinates
 * remain safe within ±8,388,607 tile units — vastly beyond the configured
 * horizon (FAR_TILE_DISTANCE 256 chunks => at most ~128 tiles per axis).
 */
export const FAR_TILE_KEY_LEVEL_BITS = 4;
export const FAR_TILE_MAX_LEVEL_INDEX = 2 ** FAR_TILE_KEY_LEVEL_BITS - 1;
export const FAR_TILE_KEY_AXIS_BITS = 24;
const FAR_TILE_KEY_AXIS_SIZE = 2 ** FAR_TILE_KEY_AXIS_BITS;
const FAR_TILE_KEY_AXIS_MASK = FAR_TILE_KEY_AXIS_SIZE - 1;
const FAR_TILE_KEY_LEVEL_MULTIPLIER = 2 ** (FAR_TILE_KEY_AXIS_BITS * 2);
const FAR_TILE_KEY_X_MULTIPLIER = FAR_TILE_KEY_AXIS_SIZE;

export function packTileKey(
	levelIndex: number,
	tx: number,
	tz: number,
): number {
	const packedX = tx & FAR_TILE_KEY_AXIS_MASK;
	const packedZ = tz & FAR_TILE_KEY_AXIS_MASK;

	return (
		levelIndex * FAR_TILE_KEY_LEVEL_MULTIPLIER +
		packedX * FAR_TILE_KEY_X_MULTIPLIER +
		packedZ
	);
}

export function farTileKeyLevel(key: number): number {
	// NO bitwise shift here: `>>>` operates on 32-bit values and `key >>> 48`
	// wraps to `>>> 16` (shift counts are mod 32), silently returning garbage
	// level bits. Plain division is exact for keys up to 2**53.
	return Math.floor(key / FAR_TILE_KEY_LEVEL_MULTIPLIER);
}

export function farTileKeyTileX(key: number): number {
	return Math.floor(key / FAR_TILE_KEY_AXIS_SIZE) & FAR_TILE_KEY_AXIS_MASK;
}

export function farTileKeyTileZ(key: number): number {
	// Keys are always non-negative in their valid domain, so `modulo` never
	// goes negative; the double-wrap belt covers callers probing the edges.
	return (
		((key % FAR_TILE_KEY_AXIS_SIZE) + FAR_TILE_KEY_AXIS_SIZE) %
		FAR_TILE_KEY_AXIS_SIZE
	);
}

// ---------------------------------------------------------------------------
// Pre-seed capacity estimation
// ---------------------------------------------------------------------------

/**
 * Number of tiles whose area intersects the ring [innerChunks, outerChunks),
 * given square tiles of `tileSizeChunks` chunks.
 *
 * This mirrors the scheduler's population, not an approximation: a tile
 * loads as soon as ANY of its chunks reaches Chebyshev distance < outer
 * while the load test is the ring's only gate, so the tile count bounding
 * the arena's steady-state occupancy is the ring's area quotient rounded
 * up (tiles straddling the outer boundary allocate whole slots the moment
 * one of their chunks enters the ring).
 *
 * Result feeds capacity PRE-SEEDING only — it must never gate behavior,
 * just memory sizing.
 */
export function farTileRingTileCount(
	innerChunks: number,
	outerChunks: number,
	tileSizeChunks: number,
): number {
	const span = Math.floor(tileSizeChunks);

	if (span <= 0) {
		return 0;
	}

	const inner = Math.max(0, Math.floor(innerChunks));
	const outer = Math.max(inner, Math.floor(outerChunks));

	if (outer <= inner) {
		return 0;
	}

	const area = outer * outer - inner * inner;

	return Math.ceil(area / (span * span));
}

/**
 * Pre-seed face capacity for ONE level's terrain arena.
 *
 * `cellsPerAxis` is the level's cells-per-tile-axis (tileSizeChunks * 32 /
 * voxelStep — integral per ladder validation) and `facesPerCell` the
 * expected average packed faces per cell (terrain emits one top face per
 * land cell plus side faces; 2 measured out as the typical full-ring mix).
 *
 * The estimate is rounded UP to a power of two so the arena's own 2x growth
 * stays aligned, floored at 4,096 faces (64 KiB — a trivial ladder is not
 * worth a special case) and capped at 2^21 faces (32 MiB of face words;
 * for exotic settings the existing growth path resumes instead of
 * pre-reserving absurd buffers).
 */
export function estimateFarTileFaceCapacity(
	innerChunks: number,
	outerChunks: number,
	tileSizeChunks: number,
	cellsPerAxis: number,
	facesPerCell: number,
): number {
	const tiles = farTileRingTileCount(innerChunks, outerChunks, tileSizeChunks);
	const cells = Math.max(0, Math.floor(cellsPerAxis));
	const ratio = Math.max(0, facesPerCell);
	const estimate = tiles * cells * cells * ratio;

	const CAPACITY_FACES_CAP = 1 << 21;
	const CAPACITY_FACES_FLOOR = 1 << 12;

	let seeded = CAPACITY_FACES_FLOOR;

	while (seeded < estimate && seeded < CAPACITY_FACES_CAP) {
		seeded <<= 1;
	}

	return seeded;
}
