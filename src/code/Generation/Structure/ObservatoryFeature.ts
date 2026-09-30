import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import {
	aabbOverlaps,
	chunkWorldBounds,
	computeRegion,
	type RegionConfig,
} from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

const MOUNTAIN_BIOMES = new Set([
	BIOME_ID.ALPINE_MEADOW,
	BIOME_ID.ROCKY_HIGHLANDS,
	BIOME_ID.MESA_PLATEAU,
	BIOME_ID.CLOUD_PEAKS,
	BIOME_ID.GLACIER,
	BIOME_ID.TUNDRA_MOUNTAINS,
]);

/**
 * Region grid for this feature's placement, hoisted so /locate can resolve
 * it without duplicating these constants. A structure exists in region
 * `floor(chunk / regionSize)` when the hash passes the spawn chance.
 */
export const OBSERVATORY_REGION: RegionConfig = {
	regionSize: 16,
	magicA: 565656001,
	magicB: 989898845,
	spawnChance: 90,
	earlyReturn: false,
};

export class ObservatoryFeature implements IWorldFeature {
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

		const region = computeRegion(
			chunkX,
			chunkZ,
			chunkSize,
			seed,
			OBSERVATORY_REGION,
		);
		if (!region) return;

		const { centerX: cx, centerZ: cz } = region;
		const radius = 3;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				cx - radius,
				cx + radius,
				cz - radius,
				cz + radius,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const b = new StructureBuilder(placeBlock, columnPrepassResolver, seed);
		const baseY = b.footprintGround(cx, cz, radius, radius).min;

		// stone base ring
		b.disc(cx, baseY, cz, radius, BlockType.Cobblestone03);
		// cylindrical wall
		for (let dy = 1; dy <= 4; dy++) {
			b.ring(cx, baseY + dy, cz, radius, BlockType.StoneTileWall);
		}
		b.disc(cx, baseY + 1, cz, radius - 1, BlockType.SlateFloor);
		// domed roof
		b.ring(cx, baseY + 5, cz, radius, BlockType.RoofSlates02);
		b.ring(cx, baseY + 6, cz, radius - 1, BlockType.RoofSlates02);
		b.disc(cx, baseY + 7, cz, 1, BlockType.RoofSlates02);
		// telescope
		b.column(cx, baseY + 1, cz, 3, BlockType.RoughWood);
		b.box(cx - 1, baseY + 4, cz, cx + 1, baseY + 4, cz, BlockType.Glass01);
	}
}
