import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const TEMPERATE_BIOMES = new Set([
	BIOME_ID.FOREST,
	BIOME_ID.PLAINS,
	BIOME_ID.GRASS_LAND,
	BIOME_ID.MEADOW,
	BIOME_ID.GROVE,
	BIOME_ID.BIRCH_FOREST,
	BIOME_ID.MAPLE_FOREST,
	BIOME_ID.SAVANNAH,
	BIOME_ID.HEDGEROW,
	BIOME_ID.CHERRY_BLOSSOM_FOREST,
	BIOME_ID.AUTUMN_FOREST,
	BIOME_ID.PINE_FOREST,
]);

export class WellFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -20, maxWorldY: 200 };
	public readonly maxAboveSurface = 8;

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
		if (!TEMPERATE_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 12,
			magicA: 1323456789,
			magicB: 990011223,
			spawnChance: 12,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: wx, centerZ: wz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		if (
			!aabbOverlaps(
				wx - 3,
				wx + 3,
				wz - 3,
				wz + 3,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(wx, wz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(wx, wz);
		}

		for (let dx = -1; dx <= 1; dx++) {
			for (let dz = -1; dz <= 1; dz++) {
				placeBlock(wx + dx, groundHeight, wz + dz, BlockType.Water, true);
			}
		}

		for (let dx = -2; dx <= 2; dx++) {
			for (let dz = -2; dz <= 2; dz++) {
				if (Math.abs(dx) === 2 || Math.abs(dz) === 2) {
					placeBlock(
						wx + dx,
						groundHeight + 1,
						wz + dz,
						BlockType.Cobblestone03,
						true,
					);
				}
			}
		}

		placeBlock(wx - 2, groundHeight + 2, wz - 2, BlockType.Cobblestone03, true);
		placeBlock(wx + 2, groundHeight + 2, wz - 2, BlockType.Cobblestone03, true);
		placeBlock(wx - 2, groundHeight + 2, wz + 2, BlockType.Cobblestone03, true);
		placeBlock(wx + 2, groundHeight + 2, wz + 2, BlockType.Cobblestone03, true);

		placeBlock(wx - 2, groundHeight + 3, wz - 2, BlockType.RoughWood, true);
		placeBlock(wx + 2, groundHeight + 3, wz - 2, BlockType.RoughWood, true);
		placeBlock(wx - 2, groundHeight + 3, wz + 2, BlockType.RoughWood, true);
		placeBlock(wx + 2, groundHeight + 3, wz + 2, BlockType.RoughWood, true);

		placeBlock(wx - 2, groundHeight + 4, wz, BlockType.RoughWood, true);
		placeBlock(wx + 2, groundHeight + 4, wz, BlockType.RoughWood, true);
		placeBlock(wx, groundHeight + 4, wz - 2, BlockType.RoughWood, true);
		placeBlock(wx, groundHeight + 4, wz + 2, BlockType.RoughWood, true);
	}
}
