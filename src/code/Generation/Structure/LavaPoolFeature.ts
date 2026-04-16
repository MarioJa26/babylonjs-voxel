import { Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { IWorldFeature } from "./IWorldFeature";
import { TerrainHeightMap } from "../TerrainHeightMap";

export class LavaPoolFeature implements IWorldFeature {
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
		getTerrainHeight: (x: number, z: number, biome: Biome) => number,
		generatingChunkX: number,
		generatingChunkZ: number,
	) {
		const POOL_REGION_SIZE = 9;

		const regionX = Math.floor(chunkX / POOL_REGION_SIZE);
		const regionZ = Math.floor(chunkZ / POOL_REGION_SIZE);

		const regionHash = Squirrel3.get(
			regionX * 873461393 + regionZ * 178246653,
			seed,
		);

		// We must check the biome at the *region* location or the specific pool location,
		// not just the biome passed in (which is the center of the neighbor chunk being iterated).
		// However, for the spawn chance logic, we'll defer the biome check until we have coordinates.

		let spawnChance = 2;
		let isSurface = false;

		// We use the passed biome for a quick check, but ideally we check the specific location later
		if (biome.name === "Volcanic_Wasteland" || biome.name === "Basalt_Deltas") {
			spawnChance = 100;
			isSurface = true;
		}

		if (Math.abs(regionHash) % 100 < spawnChance) {
			const baseHash = Squirrel3.get(regionHash, seed);
			const offsetX =
				Math.abs(Squirrel3.get(baseHash, seed)) %
				(POOL_REGION_SIZE * chunkSize);
			const offsetZ =
				Math.abs(Squirrel3.get(baseHash + 1, seed)) %
				(POOL_REGION_SIZE * chunkSize);

			const poolCenterX = regionX * POOL_REGION_SIZE * chunkSize + offsetX;
			const poolCenterZ = regionZ * POOL_REGION_SIZE * chunkSize + offsetZ;

			// --- Optimization: Bounding Box Check ---
			const MAX_POOL_RADIUS = 30; // Approximate max radius
			const minX = poolCenterX - MAX_POOL_RADIUS;
			const maxX = poolCenterX + MAX_POOL_RADIUS;
			const minZ = poolCenterZ - MAX_POOL_RADIUS;
			const maxZ = poolCenterZ + MAX_POOL_RADIUS;

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

			// Re-evaluate biome at the specific pool location for correctness
			const poolBiome = TerrainHeightMap.getBiome(poolCenterX, poolCenterZ);
			isSurface = poolBiome.name === "Volcanic_Wasteland";

			let poolSurfaceY;
			if (isSurface) {
				poolSurfaceY =
					getTerrainHeight(poolCenterX, poolCenterZ, poolBiome) - 1;
			} else {
				poolSurfaceY =
					-64 - (Math.abs(Squirrel3.get(baseHash + 2, seed)) % (1024 - 64));
			}

			this.generateLavaPool(
				chunkX,
				chunkY,
				chunkZ,
				poolCenterX,
				poolSurfaceY,
				poolCenterZ,
				placeBlock,
				seed,
			);
		}
	}

	private generateLavaPool(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
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
		const poolRadius = 25 + (Squirrel3.get(poolCenterX, seed) % 5);
		const maxDepth = 15 + (Squirrel3.get(poolCenterZ, seed) % 3);
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
				const depthFactor = Math.sqrt(distSq) / shellRadius;
				const depth = Math.floor((maxDepth + 1) * (1 - depthFactor));
				const floorY = poolCenterY - depth;

				for (let y = floorY; y <= poolCenterY; y++) {
					placeBlock(worldX, y, worldZ, shoreBlockId, true);
				}
			}
		}

		for (let dx = -poolRadius; dx <= poolRadius; dx++) {
			for (let dz = -poolRadius; dz <= poolRadius; dz++) {
				const distSq = dx * dx + dz * dz;
				if (distSq >= radiusSq) continue;

				const depth = Math.floor(maxDepth * (1 - distSq / radiusSq));
				const floorY = poolCenterY - depth;
				for (let y = floorY; y <= poolCenterY; y++) {
					placeBlock(poolCenterX + dx, y, poolCenterZ + dz, lavaBlockId, true);
				}
			}
		}
	}
}
