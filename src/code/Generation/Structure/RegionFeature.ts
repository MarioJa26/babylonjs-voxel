import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";

export interface RegionConfig {
	regionSize: number;
	magicA: number;
	magicB: number;
	spawnChance: number;
	/** true = `hash % 100 >= chance` early-return; false = `hash % 100 < chance` block-wrap */
	earlyReturn: boolean;
	/** Hash offset for X center (default 0 = regionHash) */
	offsetSeedX?: number;
	/** Hash offset for Z center (default 1 = regionHash+1) */
	offsetSeedZ?: number;
}

export interface RegionResult {
	regionX: number;
	regionZ: number;
	regionHash: number;
	centerX: number;
	centerZ: number;
}

export function computeRegion(
	chunkX: number,
	chunkZ: number,
	chunkSize: number,
	seed: number,
	config: RegionConfig,
): RegionResult | null {
	const { regionSize, magicA, magicB, spawnChance, earlyReturn } = config;

	const regionX = Math.floor(chunkX / regionSize);
	const regionZ = Math.floor(chunkZ / regionSize);

	const regionHash = getPRNGBySeed(regionX * magicA + regionZ * magicB, seed);

	const passes = earlyReturn
		? Math.abs(regionHash) % 100 >= spawnChance
		: Math.abs(regionHash) % 100 < spawnChance;
	if (!passes) return null;

	const sx = config.offsetSeedX ?? 0;
	const sz = config.offsetSeedZ ?? 1;

	const offsetX =
		Math.abs(getPRNGBySeed(regionHash + sx, seed)) % (regionSize * chunkSize);
	const offsetZ =
		Math.abs(getPRNGBySeed(regionHash + sz, seed)) % (regionSize * chunkSize);

	return {
		regionX,
		regionZ,
		regionHash,
		centerX: regionX * regionSize * chunkSize + offsetX,
		centerZ: regionZ * regionSize * chunkSize + offsetZ,
	};
}

// PERF: module-level scratch. Every call site consumes the returned bounds
// synchronously (AABB gate / loop clamps) and no feature nests another
// chunkWorldBounds() call while holding a reference, so one shared object
// replaces ~925 fresh literals per generated chunk-layer.
const _chunkBoundsScratch: {
	minX: number;
	maxX: number;
	minZ: number;
	maxZ: number;
} = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

export function chunkWorldBounds(
	genChunkX: number,
	genChunkZ: number,
	chunkSize: number,
): { minX: number; maxX: number; minZ: number; maxZ: number } {
	_chunkBoundsScratch.minX = genChunkX * chunkSize;
	_chunkBoundsScratch.maxX = (genChunkX + 1) * chunkSize;
	_chunkBoundsScratch.minZ = genChunkZ * chunkSize;
	_chunkBoundsScratch.maxZ = (genChunkZ + 1) * chunkSize;
	return _chunkBoundsScratch;
}

export function aabbOverlaps(
	fMinX: number,
	fMaxX: number,
	fMinZ: number,
	fMaxZ: number,
	cMinX: number,
	cMaxX: number,
	cMinZ: number,
	cMaxZ: number,
): boolean {
	return fMaxX > cMinX && fMinX < cMaxX && fMaxZ > cMinZ && fMinZ < cMaxZ;
}
