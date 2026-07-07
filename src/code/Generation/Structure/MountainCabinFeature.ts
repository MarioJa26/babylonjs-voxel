import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const MOUNTAIN_BIOMES = new Set([
	BIOME_ID.ALPINE_MEADOW,
	BIOME_ID.ROCKY_HIGHLANDS,
	BIOME_ID.TUNDRA_MOUNTAINS,
	BIOME_ID.CLOUD_PEAKS,
	BIOME_ID.MESA_PLATEAU,
]);

const CABIN_DATA = {
	width: 6,
	height: 4,
	depth: 5,
	palette: {
		"0": 0,
		"1": BlockType.Cobblestone03,
		"2": BlockType.RoughWood,
		"3": BlockType.OldPlanks02,
	},
	blocks: [
		1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0,
		0, 0, 1, 3, 3, 3, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 0, 0, 2, 2, 2,
		2, 0, 2, 2,
	],
};

export class MountainCabinFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 300 };
	public readonly maxAboveSurface = 10;

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
		if (!MOUNTAIN_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 14,
			magicA: 9101234567,
			magicB: 878889808,
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
