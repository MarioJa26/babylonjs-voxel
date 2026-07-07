import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const TEMPERATE_BIOMES = new Set([
	BIOME_ID.FOREST,
	BIOME_ID.PINE_FOREST,
	BIOME_ID.BIRCH_FOREST,
	BIOME_ID.MAPLE_FOREST,
	BIOME_ID.AUTUMN_FOREST,
	BIOME_ID.TEMPERATE_RAINFOREST,
	BIOME_ID.GROVE,
	BIOME_ID.MEADOW,
	BIOME_ID.HEDGEROW,
	BIOME_ID.CHERRY_BLOSSOM_FOREST,
]);

const CABIN_DATA = {
	width: 7,
	height: 5,
	depth: 6,
	palette: {
		"0": 0,
		"1": BlockType.OldPlanks02,
		"2": BlockType.RoughWood,
		"3": BlockType.ThatchRoofAngled,
	},
	blocks: [
		3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 3, 3, 0, 1, 0,
		1, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1,
		0, 0, 0, 0, 0, 1, 2, 2, 2, 0, 2, 2, 2, 2, 2, 1, 2, 1, 2, 2, 2, 2, 2, 0, 2,
		2, 2,
	],
};

export class AbandonedCabinFeature implements IWorldFeature {
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
		if (!TEMPERATE_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 14,
			magicA: 7090123456,
			magicB: 667788990,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: cx, centerZ: cz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		if (
			!aabbOverlaps(
				cx,
				cx + CABIN_DATA.width,
				cz,
				cz + CABIN_DATA.depth,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(cx, cz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(cx, cz);
		}

		for (let y = 0; y < CABIN_DATA.height; y++) {
			for (let z = 0; z < CABIN_DATA.depth; z++) {
				for (let x = 0; x < CABIN_DATA.width; x++) {
					const idx =
						x + z * CABIN_DATA.width + y * CABIN_DATA.width * CABIN_DATA.depth;
					const paletteIdx = CABIN_DATA.blocks[idx]?.toString() ?? "0";
					const blockId =
						(CABIN_DATA.palette as Record<string, number>)[paletteIdx] ?? 0;
					if (blockId !== 0) {
						placeBlock(cx + x, groundHeight + y, cz + z, blockId, true);
					}
				}
			}
		}
	}
}
