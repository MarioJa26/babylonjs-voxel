import type { Biome } from "../Biome/BiomeTypes";
import type { ColumnPrepassQuery, PlaceBlockFn } from "../SurfaceGenerator";

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

/**
 * Resolver may return a shared scratch object — callers must consume
 * {entry,localX,localZ} synchronously and not retain the reference across
 * another resolver call. This avoids allocating a fresh wrapper per ground
 * sample (footprintGround calls it ~25× per house).
 */
export type ColumnPrepassResolver = (
	worldX: number,
	worldZ: number,
) => ColumnPrepassQuery;

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

	/**
	 * Highest world Y this feature can place a block at in the given world
	 * column, or -1 when the column is outside the feature's footprint.
	 *
	 * WHY THIS EXISTS. The streaming controller decides which chunk-Y layers
	 * of a column can be skipped as "provably empty sky", using the terrain
	 * heightmap as the bound. A structure that reaches above the terrain —
	 * a tower is 60-80 blocks of solid stone on top of the ground — lives in
	 * exactly the layers that bound would skip. Without this query the tower's
	 * upper chunks are never created by the movement path and are never
	 * re-evaluated by the LOD refresh, so the structure is truncated and its
	 * LOD never updates.
	 *
	 * Optional: features that never rise above the terrain (the vast
	 * majority) do not implement it and cost nothing.
	 *
	 * `seed` is the integer world seed — the same value the generator passes
	 * to `generate()`, so the footprint test reproduces the generator's
	 * placement exactly.
	 */
	columnTopHeight?(worldX: number, worldZ: number, seed: number): number;

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
		emitContext?: StructureEmitContext,
	): void;
}

/**
 * Per-chunk scratch that lets a feature claim the structures it has already
 * emitted into the chunk currently being generated.
 *
 * The placer probes a 5x5 window of chunk positions for every chunk it
 * generates. A feature whose structure is placed per REGION resolves the same
 * region from every position inside that region, so without a claim the same
 * structure was emitted into the same chunk once per position. The Maya
 * temple was emitted 418 times into one chunk, and that is where the 500 ms
 * generation tail came from.
 *
 * Claiming is keyed by (feature, key) so two features that happen to resolve
 * the same key never block each other, and the context is created per chunk
 * so a claim never leaks into the next chunk.
 */
export interface StructureEmitContext {
	/**
	 * Claim `key` for `feature` in the chunk currently being generated.
	 *
	 * @returns true the first time the pair is seen — the caller should emit.
	 *   false on every later call — the caller should skip.
	 */
	tryClaim(feature: IWorldFeature, key: string): boolean;
}
