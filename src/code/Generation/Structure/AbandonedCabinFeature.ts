import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { type DoorSide, StructureBuilder } from "./StructureBuilder";

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

const DOORS: DoorSide[] = ["x+", "x-", "z+", "z-"];

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

		const { centerX: cx, centerZ: cz, regionHash } = region;
		const hx = 3;
		const hz = 3;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				cx - hx,
				cx + hx,
				cz - hz,
				cz + hz,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const b = new StructureBuilder(placeBlock, columnPrepassResolver, seed);
		const baseY = b.footprintGround(cx, cz, hx, hz).min;
		const door = DOORS[Math.abs(Squirrel3.get(regionHash, seed)) % 4];

		b.buildHouse({
			cx,
			cz,
			baseY,
			hx,
			hz,
			height: 4,
			wall: BlockType.OldPlanks02,
			roof: BlockType.ThatchRoofAngled,
			floor: BlockType.OldWoodFloor,
			foundation: BlockType.Cobblestone03,
			doorSide: door,
			windows: true,
			extra: (bb, by) => {
				// chimney
				bb.column(cx + hx - 1, by + 1, cz - hz + 1, 5, BlockType.Cobblestone03);
			},
		});
	}
}
