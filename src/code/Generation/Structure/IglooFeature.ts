import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

const COLD_BIOMES = new Set([
	BIOME_ID.SNOWY_PLAINS,
	BIOME_ID.FROZEN_TUNDRA_PLAINS,
	BIOME_ID.ICE_SPIKES,
	BIOME_ID.PERMAFROST_BOG,
	BIOME_ID.AURORA_TUNDRA,
	BIOME_ID.GLACIER,
]);

export class IglooFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
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
		if (!COLD_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 14,
			magicA: 171717001,
			magicB: 383838845,
			spawnChance: 90,
			earlyReturn: false,
		});
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
				cx - radius - 2,
				cx + radius + 2,
				cz - radius - 2,
				cz + radius + 2,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const b = new StructureBuilder(placeBlock, columnPrepassResolver, seed);
		const baseY = b.footprintGround(cx, cz, radius, radius).min;
		const entrance = Math.abs(getPRNGBySeed(region.regionHash, seed)) % 4;

		// dome: solid lower courses + ringed upper courses
		for (let dy = 0; dy <= 3; dy++) {
			const r = radius - dy;
			b.disc(cx, baseY + dy, cz, r, BlockType.IceBlock);
		}
		// entrance tunnel
		const ex = entrance === 0 ? 1 : entrance === 2 ? -1 : 0;
		const ez = entrance === 1 ? 1 : entrance === 3 ? -1 : 0;
		const sx = cx + ex * radius;
		const sz = cz + ez * radius;
		for (let t = 1; t <= 2; t++) {
			const tx = cx + ex * (radius + t);
			const tz = cz + ez * (radius + t);
			b.set(tx, baseY, tz, BlockType.IceBlock);
			b.set(tx, baseY + 1, tz, BlockType.IceBlock);
			b.set(tx, baseY + 2, tz, BlockType.Air);
		}
		void sx;
		void sz;
	}
}
