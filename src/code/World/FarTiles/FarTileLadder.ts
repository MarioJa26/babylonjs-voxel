import { SETTING_PARAMS } from "../SETTINGS_PARAMS";

/**
 * Far-tile LOD ladder (LOD6+).
 *
 * Beyond the per-chunk LOD bands, the world is covered by square tiles that
 * grow geometrically with distance while their voxel sampling step grows
 * proportionally.
 */
export interface FarTileLevelDef {
	/** lodLevel carried by tiles of this ring. */
	lod: number;

	/** Tile edge length in base chunks (32 blocks each). */
	tileSizeChunks: number;

	/** Voxel sample step in blocks. */
	voxelStep: number;

	/** Inclusive inner radius of this ring, in chunks. */
	ringInnerChunks: number;

	/** Exclusive outer radius of this ring, in chunks. */
	ringOuterChunks: number;
}

const BASE_CHUNK_SIZE = 32;

interface LadderDefinition {
	readonly size: number;
	readonly step: number;
}

const LADDER_DEFINITIONS: readonly LadderDefinition[] = [
	{ size: 2, step: 8 },
	{ size: 4, step: 16 },
	{ size: 8, step: 32 },
	{ size: 16, step: 64 },
];

const LOD_OFFSETS = (): readonly number[] => [
	SETTING_PARAMS.LOD_1_OFFSET,
	SETTING_PARAMS.LOD_2_OFFSET,
	SETTING_PARAMS.LOD_3_OFFSET,
	SETTING_PARAMS.LOD_4_OFFSET,
	SETTING_PARAMS.LOD_5_OFFSET,
];

function getFarTileInnerRadius(): number {
	const offsets = LOD_OFFSETS();

	let maximumOffset = offsets[0];
	for (let i = 1; i < offsets.length; i++) {
		if (offsets[i] > maximumOffset) {
			maximumOffset = offsets[i];
		}
	}

	return SETTING_PARAMS.RENDER_DISTANCE + maximumOffset;
}

/**
 * Builds the static far-tile ladder up to the configured horizon.
 *
 * Ring widths grow approximately geometrically, keeping the number of tiles
 * per ring bounded while voxel resolution decreases with distance.
 */
function buildLadder(
	farDistance: number,
	initialInnerRadius: number,
): FarTileLevelDef[] {
	if (farDistance <= initialInnerRadius) {
		return [];
	}

	const levels: FarTileLevelDef[] = [];
	let inner = initialInnerRadius;

	for (let i = 0; i < LADDER_DEFINITIONS.length; i++) {
		const definition = LADDER_DEFINITIONS[i];
		const isLastLevel = i === LADDER_DEFINITIONS.length - 1;

		const outer = isLastLevel
			? farDistance
			: Math.min(farDistance, inner * 2 + 1 + definition.size);

		if (outer <= inner) {
			break;
		}

		levels.push({
			lod: 6 + i,
			tileSizeChunks: definition.size,
			voxelStep: definition.step,
			ringInnerChunks: inner,
			ringOuterChunks: outer,
		});

		inner = outer;

		if (inner >= farDistance) {
			break;
		}
	}

	return levels;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let cachedFarDistance = Number.NaN;
let cachedInnerRadius = Number.NaN;
let cachedLevels: FarTileLevelDef[] = [];

export function getFarTileLevels(): FarTileLevelDef[] {
	const farDistance = SETTING_PARAMS.FAR_TILE_DISTANCE;
	const innerRadius = getFarTileInnerRadius();

	if (cachedFarDistance !== farDistance || cachedInnerRadius !== innerRadius) {
		cachedFarDistance = farDistance;
		cachedInnerRadius = innerRadius;
		cachedLevels = buildLadder(farDistance, innerRadius);
	}

	return cachedLevels;
}

export function isFarTilesEnabled(): boolean {
	if (SETTING_PARAMS.FAR_TILE_DISTANCE <= 0) {
		return false;
	}

	return getFarTileLevels().length !== 0;
}

/** Horizon of the far-tile system in blocks, or zero when disabled. */
export function farTileReachBlocks(): number {
	return farTileOutermostRingChunks() * BASE_CHUNK_SIZE;
}

export function farTileOutermostRingChunks(): number {
	const levels = getFarTileLevels();
	const levelCount = levels.length;

	return levelCount === 0 ? 0 : levels[levelCount - 1].ringOuterChunks;
}

/**
 * Returns the ladder-array index covering a Chebyshev chunk distance.
 *
 * Returns -1 when the distance belongs to the per-chunk bands or lies beyond
 * the far-tile horizon.
 */
export function levelForChunkDistance(chunkDist: number): number {
	const levels = getFarTileLevels();

	for (let i = 0; i < levels.length; i++) {
		const level = levels[i];

		if (chunkDist < level.ringInnerChunks) {
			return -1;
		}

		if (chunkDist < level.ringOuterChunks) {
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
