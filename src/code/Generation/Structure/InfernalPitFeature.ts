import { BlockType } from "../../World/Texture/BlockType";
import type { Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { PlaceBlockFn } from "../SurfaceGenerator";
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
		placeBlock: PlaceBlockFn,
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

		// Clamp walks to the generating chunk's Y slice and the pit's column
		// footprint: placeBlock drops every out-of-range write anyway, so the
		// old full-footprint × fill-to-Y=0 loops burned hundreds of discarded
		// placeBlock calls per column. Output is bit-identical.
		const chunkMinY = chunkY * chunkSize;
		const chunkMaxY = chunkMinY + chunkSize - 1;
		const yTop = Math.min(0, chunkMaxY);
		if (chunkMinY > yTop) return;

		const minX = Math.max(bounds.minX, px - r);
		const maxX = Math.min(bounds.maxX - 1, px + r) + 1;
		const minZ = Math.max(bounds.minZ, pz - r);
		const maxZ = Math.min(bounds.maxZ - 1, pz + r) + 1;

		for (let x = minX; x < maxX; x++) {
			for (let z = minZ; z < maxZ; z++) {
				const dx = x - px;
				const dz = z - pz;
				const distSq = dx * dx + dz * dz;
				if (distSq > rimSq) continue;

				// bowl bottom: deepest at the centre
				const bowl = Math.floor(depth * (1 - distSq / rimSq));
				const bottomY = Math.max(pitTopY - bowl, chunkMinY);

				if (distSq <= pitSq) {
					// inner crater: lava pool at the bottom, air above
					const lavaTop = bottomY + 3;
					for (let y = bottomY; y <= yTop; y++) {
						placeBlock(x, y, z, y <= lavaTop ? LAVA : 0, true);
					}
				} else {
					// basalt crater rim wall
					for (let y = bottomY; y <= yTop; y++) {
						placeBlock(x, y, z, BASALT, true);
					}
				}
			}
		}
	}
}
