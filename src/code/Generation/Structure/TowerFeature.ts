import type { Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { IWorldFeature } from "./IWorldFeature";
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

		const towerRadius = 8 + (Squirrel3.get(towerCenterX, seed) % 4);

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

		const groundHeight = this.findMinGroundHeightForTower(
			towerCenterX,
			towerCenterZ,
			towerRadius,
			biome,
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

	private generateCylinderTower(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
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
	) {
		const towerHeight = 76 + (Squirrel3.get(towerCenterZ, seed) % 8);
		const wallBlockId = 1;
		const radiusSq = towerRadius * towerRadius;

		for (let dx = -towerRadius; dx <= towerRadius; dx++) {
			for (let dz = -towerRadius; dz <= towerRadius; dz++) {
				if (dx * dx + dz * dz > radiusSq) continue;

				const worldX = towerCenterX + dx;
				const worldZ = towerCenterZ + dz;

				const originalHeight = getFinalTerrainHeight(worldX, worldZ);
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
		chunkX: number,
		chunkY: number,
		chunkZ: number,
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
		biome: Biome,
	): number {
		let minGroundHeight = Infinity;
		const radiusSq = towerRadius * towerRadius;

		for (let dx = -towerRadius; dx <= towerRadius; dx++) {
			for (let dz = -towerRadius; dz <= towerRadius; dz++) {
				if (dx * dx + dz * dz > radiusSq) continue;
				const worldX = towerCenterX + dx;
				const worldZ = towerCenterZ + dz;
				const height = getFinalTerrainHeight(worldX, worldZ);
				if (height < minGroundHeight) {
					minGroundHeight = height;
				}
			}
		}
		return minGroundHeight;
	}
}
