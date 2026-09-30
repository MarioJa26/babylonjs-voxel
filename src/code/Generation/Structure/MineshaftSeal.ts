import { getFinalTerrainHeight } from "../TerrainHeightMap";
import {
	buildMineshaftLayout,
	computeMineshaftSealBox,
	MINESHAFT_GRID_SPAN,
	MINESHAFT_SEAL_HALF_EXTENT,
	type MineshaftLayout,
	type MineshaftSealBox,
} from "./MineshaftLayout";
import { computeRegion, type RegionConfig } from "./RegionFeature";

// ---------------------------------------------------------------------------
// Mineshaft resolution + cave sealing.
//
// The cave carver runs AFTER structures have been written, so a shaft carved by
// MineshaftFeature would otherwise be eaten by the cave pass. The fix is for the
// carver to ask "is this voxel inside a mineshaft's protected box?" — and the
// answer has to be derivable from world coordinates alone, because the carver
// and the feature never talk to each other.
//
// Everything here is therefore a pure function of (worldX, worldZ, seed) and the
// same `getFinalTerrainHeight` the feature uses, so both sides independently
// arrive at the same box.
//
// MINESHAFT_REGION lives here rather than in MineshaftFeature so the feature and
// the seal share one definition without an import cycle. MineshaftFeature
// re-exports it, so StructureLocator's existing import keeps working.
// ---------------------------------------------------------------------------

/**
 * Region config for mineshaft placement. regionSize 6 = 6x6 chunks = 192x192
 * blocks.
 *
 * `earlyReturn: true` means a region holds a shaft when `hash % 100 >=
 * spawnChance`, so this is a ~38% density — one shaft per ~2.6 regions. The
 * old value of 6 gave ~94%, which was tolerable for a 20-block tunnel nobody
 * could find, and far too much for a 48-block, three-level, roofed structure.
 */
export const MINESHAFT_REGION: RegionConfig = {
	regionSize: 6,
	magicA: 472348763,
	magicB: 891234567,
	spawnChance: 62,
	earlyReturn: true,
	offsetSeedX: 1,
	offsetSeedZ: 2,
};

/**
 * Half-width used when masking a chunk's columns. `computeMineshaftSealBox`
 * already adds its own margin, so this is only used for the cheap AABB reject.
 */
export { MINESHAFT_SEAL_HALF_EXTENT };

/**
 * How many chunks either side of the generating chunk can contain a shaft
 * centre whose box still reaches the generating chunk.
 *
 * A structure is only ever written by chunks within
 * `STRUCTURE_SEARCH_RADIUS` (2) of its centre chunk, and `placeBlock` clips
 * whatever it writes to the generating chunk — so a shaft 3 chunks away still
 * contributes blocks, and must be sealed. 2 + 1 (the centre's own chunk can sit
 * at the far edge of the window) + ceil(halfExtent / CHUNK_SIZE) covers it; 5
 * is that number rounded up with room to spare.
 */
const SEAL_SEARCH_RADIUS = 5;

export type ResolvedMineshaft = {
	shaftId: number;
	centerX: number;
	centerZ: number;
};

/**
 * Resolve the mineshaft owning a region, or null when the region holds none.
 * Pure: same (chunkX, chunkZ, seed) always yields the same answer.
 */
export function resolveMineshaftInRegion(
	chunkX: number,
	chunkZ: number,
	chunkSize: number,
	seed: number,
): ResolvedMineshaft | null {
	const region = computeRegion(
		chunkX,
		chunkZ,
		chunkSize,
		seed,
		MINESHAFT_REGION,
	);
	if (!region) return null;

	return {
		shaftId: region.regionHash,
		centerX: region.centerX,
		centerZ: region.centerZ,
	};
}

/**
 * Build the full layout for a resolved shaft, or null if the site is rejected.
 *
 * The ground sampler is deliberately the canonical `getFinalTerrainHeight` and
 * not the SurfaceGenerator prepass: this is also called from the main thread and
 * the server, and only the canonical function is guaranteed to agree across the
 * worker boundary.
 */
export function buildMineshaftLayoutAt(
	resolved: ResolvedMineshaft,
	seed: number,
): MineshaftLayout | null {
	return buildMineshaftLayout(
		resolved.shaftId,
		seed,
		resolved.centerX,
		resolved.centerZ,
		getFinalTerrainHeight,
	);
}

/** AABB overlap test against a shaft's seal box. */
export function mineshaftSealOverlaps(
	seal: MineshaftSealBox,
	minX: number,
	minY: number,
	minZ: number,
	maxX: number,
	maxY: number,
	maxZ: number,
): boolean {
	return (
		seal.maxX >= minX &&
		seal.minX <= maxX &&
		seal.maxZ >= minZ &&
		seal.minZ <= maxZ &&
		seal.maxY >= minY &&
		seal.minY <= maxY
	);
}

export type MineshaftSealMask = {
	/** True when at least one column of the chunk is inside a shaft seal. */
	hasSeal: boolean;
	/** Inclusive Y range that is sealed, for the columns flagged in the mask. */
	minY: number;
	maxY: number;
};

/**
 * OR 1s into `out` for every column of the chunk at (chunkX, chunkZ) that falls
 * inside a shaft's seal box, and report the sealed Y range.
 *
 * Deliberately OR-only: `fillSealColumnMask` already filled and owns `out`, and
 * this runs immediately after it in UndergroundGenerator. Clearing here would
 * silently un-seal the Maya temple.
 *
 * Probes whole regions rather than individual chunks: a mineshaft's centre is
 * derived from its region, so several of the 11x11 chunks in the search window
 * resolve to the same region and would recompute an identical answer. That
 * turns 121 region lookups per chunk into at most 9.
 */
export function fillMineshaftSealMask(
	chunkX: number,
	chunkZ: number,
	chunkSize: number,
	seed: number,
	out: Uint8Array,
): MineshaftSealMask {
	const chunkMinX = chunkX * chunkSize;
	const chunkMaxX = chunkMinX + chunkSize - 1;
	const chunkMinZ = chunkZ * chunkSize;
	const chunkMaxZ = chunkMinZ + chunkSize - 1;

	const regionSize = MINESHAFT_REGION.regionSize;
	const minRegionX = Math.floor((chunkX - SEAL_SEARCH_RADIUS) / regionSize);
	const maxRegionX = Math.floor((chunkX + SEAL_SEARCH_RADIUS) / regionSize);
	const minRegionZ = Math.floor((chunkZ - SEAL_SEARCH_RADIUS) / regionSize);
	const maxRegionZ = Math.floor((chunkZ + SEAL_SEARCH_RADIUS) / regionSize);

	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;

	for (let rx = minRegionX; rx <= maxRegionX; rx++) {
		for (let rz = minRegionZ; rz <= maxRegionZ; rz++) {
			// computeRegion derives the region from the CHUNK it is handed, so
			// pass a chunk inside this region, not the region index itself.
			const resolved = resolveMineshaftInRegion(
				rx * regionSize,
				rz * regionSize,
				chunkSize,
				seed,
			);
			if (!resolved) continue;

			// Cheap reject before paying for a ground sample.
			if (
				Math.abs(resolved.centerX - (chunkMinX + chunkMaxX) / 2) >
					MINESHAFT_SEAL_HALF_EXTENT + chunkSize ||
				Math.abs(resolved.centerZ - (chunkMinZ + chunkMaxZ) / 2) >
					MINESHAFT_SEAL_HALF_EXTENT + chunkSize
			) {
				continue;
			}

			// Box-only path: the full layout (cells, corridors, stairs, crates)
			// is irrelevant here and this runs for every chunk in the window.
			const seal = computeMineshaftSealBox(
				resolved.centerX,
				resolved.centerZ,
				getFinalTerrainHeight,
			);
			if (!seal) continue;

			if (
				seal.maxX < chunkMinX ||
				seal.minX > chunkMaxX ||
				seal.maxZ < chunkMinZ ||
				seal.minZ > chunkMaxZ
			) {
				continue;
			}

			const x0 = Math.max(seal.minX, chunkMinX);
			const x1 = Math.min(seal.maxX, chunkMaxX);
			const z0 = Math.max(seal.minZ, chunkMinZ);
			const z1 = Math.min(seal.maxZ, chunkMaxZ);

			for (let wz = z0; wz <= z1; wz++) {
				const localZ = wz - chunkMinZ;
				for (let wx = x0; wx <= x1; wx++) {
					out[wx - chunkMinX + localZ * chunkSize] = 1;
				}
			}

			if (seal.minY < minY) minY = seal.minY;
			if (seal.maxY > maxY) maxY = seal.maxY;
		}
	}

	if (minY > maxY) return { hasSeal: false, minY: 0, maxY: -1 };

	return { hasSeal: true, minY, maxY };
}

/**
 * Half the grid span. Exported for the feature's cheap AABB reject so the
 * footprint and the seal can never drift apart.
 */
export { MINESHAFT_GRID_SPAN };
