import { SETTING_PARAMS } from "../SETTINGS_PARAMS";

/**
 * Far-tile LOD ladder (LOD6+).
 *
 * Beyond the per-chunk LOD bands, the world is covered by square TILES that
 * grow geometrically with distance while their voxel sampling step grows
 * proportionally. Tile count per ring stays bounded, so real decimated
 * geometry can extend to FAR_TILE_DISTANCE chunks without an explosion of
 * objects or draw work — the same trick Voxy / Distant Horizons use.
 */

export interface FarTileLevelDef {
	/** lodLevel carried by tiles of this ring (matches chunk LOD numbering). */
	lod: number;
	/** Tile edge length in base chunks (32 blocks each). */
	tileSizeChunks: number;
	/** Voxel sample step in blocks (1 sample per step^2 column cell). */
	voxelStep: number;
	/** Inner radius (chunks) of this ring; tiles spawn at >= this distance. */
	ringInnerChunks: number;
	/** Outer radius (chunks) of this ring. */
	ringOuterChunks: number;
}

const BASE_CHUNK_SIZE = 32;

/**
 * Static ladder definition. Ring widths double per level so every ring
 * contains a similar number of tiles.
 *
 *   LOD6:  2x2-chunk tiles, step 8,  ring +34  -> reach  55 chunks
 *   LOD7:  4x4-chunk tiles, step 16, ring +66  -> reach 121 chunks
 *   LOD8:  8x8-chunk tiles, step 32, ring +130 -> reach 251 chunks
 *   LOD9:  8x8-chunk tiles, step 32, ring +261 -> reach 512 chunks
 */
function buildLadder(farDistance: number): FarTileLevelDef[] {
	if (farDistance <= 0) return [];

	// Inner edge of the far system: just past the outermost per-chunk band.
	let inner =
		SETTING_PARAMS.RENDER_DISTANCE +
		Math.max(
			SETTING_PARAMS.LOD_1_OFFSET,
			SETTING_PARAMS.LOD_2_OFFSET,
			SETTING_PARAMS.LOD_3_OFFSET,
			SETTING_PARAMS.LOD_4_OFFSET,
			SETTING_PARAMS.LOD_5_OFFSET,
		);

	const levels: FarTileLevelDef[] = [];
	const ladders = [
		{ size: 2, step: 8 },
		{ size: 4, step: 16 },
		{ size: 8, step: 32 },
		{ size: 8, step: 32 },
	];

	for (let i = 0; i < ladders.length; i++) {
		const { size, step } = ladders[i];
		const remaining = ladders.length - i;
		// The last level always extends to the configured horizon.
		const outer =
			remaining === 1
				? farDistance
				: Math.min(farDistance, inner * 2 + 1 + size);

		if (outer <= inner) break;

		levels.push({
			lod: 6 + i,
			tileSizeChunks: size,
			voxelStep: step,
			ringInnerChunks: inner,
			ringOuterChunks: outer,
		});

		inner = outer;
	}

	return levels;
}

// ---------------------------------------------------------------------------
// Module state (rebuilt when the settings value changes)
// ---------------------------------------------------------------------------

let _cachedFarDistance = -1;
let _cachedLevels: FarTileLevelDef[] = [];

export function getFarTileLevels(): FarTileLevelDef[] {
	const far = SETTING_PARAMS.FAR_TILE_DISTANCE;
	if (_cachedFarDistance !== far) {
		_cachedFarDistance = far;
		_cachedLevels = buildLadder(far);
	}
	return _cachedLevels;
}

export function isFarTilesEnabled(): boolean {
	return SETTING_PARAMS.FAR_TILE_DISTANCE > 0 && getFarTileLevels().length > 0;
}

/** Horizon of the far-tile system in blocks (0 when disabled). */
export function farTileReachBlocks(): number {
	const levels = getFarTileLevels();
	if (levels.length === 0) return 0;
	return levels[levels.length - 1].ringOuterChunks * BASE_CHUNK_SIZE;
}

export function farTileOutermostRingChunks(): number {
	const levels = getFarTileLevels();
	return levels.length > 0 ? levels[levels.length - 1].ringOuterChunks : 0;
}

/**
 * Which ladder level covers a chunk-distance (Chebyshev), or -1 when the
 * distance belongs to the per-chunk bands / is beyond the horizon.
 */
export function levelForChunkDistance(chunkDist: number): number {
	const levels = getFarTileLevels();
	for (let i = 0; i < levels.length; i++) {
		const lv = levels[i];
		if (chunkDist >= lv.ringInnerChunks && chunkDist < lv.ringOuterChunks) {
			return i;
		}
	}
	return -1;
}

/** Tile-grid coordinate for a world block coordinate at a tile size. */
export function worldToTileCoord(
	worldBlock: number,
	tileSizeBlocks: number,
): number {
	return Math.floor(worldBlock / tileSizeBlocks);
}
