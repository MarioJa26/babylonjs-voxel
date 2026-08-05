import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

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
		_chunkY: number,
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

		const { centerX: sx, centerZ: sz, regionHash } = region;
		const circleRadius = 7;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
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

		const b = new StructureBuilder(placeBlock, columnPrepassResolver, seed);
		const numStones = 8 + (Math.abs(getPRNGBySeed(regionHash, seed)) % 5);

		for (let i = 0; i < numStones; i++) {
			const angle = (i / numStones) * Math.PI * 2;
			const stoneX = Math.round(sx + Math.cos(angle) * circleRadius);
			const stoneZ = Math.round(sz + Math.sin(angle) * circleRadius);
			const ground = b.ground(stoneX, stoneZ);
			const stoneHeight = 3 + (Math.abs(getPRNGBySeed(i * 37, seed)) % 3);
			const blockType =
				Math.abs(getPRNGBySeed(i * 53, seed)) % 2 === 0
					? BlockType.Cobblestone03
					: BlockType.MossyCobble;
			// upright slab (1xNx1) on its own conformed base
			b.column(stoneX, ground, stoneZ, stoneHeight, blockType);
			// occasional capstone
			if (Math.abs(getPRNGBySeed(i * 71, seed)) % 3 === 0) {
				b.set(stoneX, ground + stoneHeight, stoneZ, BlockType.MossyCobble);
			}
		}

		const centerStone =
			Math.abs(getPRNGBySeed(regionHash + 100, seed)) % 2 === 0;
		if (centerStone) {
			const cg = b.ground(sx, sz);
			b.box(
				sx - 1,
				cg,
				sz - 1,
				sx + 1,
				cg + 1,
				sz + 1,
				BlockType.Cobblestone03,
			);
			b.set(sx, cg + 2, sz, BlockType.MossyCobble);
		}
	}
}
