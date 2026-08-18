import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { type DoorSide, StructureBuilder } from "./StructureBuilder";

const EXOTIC_BIOMES = new Set([
	BIOME_ID.ANCIENT_RUINS_BIOME,
	BIOME_ID.ASHEN_WASTELAND,
	BIOME_ID.BADLANDS,
	BIOME_ID.DUST_BOWL,
	BIOME_ID.CRACKED_EARTH,
]);

const DOORS: DoorSide[] = ["x+", "x-", "z+", "z-"];

export class RuinFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
	public readonly maxAboveSurface = 15;

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
		if (!EXOTIC_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 12,
			magicA: 5656789012,
			magicB: 333435363,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: rx, centerZ: rz, regionHash } = region;
		const hx = 4;
		const hz = 4;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				rx - hx,
				rx + hx,
				rz - hz,
				rz + hz,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const b = new StructureBuilder(placeBlock, columnPrepassResolver, seed);
		const baseY = b.footprintGround(rx, rz, hx, hz).min;
		const door = DOORS[Math.abs(getPRNGBySeed(regionHash, seed)) % 4];
		const block =
			Math.abs(getPRNGBySeed(regionHash + 10, seed)) % 2 === 0
				? BlockType.AncientCrackedStone
				: BlockType.MossyCobble;

		b.foundation(rx, rz, hx, hz, baseY, block);
		const maxH = 5;
		b.shell(
			rx - hx,
			baseY + 1,
			rz - hz,
			rx + hx,
			baseY + maxH,
			rz + hz,
			block,
			{
				side: door,
				width: 2,
				height: 3,
			},
		);

		// broken top edge: randomly knock out upper blocks
		for (let dx = -hx; dx <= hx; dx++) {
			for (let dz = -hz; dz <= hz; dz++) {
				const edge = Math.abs(dx) === hx || Math.abs(dz) === hz;
				if (!edge) continue;
				if (Math.abs(getPRNGBySeed(dx * 13 + dz * 17, seed)) % 3 === 0) {
					b.air(rx + dx, baseY + maxH, rz + dz);
				}
			}
		}

		// central altar
		b.box(
			rx - 1,
			baseY,
			rz - 1,
			rx + 1,
			rz + 1,
			baseY,
			BlockType.Cobblestone03,
		);
		b.column(rx, baseY + 1, rz, 2, BlockType.MossyCobble);
	}
}
