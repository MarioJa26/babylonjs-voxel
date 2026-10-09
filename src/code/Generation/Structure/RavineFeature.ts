import type { Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { IWorldFeature } from "./IWorldFeature";
import {
	aabbOverlaps,
	chunkWorldBounds,
	computeRegion,
	type RegionConfig,
} from "./RegionFeature";

/**
 * Region grid for this feature's placement, hoisted so /locate can resolve
 * it without duplicating these constants. A structure exists in region
 * `floor(chunk / regionSize)` when the hash passes the spawn chance.
 */
export const RAVINE_REGION: RegionConfig = {
	regionSize: 8,
	magicA: 571384937,
	magicB: 314159267,
	spawnChance: 12,
	earlyReturn: true,
};

export class RavineFeature implements IWorldFeature {
	// depth = 30 + random % 50 (30..79) carved downward from neighbor surface.
	// Worst case: neighbor surface ~400, depth 80 -> floor at 320; surface ~ -200, depth 80 -> -280.
	public readonly verticalBounds = {
		minWorldY: -300,
		maxWorldY: 400,
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
		// PERF: generateStructures invokes every feature 25x per chunk-layer (a
		// 5x5 window) and the vertical bounds span ~22 chunkY layers, so a naive
		// implementation re-walks the whole ravine depth for every one of those
		// ~550 calls and relies on placeBlock() to discard out-of-chunk writes.
		// Probe whole REGIONS instead of individual chunks: with regionSize 8 a
		// 5-chunk window spans at most 2x2 regions, so this turns 25 identical
		// region resolutions into at most 4. Mirrors fillMineshaftSealMask.
		const regionSize = RAVINE_REGION.regionSize;
		const minRegionX = Math.floor((chunkX - 2) / regionSize);
		const maxRegionX = Math.floor((chunkX + 2) / regionSize);
		const minRegionZ = Math.floor((chunkZ - 2) / regionSize);
		const maxRegionZ = Math.floor((chunkZ + 2) / regionSize);

		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		// PERF: Clip the carve to the chunk actually being generated. Without
		// this the Y loop runs the full ravine depth on every layer while
		// placeBlock() silently drops everything outside the 32-block slice.
		const chunkMinY = chunkY * chunkSize;
		const chunkMaxY = chunkMinY + chunkSize - 1;

		for (let rx = minRegionX; rx <= maxRegionX; rx++) {
			for (let rz = minRegionZ; rz <= maxRegionZ; rz++) {
				// computeRegion derives the region from the CHUNK it is handed,
				// so pass a chunk inside this region, not the region index.
				const region = computeRegion(
					rx * regionSize,
					rz * regionSize,
					chunkSize,
					seed,
					RAVINE_REGION,
				);
				if (!region) continue;

				this.generateInRegion(
					region.regionHash,
					region.centerX,
					region.centerZ,
					bounds.minX,
					bounds.maxX,
					bounds.minZ,
					bounds.maxZ,
					chunkMinY,
					chunkMaxY,
					placeBlock,
					seed,
				);
			}
		}
	}

	/**
	 * Carve the ravine owned by one resolved region, clipped to the generating
	 * chunk's XZ footprint and Y range.
	 *
	 * Extracted from generate() so the region loop above stays readable; the
	 * math is unchanged apart from the Y clipping, which only removes iterations
	 * whose placeBlock() call would have been dropped anyway.
	 */
	private generateInRegion(
		regionHash: number,
		ravineCenterX: number,
		ravineCenterZ: number,
		boundsMinX: number,
		boundsMaxX: number,
		boundsMinZ: number,
		boundsMaxZ: number,
		chunkMinY: number,
		chunkMaxY: number,
		placeBlock: PlaceBlockFn,
		seed: number,
	) {
		const angle = (Math.abs(getPRNGBySeed(regionHash + 2, seed)) % 628) / 100;
		const length = 40 + (Math.abs(getPRNGBySeed(regionHash + 3, seed)) % 60);
		const width = 3 + (Math.abs(getPRNGBySeed(regionHash + 4, seed)) % 4);
		const depth = 30 + (Math.abs(getPRNGBySeed(regionHash + 5, seed)) % 50);

		const dxDir = Math.cos(angle);
		const dzDir = Math.sin(angle);

		const halfLen = length / 2;
		const margin = Math.max(width, depth) + 10;
		const minX = Math.floor(
			ravineCenterX - halfLen * Math.abs(dxDir) - width - margin,
		);
		const maxX = Math.floor(
			ravineCenterX + halfLen * Math.abs(dxDir) + width + margin,
		);
		const minZ = Math.floor(
			ravineCenterZ - halfLen * Math.abs(dzDir) - width - margin,
		);
		const maxZ = Math.floor(
			ravineCenterZ + halfLen * Math.abs(dzDir) + width + margin,
		);

		if (
			!aabbOverlaps(
				minX,
				maxX,
				minZ,
				maxZ,
				boundsMinX,
				boundsMaxX,
				boundsMinZ,
				boundsMaxZ,
			)
		)
			return;

		for (let x = boundsMinX; x < boundsMaxX; x++) {
			for (let z = boundsMinZ; z < boundsMaxZ; z++) {
				const dx = x - ravineCenterX;
				const dz = z - ravineCenterZ;
				const projection = dx * dxDir + dz * dzDir;
				const perpendicular = Math.abs(-dx * dzDir + dz * dxDir);

				if (projection < -halfLen || projection > halfLen) continue;

				// PERF: this ratio is needed twice below (taper + depth); it was
				// recomputed along with Math.abs(projection) in both places.
				const projFrac = Math.abs(projection) / length;
				const localWidth = width * (1 - projFrac);
				if (perpendicular > localWidth) continue;

				const wallJitter =
					(getPRNGBySeed(
						Math.floor(x * 0.5) * 7919 + Math.floor(z * 0.5) * 6271,
						seed,
					) %
						100) /
					1000;

				const ravineDepth = depth * (1 - projFrac) + wallJitter;
				const floorY = (ravineCenterZ - ravineDepth * 0.3) | 0;

				// PERF: clip to the generating chunk. Iterations outside this
				// range were previously computed and then dropped by placeBlock().
				let yLo = Math.max(floorY, -1600, chunkMinY);
				const yHi = Math.min(floorY + ravineDepth, chunkMaxY);
				if (yLo > yHi) continue;

				// Split at sea level so the `y < 42` blockId select leaves the
				// inner loop. Both halves share the same monotone taper test.
				const seaSplit = yHi < 42 ? yHi + 1 : 42;

				for (; yLo < seaSplit; yLo++) {
					const distFromFloor = yLo - floorY;
					// carveWidth shrinks monotonically with y, so once it falls
					// below `perpendicular` every higher y fails too -> break.
					if (distFromFloor > ravineDepth) break;
					if (
						perpendicular >
						localWidth * (1 - distFromFloor / ravineDepth) + 0.5
					)
						break;
					placeBlock(x, yLo, z, 30, true);
				}
				for (; yLo <= yHi; yLo++) {
					const distFromFloor = yLo - floorY;
					if (distFromFloor > ravineDepth) break;
					if (
						perpendicular >
						localWidth * (1 - distFromFloor / ravineDepth) + 0.5
					)
						break;
					placeBlock(x, yLo, z, 0, true);
				}
			}
		}
	}
}
