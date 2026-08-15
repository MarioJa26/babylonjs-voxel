import { CHUNK_SIZE, worldToChunkCoord } from "@/code/Lib/VoxelMath";
import { getFinalTerrainHeight } from "../Generation/TerrainHeightMap";
import {
	areChunksLoadedAround,
	getBlockByWorldCoords,
	getLightByWorldCoords,
	setBlock,
} from "./Chunk/ChunkLoadingSystem";
import { WATER_BLOCK_ID } from "./Chunk/Worker/ChunkMesherConstants";
import { getShapeInfo } from "./MeshPipeline/core/BlockInfoCache";

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

// How far (in chunks) we look outward from the origin for a valid spawn.
const SEARCH_CHUNK_RADIUS = 8;
// Stone (Cobble) is used for the 3x3 spawn platform.
const PLATFORM_BLOCK_ID = 1;
// Player half-height (matches PLAYER_HALF_EXTENTS.y in PlayerVehicle).
const PLAYER_HALF_HEIGHT = 0.9;
// The platform is a 3x3 floor; PLATFORM_HALF = 1 -> 3x3.
const PLATFORM_HALF = 1;

let cachedSpawn: SpawnPosition | null = null;
// Set true once the world spawn has been located/prepared and cached, so the
// loading gate knows it can spawn the player there.
let spawnPrepared = false;

// One-shot listeners fired on the first spawn preparation. Systems that must
// not stream chunks before the player is teleported (e.g. the per-frame
// PlayerLoopController) subscribe instead of polling isSpawnPrepared().
type SpawnPreparedListener = () => void;
let spawnPreparedListeners: SpawnPreparedListener[] = [];

export function getSpawnPosition(): SpawnPosition {
	return cachedSpawn ?? { x: 0, y: 0, z: 0 };
}

export function setSpawnPosition(p: SpawnPosition): void {
	cachedSpawn = p;
	if (spawnPrepared) return;
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

/**
 * Subscribe to the first spawn preparation. If the spawn is already prepared
 * (the subscription raced the server's SpawnPosition message) the listener
 * fires immediately. Returns an unsubscribe function.
 */
export function onSpawnPrepared(listener: SpawnPreparedListener): () => void {
	if (spawnPrepared) {
		listener();
		return () => {};
	}
	spawnPreparedListeners.push(listener);
	return () => {
		spawnPreparedListeners = spawnPreparedListeners.filter(
			(l) => l !== listener,
		);
	};
}

export function isSpawnPrepared(): boolean {
	return spawnPrepared;
}

function isSolidGround(id: number): boolean {
	if (id === 0 || id === WATER_BLOCK_ID) return false;
	const info = getShapeInfo(id);
	return !!info && info.isCube;
}

function getSkyLight(x: number, y: number, z: number): number {
	return (getLightByWorldCoords(x, y, z) >> 4) & 0xf;
}

// Topmost solid, non-water block in a column, or -Infinity when there is none
// (i.e. the column is open air/water/void and cannot host a ground platform).
function findTopGroundY(x: number, z: number, topY = 320, bottomY = 0): number {
	for (let y = topY; y >= bottomY; y--) {
		if (isSolidGround(getBlockByWorldCoords(x, y, z))) {
			return y;
		}
	}
	return -Infinity;
}

// Validate a single candidate center: a 3x3 solid-ground footprint with the
// column above open to daylight (natural skylight 15 at feet/head/5-above-head).
function trySpawnAt(x: number, z: number): FoundSpawn | null {
	let groundY = -Infinity;
	const groundYs: number[] = [];
	for (let dx = -PLATFORM_HALF; dx <= PLATFORM_HALF; dx++) {
		for (let dz = -PLATFORM_HALF; dz <= PLATFORM_HALF; dz++) {
			const gy = findTopGroundY(x + dx, z + dz);
			if (gy === -Infinity) return null; // water / void -> invalid
			groundYs.push(gy);
			if (gy > groundY) groundY = gy;
		}
	}
	// Require the 3x3 footprint to be reasonably flat (within 2 blocks).
	for (const gy of groundYs) {
		if (groundY - gy > 2) return null;
	}

	// Platform top block sits at groundY + 1; the player stands on top of it.
	const feetY = groundY + 2;
	const headY = groundY + 3;
	const fiveAboveHeadY = groundY + 8;

	// The occupied column must be clear air with natural full daylight.
	if (
		getBlockByWorldCoords(x, feetY, z) !== 0 ||
		getBlockByWorldCoords(x, headY, z) !== 0 ||
		getBlockByWorldCoords(x, fiveAboveHeadY, z) !== 0
	) {
		return null;
	}
	const skyFeet = getSkyLight(x, feetY, z);
	const skyHead = getSkyLight(x, headY, z);
	const skyAbove = getSkyLight(x, fiveAboveHeadY, z);
	// Freshly streamed chunks may not have propagated lighting yet (skylight 0
	// everywhere). Only reject a column as "dark" once *some* light has actually
	// been computed for it; otherwise accept the open-air column and assume it
	// will be lit once propagation catches up.
	const lightReady = skyFeet !== 0 || skyHead !== 0 || skyAbove !== 0;
	if (lightReady && (skyFeet !== 15 || skyHead !== 15 || skyAbove !== 15)) {
		return null;
	}

	const spawnY = groundY + 2 + PLAYER_HALF_HEIGHT;
	return { x, z, groundY, y: spawnY };
}

// Spiral candidate centers in chunk-sized steps (closest first).
export function getSpiralCandidates(
	centerX = 0,
	centerZ = 0,
	maxR = SEARCH_CHUNK_RADIUS,
): { x: number; z: number }[] {
	const list: { x: number; z: number }[] = [];
	for (let r = 0; r <= maxR; r++) {
		for (let ox = -r; ox <= r; ox++) {
			for (let oz = -r; oz <= r; oz++) {
				if (Math.max(Math.abs(ox), Math.abs(oz)) !== r) continue;
				list.push({
					x: centerX + ox * CHUNK_SIZE,
					z: centerZ + oz * CHUNK_SIZE,
				});
			}
		}
	}
	return list;
}

export type SpawnColumnEval = "notLoaded" | FoundSpawn | null;

// Evaluate a candidate column only if its voxel/light data is loaded. Returns
// "notLoaded" when we must wait for the surrounding chunks to stream in.
export function evaluateSpawnColumn(x: number, z: number): SpawnColumnEval {
	const cx = worldToChunkCoord(x);
	const cz = worldToChunkCoord(z);
	const approxY = getFinalTerrainHeight(x, z);
	const cy = worldToChunkCoord(approxY);
	const topCy = worldToChunkCoord(approxY + 9);
	const vRad = Math.max(1, Math.abs(topCy - cy) + 1);
	if (!areChunksLoadedAround(cx, cy, cz, 0, vRad)) {
		return "notLoaded";
	}
	return trySpawnAt(x, z);
}

export function buildPlatform(found: FoundSpawn): void {
	const { x, z, groundY } = found;
	const platformY = groundY + 1;
	for (let dx = -PLATFORM_HALF; dx <= PLATFORM_HALF; dx++) {
		for (let dz = -PLATFORM_HALF; dz <= PLATFORM_HALF; dz++) {
			setBlock(x + dx, platformY, z + dz, PLATFORM_BLOCK_ID, 0);
		}
	}
	// Clear the player's body column so we never spawn inside solid terrain.
	for (let y = platformY + 1; y <= platformY + 7; y++) {
		if (getBlockByWorldCoords(x, y, z) !== 0) {
			setBlock(x, y, z, 0, 0);
		}
	}
}

// Last-resort spawn when no valid column is found or the area never loads:
// build a platform at the given (default origin) column.
export function createFallbackSpawn(centerX = 0, centerZ = 0): SpawnPosition {
	const groundY = findTopGroundY(centerX, centerZ);
	const gy = Number.isFinite(groundY)
		? groundY
		: getFinalTerrainHeight(centerX, centerZ);
	const found: FoundSpawn = {
		x: centerX,
		z: centerZ,
		groundY: gy,
		y: gy + 2 + PLAYER_HALF_HEIGHT,
	};
	buildPlatform(found);
	const pos: SpawnPosition = { x: centerX, y: found.y, z: centerZ };
	setSpawnPosition(pos);
	return pos;
}
