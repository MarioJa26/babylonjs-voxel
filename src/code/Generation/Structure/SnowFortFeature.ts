import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { type DoorSide, StructureBuilder } from "./StructureBuilder";

const COLD_BIOMES = new Set([
	BIOME_ID.SNOWY_PLAINS,
	BIOME_ID.TUNDRA,
	BIOME_ID.FROZEN_TUNDRA_PLAINS,
]);

const GATES: DoorSide[] = ["x+", "x-", "z+", "z-"];

export class SnowFortFeature implements IWorldFeature {
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
		if (!COLD_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 12,
			magicA: 6089012345,
			magicB: 556677889,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: fx, centerZ: fz, regionHash } = region;
		const hx = 5;
		const hz = 5;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				fx - hx,
				fx + hx,
				fz - hz,
				fz + hz,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const b = new StructureBuilder(placeBlock, columnPrepassResolver, seed);
		const baseY = b.footprintGround(fx, fz, hx, hz).min;
		const gate = GATES[Math.abs(Squirrel3.get(regionHash, seed)) % 4];

		// perimeter wall with gate
		b.foundation(fx, fz, hx, hz, baseY, BlockType.SaltBlock);
		b.shell(
			fx - hx,
			baseY + 1,
			fz - hz,
			fx + hx,
			baseY + 4,
			fz + hz,
			BlockType.SaltBlock,
			{
				side: gate,
				width: 2,
				height: 3,
			},
		);
		// crenellations
		b.shell(
			fx - hx,
			baseY + 5,
			fz - hz,
			fx + hx,
			baseY + 5,
			fz + hz,
			BlockType.SaltBlock,
		);

		// corner towers
		for (const [dx, dz] of [
			[-hx, -hz],
			[hx, -hz],
			[-hx, hz],
			[hx, hz],
		]) {
			b.box(
				fx + dx - 1,
				baseY,
				fz + dz - 1,
				fx + dx + 1,
				baseY + 6,
				fz + dz + 1,
				BlockType.Cobblestone03,
			);
		}

		// central keep
		b.box(
			fx - 1,
			baseY + 1,
			fz - 1,
			fx + 1,
			baseY + 3,
			fz + 1,
			BlockType.SaltBlock,
		);
		b.set(fx, baseY + 4, fz, BlockType.Cobblestone03);
	}
}
