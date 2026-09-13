import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

const GEOLOGICAL_BIOMES = new Set([
	BIOME_ID.CRYSTAL_CAVES,
	BIOME_ID.OBSIDIAN_FLATS,
	BIOME_ID.GEOTHERMAL_FIELD,
]);

export class CrystalShrineFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
	public readonly maxAboveSurface = 12;

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
		if (!GEOLOGICAL_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 14,
			magicA: 646464646,
			magicB: 121212845,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: cx, centerZ: cz, regionHash } = region;
		const radius = 4;
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

		// ring of crystal pillars
		const pillars = 6 + (Math.abs(getPRNGBySeed(regionHash, seed)) % 3);
		for (let i = 0; i < pillars; i++) {
			const angle = (i / pillars) * Math.PI * 2;
			const px = Math.round(cx + Math.cos(angle) * radius);
			const pz = Math.round(cz + Math.sin(angle) * radius);
			const pg = b.ground(px, pz);
			const h = 5 + (Math.abs(getPRNGBySeed(i * 91, seed)) % 4);
			b.column(px, pg, pz, h, BlockType.CrystalBlock);
		}

		// central cluster
		const cg = b.ground(cx, cz);
		b.disc(cx, cg, cz, 1, BlockType.ExposedCrystalBlock);
		b.column(cx, cg + 1, cz, 3, BlockType.CrystalBlock);
		b.set(cx, cg + 4, cz, BlockType.ExposedCrystalBlock);
	}
}
