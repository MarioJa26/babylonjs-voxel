import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

const HOT_BIOMES = new Set([
	BIOME_ID.DESERT,
	BIOME_ID.DUNE_SEA,
	BIOME_ID.SAVANNAH,
	BIOME_ID.PLAINS,
	BIOME_ID.GRASS_LAND,
	BIOME_ID.SCORCHED_SAVANNAH,
	BIOME_ID.OASIS,
]);

export class WatchtowerFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
	public readonly maxAboveSurface = 18;

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
		if (!HOT_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 16,
			magicA: 707070001,
			magicB: 131313845,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: cx, centerZ: cz } = region;
		const hx = 1;
		const hz = 1;
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
		const height = 12;

		b.foundation(cx, cz, hx, hz, baseY, BlockType.Cobblestone03);
		b.shell(
			cx - hx,
			baseY + 1,
			cz - hz,
			cx + hx,
			baseY + height,
			cz + hz,
			BlockType.StoneTileWall,
		);
		// mid floor
		b.box(
			cx - hx,
			baseY + 6,
			cz - hz,
			cx + hx,
			baseY + 6,
			cz + hz,
			BlockType.SlateFloor,
		);
		// battlements
		b.shell(
			cx - hx,
			baseY + height + 1,
			cz - hz,
			cx + hx,
			baseY + height + 1,
			cz + hz,
			BlockType.StoneTileWall,
		);
		b.box(
			cx - hx,
			baseY + height + 2,
			cz - hz,
			cx + hx,
			baseY + height + 2,
			cz + hz,
			BlockType.RoofSlates02,
		);
	}
}
