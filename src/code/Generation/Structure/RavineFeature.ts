import type { Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

export class RavineFeature implements IWorldFeature {
	// depth = 30 + random % 50 (30..79) carved downward from neighbor surface.
	// Worst case: neighbor surface ~400, depth 80 -> floor at 320; surface ~ -200, depth 80 -> -280.
	public readonly verticalBounds = {
		minWorldY: -300,
		maxWorldY: 400,
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
			regionSize: 8,
			magicA: 571384937,
			magicB: 314159267,
			spawnChance: 12,
			earlyReturn: true,
		});
		if (!region) return;

		const {
			regionHash,
			centerX: ravineCenterX,
			centerZ: ravineCenterZ,
		} = region;

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

		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				minX,
				maxX,
				minZ,
				maxZ,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const _maxDepthY = ravineCenterZ + depth;

		for (let x = bounds.minX; x < bounds.maxX; x++) {
			for (let z = bounds.minZ; z < bounds.maxZ; z++) {
				const dx = x - ravineCenterX;
				const dz = z - ravineCenterZ;
				const projection = dx * dxDir + dz * dzDir;
				const perpendicular = Math.abs(-dx * dzDir + dz * dxDir);

				if (projection < -halfLen || projection > halfLen) continue;

				const localWidth = width * (1 - Math.abs(projection) / length);
				if (perpendicular > localWidth) continue;

				const wallJitter =
					(getPRNGBySeed(
						Math.floor(x * 0.5) * 7919 + Math.floor(z * 0.5) * 6271,
						seed,
					) %
						100) /
					1000;

				const ravineDepth =
					depth * (1 - Math.abs(projection) / length) + wallJitter;
				const floorY = (ravineCenterZ - ravineDepth * 0.3) | 0;

				for (let y = Math.max(floorY, -1600); y <= 512; y++) {
					const distFromFloor = y - floorY;
					const _wallWidth = 0.5 + wallJitter;
					if (distFromFloor < 0) continue;
					if (distFromFloor > ravineDepth) break;

					const carveWidth =
						localWidth * (1 - distFromFloor / ravineDepth) + 0.5;
					if (perpendicular > carveWidth) continue;

					const blockId = y < 42 ? 30 : 0;
					placeBlock(x, y, z, blockId, true);
				}
			}
		}
	}
}
