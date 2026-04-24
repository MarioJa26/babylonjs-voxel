import type { Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { IWorldFeature } from "./IWorldFeature";

export class TowerFeature implements IWorldFeature {
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
		const TOWER_REGION_SIZE = 16; // in chunks
		const TOWER_SPAWN_CHANCE = 100; // out of 100

		const regionX = Math.floor(chunkX / TOWER_REGION_SIZE);
		const regionZ = Math.floor(chunkZ / TOWER_REGION_SIZE);

		const regionHash = Squirrel3.get(
			regionX * 374761393 + regionZ * 678446653,
			seed,
		);

		if (Math.abs(regionHash) % 100 < TOWER_SPAWN_CHANCE) {
			const offsetX =
				Math.abs(Squirrel3.get(regionHash, seed)) %
				(TOWER_REGION_SIZE * chunkSize);
			const offsetZ =
				Math.abs(Squirrel3.get(regionHash + 1, seed)) %
				(TOWER_REGION_SIZE * chunkSize);

			const towerCenterX = regionX * TOWER_REGION_SIZE * chunkSize + offsetX;
			const towerCenterZ = regionZ * TOWER_REGION_SIZE * chunkSize + offsetZ;

			const axisCorridorWidth = 20;
			if (
				Math.abs(towerCenterX) < axisCorridorWidth ||
				Math.abs(towerCenterZ) < axisCorridorWidth
			) {
				return;
			}

			const towerRadius = 8 + (Squirrel3.get(towerCenterX, seed) % 4);

			// --- Optimization: Bounding Box Check ---
			const minX = towerCenterX - towerRadius;
			const maxX = towerCenterX + towerRadius;
			const minZ = towerCenterZ - towerRadius;
			const maxZ = towerCenterZ + towerRadius;

			const chunkMinX = generatingChunkX * chunkSize;
			const chunkMaxX = (generatingChunkX + 1) * chunkSize;
			const chunkMinZ = generatingChunkZ * chunkSize;
			const chunkMaxZ = (generatingChunkZ + 1) * chunkSize;

			if (
				maxX <= chunkMinX ||
				minX >= chunkMaxX ||
				maxZ <= chunkMinZ ||
				minZ >= chunkMaxZ
			)
				return;
			// ----------------------------------------

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
