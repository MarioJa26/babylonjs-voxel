import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { type DoorSide, StructureBuilder } from "./StructureBuilder";

const GEOLOGICAL_BIOMES = new Set([
	BIOME_ID.MUSHROOM_FIELDS,
	BIOME_ID.SWAMP,
	BIOME_ID.PEAT_BOG,
	BIOME_ID.WETLANDS,
]);

const DOORS: DoorSide[] = ["x+", "x-", "z+", "z-"];

export class MushroomHutFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
	public readonly maxAboveSurface = 16;

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
		if (!GEOLOGICAL_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 15,
			magicA: 515253001,
			magicB: 717273845,
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
				cx - hx - 1,
				cx + hx + 1,
				cz - hz - 1,
				cz + hz + 1,
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
			height: 3,
			wall: BlockType.MushroomStem,
			roof: BlockType.MushroomAmanitacap,
			floor: BlockType.MossWood,
			foundation: BlockType.MushroomStem,
			doorSide: door,
		});
		// wide cap overhang
		b.disc(cx, baseY + 5, cz, hx + 1, BlockType.MushroomAmanitacap);
	}
}
