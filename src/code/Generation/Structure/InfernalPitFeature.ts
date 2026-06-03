import type { Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import type { IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

export class InfernalPitFeature implements IWorldFeature {
	// pitTopY = -64 - random % 128 (-64..-192), pit extends downward 30+ cells.
	public readonly verticalBounds = {
		minWorldY: -230,
		maxWorldY: -50,
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
		const pitTopY = -64 - (Math.abs(Squirrel3.get(regionHash + 2, seed)) % 128);
		const pitRadius = 8 + (Math.abs(Squirrel3.get(regionHash + 3, seed)) % 6);

		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		const r = pitRadius + 2;
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

		const radiusSq = pitRadius * pitRadius;
		const rimRadiusSq = r * r;

		for (let x = bounds.minX; x < bounds.maxX; x++) {
			for (let z = bounds.minZ; z < bounds.maxZ; z++) {
				const dx = x - px;
				const dz = z - pz;
				const distSq = dx * dx + dz * dz;

				if (distSq > rimRadiusSq) continue;

				for (let y = pitTopY; y <= 0; y++) {
					if (distSq <= radiusSq) {
						const blockId = y < -1536 ? 24 : 0;
						placeBlock(x, y, z, blockId, true);
					} else {
						placeBlock(x, y, z, 81, true);
					}
				}
			}
		}
	}
}
