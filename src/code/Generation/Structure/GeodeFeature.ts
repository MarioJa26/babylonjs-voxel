import type { Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

export class GeodeFeature implements IWorldFeature {
	// cy = -32 - random % 256 (-32..-288), plus outerRadius (6..10) + shell 2.
	public readonly verticalBounds = {
		minWorldY: -300,
		maxWorldY: -20,
	};

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
			regionSize: 6,
			magicA: 784129637,
			magicB: 562348931,
			spawnChance: 8,
			earlyReturn: true,
		});
		if (!region) return;

		const { regionHash, centerX: cx, centerZ: cz } = region;
		const cy = -32 - (Math.abs(getPRNGBySeed(regionHash + 2, seed)) % 256);
		const outerRadius = 6 + (Math.abs(getPRNGBySeed(regionHash + 3, seed)) % 5);
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

		// Clamp the column walk to the sphere's footprint: columns outside
		// [cx-maxR, cx+maxR] can never satisfy distSq <= outerSq, so scanning
		// them was pure overhead (up to ~12x over-scan when the geode sits in
		// a corner of the chunk). Output is identical.
		const minX = Math.max(bounds.minX, cx - maxR);
		const maxX = Math.min(bounds.maxX - 1, cx + maxR) + 1;
		const minZ = Math.max(bounds.minZ, cz - maxR);
		const maxZ = Math.min(bounds.maxZ - 1, cz + maxR) + 1;

		for (let x = minX; x < maxX; x++) {
			for (let z = minZ; z < maxZ; z++) {
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
