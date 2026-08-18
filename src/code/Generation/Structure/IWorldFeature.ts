import type { Biome } from "../Biome/BiomeTypes";
import type {
	ColumnPrepassCacheEntry,
	PlaceBlockFn,
} from "../SurfaceGenerator";

/**
 * Optional absolute vertical bounds for an IWorldFeature, expressed in world
 * Y coordinates. When set, SurfaceGenerator will skip this feature for any
 * chunkY whose Y-range cannot possibly intersect these bounds — turning 8×N
 * feature invocations per chunk slice into a handful.
 *
 * Bounds must be conservative: `minWorldY` should be the lowest Y the
 * feature can ever place a block at, and `maxWorldY` the highest. The check
 * uses these as hard absolute limits, so features that pick a location
 * based on neighbor surface Y (e.g. ravines) must account for the
 * neighbor's worst-case surface.
 *
 * If `undefined`, the feature is invoked for every chunkY (preserving the
 * previous always-run behaviour for features that don't expose bounds).
 */
export type FeatureVerticalBounds = {
	minWorldY: number;
	maxWorldY: number;
};

export type ColumnPrepassResolver = (
	worldX: number,
	worldZ: number,
) => {
	entry: ColumnPrepassCacheEntry;
	localX: number;
	localZ: number;
};

export interface IWorldFeature {
	/**
	 * Vertical bounds relative to the local surface. Optional — features that
	 * don't know their Y range (or that legitimately span any height) should
	 * leave this `undefined`.
	 */
	readonly verticalBounds?: FeatureVerticalBounds;

	/**
	 * How far above the highest surface Y in the chunk this feature may
	 * place blocks.  Used by SurfaceGenerator's canContainStructures gate
	 * so that tall features (e.g. a 500-block butte) are not silently
	 * truncated.
	 *
	 * Defaults to 64 (CHUNK_SIZE * 2) when omitted.
	 */
	readonly maxAboveSurface?: number;

	generate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		_chunkBiome: Biome,
		placeBlock: PlaceBlockFn,
		seed: number,
		chunkSize: number,
		generatingChunkX: number,
		generatingChunkZ: number,
		columnPrepassResolver?: ColumnPrepassResolver,
	): void;
}
