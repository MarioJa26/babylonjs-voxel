import { BlockType } from "../../World/Texture/BlockType";
import type { Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

export class FossilBedFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -300, maxWorldY: -20 };

	public generate(
		chunkX: number,
		_chunkY: number,
		chunkZ: number,
		_biome: Biome,
		placeBlock: PlaceBlockFn,
		seed: number,
		chunkSize: number,
		generatingChunkX: number,
		generatingChunkZ: number,
	) {
		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 10,
			magicA: 8989012345,
			magicB: 666768696,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: fx, centerZ: fz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		if (
			!aabbOverlaps(
				fx - 8,
				fx + 8,
				fz - 8,
				fz + 8,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const fossilY =
			-50 - (Math.abs(getPRNGBySeed(region.regionHash, seed)) % 150);
		const numFossils =
			3 + (Math.abs(getPRNGBySeed(region.regionHash + 5, seed)) % 4);

		for (let i = 0; i < numFossils; i++) {
			const sx = fx + (Math.abs(getPRNGBySeed(i * 13, seed)) % 11) - 5;
			const sz = fz + (Math.abs(getPRNGBySeed(i * 17, seed)) % 11) - 5;
			const len = 4 + (Math.abs(getPRNGBySeed(i * 23, seed)) % 5);
			const dir = Math.abs(getPRNGBySeed(i * 29, seed)) % 2;
			const bone =
				Math.abs(getPRNGBySeed(i * 31, seed)) % 2 === 0
					? BlockType.SaltBlock
					: BlockType.Cobblestone03;

			// spine
			for (let l = 0; l < len; l++) {
				placeBlock(
					sx + (dir === 0 ? l : 0),
					fossilY,
					sz + (dir === 1 ? l : 0),
					bone,
					true,
				);
			}
			// skull at the head end
			const hx = sx + (dir === 0 ? len : 0);
			const hz = sz + (dir === 1 ? len : 0);
			placeBlock(hx, fossilY, hz, BlockType.Cobblestone03, true);
			placeBlock(hx, fossilY + 1, hz, BlockType.Cobblestone03, true);

			// rib cage: symmetric arches along the spine
			const ribs = 2 + (Math.abs(getPRNGBySeed(i * 37, seed)) % 3);
			for (let r = 0; r < ribs; r++) {
				const off = 1 + (Math.abs(getPRNGBySeed(i * 41 + r, seed)) % (len - 1));
				const bx = sx + (dir === 0 ? off : 0);
				const bz = sz + (dir === 1 ? off : 0);
				const spread = 2;
				for (let k = 1; k <= spread; k++) {
					placeBlock(bx - k, fossilY + 1, bz, bone, true);
					placeBlock(bx + k, fossilY + 1, bz, bone, true);
					placeBlock(bx - k, fossilY + 2, bz, bone, true);
					placeBlock(bx + k, fossilY + 2, bz, bone, true);
				}
			}
		}

		// scattered loose bones in the sediment
		for (let dx = -4; dx <= 4; dx++) {
			for (let dz = -4; dz <= 4; dz++) {
				if (
					Math.abs(getPRNGBySeed(fx + dx * 7 + fz + dz * 11, seed)) % 5 ===
					0
				) {
					placeBlock(fx + dx, fossilY - 1, fz + dz, BlockType.SaltBlock, true);
				}
			}
		}
	}
}
