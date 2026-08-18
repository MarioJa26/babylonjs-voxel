import { CHUNK_SIZE, worldToChunkCoord } from "@/code/Lib/VoxelMath";
import { getFinalTerrainHeight } from "../Generation/TerrainHeightMap";
import {
	areChunksLoadedAround,
	getBlockByWorldCoords,
	getLightByWorldCoords,
	setBlock,
} from "./Chunk/ChunkLoadingSystem";
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

const SEARCH_CHUNK_RADIUS = 8;
const PLATFORM_BLOCK_ID = 1;
const PLAYER_HALF_HEIGHT = 0.9;
const PLATFORM_HALF = 1;

const AIR_BLOCK_ID = 0;
const MAX_SCAN_Y = 320;
const MIN_SCAN_Y = 0;

let cachedSpawn: SpawnPosition | null = null;
let spawnPrepared = false;
let spawnPreparedListeners: (() => void)[] = [];

const noop = (): void => {};

const isSolidGround = (id: number): boolean =>
	id !== AIR_BLOCK_ID && id !== WATER_BLOCK_ID;

const getSkyLight = (x: number, y: number, z: number): number =>
	(getLightByWorldCoords(x, y, z) >> 4) & 0xf;

const getSpawnY = (groundY: number): number => groundY + 2 + PLAYER_HALF_HEIGHT;

function forPlatformColumns(
	x: number,
	z: number,
	callback: (wx: number, wz: number) => void,
): void {
	for (let dx = -PLATFORM_HALF; dx <= PLATFORM_HALF; dx++) {
		for (let dz = -PLATFORM_HALF; dz <= PLATFORM_HALF; dz++) {
			callback(x + dx, z + dz);
		}
	}
}

function findTopGroundY(
	x: number,
	z: number,
	topY = MAX_SCAN_Y,
	bottomY = MIN_SCAN_Y,
): number {
	for (let y = topY; y >= bottomY; y--) {
		if (isSolidGround(getBlockByWorldCoords(x, y, z))) return y;
	}

	return -Infinity;
}

export function getSpiralCandidates(
	centerX = 0,
	centerZ = 0,
	maxR = SEARCH_CHUNK_RADIUS,
): { x: number; z: number }[] {
	const list: { x: number; z: number }[] = [{ x: centerX, z: centerZ }];

	for (let r = 1; r <= maxR; r++) {
		const step = r * CHUNK_SIZE;
		const min = -step;
		const max = step;
		for (let ox = min; ox <= max; ox += CHUNK_SIZE) {
			list.push({ x: centerX + ox, z: centerZ + max });
		}
		for (let oz = max - CHUNK_SIZE; oz >= min; oz -= CHUNK_SIZE) {
			list.push({ x: centerX + max, z: centerZ + oz });
		}
		for (let ox = max; ox >= min; ox -= CHUNK_SIZE) {
			list.push({ x: centerX + ox, z: centerZ + min });
		}
		for (let oz = min + CHUNK_SIZE; oz <= max; oz += CHUNK_SIZE) {
			list.push({ x: centerX + min, z: centerZ + oz });
		}
	}
	return list;
}

export function evaluateSpawnColumn(x: number, z: number): SpawnColumnEval {
	const approxY = getFinalTerrainHeight(x, z);
	const cy = worldToChunkCoord(approxY);
	const vRad = Math.max(1, Math.abs(worldToChunkCoord(approxY + 9) - cy) + 1);

	return areChunksLoadedAround(
		worldToChunkCoord(x),
		cy,
		worldToChunkCoord(z),
		0,
		vRad,
	)
		? trySpawnAt(x, z)
		: "notLoaded";
}

export function buildPlatform(found: FoundSpawn): void {
	const { x, z, groundY } = found;
	const platformY = groundY + 1;

	forPlatformColumns(x, z, (wx, wz) => {
		setBlock(wx, platformY, wz, PLATFORM_BLOCK_ID, 0);
	});

	for (let y = platformY + 1; y <= platformY + 7; y++) {
		setBlock(x, y, z, AIR_BLOCK_ID, 0);
	}
}

export function createFallbackSpawn(centerX = 0, centerZ = 0): SpawnPosition {
	const topGroundY = findTopGroundY(centerX, centerZ);
	const groundY =
		topGroundY === -Infinity
			? getFinalTerrainHeight(centerX, centerZ)
			: topGroundY;

	const found: FoundSpawn = {
		x: centerX,
		z: centerZ,
		groundY,
		y: getSpawnY(groundY),
	};

	buildPlatform(found);

	const pos: SpawnPosition = { x: centerX, y: found.y, z: centerZ };
	setSpawnPosition(pos);

	return pos;
}

export function getSpawnPosition(): SpawnPosition {
	return cachedSpawn ?? { x: 0, y: 0, z: 0 };
}

export function setSpawnPosition(p: SpawnPosition): void {
	if (spawnPrepared) return;

	cachedSpawn = p;
	spawnPrepared = true;

	const listeners = spawnPreparedListeners;
	spawnPreparedListeners = [];

	for (const listener of listeners) {
		try {
			listener();
		} catch (err) {
			console.error("[SpawnPoint] spawn-prepared listener threw:", err);
		}
	}
}

export function onSpawnPrepared(listener: () => void): () => void {
	if (spawnPrepared) {
		listener();
		return noop;
	}

	spawnPreparedListeners.push(listener);

	return () => {
		const index = spawnPreparedListeners.indexOf(listener);
		if (index !== -1) spawnPreparedListeners.splice(index, 1);
	};
}

export function isSpawnPrepared(): boolean {
	return spawnPrepared;
}

function trySpawnAt(x: number, z: number): FoundSpawn | null {
	let groundY = -Infinity;

	for (let dx = -PLATFORM_HALF; dx <= PLATFORM_HALF; dx++) {
		for (let dz = -PLATFORM_HALF; dz <= PLATFORM_HALF; dz++) {
			const gy = findTopGroundY(x + dx, z + dz);
			if (gy === -Infinity) return null;
			if (gy > groundY) groundY = gy;
		}
	}

	const feetY = groundY + 2;
	const headY = groundY + 3;
	const aboveY = groundY + 8;

	if (
		getBlockByWorldCoords(x, feetY, z) !== AIR_BLOCK_ID ||
		getBlockByWorldCoords(x, headY, z) !== AIR_BLOCK_ID ||
		getBlockByWorldCoords(x, aboveY, z) !== AIR_BLOCK_ID
	) {
		return null;
	}

	if (
		getSkyLight(x, feetY, z) !== 15 ||
		getSkyLight(x, headY, z) !== 15 ||
		getSkyLight(x, aboveY, z) !== 15
	) {
		return null;
	}

	return {
		x,
		z,
		groundY,
		y: groundY + 2 + PLAYER_HALF_HEIGHT,
	};
}
