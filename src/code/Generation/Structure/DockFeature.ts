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
	BIOME_ID.TIDAL_FLATS,
	BIOME_ID.KELP_FOREST,
	BIOME_ID.CORAL_REEF,
]);

export class DockFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -20, maxWorldY: 200 };
	public readonly maxAboveSurface = 8;

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
			regionSize: 14,
			magicA: 131313001,
			magicB: 767676845,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: cx, centerZ: cz } = region;
		const hx = 2;
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
		// docks sit at water level: use the lowest ground (shore) as deck height
		const baseY = b.footprintGround(cx, cz, hx, hz).min;

		// deck planks
		b.box(
			cx - hx,
			baseY,
			cz - hz,
			cx + hx,
			baseY,
			cz + hz,
			BlockType.WoodPlanks,
		);
		// support posts at the corners going down
		for (const [dx, dz] of [
			[-hx, -hz],
			[hx, -hz],
			[-hx, hz],
			[hx, hz],
		]) {
			const g = b.ground(cx + dx, cz + dz);
			b.column(cx + dx, g, cz + dz, baseY - g + 1, BlockType.RoughWood);
		}
		// small hut at the shore end
		b.box(
			cx - hx,
			baseY + 1,
			cz - hz,
			cx + hx,
			baseY + 2,
			cz - hz,
			BlockType.WoodPlankWall,
			true,
		);
		b.box(
			cx - hx,
			baseY + 3,
			cz - hz,
			cx + hx,
			baseY + 3,
			cz - hz,
			BlockType.ThatchRoofAngled,
			true,
		);
	}
}
