import type { Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import type { IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

export class GeodeFeature implements IWorldFeature {
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
			regionSize: 6,
			magicA: 784129637,
			magicB: 562348931,
			spawnChance: 8,
			earlyReturn: true,
		});
		if (!region) return;

		const { regionHash, centerX: cx, centerZ: cz } = region;
		const cy = -32 - (Math.abs(Squirrel3.get(regionHash + 2, seed)) % 256);
		const outerRadius = 6 + (Math.abs(Squirrel3.get(regionHash + 3, seed)) % 5);
		const innerRadius = outerRadius - 3;

		const maxR = outerRadius + 2;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				cx - maxR,
				cx + maxR,
				cz - maxR,
				cz + maxR,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const outerSq = outerRadius * outerRadius;
		const innerSq = innerRadius * innerRadius;

		for (let x = bounds.minX; x < bounds.maxX; x++) {
			for (let z = bounds.minZ; z < bounds.maxZ; z++) {
				for (let y = cy - maxR; y <= cy + maxR; y++) {
					const dx = x - cx;
					const dy = y - cy;
					const dz = z - cz;
					const distSq = dx * dx + dy * dy + dz * dz;

					if (distSq > outerSq) continue;

					if (distSq <= innerSq) {
						placeBlock(x, y, z, 0, true);
					} else if (distSq <= innerSq + 2) {
						placeBlock(x, y, z, 79, true);
					} else {
						placeBlock(x, y, z, 67, true);
					}
				}
			}
		}
	}
}
