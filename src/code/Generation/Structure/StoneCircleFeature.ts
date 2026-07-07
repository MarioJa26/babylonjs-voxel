import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const TEMPERATE_BIOMES = new Set([
	BIOME_ID.MEADOW,
	BIOME_ID.PLAINS,
	BIOME_ID.GRASS_LAND,
	BIOME_ID.GROVE,
	BIOME_ID.HEDGEROW,
	BIOME_ID.CHERRY_BLOSSOM_FOREST,
	BIOME_ID.AUTUMN_FOREST,
	BIOME_ID.PINE_FOREST,
]);

export class StoneCircleFeature implements IWorldFeature {
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
			magicA: 9212345678,
			magicB: 889900112,
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
		const circleRadius = 7;

		if (
			!aabbOverlaps(
				sx - circleRadius,
				sx + circleRadius,
				sz - circleRadius,
				sz + circleRadius,
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

		const numStones =
			8 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 5);

		for (let i = 0; i < numStones; i++) {
			const angle = (i / numStones) * Math.PI * 2;
			const stoneX = Math.floor(sx + Math.cos(angle) * circleRadius);
			const stoneZ = Math.floor(sz + Math.sin(angle) * circleRadius);
			const stoneHeight = 3 + (Math.abs(Squirrel3.get(i * 37, seed)) % 3);
			const blockType =
				Math.abs(Squirrel3.get(i * 53, seed)) % 2 === 0
					? BlockType.Cobblestone03
					: BlockType.MossyCobble;

			for (let y = 0; y < stoneHeight; y++) {
				placeBlock(stoneX, groundHeight + y, stoneZ, blockType, true);
			}
		}

		const centerStone =
			Math.abs(Squirrel3.get(region.regionHash + 100, seed)) % 2 === 0;
		if (centerStone) {
			for (let y = 0; y < 2; y++) {
				placeBlock(sx, groundHeight + y, sz, BlockType.Cobblestone03, true);
			}
		}
	}
}
