import { BlockTextures } from "@/code/World/Texture/BlockTextures";
import { FaceName } from "@/code/World/Texture/FaceName";
import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import { getBiome, getFinalTerrainHeight } from "../TerrainHeightMap";

const DEFAULT_TILE_X = 14;
const DEFAULT_TILE_Y = 0;
const INSIDE_CLIP_Y = -200;

let positions: Int16Array | undefined;
let normals: Int8Array | undefined;
let surfaceTiles: Uint8Array | undefined;

let lastGridCenterChunkX = Number.NaN;
let lastGridCenterChunkZ = Number.NaN;
let lastCenterChunkX = Number.NaN;
let lastCenterChunkZ = Number.NaN;

let currentRenderDistance = 0;
let rowSize = 0;
let segments = 0;
let gridStep = 1;
let radius = 0;
let usingSharedBuffers = false;

const _heightCache = new Float32Array(131072);
const _heightCacheKeys = new Int32Array(131072);
const _heightCacheMask = 131071;

function cachedHeight(wx: number, wz: number): number {
	const key = (wx & 0x3fff) | ((wz & 0x3fff) << 14);
	const slot = key & _heightCacheMask;
	if (_heightCacheKeys[slot] === key) {
		return _heightCache[slot];
	}
	const h = getFinalTerrainHeight(wx, wz);
	_heightCacheKeys[slot] = key;
	_heightCache[slot] = h;
	return h;
}

// =====================================================================
// Configuration
// =====================================================================

export function setRenderDistance(value: number): void {
	currentRenderDistance = value;
}

// =====================================================================
// SharedArrayBuffer initialization
// =====================================================================

export function initSharedBuffers(
	positionsBuffer: SharedArrayBuffer,
	normalsBuffer: SharedArrayBuffer,
	surfaceTilesBuffer: SharedArrayBuffer,
	r: number,
	gStep: number,
) {
	configureGrid(r, gStep);

	const vertexCount = rowSize ** 2;
	const expectedPositionsBytes = vertexCount * 3 * Int16Array.BYTES_PER_ELEMENT;
	const expectedNormalsBytes = vertexCount * 3 * Int8Array.BYTES_PER_ELEMENT;
	const expectedSurfaceTilesBytes =
		vertexCount * 2 * Uint8Array.BYTES_PER_ELEMENT;

	if (positionsBuffer.byteLength !== expectedPositionsBytes)
		throw new Error(
			`Shared positions buffer size mismatch. Expected ${expectedPositionsBytes}, got ${positionsBuffer.byteLength}.`,
		);
	if (normalsBuffer.byteLength !== expectedNormalsBytes)
		throw new Error(
			`Shared normals buffer size mismatch. Expected ${expectedNormalsBytes}, got ${normalsBuffer.byteLength}.`,
		);
	if (surfaceTilesBuffer.byteLength !== expectedSurfaceTilesBytes)
		throw new Error(
			`Shared surfaceTiles buffer size mismatch. Expected ${expectedSurfaceTilesBytes}, got ${surfaceTilesBuffer.byteLength}.`,
		);

	positions = new Int16Array(positionsBuffer);
	normals = new Int8Array(normalsBuffer);
	surfaceTiles = new Uint8Array(surfaceTilesBuffer);
	usingSharedBuffers = true;
	resetTracking();
}

// =====================================================================
// Public generation entry point
// =====================================================================

export function generate(
	centerChunkX: number,
	centerChunkZ: number,
	r: number,
	gStep: number,
	forceFullRebuild = false,
) {
	const gridCenterChunkX = Math.floor(centerChunkX / gStep) * gStep;
	const gridCenterChunkZ = Math.floor(centerChunkZ / gStep) * gStep;

	ensureBuffers(r, gStep);

	const pos = positions!;
	const nrm = normals!;
	const tiles = surfaceTiles!;

	const firstBuild =
		forceFullRebuild ||
		Number.isNaN(lastGridCenterChunkX) ||
		Number.isNaN(lastGridCenterChunkZ);

	if (firstBuild) {
		fullGenerate(
			gridCenterChunkX,
			gridCenterChunkZ,
			centerChunkX,
			centerChunkZ,
		);
	} else {
		const shiftX = (gridCenterChunkX - lastGridCenterChunkX) / gridStep;
		const shiftZ = (gridCenterChunkZ - lastGridCenterChunkZ) / gridStep;
		const exactCenterMoved =
			centerChunkX !== lastCenterChunkX || centerChunkZ !== lastCenterChunkZ;
		const snappedGridMoved = shiftX !== 0 || shiftZ !== 0;

		const needsFullRebuild =
			Math.abs(shiftX) >= rowSize ||
			Math.abs(shiftZ) >= rowSize ||
			!Number.isInteger(shiftX) ||
			!Number.isInteger(shiftZ) ||
			(exactCenterMoved && !snappedGridMoved) ||
			Math.abs(shiftX) > 1 ||
			Math.abs(shiftZ) > 1;

		if (needsFullRebuild) {
			fullGenerate(
				gridCenterChunkX,
				gridCenterChunkZ,
				centerChunkX,
				centerChunkZ,
			);
		} else {
			if (snappedGridMoved) {
				if (shiftX !== 0 && shiftZ !== 0) {
					slideArrays(shiftX, 0);
					regenerateEdges(
						shiftX,
						0,
						gridCenterChunkX,
						gridCenterChunkZ,
						centerChunkX,
						centerChunkZ,
					);
					slideArrays(0, shiftZ);
					regenerateEdges(
						0,
						shiftZ,
						gridCenterChunkX,
						gridCenterChunkZ,
						centerChunkX,
						centerChunkZ,
					);
				} else {
					slideArrays(shiftX, shiftZ);
					regenerateEdges(
						shiftX,
						shiftZ,
						gridCenterChunkX,
						gridCenterChunkZ,
						centerChunkX,
						centerChunkZ,
					);
				}
			}
			if (snappedGridMoved || exactCenterMoved) {
				rewriteLocalXZ(
					centerChunkX,
					centerChunkZ,
					gridCenterChunkX,
					gridCenterChunkZ,
				);
			}
		}
	}

	lastGridCenterChunkX = gridCenterChunkX;
	lastGridCenterChunkZ = gridCenterChunkZ;
	lastCenterChunkX = centerChunkX;
	lastCenterChunkZ = centerChunkZ;

	return {
		positions: pos,
		normals: nrm,
		surfaceTiles: tiles,
		centerChunkX,
		centerChunkZ,
	};
}

// =====================================================================
// Buffer / grid helpers
// =====================================================================

function ensureBuffers(r: number, gStep: number) {
	const buffersMissing =
		!positions ||
		!normals ||
		!surfaceTiles ||
		positions.buffer.byteLength === 0 ||
		normals.buffer.byteLength === 0 ||
		surfaceTiles.buffer.byteLength === 0;

	const configChanged = radius !== r || gridStep !== gStep;

	if (buffersMissing || configChanged) {
		if (usingSharedBuffers)
			throw new Error(
				"DistantTerrainGenerator: shared buffers missing or config changed — recreate shared buffers.",
			);
		configureGrid(r, gStep);
		allocateLocalBuffers();
		resetTracking();
	}
}

function configureGrid(r: number, gStep: number) {
	radius = r;
	gridStep = gStep;
	segments = Math.floor((r * 2) / gStep);
	rowSize = segments + 1;
}

function allocateLocalBuffers() {
	const vertexCount = rowSize ** 2;
	positions = new Int16Array(vertexCount * 3);
	normals = new Int8Array(vertexCount * 3);
	surfaceTiles = new Uint8Array(vertexCount * 2);
	usingSharedBuffers = false;
}

function resetTracking() {
	lastGridCenterChunkX = Number.NaN;
	lastGridCenterChunkZ = Number.NaN;
	lastCenterChunkX = Number.NaN;
	lastCenterChunkZ = Number.NaN;
}

// =====================================================================
// Full generation
// =====================================================================

function fullGenerate(gcx: number, gcz: number, ccx: number, ccz: number) {
	const r = rowSize;
	for (let z = 0; z < r; z++)
		for (let x = 0; x < r; x++) generateVertex(x, z, gcx, gcz, ccx, ccz);
}

// =====================================================================
// Sliding-window copy (single-axis shifts of 1 only)
// =====================================================================

function slideArrays(shiftX: number, shiftZ: number) {
	const r = rowSize;
	const pos = positions!;
	const nrm = normals!;
	const tiles = surfaceTiles!;

	if (shiftZ !== 0) {
		const rowsToCopy = r - Math.abs(shiftZ);
		const srcRow = shiftZ > 0 ? shiftZ : 0;
		const dstRow = shiftZ > 0 ? 0 : -shiftZ;
		pos.copyWithin(
			dstRow * r * 3,
			srcRow * r * 3,
			(srcRow + rowsToCopy) * r * 3,
		);
		nrm.copyWithin(
			dstRow * r * 3,
			srcRow * r * 3,
			(srcRow + rowsToCopy) * r * 3,
		);
		tiles.copyWithin(
			dstRow * r * 2,
			srcRow * r * 2,
			(srcRow + rowsToCopy) * r * 2,
		);
	}

	if (shiftX !== 0) {
		const colsToCopy = r - Math.abs(shiftX);
		const srcCol = shiftX > 0 ? shiftX : 0;
		const dstCol = shiftX > 0 ? 0 : -shiftX;
		for (let z = 0; z < r; z++) {
			const base3 = z * r * 3;
			const base2 = z * r * 2;
			pos.copyWithin(
				base3 + dstCol * 3,
				base3 + srcCol * 3,
				base3 + (srcCol + colsToCopy) * 3,
			);
			nrm.copyWithin(
				base3 + dstCol * 3,
				base3 + srcCol * 3,
				base3 + (srcCol + colsToCopy) * 3,
			);
			tiles.copyWithin(
				base2 + dstCol * 2,
				base2 + srcCol * 2,
				base2 + (srcCol + colsToCopy) * 2,
			);
		}
	}
}

// =====================================================================
// Regenerate newly exposed border vertices
// =====================================================================

function regenerateEdges(
	shiftX: number,
	shiftZ: number,
	gcx: number,
	gcz: number,
	ccx: number,
	ccz: number,
) {
	const r = rowSize;
	const gen = (x: number, z: number) =>
		generateVertex(x, z, gcx, gcz, ccx, ccz);

	if (shiftZ > 0)
		for (let z = r - shiftZ; z < r; z++) for (let x = 0; x < r; x++) gen(x, z);
	else if (shiftZ < 0)
		for (let z = 0; z < -shiftZ; z++) for (let x = 0; x < r; x++) gen(x, z);

	if (shiftX > 0)
		for (let x = r - shiftX; x < r; x++) for (let z = 0; z < r; z++) gen(x, z);
	else if (shiftX < 0)
		for (let x = 0; x < -shiftX; x++) for (let z = 0; z < r; z++) gen(x, z);
}

// =====================================================================
// Rewrite local X/Z after sliding or center movement
// =====================================================================

function rewriteLocalXZ(ccx: number, ccz: number, gcx: number, gcz: number) {
	const { CHUNK_SIZE } = GenerationParams;
	const r = rowSize;
	const step = gridStep;
	const rad = radius;
	const pos = positions!;

	let i3 = 0;
	for (let z = 0; z < r; z++) {
		const localZ = (gcz - rad + z * step - ccz) * CHUNK_SIZE;
		for (let x = 0; x < r; x++, i3 += 3) {
			const localX = (gcx - rad + x * step - ccx) * CHUNK_SIZE;
			pos[i3] = localX;
			pos[i3 + 2] = localZ;
		}
	}
}

// =====================================================================
// Single vertex generation
// =====================================================================

function generateVertex(
	x: number,
	z: number,
	gcx: number,
	gcz: number,
	ccx: number,
	ccz: number,
) {
	const { CHUNK_SIZE } = GenerationParams;
	const r = rowSize;
	const i3 = (z * r + x) * 3;
	const i2 = (z * r + x) * 2;

	const chunkX = gcx - radius + x * gridStep;
	const chunkZ = gcz - radius + z * gridStep;
	const localChunkX = chunkX - ccx;
	const localChunkZ = chunkZ - ccz;
	const isInsideRealTerrain =
		localChunkX > -currentRenderDistance &&
		localChunkX <= currentRenderDistance &&
		localChunkZ > -currentRenderDistance &&
		localChunkZ <= currentRenderDistance;

	const pos = positions!;
	const nrm = normals!;
	const tiles = surfaceTiles!;

	let y: number;

	if (isInsideRealTerrain) {
		const worldX = chunkX * CHUNK_SIZE;
		const worldZ = chunkZ * CHUNK_SIZE;
		y = INSIDE_CLIP_Y;

		const hRight = cachedHeight(worldX + 1, worldZ);
		const hDown = cachedHeight(worldX, worldZ + 1);
		const dy1 = hRight - y;
		const dy2 = hDown - y;
		const len = Math.sqrt(dy1 * dy1 + 1 + dy2 * dy2) || 1;

		nrm[i3] = (-dy1 / len) * 127;
		nrm[i3 + 1] = (1 / len) * 127;
		nrm[i3 + 2] = (-dy2 / len) * 127;

		const topBlockId = getBiome(worldX, worldZ).topBlock;
		const [tileX, tileY] = getTopTileForBlock(topBlockId);
		tiles[i2] = tileX;
		tiles[i2 + 1] = tileY;
	} else {
		const worldX = chunkX * CHUNK_SIZE;
		const worldZ = chunkZ * CHUNK_SIZE;
		y = cachedHeight(worldX, worldZ);

		const hRight = cachedHeight(worldX + 1, worldZ);
		const hDown = cachedHeight(worldX, worldZ + 1);
		const dy1 = hRight - y;
		const dy2 = hDown - y;
		const len = Math.sqrt(dy1 * dy1 + 1 + dy2 * dy2) || 1;

		nrm[i3] = (-dy1 / len) * 127;
		nrm[i3 + 1] = (1 / len) * 127;
		nrm[i3 + 2] = (-dy2 / len) * 127;

		const topBlockId = getBiome(worldX, worldZ).topBlock;
		const [tileX, tileY] = getTopTileForBlock(topBlockId);
		tiles[i2] = tileX;
		tiles[i2 + 1] = tileY;
	}

	pos[i3] = localChunkX * CHUNK_SIZE;
	pos[i3 + 1] = y;
	pos[i3 + 2] = localChunkZ * CHUNK_SIZE;
}

// =====================================================================
// Tile lookup
// =====================================================================

function getTopTileForBlock(blockId: number): [number, number] {
	const tex = BlockTextures[blockId];
	const tile = tex?.[FaceName.Top] ?? tex?.[FaceName.All];
	return tile ?? [DEFAULT_TILE_X, DEFAULT_TILE_Y];
}
