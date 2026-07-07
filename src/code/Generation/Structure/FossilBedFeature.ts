import { BlockType } from "../../World/Texture/BlockType";
import type { Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import type { IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

export class FossilBedFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -300, maxWorldY: -20 };

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
	) {
		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 10,
			magicA: 8989012345,
			magicB: 666768696,
			spawnChance: 5,
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
			-50 - (Math.abs(Squirrel3.get(region.regionHash, seed)) % 150);
		const numFossils =
			3 + (Math.abs(Squirrel3.get(region.regionHash + 5, seed)) % 5);

		for (let i = 0; i < numFossils; i++) {
			const fX = fx + (Math.abs(Squirrel3.get(i * 13, seed)) % 11) - 5;
			const fZ = fz + (Math.abs(Squirrel3.get(i * 17, seed)) % 11) - 5;
			const fLen = 3 + (Math.abs(Squirrel3.get(i * 23, seed)) % 4);
			const dir = Math.abs(Squirrel3.get(i * 29, seed)) % 2;

			for (let l = 0; l < fLen; l++) {
				const fossilBlock =
					Math.abs(Squirrel3.get(i * 31 + l, seed)) % 2 === 0
						? BlockType.SaltBlock
						: BlockType.Cobblestone03;
				placeBlock(
					fX + (dir === 0 ? l : 0),
					fossilY,
					fZ + (dir === 1 ? l : 0),
					fossilBlock,
					true,
				);
			}

			const ribCount = 2 + (Math.abs(Squirrel3.get(i * 37, seed)) % 3);
			for (let r = 0; r < ribCount; r++) {
				const rOffset =
					1 + (Math.abs(Squirrel3.get(i * 41 + r, seed)) % (fLen - 1));
				placeBlock(
					fX + (dir === 0 ? rOffset : 0),
					fossilY + 1,
					fZ + (dir === 1 ? rOffset : 0),
					BlockType.SaltBlock,
					true,
				);
			}
		}

		for (let dx = -4; dx <= 4; dx++) {
			for (let dz = -4; dz <= 4; dz++) {
				if (
					Math.abs(Squirrel3.get(fx + dx * 7 + fz + dz * 11, seed)) % 4 ===
					0
				) {
					placeBlock(fx + dx, fossilY - 1, fz + dz, BlockType.SaltBlock, true);
				}
			}
		}
	}
}
