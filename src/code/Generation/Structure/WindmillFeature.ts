import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

const TEMPERATE_BIOMES = new Set([
	BIOME_ID.PLAINS,
	BIOME_ID.GRASS_LAND,
	BIOME_ID.MEADOW,
	BIOME_ID.HEDGEROW,
	BIOME_ID.SAVANNAH,
]);

export class WindmillFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
	public readonly maxAboveSurface = 22;

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
			regionSize: 16,
			magicA: 858585001,
			magicB: 252525845,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: cx, centerZ: cz, regionHash } = region;
		const hx = 1;
		const hz = 1;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				cx - hx - 4,
				cx + hx + 4,
				cz - hz - 4,
				cz + hz + 4,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const b = new StructureBuilder(placeBlock, columnPrepassResolver, seed);
		const baseY = b.footprintGround(cx, cz, hx, hz).min;

		// stone base
		b.foundation(cx, cz, hx, hz, baseY, BlockType.Cobblestone03);
		b.shell(
			cx - hx,
			baseY + 1,
			cz - hz,
			cx + hx,
			baseY + 5,
			cz + hz,
			BlockType.StoneTileWall,
		);
		// wood upper
		b.shell(
			cx - hx,
			baseY + 6,
			cz - hz,
			cx + hx,
			baseY + 11,
			cz + hz,
			BlockType.WoodPlankWall,
		);
		// cap roof
		b.box(
			cx - hx,
			baseY + 12,
			cz - hz,
			cx + hx,
			baseY + 12,
			cz + hz,
			BlockType.RoofSlates02,
		);

		// blades: a cross of RoughWood on the +x face
		const hubY = baseY + 9;
		b.column(cx + hx + 1, hubY - 4, cz, 9, BlockType.RoughWood);
		b.column(cx + hx + 1, hubY, cz - 4, 9, BlockType.RoughWood);
		b.set(cx + hx + 1, hubY, cz, BlockType.WoodTable);
	}
}
