import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { type DoorSide, StructureBuilder } from "./StructureBuilder";

const MOUNTAIN_BIOMES = new Set([
	BIOME_ID.TUNDRA_MOUNTAINS,
	BIOME_ID.ALPINE_MEADOW,
	BIOME_ID.ROCKY_HIGHLANDS,
	BIOME_ID.MESA_PLATEAU,
	BIOME_ID.CLOUD_PEAKS,
	BIOME_ID.GLACIER,
]);

const DOORS: DoorSide[] = ["x+", "x-", "z+", "z-"];

export class MountainCabinFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 400 };
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
		if (!MOUNTAIN_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 16,
			magicA: 332211009,
			magicB: 112233445,
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
		const door = DOORS[Math.abs(getPRNGBySeed(regionHash, seed)) % 4];

		b.buildHouse({
			cx,
			cz,
			baseY,
			hx,
			hz,
			height: 4,
			wall: BlockType.WoodTrunkWall,
			roof: BlockType.RoofSlates02,
			floor: BlockType.PlankFlooring02,
			foundation: BlockType.StoneTileWall,
			doorSide: door,
			windows: true,
			extra: (bb, by) => {
				bb.column(cx - hx + 1, by + 1, cz + hz - 1, 5, BlockType.StoneTileWall);
			},
		});
	}
}
