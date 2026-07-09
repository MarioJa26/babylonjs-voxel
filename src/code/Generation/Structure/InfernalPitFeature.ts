import { BlockType } from "../../World/Texture/BlockType";
import type { Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const LAVA = 24;
const BASALT = BlockType.BasaltBlock;

export class InfernalPitFeature implements IWorldFeature {
	// pitTopY = -64 - random % 128 (-64..-192), pit extends downward into a crater.
	public readonly verticalBounds = {
		minWorldY: -230,
		maxWorldY: 0,
	};

	public generate(
		chunkX: number,
		chunkY: number,
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
			magicA: 914237561,
			magicB: 348921467,
			spawnChance: 4,
			earlyReturn: true,
		});
		if (!region) return;

		const { regionHash, centerX: px, centerZ: pz } = region;
		const pitTopY = -64 - (Math.abs(getPRNGBySeed(regionHash + 2, seed)) % 128);
		const pitRadius = 7 + (Math.abs(getPRNGBySeed(regionHash + 3, seed)) % 5);
		const depth = 18 + (Math.abs(getPRNGBySeed(regionHash + 4, seed)) % 12);
		const rimRadius = pitRadius + 2;

		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		const r = rimRadius;
		if (
			!aabbOverlaps(
				px - r,
				px + r,
				pz - r,
				pz + r,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const pitSq = pitRadius * pitRadius;
		const rimSq = rimRadius * rimRadius;

		for (let x = bounds.minX; x < bounds.maxX; x++) {
			for (let z = bounds.minZ; z < bounds.maxZ; z++) {
				const dx = x - px;
				const dz = z - pz;
				const distSq = dx * dx + dz * dz;
				if (distSq > rimSq) continue;

				// bowl bottom: deepest at the centre
				const bowl = Math.floor(depth * (1 - distSq / rimSq));
				const bottomY = pitTopY - bowl;

				if (distSq <= pitSq) {
					// inner crater: lava pool at the bottom, air above
					const lavaTop = bottomY + 3;
					for (let y = bottomY; y <= 0; y++) {
						placeBlock(x, y, z, y <= lavaTop ? LAVA : 0, true);
					}
				} else {
					// basalt crater rim wall
					for (let y = bottomY; y <= 0; y++) {
						placeBlock(x, y, z, BASALT, true);
					}
				}
			}
		}
	}
}
