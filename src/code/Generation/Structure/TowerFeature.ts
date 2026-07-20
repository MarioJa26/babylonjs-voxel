import type { Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

export class TowerFeature implements IWorldFeature {
	// Above-surface tower is 76-83 tall; underground reaches MIN_WORLD_Y = -1600.
	// Conservative: max surface ~400 + tower 84.
	public readonly verticalBounds = {
		minWorldY: -1600,
		maxWorldY: 500,
	};

	public generate(
		chunkX: number,
		chunkY: number,
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
		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 16,
			magicA: 374761393,
			magicB: 678446653,
			spawnChance: 100,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: towerCenterX, centerZ: towerCenterZ } = region;

		const axisCorridorWidth = 20;
		if (
			Math.abs(towerCenterX) < axisCorridorWidth ||
			Math.abs(towerCenterZ) < axisCorridorWidth
		) {
			return;
		}

		const towerRadius = 8 + (getPRNGBySeed(towerCenterX, seed) % 4);

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

		this.generateCylinderTower(
			chunkX,
			chunkY,
			chunkZ,
			towerCenterX,
			towerCenterZ,
			towerRadius,
			groundHeight,
			biome,
			placeBlock,
			chunkSize,
			seed,
			prepassByChunk,
		);
		this.generateUndergroundCylinderTower(
			chunkX,
			chunkY,
			chunkZ,
			towerCenterX,
			towerCenterZ,
			towerRadius,
			groundHeight,
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
		_chunkX: number,
		chunkY: number,
		_chunkZ: number,
		towerCenterX: number,
		towerCenterZ: number,
		towerRadius: number,
		groundHeight: number,
		biome: Biome,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void,
		chunkSize: number,
		seed: number,
		prepassByChunk:
			| Map<string, ReturnType<ColumnPrepassResolver>["entry"]>
			| undefined,
	) {
		const towerHeight = 76 + (getPRNGBySeed(towerCenterZ, seed) % 8);
		const wallBlockId = 1;
		const radiusSq = towerRadius * towerRadius;

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

				for (let y = originalHeight; y < groundHeight; y++) {
					placeBlock(worldX, y, worldZ, biome.undergroundBlock, true);
				}
			}
		}

		for (let localY = 0; localY < chunkSize; localY++) {
			const worldY = chunkY * chunkSize + localY;
			if (worldY < groundHeight || worldY >= groundHeight + towerHeight) {
				continue;
			}

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
		_chunkX: number,
		chunkY: number,
		_chunkZ: number,
		towerCenterX: number,
		towerCenterZ: number,
		towerRadius: number,
		groundHeight: number,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void,
		chunkSize: number,
	) {
		const wallBlockId = 26;
		const MIN_WORLD_Y = -16 * 100;
		const radiusSq = towerRadius * towerRadius;

		for (let localY = 0; localY < chunkSize; localY++) {
			const worldY = chunkY * chunkSize + localY;
			if (worldY < MIN_WORLD_Y || worldY >= groundHeight) {
				continue;
			}

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
		_biome: Biome,
		prepassByChunk:
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
