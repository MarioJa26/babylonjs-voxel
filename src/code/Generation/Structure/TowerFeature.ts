import type { Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import {
	aabbOverlaps,
	chunkWorldBounds,
	computeRegion,
	type RegionConfig,
} from "./RegionFeature";

/**
 * Region grid for this feature's placement, hoisted so /locate can resolve
 * it without duplicating these constants. A structure exists in region
 * `floor(chunk / regionSize)` when the hash passes the spawn chance.
 */
export const TOWER_REGION: RegionConfig = {
	regionSize: 16,
	magicA: 374761393,
	magicB: 678446653,
	spawnChance: 100,
	earlyReturn: false,
};

export class TowerFeature implements IWorldFeature {
	// Above-surface tower is 76-83 tall; underground reaches MIN_WORLD_Y = -1600.
	// Conservative: max surface ~400 + tower 84.
	public readonly verticalBounds = {
		minWorldY: -1600,
		maxWorldY: 500,
	};

	/**
	 * No tower is placed within this many blocks of either world axis.
	 * Shared by the generation path and the column-top query so the two can
	 * never disagree about where a tower exists.
	 */
	private static readonly AXIS_CORRIDOR_WIDTH = 20;

	// generate() runs once per chunk-Y layer inside verticalBounds (~66 layers
	// per chunk column × 25 neighbor chunks), but every decision input below
	// is Y-independent: region center, corridor gate, radius, ground height
	// and the collected prepasses. Without this cache each layer re-hashed the
	// region, re-collected prepasses (first touch builds full 32×32 column
	// prepasses) and re-scanned ~200 columns for the minimum ground height.
	private static readonly DECISION_CACHE_MAX = 8192;
	private static decisionCache = new Map<
		string,
		{
			seed: number;
			hasResolverPrepasses: boolean;
			towerCenterX: number;
			towerCenterZ: number;
			towerRadius: number;
			prepassByChunk:
				| Map<string, ReturnType<ColumnPrepassResolver>["entry"]>
				| undefined;
			groundHeight: number;
		}
	>();

	/**
	 * Column-top cache for the streaming controller's sky guard.
	 *
	 * Deliberately SEPARATE from `decisionCache`: the generation path
	 * resolves ground heights from worker column prepasses, while this path
	 * resolves them from the 2D heightmap on the main thread. Sharing one
	 * cache would let the two paths clobber each other's ground height — and
	 * the "no resolver prepasses" flag would make the generation path
	 * conclude that no tower exists.
	 *
	 * Keyed by the tower's centre (plus the seed), not by the queried column:
	 * the ground height and tower height belong to the tower, only the
	 * footprint test depends on the query.
	 */
	private static columnTopCache = new Map<string, number>();

	/**
	 * Highest world Y the tower reaches in this column, or -1 when there is
	 * no tower here.
	 *
	 * Mirrors `generate()`'s placement exactly (same region hash, same
	 * axis-corridor gate, same radius), so the streaming controller's sky
	 * guard keeps the chunks the tower actually occupies.
	 */
	public columnTopHeight(worldX: number, worldZ: number, seed: number): number {
		const chunkSize = 32;
		const chunkX = Math.floor(worldX / chunkSize);
		const chunkZ = Math.floor(worldZ / chunkSize);

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, TOWER_REGION);
		if (!region) return -1;

		const { centerX, centerZ } = region;

		// The axis-corridor gate: no tower is placed within 20 blocks of
		// either world axis.
		if (
			Math.abs(centerX) < TowerFeature.AXIS_CORRIDOR_WIDTH ||
			Math.abs(centerZ) < TowerFeature.AXIS_CORRIDOR_WIDTH
		) {
			return -1;
		}

		const cacheKey = `${centerX},${centerZ},${seed}`;
		const cachedTop = TowerFeature.columnTopCache.get(cacheKey);
		if (cachedTop !== undefined) {
			return this.towerReachesColumn(
				cachedTop,
				worldX,
				worldZ,
				centerX,
				centerZ,
				seed,
			);
		}

		const radius = TowerFeature.towerRadius(centerX, seed);
		const towerHeight = TowerFeature.towerHeight(centerZ, seed);
		const groundHeight = this.findMinGroundHeightForTower(
			centerX,
			centerZ,
			radius,
			undefined,
			undefined,
			chunkSize,
		);
		const top = groundHeight + towerHeight;

		if (TowerFeature.columnTopCache.size >= TowerFeature.DECISION_CACHE_MAX) {
			TowerFeature.columnTopCache.clear();
		}
		TowerFeature.columnTopCache.set(cacheKey, top);

		return this.towerReachesColumn(top, worldX, worldZ, centerX, centerZ, seed);
	}

	/**
	 * Whether the CHUNK containing (worldX, worldZ) intersects the tower's
	 * footprint.
	 *
	 * The whole chunk footprint matters, not just its centre: the tower is a
	 * solid cylinder whose disk (radius 8-11) usually covers only part of
	 * the chunk it sits in, and a centre-only test would report "no tower"
	 * for chunks that are in fact half full of tower.
	 */
	private towerReachesColumn(
		top: number,
		worldX: number,
		worldZ: number,
		centerX: number,
		centerZ: number,
		seed: number,
	): number {
		const chunkSize = 32;
		const radius = TowerFeature.towerRadius(centerX, seed);
		const radiusSq = radius * radius;

		const minX = Math.floor(worldX / chunkSize) * chunkSize;
		const minZ = Math.floor(worldZ / chunkSize) * chunkSize;
		const maxX = minX + chunkSize - 1;
		const maxZ = minZ + chunkSize - 1;

		// Closest point of the chunk's XZ rectangle to the tower's centre.
		const closestX = Math.max(minX, Math.min(centerX, maxX));
		const closestZ = Math.max(minZ, Math.min(centerZ, maxZ));

		const dx = closestX - centerX;
		const dz = closestZ - centerZ;

		return dx * dx + dz * dz <= radiusSq ? top : -1;
	}

	private static towerRadius(centerX: number, seed: number): number {
		return 8 + (getPRNGBySeed(centerX, seed) % 4);
	}

	private static towerHeight(centerZ: number, seed: number): number {
		return 76 + (getPRNGBySeed(centerZ, seed) % 8);
	}

	public generate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		biome: Biome,
		placeBlock: PlaceBlockFn,
		seed: number,
		chunkSize: number,
		generatingChunkX: number,
		generatingChunkZ: number,
		columnPrepassResolver?: ColumnPrepassResolver,
	) {
		const cacheKey = chunkX + "," + chunkZ;
		let decision = TowerFeature.decisionCache.get(cacheKey);
		if (TowerFeature.decisionCache.size >= TowerFeature.DECISION_CACHE_MAX) {
			TowerFeature.decisionCache.clear();
		}
		if (decision === undefined || decision.seed !== seed) {
			const region = computeRegion(
				chunkX,
				chunkZ,
				chunkSize,
				seed,
				TOWER_REGION,
			);
			if (!region) {
				TowerFeature.decisionCache.set(cacheKey, {
					seed,
					hasResolverPrepasses: false,
					towerCenterX: 0,
					towerCenterZ: 0,
					towerRadius: 0,
					prepassByChunk: undefined,
					groundHeight: 0,
				});
				return;
			}

			const { centerX: towerCenterX, centerZ: towerCenterZ } = region;

			const axisCorridorWidth = TowerFeature.AXIS_CORRIDOR_WIDTH;
			if (
				Math.abs(towerCenterX) < axisCorridorWidth ||
				Math.abs(towerCenterZ) < axisCorridorWidth
			) {
				TowerFeature.decisionCache.set(cacheKey, {
					seed,
					hasResolverPrepasses: false,
					towerCenterX: 0,
					towerCenterZ: 0,
					towerRadius: 0,
					prepassByChunk: undefined,
					groundHeight: 0,
				});
				return;
			}

			const towerRadius = TowerFeature.towerRadius(towerCenterX, seed);

			// Fetch every affected chunk's prepass ONCE (the resolver builds a
			// full 32x32 chunk prepass, so calling it per-column would rebuild
			// up to 9 prepasses per tower). We cover the tower's bounding box of
			// chunks and index into the cached height maps.
			const prepassByChunk = columnPrepassResolver
				? this.collectPrepasses(
						towerCenterX,
						towerCenterZ,
						towerRadius,
						chunkSize,
						columnPrepassResolver,
					)
				: undefined;

			const groundHeight = this.findMinGroundHeightForTower(
				towerCenterX,
				towerCenterZ,
				towerRadius,
				biome,
				prepassByChunk,
			);

			decision = {
				seed,
				hasResolverPrepasses: true,
				towerCenterX,
				towerCenterZ,
				towerRadius,
				prepassByChunk,
				groundHeight,
			};
			TowerFeature.decisionCache.set(cacheKey, decision);
		} else if (!decision.hasResolverPrepasses) {
			return;
		}

		const { towerCenterX, towerCenterZ, towerRadius } = decision;

		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				towerCenterX - towerRadius,
				towerCenterX + towerRadius,
				towerCenterZ - towerRadius,
				towerCenterZ + towerRadius,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		this.generateCylinderTower(
			chunkY,
			towerCenterX,
			towerCenterZ,
			towerRadius,
			decision.groundHeight,
			biome,
			placeBlock,
			chunkSize,
			seed,
			decision.prepassByChunk,
		);
		this.generateUndergroundCylinderTower(
			chunkY,
			towerCenterX,
			towerCenterZ,
			towerRadius,
			decision.groundHeight,
			placeBlock,
			chunkSize,
		);
	}

	/**
	 * Build a map from (chunkX,chunkZ) -> prepass entry for every chunk that
	 * the tower's bounding disk touches. Called once per tower so the heavy
	 * per-chunk prepass is built at most once per chunk, not once per column.
	 */
	private collectPrepasses(
		centerX: number,
		centerZ: number,
		radius: number,
		chunkSize: number,
		resolver: ColumnPrepassResolver,
	): Map<string, ReturnType<ColumnPrepassResolver>["entry"]> {
		const map = new Map<string, ReturnType<ColumnPrepassResolver>["entry"]>();
		const minX = centerX - radius;
		const maxX = centerX + radius;
		const minZ = centerZ - radius;
		const maxZ = centerZ + radius;
		const minChunkX = Math.floor(minX / chunkSize);
		const maxChunkX = Math.floor(maxX / chunkSize);
		const minChunkZ = Math.floor(minZ / chunkSize);
		const maxChunkZ = Math.floor(maxZ / chunkSize);
		for (let cx = minChunkX; cx <= maxChunkX; cx++) {
			for (let cz = minChunkZ; cz <= maxChunkZ; cz++) {
				const key = cx + "," + cz;
				if (!map.has(key)) {
					const resolved = resolver(cx * chunkSize, cz * chunkSize);
					map.set(key, resolved.entry);
				}
			}
		}
		return map;
	}

	private resolveHeight(
		worldX: number,
		worldZ: number,
		chunkSize: number,
		prepassByChunk:
			| Map<string, ReturnType<ColumnPrepassResolver>["entry"]>
			| undefined,
	): number {
		if (!prepassByChunk) {
			return getFinalTerrainHeight(worldX, worldZ);
		}
		const cx = Math.floor(worldX / chunkSize);
		const cz = Math.floor(worldZ / chunkSize);
		const entry = prepassByChunk.get(cx + "," + cz);
		if (!entry) return getFinalTerrainHeight(worldX, worldZ);
		const localX = worldX - cx * chunkSize;
		const localZ = worldZ - cz * chunkSize;
		return entry.terrainHeightMap[localX + localZ * chunkSize];
	}

	private generateCylinderTower(
		chunkY: number,
		towerCenterX: number,
		towerCenterZ: number,
		towerRadius: number,
		groundHeight: number,
		biome: Biome,
		placeBlock: PlaceBlockFn,
		chunkSize: number,
		seed: number,
		prepassByChunk:
			| Map<string, ReturnType<ColumnPrepassResolver>["entry"]>
			| undefined,
	) {
		const chunkMinY = chunkY * chunkSize;
		const chunkMaxY = chunkMinY + chunkSize - 1;
		const towerHeight = TowerFeature.towerHeight(towerCenterZ, seed);
		const wallBlockId = 1;
		const radiusSq = towerRadius * towerRadius;

		// Band-clamped below-ground fill: writes land in
		// [originalHeight, groundHeight), so layers starting at/above
		// groundHeight can skip the whole phase.
		if (chunkMinY < groundHeight) {
			for (let dx = -towerRadius; dx <= towerRadius; dx++) {
				for (let dz = -towerRadius; dz <= towerRadius; dz++) {
					if (dx * dx + dz * dz > radiusSq) continue;

					const worldX = towerCenterX + dx;
					const worldZ = towerCenterZ + dz;

					const originalHeight = this.resolveHeight(
						worldX,
						worldZ,
						chunkSize,
						prepassByChunk,
					);

					const yStart = Math.max(originalHeight, chunkMinY);
					const yEnd = Math.min(groundHeight, chunkMaxY + 1);
					for (let y = yStart; y < yEnd; y++) {
						placeBlock(worldX, y, worldZ, biome.undergroundBlock, true);
					}
				}
			}
		}

		// Band-clamped wall cylinder: intersect [groundHeight,
		// groundHeight+towerHeight) with this layer once instead of filtering
		// 32 candidate rows through two comparisons each.
		const wallStart = Math.max(groundHeight, chunkMinY);
		const wallEnd = Math.min(groundHeight + towerHeight, chunkMaxY + 1);
		for (let worldY = wallStart; worldY < wallEnd; worldY++) {
			for (let dx = -towerRadius; dx <= towerRadius; dx++) {
				for (let dz = -towerRadius; dz <= towerRadius; dz++) {
					if (dx * dx + dz * dz > radiusSq) continue;
					placeBlock(
						towerCenterX + dx,
						worldY,
						towerCenterZ + dz,
						wallBlockId,
						true,
					);
				}
			}
		}
	}

	private generateUndergroundCylinderTower(
		chunkY: number,
		towerCenterX: number,
		towerCenterZ: number,
		towerRadius: number,
		groundHeight: number,
		placeBlock: PlaceBlockFn,
		chunkSize: number,
	) {
		const wallBlockId = 26;
		const MIN_WORLD_Y = -16 * 100;
		const radiusSq = towerRadius * towerRadius;

		const chunkMinY = chunkY * chunkSize;
		const chunkMaxY = chunkMinY + chunkSize - 1;
		const shaftStart = Math.max(MIN_WORLD_Y, chunkMinY);
		const shaftEnd = Math.min(groundHeight, chunkMaxY + 1);
		if (shaftStart >= shaftEnd) return;

		for (let worldY = shaftStart; worldY < shaftEnd; worldY++) {
			for (let dx = -towerRadius; dx <= towerRadius; dx++) {
				for (let dz = -towerRadius; dz <= towerRadius; dz++) {
					if (dx * dx + dz * dz > radiusSq) continue;
					placeBlock(
						towerCenterX + dx,
						worldY,
						towerCenterZ + dz,
						wallBlockId,
						true,
					);
				}
			}
		}
	}

	private findMinGroundHeightForTower(
		towerCenterX: number,
		towerCenterZ: number,
		towerRadius: number,
		_biome?: Biome,
		prepassByChunk?:
			| Map<string, ReturnType<ColumnPrepassResolver>["entry"]>
			| undefined,
		chunkSize = 32,
	): number {
		let minGroundHeight = Infinity;
		const radiusSq = towerRadius * towerRadius;

		for (let dx = -towerRadius; dx <= towerRadius; dx++) {
			for (let dz = -towerRadius; dz <= towerRadius; dz++) {
				if (dx * dx + dz * dz > radiusSq) continue;
				const worldX = towerCenterX + dx;
				const worldZ = towerCenterZ + dz;

				const height = this.resolveHeight(
					worldX,
					worldZ,
					chunkSize,
					prepassByChunk,
				);

				if (height < minGroundHeight) {
					minGroundHeight = height;
				}
			}
		}
		return minGroundHeight;
	}
}
