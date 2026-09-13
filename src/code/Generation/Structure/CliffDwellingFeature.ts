import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { type DoorSide, StructureBuilder } from "./StructureBuilder";

const MOUNTAIN_BIOMES = new Set([
	BIOME_ID.RED_ROCK_CANYON,
	BIOME_ID.MESA_PLATEAU,
	BIOME_ID.BADLANDS,
	BIOME_ID.ROCKY_HIGHLANDS,
]);

const DOORS: DoorSide[] = ["x+", "x-", "z+", "z-"];

export class CliffDwellingFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 400 };
	public readonly maxAboveSurface = 16;

	public generate(
		chunkX: number,
		_chunkY: number,
		chunkZ: number,
		biome: Biome,
		placeBlock: PlaceBlockFn,
		seed: number,
		chunkSize: number,
		generatingChunkX: number,
		generatingChunkZ: number,
		columnPrepassResolver?: ColumnPrepassResolver,
	) {
		if (!MOUNTAIN_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 14,
			magicA: 646464001,
			magicB: 919191845,
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
			height: 3,
			wall: BlockType.JapaneseStoneWall,
			roof: BlockType.StoneTiles02,
			floor: BlockType.PlankFlooring02,
			foundation: BlockType.Cobblestone03,
			doorSide: door,
		});
		// second terrace tier
		b.box(
			cx - hx,
			baseY + 5,
			cz - hz,
			cx + hx - 1,
			baseY + 5,
			cz + hz - 1,
			BlockType.StoneTiles02,
		);
		b.shell(
			cx - hx,
			baseY + 6,
			cz - hz,
			cx + hx - 1,
			baseY + 7,
			cz + hz - 1,
			BlockType.JapaneseStoneWall,
			{ side: door, width: 1, height: 2 },
		);
	}
}
