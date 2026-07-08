import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { type DoorSide, StructureBuilder } from "./StructureBuilder";

const FOREST_BIOMES = new Set([
	BIOME_ID.FOREST,
	BIOME_ID.BIRCH_FOREST,
	BIOME_ID.MAPLE_FOREST,
	BIOME_ID.AUTUMN_FOREST,
	BIOME_ID.TEMPERATE_RAINFOREST,
	BIOME_ID.CHERRY_BLOSSOM_FOREST,
]);

const DOORS: DoorSide[] = ["x+", "x-", "z+", "z-"];

export class TreehouseFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 300 };
	public readonly maxAboveSurface = 24;

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
		if (!FOREST_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 16,
			magicA: 737373001,
			magicB: 141414845,
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
		const g = b.footprintGround(cx, cz, hx, hz);
		const baseY = g.avg + 5;
		const door = DOORS[Math.abs(Squirrel3.get(regionHash, seed)) % 4];

		// support stilts from ground up to the platform
		for (const [dx, dz] of [
			[-hx, -hz],
			[hx, -hz],
			[-hx, hz],
			[hx, hz],
		]) {
			const ground = b.ground(cx + dx, cz + dz);
			b.column(cx + dx, ground, cz + dz, baseY - ground, BlockType.RoughWood);
		}
		// platform
		b.box(
			cx - hx - 1,
			baseY - 1,
			cz - hz - 1,
			cx + hx + 1,
			baseY - 1,
			cz + hz + 1,
			BlockType.WoodPlanks,
		);

		b.buildHouse({
			cx,
			cz,
			baseY,
			hx,
			hz,
			height: 3,
			wall: BlockType.WoodPlanks,
			roof: BlockType.ThatchRoofAngled,
			floor: BlockType.PlankFlooring02,
			foundation: BlockType.WoodPlanks,
			doorSide: door,
			windows: true,
		});
	}
}
