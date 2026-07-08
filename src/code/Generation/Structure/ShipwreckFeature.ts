import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

const COASTAL_BIOMES = new Set([
	BIOME_ID.OCEAN,
	BIOME_ID.SANDY_SHORE,
	BIOME_ID.ROCKY_SHORE,
	BIOME_ID.CORAL_REEF,
	BIOME_ID.KELP_FOREST,
	BIOME_ID.ARCHIPELAGO,
	BIOME_ID.TIDAL_FLATS,
]);

export class ShipwreckFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -20, maxWorldY: 200 };
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
		if (!COASTAL_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 16,
			magicA: 343434434,
			magicB: 565656845,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: cx, centerZ: cz } = region;
		const hx = 4;
		const hz = 2;
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
		const rot = Math.abs(Squirrel3.get(region.regionHash, seed)) % 4;

		// hull sides (skip the very bow/stern for a tapered look)
		for (let dx = -hx + 1; dx <= hx - 1; dx++) {
			for (let dy = 0; dy <= 2; dy++) {
				b.set(cx + dx, baseY + dy, cz - hz, BlockType.WoodPlankWall);
				b.set(cx + dx, baseY + dy, cz + hz, BlockType.WoodPlankWall);
			}
		}
		// deck
		b.box(
			cx - hx + 1,
			baseY + 3,
			cz - hz,
			cx + hx - 1,
			baseY + 3,
			cz + hz,
			BlockType.WoodPlanks,
		);
		// broken hull bottom
		b.box(
			cx - hx + 1,
			baseY - 1,
			cz - hz + 1,
			cx + hx - 1,
			baseY - 1,
			cz + hz - 1,
			BlockType.WoodPlankWall,
		);

		// mast + crossbeam
		const mastX = cx + (rot % 2 === 0 ? 0 : hx - 2);
		b.column(mastX, baseY + 4, cz, 6, BlockType.RoughWood);
		b.box(
			mastX - 3,
			baseY + 8,
			cz,
			mastX + 3,
			baseY + 8,
			cz,
			BlockType.RoughWood,
		);

		// a couple of broken ribs poking out
		for (const off of [-2, 2]) {
			b.set(cx + off, baseY + 4, cz - hz, BlockType.RoughWood);
			b.set(cx + off, baseY + 4, cz + hz, BlockType.RoughWood);
		}
	}
}
