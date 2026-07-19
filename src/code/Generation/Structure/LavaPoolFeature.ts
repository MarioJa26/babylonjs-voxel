import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import { getBiome, getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

export class LavaPoolFeature implements IWorldFeature {
	// Underground pools: -64..-1087. Surface pools: surface-17..surface-1 (max ~400).
	public readonly verticalBounds = {
		minWorldY: -1100,
		maxWorldY: 400,
	};

	public generate(
		chunkX: number,
		_chunkY: number,
		chunkZ: number,
		biome: Biome,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void,
		seed: number,
		chunkSize: number,
		generatingChunkX: number,
		generatingChunkZ: number,
		columnPrepassResolver?: ColumnPrepassResolver,
	) {
		let spawnChance = 2;
		let isSurface = false;

		if (
			biome.id === BIOME_ID.VOLCANIC_WASTELAND ||
			biome.id === BIOME_ID.BASALT_DELTAS
		) {
			spawnChance = 100;
			isSurface = true;
		}

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 9,
			magicA: 873461393,
			magicB: 178246653,
			spawnChance,
			earlyReturn: false,
		});
		if (!region) return;

		const { regionHash } = region;

		// LavaPool uses a different offset derivation via intermediate baseHash
		const baseHash = getPRNGBySeed(regionHash, seed);
		const offsetX = Math.abs(getPRNGBySeed(baseHash, seed)) % (9 * chunkSize);
		const offsetZ =
			Math.abs(getPRNGBySeed(baseHash + 1, seed)) % (9 * chunkSize);
		const poolCenterX = region.regionX * 9 * chunkSize + offsetX;
		const poolCenterZ = region.regionZ * 9 * chunkSize + offsetZ;

		const MAX_POOL_RADIUS = 30;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				poolCenterX - MAX_POOL_RADIUS,
				poolCenterX + MAX_POOL_RADIUS,
				poolCenterZ - MAX_POOL_RADIUS,
				poolCenterZ + MAX_POOL_RADIUS,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const poolBiome = getBiome(poolCenterX, poolCenterZ);
		isSurface =
			poolBiome.id === BIOME_ID.VOLCANIC_WASTELAND ||
			poolBiome.id === BIOME_ID.BASALT_DELTAS;

		let poolSurfaceY = 0;
		if (isSurface) {
			if (columnPrepassResolver) {
				const resolved = columnPrepassResolver(poolCenterX, poolCenterZ);
				poolSurfaceY =
					resolved.entry.terrainHeightMap[
						resolved.localX + resolved.localZ * 32
					] - 1;
			} else {
				poolSurfaceY = getFinalTerrainHeight(poolCenterX, poolCenterZ) - 1;
			}
		} else {
			poolSurfaceY =
				-64 - (Math.abs(getPRNGBySeed(baseHash + 2, seed)) % (1024 - 64));
		}

		this.generateLavaPool(
			poolCenterX,
			poolSurfaceY,
			poolCenterZ,
			placeBlock,
			seed,
		);
	}

	private generateLavaPool(
		poolCenterX: number,
		poolCenterY: number,
		poolCenterZ: number,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void,
		seed: number,
	) {
		const poolRadius = 25 + (getPRNGBySeed(poolCenterX, seed) % 5);
		const maxDepth = 15 + (getPRNGBySeed(poolCenterZ, seed) % 3);
		const rimHeight = 3;
		const lavaTop = poolCenterY - rimHeight;
		const radiusSq = poolRadius * poolRadius;
		const lavaBlockId = 24;
		const shoreBlockId = 25;

		const shellRadius = poolRadius + 1;
		const shellRadiusSq = shellRadius * shellRadius;
		for (let dx = -shellRadius; dx <= shellRadius; dx++) {
			for (let dz = -shellRadius; dz <= shellRadius; dz++) {
				const distSq = dx * dx + dz * dz;
				if (distSq >= shellRadiusSq) continue;

				const worldX = poolCenterX + dx;
				const worldZ = poolCenterZ + dz;
				// linear cone so the rim walls match the lava bowl below
				const depth = Math.floor(
					maxDepth * (1 - Math.sqrt(distSq) / shellRadius),
				);
				const floorY = poolCenterY - depth;

				for (let y = floorY; y <= poolCenterY; y++) {
					placeBlock(worldX, y, worldZ, shoreBlockId, true);
				}
			}
		}

		// Lava fills the same cone but stops below the rim, so the shore
		// walls remain above it and the pool is properly encased.
		for (let dx = -poolRadius; dx <= poolRadius; dx++) {
			for (let dz = -poolRadius; dz <= poolRadius; dz++) {
				const distSq = dx * dx + dz * dz;
				if (distSq >= radiusSq) continue;

				const depth = Math.floor(
					maxDepth * (1 - Math.sqrt(distSq) / poolRadius),
				);
				const floorY = poolCenterY - depth;
				const topY = Math.min(poolCenterY, lavaTop);
				if (topY < floorY) continue;
				for (let y = floorY; y <= topY; y++) {
					placeBlock(poolCenterX + dx, y, poolCenterZ + dz, lavaBlockId, true);
				}
			}
		}
	}
}
