import { BlockType } from "../../World/Texture/BlockType";
import type { Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

export class AbyssalTempleFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -400, maxWorldY: -50 };

	public generate(
		chunkX: number,
		_chunkY: number,
		chunkZ: number,
		_biome: Biome,
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
			regionSize: 16,
			magicA: 7878901234,
			magicB: 555657585,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: tx, centerZ: tz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		const templeRadius = 8;

		if (
			!aabbOverlaps(
				tx - templeRadius,
				tx + templeRadius,
				tz - templeRadius,
				tz + templeRadius,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const templeY =
			-100 - (Math.abs(getPRNGBySeed(region.regionHash, seed)) % 200);
		const templeHeight =
			12 + (Math.abs(getPRNGBySeed(region.regionHash + 5, seed)) % 8);
		const radiusSq = templeRadius * templeRadius;

		for (let dy = 0; dy < templeHeight; dy++) {
			for (let dx = -templeRadius; dx <= templeRadius; dx++) {
				for (let dz = -templeRadius; dz <= templeRadius; dz++) {
					if (dx * dx + dz * dz > radiusSq) continue;

					const isWall =
						Math.abs(dx) === templeRadius || Math.abs(dz) === templeRadius;
					const isFloor = dy === 0 || dy === templeHeight - 1;
					const isHollow =
						dy > 0 &&
						dy < templeHeight - 1 &&
						Math.abs(dx) < templeRadius - 1 &&
						Math.abs(dz) < templeRadius - 1;

					if (isHollow && !isWall && !isFloor) continue;

					let blockId: number;
					if (isFloor) {
						blockId = BlockType.Obsidian;
					} else if (isWall) {
						blockId =
							dy % 3 === 0 ? BlockType.CrystalBlock : BlockType.Obsidian;
					} else {
						blockId = BlockType.Obsidian;
					}
					placeBlock(tx + dx, templeY + dy, tz + dz, blockId, true);
				}
			}
		}

		const pillarPositions: [number, number][] = [
			[-3, -3],
			[3, -3],
			[-3, 3],
			[3, 3],
		];
		for (const [px, pz] of pillarPositions) {
			for (let y = 1; y < templeHeight - 1; y++) {
				placeBlock(
					tx + px,
					templeY + y,
					tz + pz,
					BlockType.ExposedCrystalBlock,
					true,
				);
			}
		}

		placeBlock(
			tx,
			templeY + Math.floor(templeHeight / 2),
			tz,
			BlockType.CrystalBlock,
			true,
		);
	}
}
