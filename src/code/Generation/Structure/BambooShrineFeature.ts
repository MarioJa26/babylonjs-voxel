import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { type DoorSide, StructureBuilder } from "./StructureBuilder";

const TROPICAL_BIOMES = new Set([
	BIOME_ID.BAMBOO_FOREST,
	BIOME_ID.JUNGLE,
	BIOME_ID.MANGROVE,
	BIOME_ID.TROPICAL_ISLAND,
	BIOME_ID.CLOUD_FOREST,
]);

const DOORS: DoorSide[] = ["x+", "x-", "z+", "z-"];

export class BambooShrineFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
	public readonly maxAboveSurface = 14;

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
			regionSize: 15,
			magicA: 424242001,
			magicB: 838383845,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: sx, centerZ: sz, regionHash } = region;
		const hx = 3;
		const hz = 3;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				sx - hx,
				sx + hx,
				sz - hz,
				sz + hz,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const b = new StructureBuilder(placeBlock, columnPrepassResolver, seed);
		const baseY = b.footprintGround(sx, sz, hx, hz).min;
		const door = DOORS[Math.abs(Squirrel3.get(regionHash, seed)) % 4];

		b.buildHouse({
			cx: sx,
			cz: sz,
			baseY,
			hx,
			hz,
			height: 4,
			wall: BlockType.WoodPlanks,
			roof: BlockType.ThatchRoofAngled,
			floor: BlockType.PlankFlooring02,
			foundation: BlockType.Cobblestone03,
			doorSide: door,
			extra: (bb, by) => {
				// bamboo corner posts
				for (const [dx, dz] of [
					[-hx, -hz],
					[hx, -hz],
					[-hx, hz],
					[hx, hz],
				]) {
					bb.column(sx + dx, by, sz + dz, 6, BlockType.RoughWood);
				}
			},
		});
	}
}
