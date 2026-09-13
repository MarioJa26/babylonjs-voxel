import type { DistantTerrainGenerateOutput } from "@/code/World/Chunk/Worker/WorkerTaskHandlers";
import { isFarTilesEnabled } from "@/code/World/FarTiles/FarTileLadder";
import {
	BlockFaceTileX,
	BlockFaceTileY,
} from "@/code/World/Texture/BlockTextures";
import { FaceName } from "@/code/World/Texture/FaceName";
import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import { getBiome, getFinalTerrainHeight } from "../TerrainHeightMap";

const DEFAULT_TILE_X = 14;
const DEFAULT_TILE_Y = 0;
const INSIDE_CLIP_Y = -200;
const FAR_TILE_UNDERLAY_DROP = 16;

const POSITION_COMPONENTS = 3;
const TILE_COMPONENTS = 4;

let positions: Float32Array | undefined;
let normals: Float32Array | undefined;
let surfaceTiles: Uint8Array | undefined;

let lastGridCenterChunkX = Number.NaN;
let lastGridCenterChunkZ = Number.NaN;
let lastCenterChunkX = Number.NaN;
let lastCenterChunkZ = Number.NaN;

let currentRenderDistance = 0;
let farTilesActive = false;

let rowSize = 0;
let rowStride3 = 0;
let rowStride4 = 0;
let vertexCount = 0;

let segments = 0;
let gridStep = 1;
let radius = 0;
let usingSharedBuffers = false;

function cachedHeight(wx: number, wz: number): number {
	return getFinalTerrainHeight(wx, wz);
}

// =====================================================================
// Configuration
// =====================================================================

export function setRenderDistance(value: number): void {
	currentRenderDistance = value;
	farTilesActive = isFarTilesEnabled();
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
): void {
	configureGrid(r, gStep);

	const expectedPositionsBytes =
		vertexCount * POSITION_COMPONENTS * Float32Array.BYTES_PER_ELEMENT;

	const expectedNormalsBytes =
		vertexCount * POSITION_COMPONENTS * Float32Array.BYTES_PER_ELEMENT;

	const expectedSurfaceTilesBytes =
		vertexCount * TILE_COMPONENTS * Uint8Array.BYTES_PER_ELEMENT;

	if (positionsBuffer.byteLength !== expectedPositionsBytes) {
		throw new Error(
			`Shared positions buffer size mismatch. Expected ${expectedPositionsBytes}, got ${positionsBuffer.byteLength}.`,
		);
	}

	if (normalsBuffer.byteLength !== expectedNormalsBytes) {
		throw new Error(
			`Shared normals buffer size mismatch. Expected ${expectedNormalsBytes}, got ${normalsBuffer.byteLength}.`,
		);
	}

	if (surfaceTilesBuffer.byteLength !== expectedSurfaceTilesBytes) {
		throw new Error(
			`Shared surfaceTiles buffer size mismatch. Expected ${expectedSurfaceTilesBytes}, got ${surfaceTilesBuffer.byteLength}.`,
		);
	}

	positions = new Float32Array(positionsBuffer);
	normals = new Float32Array(normalsBuffer);
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
	out: DistantTerrainGenerateOutput,
): void {
	const gridCenterChunkX = Math.floor(centerChunkX / gStep) * gStep;
	const gridCenterChunkZ = Math.floor(centerChunkZ / gStep) * gStep;

	ensureBuffers(r, gStep);

	const firstBuild =
		Number.isNaN(lastGridCenterChunkX) || Number.isNaN(lastGridCenterChunkZ);

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

		const absShiftX = Math.abs(shiftX);
		const absShiftZ = Math.abs(shiftZ);

		const needsFullRebuild =
			absShiftX >= rowSize ||
			absShiftZ >= rowSize ||
			!Number.isInteger(shiftX) ||
			!Number.isInteger(shiftZ) ||
			(exactCenterMoved && !snappedGridMoved) ||
			absShiftX > 1 ||
			absShiftZ > 1;

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

	out.centerChunkX = centerChunkX;
	out.centerChunkZ = centerChunkZ;
}

// =====================================================================
// Buffer and grid helpers
// =====================================================================

function ensureBuffers(r: number, gStep: number): void {
	const pos = positions;
	const nrm = normals;
	const tiles = surfaceTiles;

	const buffersMissing =
		pos === undefined ||
		nrm === undefined ||
		tiles === undefined ||
		pos.buffer.byteLength === 0 ||
		nrm.buffer.byteLength === 0 ||
		tiles.buffer.byteLength === 0;

	const configChanged = radius !== r || gridStep !== gStep;

	if (!buffersMissing && !configChanged) {
		return;
	}

	if (usingSharedBuffers) {
		throw new Error(
			"DistantTerrainGenerator: shared buffers missing or config changed; recreate shared buffers.",
		);
	}

	configureGrid(r, gStep);
	allocateLocalBuffers();
	resetTracking();
}

function configureGrid(r: number, gStep: number): void {
	radius = r;
	gridStep = gStep;

	segments = Math.floor((r * 2) / gStep);
	rowSize = segments + 1;

	vertexCount = rowSize * rowSize;
	rowStride3 = rowSize * POSITION_COMPONENTS;
	rowStride4 = rowSize * TILE_COMPONENTS;
}

function allocateLocalBuffers(): void {
	positions = new Float32Array(vertexCount * POSITION_COMPONENTS);
	normals = new Float32Array(vertexCount * POSITION_COMPONENTS);
	surfaceTiles = new Uint8Array(vertexCount * TILE_COMPONENTS);

	usingSharedBuffers = false;
}

function resetTracking(): void {
	lastGridCenterChunkX = Number.NaN;
	lastGridCenterChunkZ = Number.NaN;
	lastCenterChunkX = Number.NaN;
	lastCenterChunkZ = Number.NaN;
}

/**
 * Reset grid tracking so the next generate() call performs a full rebuild.
 * Call this when the world seed changes.
 */
export function resetCacheAndTracking(): void {
	resetTracking();
}

// =====================================================================
// Full generation
// =====================================================================

function fullGenerate(
	gcx: number,
	gcz: number,
	ccx: number,
	ccz: number,
): void {
	const size = rowSize;

	for (let z = 0; z < size; z++) {
		for (let x = 0; x < size; x++) {
			generateVertex(x, z, gcx, gcz, ccx, ccz);
		}
	}
}

// =====================================================================
// Sliding-window copy
// =====================================================================

function slideArrays(shiftX: number, shiftZ: number): void {
	const size = rowSize;
	const pos = positions!;
	const nrm = normals!;
	const tiles = surfaceTiles!;

	if (shiftZ !== 0) {
		const absoluteShiftZ = Math.abs(shiftZ);
		const rowsToCopy = size - absoluteShiftZ;
		const srcRow = shiftZ > 0 ? shiftZ : 0;
		const dstRow = shiftZ > 0 ? 0 : -shiftZ;

		const srcStart3 = srcRow * rowStride3;
		const dstStart3 = dstRow * rowStride3;
		const srcEnd3 = srcStart3 + rowsToCopy * rowStride3;

		const srcStart4 = srcRow * rowStride4;
		const dstStart4 = dstRow * rowStride4;
		const srcEnd4 = srcStart4 + rowsToCopy * rowStride4;

		pos.copyWithin(dstStart3, srcStart3, srcEnd3);
		nrm.copyWithin(dstStart3, srcStart3, srcEnd3);
		tiles.copyWithin(dstStart4, srcStart4, srcEnd4);
	}

	if (shiftX !== 0) {
		const absoluteShiftX = Math.abs(shiftX);
		const columnsToCopy = size - absoluteShiftX;
		const srcColumn = shiftX > 0 ? shiftX : 0;
		const dstColumn = shiftX > 0 ? 0 : -shiftX;

		const srcColumn3 = srcColumn * POSITION_COMPONENTS;
		const dstColumn3 = dstColumn * POSITION_COMPONENTS;
		const copyLength3 = columnsToCopy * POSITION_COMPONENTS;

		const srcColumn4 = srcColumn * TILE_COMPONENTS;
		const dstColumn4 = dstColumn * TILE_COMPONENTS;
		const copyLength4 = columnsToCopy * TILE_COMPONENTS;

		let base3 = 0;
		let base4 = 0;

		for (let z = 0; z < size; z++) {
			const srcStart3 = base3 + srcColumn3;
			const dstStart3 = base3 + dstColumn3;

			pos.copyWithin(dstStart3, srcStart3, srcStart3 + copyLength3);
			nrm.copyWithin(dstStart3, srcStart3, srcStart3 + copyLength3);

			const srcStart4 = base4 + srcColumn4;
			tiles.copyWithin(base4 + dstColumn4, srcStart4, srcStart4 + copyLength4);

			base3 += rowStride3;
			base4 += rowStride4;
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
): void {
	const size = rowSize;

	/*
	 * Call generateVertex directly instead of allocating an arrow-function
	 * closure on every regenerateEdges invocation.
	 */
	if (shiftZ > 0) {
		const firstZ = size - shiftZ;

		for (let z = firstZ; z < size; z++) {
			for (let x = 0; x < size; x++) {
				generateVertex(x, z, gcx, gcz, ccx, ccz);
			}
		}
	} else if (shiftZ < 0) {
		const endZ = -shiftZ;

		for (let z = 0; z < endZ; z++) {
			for (let x = 0; x < size; x++) {
				generateVertex(x, z, gcx, gcz, ccx, ccz);
			}
		}
	}

	if (shiftX > 0) {
		const firstX = size - shiftX;

		for (let x = firstX; x < size; x++) {
			for (let z = 0; z < size; z++) {
				generateVertex(x, z, gcx, gcz, ccx, ccz);
			}
		}
	} else if (shiftX < 0) {
		const endX = -shiftX;

		for (let x = 0; x < endX; x++) {
			for (let z = 0; z < size; z++) {
				generateVertex(x, z, gcx, gcz, ccx, ccz);
			}
		}
	}
}

// =====================================================================
// Rewrite local X/Z after sliding or center movement
// =====================================================================

function rewriteLocalXZ(
	ccx: number,
	ccz: number,
	gcx: number,
	gcz: number,
): void {
	const chunkSize = GenerationParams.CHUNK_SIZE;
	const size = rowSize;
	const stepWorld = gridStep * chunkSize;

	const baseLocalX = (gcx - radius - ccx) * chunkSize;
	const baseLocalZ = (gcz - radius - ccz) * chunkSize;

	const pos = positions!;

	let rowBase3 = 0;
	let localZ = baseLocalZ;

	for (let z = 0; z < size; z++) {
		let i3 = rowBase3;
		let localX = baseLocalX;

		for (let x = 0; x < size; x++) {
			pos[i3] = localX;
			pos[i3 + 2] = localZ;

			i3 += POSITION_COMPONENTS;
			localX += stepWorld;
		}

		rowBase3 += rowStride3;
		localZ += stepWorld;
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
): void {
	const chunkSize = GenerationParams.CHUNK_SIZE;

	const vertexIndex = z * rowSize + x;
	const i3 = vertexIndex * POSITION_COMPONENTS;
	const i4 = vertexIndex * TILE_COMPONENTS;

	const chunkX = gcx - radius + x * gridStep;
	const chunkZ = gcz - radius + z * gridStep;

	const localChunkX = chunkX - ccx;
	const localChunkZ = chunkZ - ccz;

	const worldX = chunkX * chunkSize;
	const worldZ = chunkZ * chunkSize;

	const renderDistance = currentRenderDistance;

	const isInsideRealTerrain =
		localChunkX > -renderDistance &&
		localChunkX <= renderDistance &&
		localChunkZ > -renderDistance &&
		localChunkZ <= renderDistance;

	let y: number;

	if (isInsideRealTerrain) {
		y = INSIDE_CLIP_Y;
	} else {
		y = cachedHeight(worldX, worldZ);

		if (farTilesActive) {
			y -= FAR_TILE_UNDERLAY_DROP;
		}
	}

	/*
	 * These lookups are retained even for clipped vertices because they
	 * affect the generated normals in the original implementation.
	 */
	const hRight = cachedHeight(worldX + 1, worldZ);
	const hDown = cachedHeight(worldX, worldZ + 1);

	const dy1 = hRight - y;
	const dy2 = hDown - y;

	const lengthSquared = dy1 * dy1 + 1 + dy2 * dy2;
	const invLength = 1 / Math.sqrt(lengthSquared);

	const pos = positions!;
	const nrm = normals!;
	const tiles = surfaceTiles!;

	pos[i3] = localChunkX * chunkSize;
	pos[i3 + 1] = y;
	pos[i3 + 2] = localChunkZ * chunkSize;

	nrm[i3] = -dy1 * invLength;
	nrm[i3 + 1] = invLength;
	nrm[i3 + 2] = -dy2 * invLength;

	const topBlockId = getBiome(worldX, worldZ).topBlock;
	const tileIndex = topBlockId * FaceName.Count + FaceName.Top;

	if (topBlockId >= 0 && tileIndex < BlockFaceTileX.length) {
		tiles[i4] = BlockFaceTileX[tileIndex];
		tiles[i4 + 1] = BlockFaceTileY[tileIndex];
	} else {
		tiles[i4] = DEFAULT_TILE_X;
		tiles[i4 + 1] = DEFAULT_TILE_Y;
	}

	tiles[i4 + 2] = 0;
	tiles[i4 + 3] = 255;
}
