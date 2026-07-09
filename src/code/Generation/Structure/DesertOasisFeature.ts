import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

const HOT_BIOMES = new Set([
	BIOME_ID.DESERT,
	BIOME_ID.DUNE_SEA,
	BIOME_ID.SAVANNAH,
	BIOME_ID.CRACKED_EARTH,
]);

export class DesertOasisFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -20, maxWorldY: 200 };
	public readonly maxAboveSurface = 10;

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
		if (!HOT_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 16,
			magicA: 393939001,
			magicB: 606060845,
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

		// water pool
		const cg = b.ground(cx, cz);
		b.disc(cx, cg - 1, cz, radius, BlockType.Water);
		b.disc(cx, cg - 2, cz, radius - 1, BlockType.Water);
		// sandy rim
		b.ring(cx, cg, cz, radius + 1, BlockType.GravellySand);

		// palms around the rim
		const palms = 3 + (Math.abs(getPRNGBySeed(regionHash, seed)) % 3);
		for (let i = 0; i < palms; i++) {
			const angle = (i / palms) * Math.PI * 2 + 0.5;
			const tx = Math.round(cx + Math.cos(angle) * (radius + 1));
			const tz = Math.round(cz + Math.sin(angle) * (radius + 1));
			const tg = b.ground(tx, tz);
			const h = 4 + (Math.abs(getPRNGBySeed(i * 57, seed)) % 3);
			b.column(tx, tg, tz, h, BlockType.PalmTrunk);
			b.disc(tx, tg + h, tz, 2, BlockType.PalmLeaves);
			b.disc(tx, tg + h + 1, tz, 1, BlockType.PalmLeaves);
		}
	}
}
