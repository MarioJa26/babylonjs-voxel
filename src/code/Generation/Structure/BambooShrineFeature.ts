import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

export class BambooShrineFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
	public readonly maxAboveSurface = 12;

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
		if (biome.id !== BIOME_ID.BAMBOO_FOREST) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 12,
			magicA: 8090123456,
			magicB: 767778797,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: sx, centerZ: sz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		if (
			!aabbOverlaps(
				sx - 5,
				sx + 5,
				sz - 5,
				sz + 5,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(sx, sz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(sx, sz);
		}

		const shrineHeight =
			4 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 2);

		for (let dx = -2; dx <= 2; dx++) {
			for (let dz = -2; dz <= 2; dz++) {
				placeBlock(sx + dx, groundHeight, sz + dz, BlockType.WoodPlanks, true);
			}
		}

		for (let y = 1; y <= shrineHeight; y++) {
			placeBlock(sx - 2, groundHeight + y, sz - 2, BlockType.RoughWood, true);
			placeBlock(sx + 2, groundHeight + y, sz - 2, BlockType.RoughWood, true);
			placeBlock(sx - 2, groundHeight + y, sz + 2, BlockType.RoughWood, true);
			placeBlock(sx + 2, groundHeight + y, sz + 2, BlockType.RoughWood, true);
		}

		for (let dx = -2; dx <= 2; dx++) {
			placeBlock(
				sx + dx,
				groundHeight + shrineHeight + 1,
				sz - 2,
				BlockType.RoughWood,
				true,
			);
			placeBlock(
				sx + dx,
				groundHeight + shrineHeight + 1,
				sz + 2,
				BlockType.RoughWood,
				true,
			);
		}
		for (let dz = -2; dz <= 2; dz++) {
			placeBlock(
				sx - 2,
				groundHeight + shrineHeight + 1,
				sz + dz,
				BlockType.RoughWood,
				true,
			);
			placeBlock(
				sx + 2,
				groundHeight + shrineHeight + 1,
				sz + dz,
				BlockType.RoughWood,
				true,
			);
		}

		placeBlock(sx, groundHeight + 2, sz, BlockType.ExposedCrystalBlock, true);
		placeBlock(sx, groundHeight + 3, sz, BlockType.ExposedCrystalBlock, true);
	}
}
