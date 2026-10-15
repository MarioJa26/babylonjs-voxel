import { CHUNK_SIZE, worldToChunkCoord } from "@/code/Lib/VoxelMath";
import { getFinalTerrainHeight } from "../Generation/TerrainHeightMap";
import {
	getBlockByWorldCoords,
	getLightByWorldCoords,
	setBlock,
} from "./Chunk/ChunkLoadingSystem";
import { areChunksLoadedAround } from "./Chunk/Loading/ChunkReadiness";
import { WATER_BLOCK_ID } from "./Chunk/Worker/ChunkMesherConstants";

export interface SpawnPosition {
	x: number;
	y: number;
	z: number;
}

export interface FoundSpawn {
	x: number;
	z: number;
	groundY: number;
	y: number;
}

export type SpawnColumnEval = "notLoaded" | FoundSpawn | null;

interface SpawnCandidate {
	x: number;
	z: number;
}

const SEARCH_CHUNK_RADIUS = 8;

const PLATFORM_BLOCK_ID = 1;
const PLATFORM_HALF = 1;

const AIR_BLOCK_ID = 0;

const PLAYER_HALF_HEIGHT = 0.9;
const SPAWN_FEET_OFFSET = 2;
const SPAWN_HEAD_OFFSET = 3;
const SPAWN_CLEARANCE_OFFSET = 8;

const MAX_SCAN_Y = 320;
const MIN_SCAN_Y = 0;

const FULL_SKY_LIGHT = 15;
const SKY_LIGHT_SHIFT = 4;
const LIGHT_NIBBLE_MASK = 0xf;

let cachedSpawn: SpawnPosition | null = null;
let spawnPrepared = false;
let spawnPreparedListeners: (() => void)[] = [];

const noop = (): void => {};

const isSolidGround = (blockId: number): boolean =>
	blockId !== AIR_BLOCK_ID && blockId !== WATER_BLOCK_ID;

const getSkyLight = (x: number, y: number, z: number): number =>
	(getLightByWorldCoords(x, y, z) >> SKY_LIGHT_SHIFT) & LIGHT_NIBBLE_MASK;

const getSpawnY = (groundY: number): number =>
	groundY + SPAWN_FEET_OFFSET + PLAYER_HALF_HEIGHT;

function findTopGroundY(
	x: number,
	z: number,
	topY = MAX_SCAN_Y,
	bottomY = MIN_SCAN_Y,
): number {
	for (let y = topY; y >= bottomY; y--) {
		if (isSolidGround(getBlockByWorldCoords(x, y, z))) {
			return y;
		}
	}

	return -Infinity;
}

/**
 * Returns chunk-spaced candidate positions in outward square rings.
 *
 * Each position appears exactly once. A radius R contains:
 *
 *   1 + 4 * R * (R + 1)
 *
 * candidates.
 */
export function getSpiralCandidates(
	centerX = 0,
	centerZ = 0,
	maxR = SEARCH_CHUNK_RADIUS,
): SpawnCandidate[] {
	const radius = Number.isFinite(maxR) && maxR > 0 ? Math.floor(maxR) : 0;

	const candidateCount = 1 + 4 * radius * (radius + 1);
	const candidates = new Array<SpawnCandidate>(candidateCount);

	let index = 0;

	candidates[index++] = {
		x: centerX,
		z: centerZ,
	};

	for (let ring = 1; ring <= radius; ring++) {
		const extent = ring * CHUNK_SIZE;
		const minX = centerX - extent;
		const maxX = centerX + extent;
		const minZ = centerZ - extent;
		const maxZ = centerZ + extent;

		// Top edge, including both corners.
		for (let x = minX; x <= maxX; x += CHUNK_SIZE) {
			candidates[index++] = {
				x,
				z: maxZ,
			};
		}

		// Right edge, excluding the top-right corner.
		for (let z = maxZ - CHUNK_SIZE; z >= minZ; z -= CHUNK_SIZE) {
			candidates[index++] = {
				x: maxX,
				z,
			};
		}

		// Bottom edge, excluding the bottom-right corner.
		for (let x = maxX - CHUNK_SIZE; x >= minX; x -= CHUNK_SIZE) {
			candidates[index++] = {
				x,
				z: minZ,
			};
		}

		// Left edge, excluding both previously emitted corners.
		for (let z = minZ + CHUNK_SIZE; z < maxZ; z += CHUNK_SIZE) {
			candidates[index++] = {
				x: minX,
				z,
			};
		}
	}

	return candidates;
}

export function evaluateSpawnColumn(x: number, z: number): SpawnColumnEval {
	const approximateY = getFinalTerrainHeight(x, z);

	const chunkX = worldToChunkCoord(x);
	const chunkY = worldToChunkCoord(approximateY);
	const chunkZ = worldToChunkCoord(z);
	const upperChunkY = worldToChunkCoord(approximateY + 9);

	const verticalRadius = Math.max(1, Math.abs(upperChunkY - chunkY) + 1);

	if (!areChunksLoadedAround(chunkX, chunkY, chunkZ, 0, verticalRadius)) {
		return "notLoaded";
	}

	return trySpawnAt(x, z);
}

export function buildPlatform(found: FoundSpawn): void {
	const platformY = found.groundY + 1;

	/*
	 * Write the 3-by-3 platform directly. This avoids allocating a closure
	 * and making one callback invocation per platform column.
	 */
	for (let x = found.x - PLATFORM_HALF; x <= found.x + PLATFORM_HALF; x++) {
		for (let z = found.z - PLATFORM_HALF; z <= found.z + PLATFORM_HALF; z++) {
			setBlock(x, platformY, z, PLATFORM_BLOCK_ID, 0);
		}
	}

	/*
	 * Preserve the original behavior: only the center column is cleared
	 * above the platform.
	 */
	const clearFromY = platformY + 1;
	const clearThroughY = platformY + 7;

	for (let y = clearFromY; y <= clearThroughY; y++) {
		setBlock(found.x, y, found.z, AIR_BLOCK_ID, 0);
	}
}

export function createFallbackSpawn(centerX = 0, centerZ = 0): SpawnPosition {
	const scannedGroundY = findTopGroundY(centerX, centerZ);

	const groundY =
		scannedGroundY === -Infinity
			? getFinalTerrainHeight(centerX, centerZ)
			: scannedGroundY;

	const spawnY = getSpawnY(groundY);

	const found: FoundSpawn = {
		x: centerX,
		z: centerZ,
		groundY,
		y: spawnY,
	};

	buildPlatform(found);

	const position: SpawnPosition = {
		x: centerX,
		y: spawnY,
		z: centerZ,
	};

	setSpawnPosition(position);

	return position;
}

export function getSpawnPosition(): SpawnPosition {
	return cachedSpawn ?? { x: 0, y: 0, z: 0 };
}

export function setSpawnPosition(position: SpawnPosition): void {
	if (spawnPrepared) {
		return;
	}

	cachedSpawn = position;
	spawnPrepared = true;

	/*
	 * Clear the shared array before invoking listeners. This ensures listener
	 * removal or registration during notification cannot affect iteration.
	 */
	const listeners = spawnPreparedListeners;
	spawnPreparedListeners = [];

	for (let i = 0; i < listeners.length; i++) {
		try {
			listeners[i]();
		} catch (error) {
			console.error("[SpawnPoint] spawn-prepared listener threw:", error);
		}
	}
}

export function onSpawnPrepared(listener: () => void): () => void {
	if (spawnPrepared) {
		listener();
		return noop;
	}

	spawnPreparedListeners.push(listener);

	let active = true;

	return (): void => {
		if (!active) {
			return;
		}

		active = false;

		const index = spawnPreparedListeners.indexOf(listener);

		if (index !== -1) {
			spawnPreparedListeners.splice(index, 1);
		}
	};
}

export function isSpawnPrepared(): boolean {
	return spawnPrepared;
}

function trySpawnAt(x: number, z: number): FoundSpawn | null {
	let groundY = -Infinity;

	/*
	 * The platform uses the highest solid ground position in its 3-by-3
	 * footprint. Return immediately if any column has no solid ground.
	 */
	for (let worldX = x - PLATFORM_HALF; worldX <= x + PLATFORM_HALF; worldX++) {
		for (
			let worldZ = z - PLATFORM_HALF;
			worldZ <= z + PLATFORM_HALF;
			worldZ++
		) {
			const columnGroundY = findTopGroundY(worldX, worldZ);

			if (columnGroundY === -Infinity) {
				return null;
			}

			if (columnGroundY > groundY) {
				groundY = columnGroundY;
			}
		}
	}

	const feetY = groundY + SPAWN_FEET_OFFSET;
	const headY = groundY + SPAWN_HEAD_OFFSET;
	const clearanceY = groundY + SPAWN_CLEARANCE_OFFSET;

	/*
	 * Reject obstructed columns before performing light lookups, which may
	 * require additional chunk indexing.
	 */
	if (
		getBlockByWorldCoords(x, feetY, z) !== AIR_BLOCK_ID ||
		getBlockByWorldCoords(x, headY, z) !== AIR_BLOCK_ID ||
		getBlockByWorldCoords(x, clearanceY, z) !== AIR_BLOCK_ID
	) {
		return null;
	}

	if (
		getSkyLight(x, feetY, z) !== FULL_SKY_LIGHT ||
		getSkyLight(x, headY, z) !== FULL_SKY_LIGHT ||
		getSkyLight(x, clearanceY, z) !== FULL_SKY_LIGHT
	) {
		return null;
	}

	return {
		x,
		z,
		groundY,
		y: getSpawnY(groundY),
	};
}
