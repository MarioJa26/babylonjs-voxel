import type { Biome } from "../Biome/BiomeTypes";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { IWorldFeature } from "./IWorldFeature";
import { chunkWorldBounds, computeRegion } from "./RegionFeature";

export class MineshaftFeature implements IWorldFeature {
	// baseY = -16 - random % 128 (-16..-143), plus a few cells of vertical carving.
	public readonly verticalBounds = {
		minWorldY: -150,
		maxWorldY: 0,
	};

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
			regionSize: 6,
			magicA: 472348763,
			magicB: 891234567,
			spawnChance: 6,
			earlyReturn: true,
			offsetSeedX: 1,
			offsetSeedZ: 2,
		});
		if (!region) return;

		const { regionHash, centerX: mx, centerZ: mz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		const baseY = -16 - (Math.abs(getPRNGBySeed(regionHash, seed)) % 128);
		const tunnelLen = 20 + (Math.abs(getPRNGBySeed(regionHash + 3, seed)) % 30);
		const numBranches = 2 + (Math.abs(getPRNGBySeed(regionHash + 4, seed)) % 3);

		this.carveTunnel(
			mx - tunnelLen / 2,
			mx + tunnelLen / 2,
			baseY,
			mz,
			bounds.minX,
			bounds.maxX,
			bounds.minZ,
			bounds.maxZ,
			placeBlock,
		);

		let branchSeed = regionHash + 5;
		for (let i = 0; i < numBranches; i++) {
			const branchAngle =
				(Math.abs(getPRNGBySeed(branchSeed++, seed)) % 628) / 100;
			const branchLen = 10 + (Math.abs(getPRNGBySeed(branchSeed++, seed)) % 20);
			const branchZ =
				mz + (Math.abs(getPRNGBySeed(branchSeed++, seed)) % 60) - 30;
			const branchX =
				mx + (Math.abs(getPRNGBySeed(branchSeed++, seed)) % 60) - 30;
			const branchY =
				baseY + (Math.abs(getPRNGBySeed(branchSeed++, seed)) % 8) - 4;

			const ex = branchX + Math.cos(branchAngle) * branchLen;
			const ez = branchZ + Math.sin(branchAngle) * branchLen;

			this.carveTunnel(
				Math.min(branchX, ex),
				Math.max(branchX, ex),
				branchY,
				(branchZ + ez) / 2,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
				placeBlock,
			);
		}
	}

	private carveTunnel(
		x1: number,
		x2: number,
		y: number,
		zCenter: number,
		minX: number,
		maxX: number,
		minZ: number,
		maxZ: number,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void,
	) {
		const TUNNEL_HALF_WIDTH = 2;

		if (x2 + TUNNEL_HALF_WIDTH <= minX || x1 - TUNNEL_HALF_WIDTH >= maxX)
			return;
		if (
			zCenter + TUNNEL_HALF_WIDTH <= minZ ||
			zCenter - TUNNEL_HALF_WIDTH >= maxZ
		)
			return;

		const startX = Math.max(Math.floor(x1) - TUNNEL_HALF_WIDTH, minX);
		const endX = Math.min(Math.ceil(x2) + TUNNEL_HALF_WIDTH, maxX);
		const startZ = Math.max(Math.floor(zCenter) - TUNNEL_HALF_WIDTH, minZ);
		const endZ = Math.min(Math.ceil(zCenter) + TUNNEL_HALF_WIDTH, maxZ);

		const FLOOR = 1;
		const SUPPORT = 10;

		for (let x = startX; x < endX; x++) {
			for (let z = startZ; z < endZ; z++) {
				placeBlock(x, y, z, FLOOR, true);
				placeBlock(x, y + 1, z, 0, true);
				placeBlock(x, y + 2, z, 0, true);
				placeBlock(x, y + 3, z, 0, true);
				placeBlock(x, y + 4, z, FLOOR, true);

				if (x % 4 === 0 && z === Math.floor(zCenter)) {
					placeBlock(x, y + 1, z, SUPPORT, true);
					placeBlock(x, y + 2, z, SUPPORT, true);
					placeBlock(x, y + 3, z, SUPPORT, true);
				}
			}
		}
	}
}
