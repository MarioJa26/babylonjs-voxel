import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

const EXOTIC_BIOMES = new Set([
	BIOME_ID.PETRIFIED_FOREST,
	BIOME_ID.ASHEN_WASTELAND,
	BIOME_ID.BADLANDS,
	BIOME_ID.DUST_BOWL,
]);

export class PetrifiedShrineFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
	public readonly maxAboveSurface = 12;

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
		if (!EXOTIC_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 14,
			magicA: 757575757,
			magicB: 343434845,
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

		// ring of petrified logs stood on end
		const pillars = 6 + (Math.abs(getPRNGBySeed(regionHash, seed)) % 3);
		for (let i = 0; i < pillars; i++) {
			const angle = (i / pillars) * Math.PI * 2;
			const px = Math.round(cx + Math.cos(angle) * radius);
			const pz = Math.round(cz + Math.sin(angle) * radius);
			const pg = b.ground(px, pz);
			const h = 4 + (Math.abs(getPRNGBySeed(i * 91, seed)) % 3);
			b.column(px, pg, pz, h, BlockType.MossWood);
		}

		// central altar of cracked stone
		const cg = b.ground(cx, cz);
		b.disc(cx, cg, cz, 1, BlockType.AncientCrackedStone);
		b.column(cx, cg + 1, cz, 2, BlockType.MossWood);
		b.set(cx, cg + 3, cz, BlockType.AncientCrackedStone);
	}
}
