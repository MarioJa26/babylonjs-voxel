import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

const HOT_TEMPERATE_BIOMES = new Set([
	BIOME_ID.DESERT,
	BIOME_ID.SAVANNAH,
	BIOME_ID.DUNE_SEA,
	BIOME_ID.SCORCHED_SAVANNAH,
	BIOME_ID.DUST_BOWL,
	BIOME_ID.OASIS,
]);

export class CaravanCampFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
	public readonly maxAboveSurface = 6;

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
		if (!HOT_TEMPERATE_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 16,
			magicA: 343434001,
			magicB: 767676845,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: cx, centerZ: cz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				cx - 7,
				cx + 7,
				cz - 7,
				cz + 7,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const b = new StructureBuilder(placeBlock, columnPrepassResolver, seed);

		// central campfire
		const cg = b.ground(cx, cz);
		b.box(cx - 1, cg, cz - 1, cx + 1, cg, cz + 1, BlockType.Cobblestone03);
		b.set(cx, cg + 1, cz, BlockType.WoodTable);
		b.set(cx, cg + 2, cz, BlockType.Cobblestone03);

		// ring of tents
		const tents = 3 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 3);
		for (let i = 0; i < tents; i++) {
			const angle = (i / tents) * Math.PI * 2;
			const tx = Math.round(cx + Math.cos(angle) * 5);
			const tz = Math.round(cz + Math.sin(angle) * 5);
			const tg = b.ground(tx, tz);
			const hx = 2;
			const hz = 2;
			b.foundation(tx, tz, hx, hz, tg + 1, BlockType.GravellySand);
			// tent walls (short)
			b.shell(
				tx - hx,
				tg + 1,
				tz - hz,
				tx + hx,
				tg + 2,
				tz + hz,
				BlockType.TerracottaBlock,
			);
			// peaked roof made of thatch
			for (let dy = 0; dy <= hx + 1; dy++) {
				const r = hx + 1 - dy;
				b.disc(tx, tg + 3 + dy, tz, r, BlockType.ThatchRoofAngled);
			}
		}
	}
}
