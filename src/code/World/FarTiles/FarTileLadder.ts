// .js suffix: keeps this module compilable/runnable outside Vite (the
// standalone far-tile self-test compiles the import graph with plain tsc).
import { SETTING_PARAMS } from "../SETTINGS_PARAMS.js";

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

/**
 * Blocks per chunk edge. Exported so the manager's arena pre-seeding and
 * anything else deriving cells-per-tile from ladder definitions shares one
 * constant instead of maintaining another private copy.
 */
export const BASE_CHUNK_SIZE = 32;

interface LadderDefinition {
	readonly size: number;
	readonly step: number;
}

const FIRST_FAR_TILE_LOD = 6;

const LADDER_DEFINITIONS: readonly LadderDefinition[] = [
	{ size: 2, step: 8 },
	{ size: 4, step: 16 },
	{ size: 8, step: 32 },
	{ size: 16, step: 64 },
];

/**
 * Normalizes a chunk-distance setting into a finite, non-negative integer.
 *
 * Non-finite values are treated as zero so malformed runtime settings cannot
 * produce NaN or infinite ring boundaries.
 */
function normalizeChunkDistance(value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		return 0;
	}

	return Math.floor(value);
}

/**
 * Returns the outer edge of the per-chunk LOD bands.
 *
 * This intentionally avoids allocating a temporary offsets array because the
 * function may run whenever far-tile settings are checked.
 */
function getFarTileInnerRadius(): number {
	let maximumOffset = SETTING_PARAMS.LOD_1_OFFSET;

	const offset2 = SETTING_PARAMS.LOD_2_OFFSET;
	if (offset2 > maximumOffset) {
		maximumOffset = offset2;
	}

	const offset3 = SETTING_PARAMS.LOD_3_OFFSET;
	if (offset3 > maximumOffset) {
		maximumOffset = offset3;
	}

	const offset4 = SETTING_PARAMS.LOD_4_OFFSET;
	if (offset4 > maximumOffset) {
		maximumOffset = offset4;
	}

	const offset5 = SETTING_PARAMS.LOD_5_OFFSET;
	if (offset5 > maximumOffset) {
		maximumOffset = offset5;
	}

	/*
	 * Normalize the final sum rather than every offset separately. This
	 * preserves the original maximum-offset behavior for valid settings.
	 */
	return normalizeChunkDistance(SETTING_PARAMS.RENDER_DISTANCE + maximumOffset);
}

/**
 * A structurally valid ladder definition must have:
 *
 * - a positive integer tile size
 * - a positive integer voxel step
 * - a tile edge length divisible by the voxel step
 * - at least one terrain cell per tile axis
 *
 * With the stock definitions, every level contains an 8 × 8 terrain-cell
 * grid:
 *
 * - 2 chunks × 32 blocks / step 8 = 8 cells
 * - 4 chunks × 32 blocks / step 16 = 8 cells
 * - 8 chunks × 32 blocks / step 32 = 8 cells
 * - 16 chunks × 32 blocks / step 64 = 8 cells
 *
 * Invalid definitions are skipped with a warning instead of aborting world
 * loading. A smaller valid ladder is preferable to no far-tile ladder.
 */
function isStructurallyValid(definition: LadderDefinition): boolean {
	const size = definition.size;
	const step = definition.step;

	if (
		!Number.isInteger(size) ||
		!Number.isInteger(step) ||
		size <= 0 ||
		step <= 0
	) {
		return false;
	}

	const tileSizeBlocks = size * BASE_CHUNK_SIZE;

	/*
	 * Both operands are positive integers here. Divisibility guarantees that
	 * cellsPerAxis is also a positive integer, so computing and separately
	 * validating that quotient is unnecessary.
	 */
	return tileSizeBlocks % step === 0;
}

/**
 * Builds the far-tile ladder from validated definitions up to the horizon.
 *
 * Ring widths grow approximately geometrically, keeping the number of tiles
 * per ring bounded while voxel resolution decreases with distance.
 */
export function buildValidatedLadderLevels(
	definitions: readonly LadderDefinition[],
	rawFarDistance: number,
	rawInitialInnerRadius: number,
): FarTileLevelDef[] {
	const farDistance = normalizeChunkDistance(rawFarDistance);
	const initialInnerRadius = normalizeChunkDistance(rawInitialInnerRadius);

	if (
		farDistance === 0 ||
		farDistance <= initialInnerRadius ||
		definitions.length === 0
	) {
		return [];
	}

	/*
	 * The ladder cannot contain more levels than definitions, so reserving
	 * indirectly is unnecessary. JavaScript arrays grow efficiently for this
	 * very small collection.
	 */
	const levels: FarTileLevelDef[] = [];

	let inner = initialInnerRadius;

	for (let i = 0; i < definitions.length; i++) {
		const definition = definitions[i];
		const lod = FIRST_FAR_TILE_LOD + i;

		if (!isStructurallyValid(definition)) {
			console.warn(
				"[FarTileLadder] skipping structurally invalid ladder " +
					`definition {size: ${definition.size}, ` +
					`step: ${definition.step}}`,
			);

			continue;
		}

		const isLastDefinition = i === definitions.length - 1;

		const outer = isLastDefinition
			? farDistance
			: Math.min(farDistance, inner * 2 + 1 + definition.size);

		if (outer <= inner) {
			break;
		}

		levels.push({
			lod,
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

/**
 * Signature of every ladder field that structurally drives manager resources:
 *
 * - level count and order
 * - LOD
 * - tile size
 * - voxel step
 * - inner and outer ring radii
 *
 * The far-tile manager rebuilds its resources when this signature changes and
 * invalidates requests belonging to the previous ladder generation.
 */
export function getLadderSignature(levels: readonly FarTileLevelDef[]): string {
	const levelCount = levels.length;

	if (levelCount === 0) {
		return "";
	}

	/*
	 * An array plus join avoids repeatedly copying an increasingly large
	 * accumulated string. The ladder is small, but this remains predictable
	 * if more levels are added later.
	 */
	const parts = new Array<string>(levelCount);

	for (let i = 0; i < levelCount; i++) {
		const level = levels[i];

		parts[i] =
			`${level.lod}:` +
			`${level.tileSizeChunks}:` +
			`${level.voxelStep}:` +
			`${level.ringInnerChunks}:` +
			`${level.ringOuterChunks};`;
	}

	return parts.join("");
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/*
 * Cache normalized values. Fractional settings that normalize to the same
 * chunk boundary no longer cause a redundant ladder rebuild.
 */
let cachedFarDistance = Number.NaN;
let cachedInnerRadius = Number.NaN;

let cachedLevels: FarTileLevelDef[] = [];
let cachedSignature = "";

/**
 * Returns the current validated far-tile levels.
 *
 * The same array instance is returned until a structurally relevant setting
 * changes. Callers must treat the returned array and its elements as
 * read-only.
 */
export function getFarTileLevels(): FarTileLevelDef[] {
	const farDistance = normalizeChunkDistance(SETTING_PARAMS.FAR_TILE_DISTANCE);

	const innerRadius = getFarTileInnerRadius();

	if (cachedFarDistance === farDistance && cachedInnerRadius === innerRadius) {
		return cachedLevels;
	}

	const levels = buildValidatedLadderLevels(
		LADDER_DEFINITIONS,
		farDistance,
		innerRadius,
	);

	cachedFarDistance = farDistance;
	cachedInnerRadius = innerRadius;
	cachedLevels = levels;
	cachedSignature = getLadderSignature(levels);

	return levels;
}

/**
 * Stable signature of the current ladder.
 *
 * Calling getFarTileLevels() first ensures this reflects any settings changed
 * since the previous access.
 */
export function getFarTileLadderSignature(): string {
	getFarTileLevels();

	return cachedSignature;
}

/**
 * Returns whether the current settings produce at least one far-tile level.
 */
export function isFarTilesEnabled(): boolean {
	/*
	 * getFarTileLevels() already normalizes and validates FAR_TILE_DISTANCE,
	 * so a separate raw-setting branch would duplicate that work and could
	 * disagree for NaN or Infinity.
	 */
	return getFarTileLevels().length !== 0;
}

/**
 * Horizon of the far-tile system in blocks, or zero when disabled.
 */
export function farTileReachBlocks(): number {
	return farTileOutermostRingChunks() * BASE_CHUNK_SIZE;
}

/**
 * Horizon of the far-tile system in chunks, or zero when disabled.
 */
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
	const levelCount = levels.length;

	if (levelCount === 0 || !Number.isFinite(chunkDist)) {
		return -1;
	}

	/*
	 * Reject distances below the first ring without entering the loop. This
	 * is the common path for chunks handled by the normal per-chunk LODs.
	 */
	if (chunkDist < levels[0].ringInnerChunks) {
		return -1;
	}

	for (let i = 0; i < levelCount; i++) {
		if (chunkDist < levels[i].ringOuterChunks) {
			return i;
		}
	}

	return -1;
}

/**
 * Returns the tile-grid coordinate containing a world block coordinate.
 */
export function worldToTileCoord(
	worldBlock: number,
	tileSizeBlocks: number,
): number {
	return Math.floor(worldBlock / tileSizeBlocks);
}
