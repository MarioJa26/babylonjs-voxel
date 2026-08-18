import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

const TROPICAL_BIOMES = new Set([
	BIOME_ID.JUNGLE,
	BIOME_ID.BAMBOO_FOREST,
	BIOME_ID.MANGROVE,
	BIOME_ID.TROPICAL_ISLAND,
	BIOME_ID.CLOUD_FOREST,
]);

export class TropicalTempleFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
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
		if (!TROPICAL_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 16,
			magicA: 818181001,
			magicB: 272727845,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: cx, centerZ: cz } = region;
		const hx = 4;
		const hz = 4;
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

		// stepped platform
		b.box(
			cx - hx - 1,
			baseY,
			cz - hz - 1,
			cx + hx + 1,
			baseY,
			cz + hz + 1,
			BlockType.GravellySand,
		);
		b.box(
			cx - hx,
			baseY + 1,
			cz - hz,
			cx + hx,
			baseY + 1,
			cz + hz,
			BlockType.RedSandstoneWall,
		);

		// hall: corner columns + roof
		for (const [dx, dz] of [
			[-hx, -hz],
			[hx, -hz],
			[-hx, hz],
			[hx, hz],
		]) {
			b.column(cx + dx, baseY + 2, cz + dz, 5, BlockType.RedSandstoneWall);
		}
		b.box(
			cx - hx,
			baseY + 7,
			cz - hz,
			cx + hx,
			baseY + 7,
			cz + hz,
			BlockType.RoofSlates02,
		);
		// doorway pillars
		b.shell(
			cx - 1,
			baseY + 2,
			cz - hz,
			cx + 1,
			baseY + 4,
			cz - hz,
			BlockType.RedSandstoneWall,
			{
				side: "z-",
				width: 1,
				height: 3,
			},
		);
	}
}
