import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

const COASTAL_BIOMES = new Set([
	BIOME_ID.OCEAN,
	BIOME_ID.SANDY_SHORE,
	BIOME_ID.ROCKY_SHORE,
	BIOME_ID.CORAL_REEF,
	BIOME_ID.ARCHIPELAGO,
	BIOME_ID.KELP_FOREST,
]);

export class LighthouseFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
	public readonly maxAboveSurface = 20;

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
		if (!COASTAL_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 16,
			magicA: 929292001,
			magicB: 454545845,
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
		const height = 13;

		b.foundation(cx, cz, hx, hz, baseY, BlockType.Cobblestone03);
		b.shell(
			cx - hx,
			baseY + 1,
			cz - hz,
			cx + hx,
			baseY + height,
			cz + hz,
			BlockType.ConcreteTileFacade,
			{
				side: "z+",
				width: 1,
				height: 3,
			},
		);
		// gallery floor
		b.box(
			cx - hx - 1,
			baseY + height + 1,
			cz - hz - 1,
			cx + hx + 1,
			baseY + height + 1,
			cz + hz + 1,
			BlockType.Cobblestone03,
		);
		// lantern room (glass)
		b.box(
			cx - hx,
			baseY + height + 2,
			cz - hz,
			cx + hx,
			baseY + height + 4,
			cz + hz,
			BlockType.Glass01,
		);
		// roof
		b.box(
			cx - hx,
			baseY + height + 5,
			cz - hz,
			cx + hx,
			baseY + height + 5,
			cz + hz,
			BlockType.RoofSlates02,
		);
	}
}
