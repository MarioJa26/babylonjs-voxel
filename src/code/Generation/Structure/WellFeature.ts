import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

const TEMPERATE_BIOMES = new Set([
	BIOME_ID.FOREST,
	BIOME_ID.PLAINS,
	BIOME_ID.GRASS_LAND,
	BIOME_ID.MEADOW,
	BIOME_ID.GROVE,
	BIOME_ID.BIRCH_FOREST,
	BIOME_ID.MAPLE_FOREST,
	BIOME_ID.SAVANNAH,
	BIOME_ID.HEDGEROW,
	BIOME_ID.CHERRY_BLOSSOM_FOREST,
	BIOME_ID.AUTUMN_FOREST,
	BIOME_ID.PINE_FOREST,
]);

export class WellFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -20, maxWorldY: 200 };
	public readonly maxAboveSurface = 10;

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
		if (!TEMPERATE_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 12,
			magicA: 1323456789,
			magicB: 990011223,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: wx, centerZ: wz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				wx - 3,
				wx + 3,
				wz - 3,
				wz + 3,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const b = new StructureBuilder(placeBlock, columnPrepassResolver, seed);
		const ground = b.ground(wx, wz);

		// sunken water pool 3x3
		b.box(
			wx - 1,
			ground - 2,
			wz - 1,
			wx + 1,
			ground - 1,
			wz + 1,
			BlockType.Water,
		);
		// stone rim
		for (let dx = -2; dx <= 2; dx++) {
			for (let dz = -2; dz <= 2; dz++) {
				if (Math.abs(dx) === 2 || Math.abs(dz) === 2) {
					b.set(wx + dx, ground, wz + dz, BlockType.Cobblestone03);
					b.set(wx + dx, ground + 1, wz + dz, BlockType.Cobblestone03);
				}
			}
		}
		// corner posts
		for (const [dx, dz] of [
			[-2, -2],
			[2, -2],
			[-2, 2],
			[2, 2],
		]) {
			b.column(wx + dx, ground + 2, wz + dz, 3, BlockType.RoughWood);
		}
		// cross beams
		b.box(wx - 2, ground + 4, wz, wx + 2, ground + 4, wz, BlockType.RoughWood);
		b.box(wx, ground + 4, wz - 2, wx, ground + 4, wz + 2, BlockType.RoughWood);
		// little roof
		b.box(
			wx - 2,
			ground + 5,
			wz - 2,
			wx + 2,
			ground + 5,
			wz + 2,
			BlockType.ThatchRoofAngled,
		);
	}
}
