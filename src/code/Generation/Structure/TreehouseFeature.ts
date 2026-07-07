import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const TROPICAL_BIOMES = new Set([
	BIOME_ID.JUNGLE,
	BIOME_ID.BAMBOO_FOREST,
	BIOME_ID.MANGROVE,
	BIOME_ID.CLOUD_FOREST,
]);

export class TreehouseFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 250 };
	public readonly maxAboveSurface = 30;

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
		if (!TROPICAL_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 14,
			magicA: 7989012345,
			magicB: 656667686,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: tx, centerZ: tz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		if (
			!aabbOverlaps(
				tx - 6,
				tx + 6,
				tz - 6,
				tz + 6,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(tx, tz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(tx, tz);
		}

		const trunkHeight =
			10 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 6);

		for (let y = 0; y < trunkHeight; y++) {
			placeBlock(tx, groundHeight + y, tz, BlockType.PalmTrunk, true);
		}

		const platformY = groundHeight + trunkHeight;
		const platRadius = 3;
		const platRs = platRadius * platRadius;
		for (let dx = -platRadius; dx <= platRadius; dx++) {
			for (let dz = -platRadius; dz <= platRadius; dz++) {
				if (dx * dx + dz * dz > platRs) continue;
				placeBlock(tx + dx, platformY, tz + dz, BlockType.WoodPlanks, true);
			}
		}

		for (let dx = -platRadius; dx <= platRadius; dx++) {
			for (let dz = -platRadius; dz <= platRadius; dz++) {
				if (dx * dx + dz * dz > platRs) continue;
				if (Math.abs(dx) === platRadius || Math.abs(dz) === platRadius) {
					placeBlock(
						tx + dx,
						platformY + 1,
						tz + dz,
						BlockType.WoodPlanks,
						true,
					);
				}
			}
		}

		placeBlock(tx + 1, platformY + 1, tz + 1, BlockType.Air, true);
		placeBlock(tx, platformY + 1, tz, BlockType.Air, true);
		placeBlock(tx - 1, platformY + 1, tz - 1, BlockType.Air, true);

		placeBlock(tx, platformY + 2, tz, BlockType.WoodPlanks, true);

		for (let dx = -3; dx <= 3; dx++) {
			for (let dz = -3; dz <= 3; dz++) {
				if (dx * dx + dz * dz > 9) continue;
				placeBlock(tx + dx, platformY + 3, tz + dz, BlockType.PalmLeaves, true);
			}
		}
	}
}
