import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

const HOT_BIOMES = new Set([
	BIOME_ID.DESERT,
	BIOME_ID.DUNE_SEA,
	BIOME_ID.SALT_FLATS,
	BIOME_ID.CRACKED_EARTH,
	BIOME_ID.DUST_BOWL,
	BIOME_ID.BADLANDS,
	BIOME_ID.RED_ROCK_CANYON,
]);

export class PyramidFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 300 };
	public readonly maxAboveSurface = 40;

	public generate(
		chunkX: number,
		_chunkY: number,
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
			regionSize: 18,
			magicA: 2434567890,
			magicB: 101112131,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: px, centerZ: pz, regionHash } = region;
		const baseRadius = 9 + (Math.abs(getPRNGBySeed(regionHash, seed)) % 6);
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				px - baseRadius,
				px + baseRadius,
				pz - baseRadius,
				pz + baseRadius,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const b = new StructureBuilder(placeBlock, columnPrepassResolver, seed);
		const ground = b.ground(px, pz);
		const gateDir = Math.abs(getPRNGBySeed(regionHash + 3, seed)) % 4;
		const gate =
			gateDir === 0 ? "x+" : gateDir === 1 ? "x-" : gateDir === 2 ? "z+" : "z-";

		const height = baseRadius; // 1 block per step
		for (let dy = 0; dy < height; dy++) {
			const r = baseRadius - dy;
			const block =
				dy % 3 === 0 ? BlockType.RedSandstoneWall : BlockType.Cobblestone03;
			const r2 = r * r;
			const inner2 = (r - 2) * (r - 2);
			for (let dx = -r; dx <= r; dx++) {
				for (let dz = -r; dz <= r; dz++) {
					const d2 = dx * dx + dz * dz;
					if (d2 > r2) continue;
					// hollow interior above the first few steps
					if (dy >= 3 && d2 < inner2) continue;
					// entrance gap at the base
					if (
						dy < 3 &&
						((gate === "x+" && dx === r && Math.abs(dz) <= 1) ||
							(gate === "x-" && dx === -r && Math.abs(dz) <= 1) ||
							(gate === "z+" && dz === r && Math.abs(dx) <= 1) ||
							(gate === "z-" && dz === -r && Math.abs(dx) <= 1))
					)
						continue;
					b.set(px + dx, ground + dy, pz + dz, block);
				}
			}
		}
		// capstone
		b.set(px, ground + height, pz, BlockType.Glass01);
	}
}
