import { BlockTextures } from "@/code/World/Texture/BlockTextures";
import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import { TerrainHeightMap } from "../TerrainHeightMap";

export class DistantTerrainGenerator {
	private static readonly DEFAULT_TILE_X = 14;
	private static readonly DEFAULT_TILE_Y = 0;
	private static readonly INSIDE_CLIP_Y = -200;

	private static positions?: Int16Array;
	private static normals?: Int8Array;
	private static surfaceTiles?: Uint8Array;

	private static lastGridCenterChunkX = Number.NaN;
	private static lastGridCenterChunkZ = Number.NaN;
	private static lastCenterChunkX = Number.NaN;
	private static lastCenterChunkZ = Number.NaN;

	private static rowSize = 0;
	private static segments = 0;
	private static gridStep = 1;
	private static radius = 0;
	private static usingSharedBuffers = false;

	// =====================================================================
	// SharedArrayBuffer initialization
	// =====================================================================

	public static initSharedBuffers(
		positionsBuffer: SharedArrayBuffer,
		normalsBuffer: SharedArrayBuffer,
		surfaceTilesBuffer: SharedArrayBuffer,
		radius: number,
		gridStep: number,
	) {
		DistantTerrainGenerator.configureGrid(radius, gridStep);

		const vertexCount = DistantTerrainGenerator.rowSize ** 2;
		const expectedPositionsBytes =
			vertexCount * 3 * Int16Array.BYTES_PER_ELEMENT;
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

		DistantTerrainGenerator.positions = new Int16Array(positionsBuffer);
		DistantTerrainGenerator.normals = new Int8Array(normalsBuffer);
		DistantTerrainGenerator.surfaceTiles = new Uint8Array(surfaceTilesBuffer);
		DistantTerrainGenerator.usingSharedBuffers = true;
		DistantTerrainGenerator.resetTracking();
	}

	// =====================================================================
	// Public generation entry point
	// =====================================================================

	public static generate(
		centerChunkX: number,
		centerChunkZ: number,
		radius: number,
		renderDistance: number,
		gridStep: number,
		forceFullRebuild = false,
	) {
		const gridCenterChunkX = Math.floor(centerChunkX / gridStep) * gridStep;
		const gridCenterChunkZ = Math.floor(centerChunkZ / gridStep) * gridStep;

		DistantTerrainGenerator.ensureBuffers(radius, gridStep);

		const positions = DistantTerrainGenerator.positions!;
		const normals = DistantTerrainGenerator.normals!;
		const surfaceTiles = DistantTerrainGenerator.surfaceTiles!;

		const firstBuild =
			forceFullRebuild ||
			Number.isNaN(DistantTerrainGenerator.lastGridCenterChunkX) ||
			Number.isNaN(DistantTerrainGenerator.lastGridCenterChunkZ);

		if (firstBuild) {
			DistantTerrainGenerator.fullGenerate(
				gridCenterChunkX,
				gridCenterChunkZ,
				centerChunkX,
				centerChunkZ,
				renderDistance,
			);
		} else {
			const shiftX =
				(gridCenterChunkX - DistantTerrainGenerator.lastGridCenterChunkX) /
				DistantTerrainGenerator.gridStep;
			const shiftZ =
				(gridCenterChunkZ - DistantTerrainGenerator.lastGridCenterChunkZ) /
				DistantTerrainGenerator.gridStep;
			const exactCenterMoved =
				centerChunkX !== DistantTerrainGenerator.lastCenterChunkX ||
				centerChunkZ !== DistantTerrainGenerator.lastCenterChunkZ;
			const snappedGridMoved = shiftX !== 0 || shiftZ !== 0;

			const needsFullRebuild =
				Math.abs(shiftX) >= DistantTerrainGenerator.rowSize ||
				Math.abs(shiftZ) >= DistantTerrainGenerator.rowSize ||
				!Number.isInteger(shiftX) ||
				!Number.isInteger(shiftZ) ||
				(exactCenterMoved && !snappedGridMoved) ||
				Math.abs(shiftX) > 1 ||
				Math.abs(shiftZ) > 1 ||
				(shiftX !== 0 && shiftZ !== 0);

			if (needsFullRebuild) {
				DistantTerrainGenerator.fullGenerate(
					gridCenterChunkX,
					gridCenterChunkZ,
					centerChunkX,
					centerChunkZ,
					renderDistance,
				);
			} else {
				if (snappedGridMoved) {
					DistantTerrainGenerator.slideArrays(shiftX, shiftZ);
					DistantTerrainGenerator.regenerateEdges(
						shiftX,
						shiftZ,
						gridCenterChunkX,
						gridCenterChunkZ,
						centerChunkX,
						centerChunkZ,
						renderDistance,
					);
				}
				if (snappedGridMoved || exactCenterMoved) {
					DistantTerrainGenerator.rewriteLocalXZ(
						centerChunkX,
						centerChunkZ,
						gridCenterChunkX,
						gridCenterChunkZ,
					);
				}
			}
		}

		DistantTerrainGenerator.lastGridCenterChunkX = gridCenterChunkX;
		DistantTerrainGenerator.lastGridCenterChunkZ = gridCenterChunkZ;
		DistantTerrainGenerator.lastCenterChunkX = centerChunkX;
		DistantTerrainGenerator.lastCenterChunkZ = centerChunkZ;

		return { positions, normals, surfaceTiles, centerChunkX, centerChunkZ };
	}

	// =====================================================================
	// Buffer / grid helpers
	// =====================================================================

	private static ensureBuffers(radius: number, gridStep: number) {
		const buffersMissing =
			!DistantTerrainGenerator.positions ||
			!DistantTerrainGenerator.normals ||
			!DistantTerrainGenerator.surfaceTiles ||
			DistantTerrainGenerator.positions.buffer.byteLength === 0 ||
			DistantTerrainGenerator.normals.buffer.byteLength === 0 ||
			DistantTerrainGenerator.surfaceTiles.buffer.byteLength === 0;

		const configChanged =
			DistantTerrainGenerator.radius !== radius ||
			DistantTerrainGenerator.gridStep !== gridStep;

		if (buffersMissing || configChanged) {
			if (DistantTerrainGenerator.usingSharedBuffers)
				throw new Error(
					"DistantTerrainGenerator: shared buffers missing or config changed — recreate shared buffers.",
				);
			DistantTerrainGenerator.configureGrid(radius, gridStep);
			DistantTerrainGenerator.allocateLocalBuffers();
			DistantTerrainGenerator.resetTracking();
		}
	}

	private static configureGrid(radius: number, gridStep: number) {
		DistantTerrainGenerator.radius = radius;
		DistantTerrainGenerator.gridStep = gridStep;
		DistantTerrainGenerator.segments = Math.floor((radius * 2) / gridStep);
		DistantTerrainGenerator.rowSize = DistantTerrainGenerator.segments + 1;
	}

	private static allocateLocalBuffers() {
		const vertexCount = DistantTerrainGenerator.rowSize ** 2;
		DistantTerrainGenerator.positions = new Int16Array(vertexCount * 3);
		DistantTerrainGenerator.normals = new Int8Array(vertexCount * 3);
		DistantTerrainGenerator.surfaceTiles = new Uint8Array(vertexCount * 2);
		DistantTerrainGenerator.usingSharedBuffers = false;
	}

	private static resetTracking() {
		DistantTerrainGenerator.lastGridCenterChunkX = Number.NaN;
		DistantTerrainGenerator.lastGridCenterChunkZ = Number.NaN;
		DistantTerrainGenerator.lastCenterChunkX = Number.NaN;
		DistantTerrainGenerator.lastCenterChunkZ = Number.NaN;
	}

	// =====================================================================
	// Full generation
	// =====================================================================

	private static fullGenerate(
		gridCenterChunkX: number,
		gridCenterChunkZ: number,
		centerChunkX: number,
		centerChunkZ: number,
		renderDistance: number,
	) {
		const r = DistantTerrainGenerator.rowSize;
		for (let z = 0; z < r; z++)
			for (let x = 0; x < r; x++)
				DistantTerrainGenerator.generateVertex(
					x,
					z,
					gridCenterChunkX,
					gridCenterChunkZ,
					centerChunkX,
					centerChunkZ,
					renderDistance,
				);
	}

	// =====================================================================
	// Sliding-window copy (single-axis shifts of 1 only)
	// =====================================================================

	private static slideArrays(shiftX: number, shiftZ: number) {
		const r = DistantTerrainGenerator.rowSize;
		const positions = DistantTerrainGenerator.positions!;
		const normals = DistantTerrainGenerator.normals!;
		const surfaceTiles = DistantTerrainGenerator.surfaceTiles!;

		if (shiftZ !== 0) {
			const rowsToCopy = r - Math.abs(shiftZ);
			const srcRow = shiftZ > 0 ? shiftZ : 0;
			const dstRow = shiftZ > 0 ? 0 : -shiftZ;
			positions.copyWithin(
				dstRow * r * 3,
				srcRow * r * 3,
				(srcRow + rowsToCopy) * r * 3,
			);
			normals.copyWithin(
				dstRow * r * 3,
				srcRow * r * 3,
				(srcRow + rowsToCopy) * r * 3,
			);
			surfaceTiles.copyWithin(
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
				positions.copyWithin(
					base3 + dstCol * 3,
					base3 + srcCol * 3,
					base3 + (srcCol + colsToCopy) * 3,
				);
				normals.copyWithin(
					base3 + dstCol * 3,
					base3 + srcCol * 3,
					base3 + (srcCol + colsToCopy) * 3,
				);
				surfaceTiles.copyWithin(
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

	private static regenerateEdges(
		shiftX: number,
		shiftZ: number,
		gridCenterChunkX: number,
		gridCenterChunkZ: number,
		centerChunkX: number,
		centerChunkZ: number,
		renderDistance: number,
	) {
		const r = DistantTerrainGenerator.rowSize;
		const gen = (x: number, z: number) =>
			DistantTerrainGenerator.generateVertex(
				x,
				z,
				gridCenterChunkX,
				gridCenterChunkZ,
				centerChunkX,
				centerChunkZ,
				renderDistance,
			);

		if (shiftZ > 0)
			for (let z = r - shiftZ; z < r; z++)
				for (let x = 0; x < r; x++) gen(x, z);
		else if (shiftZ < 0)
			for (let z = 0; z < -shiftZ; z++) for (let x = 0; x < r; x++) gen(x, z);

		if (shiftX > 0)
			for (let x = r - shiftX; x < r; x++)
				for (let z = 0; z < r; z++) gen(x, z);
		else if (shiftX < 0)
			for (let x = 0; x < -shiftX; x++) for (let z = 0; z < r; z++) gen(x, z);
	}

	// =====================================================================
	// Rewrite local X/Z after sliding or center movement
	// =====================================================================

	private static rewriteLocalXZ(
		centerChunkX: number,
		centerChunkZ: number,
		gridCenterChunkX: number,
		gridCenterChunkZ: number,
	) {
		const { CHUNK_SIZE } = GenerationParams;
		const r = DistantTerrainGenerator.rowSize;
		const step = DistantTerrainGenerator.gridStep;
		const radius = DistantTerrainGenerator.radius;
		const positions = DistantTerrainGenerator.positions!;

		let i3 = 0;
		for (let z = 0; z < r; z++) {
			const localZ =
				(gridCenterChunkZ - radius + z * step - centerChunkZ) * CHUNK_SIZE;
			for (let x = 0; x < r; x++, i3 += 3) {
				const localX =
					(gridCenterChunkX - radius + x * step - centerChunkX) * CHUNK_SIZE;
				positions[i3] = localX;
				positions[i3 + 2] = localZ;
			}
		}
	}

	// =====================================================================
	// Single vertex generation
	// =====================================================================

	private static generateVertex(
		x: number,
		z: number,
		gridCenterChunkX: number,
		gridCenterChunkZ: number,
		centerChunkX: number,
		centerChunkZ: number,
		renderDistance: number,
	) {
		const { CHUNK_SIZE } = GenerationParams;
		const r = DistantTerrainGenerator.rowSize;
		const i3 = (z * r + x) * 3;
		const i2 = (z * r + x) * 2;

		const chunkX =
			gridCenterChunkX -
			DistantTerrainGenerator.radius +
			x * DistantTerrainGenerator.gridStep;
		const chunkZ =
			gridCenterChunkZ -
			DistantTerrainGenerator.radius +
			z * DistantTerrainGenerator.gridStep;
		const localChunkX = chunkX - centerChunkX;
		const localChunkZ = chunkZ - centerChunkZ;

		const isInsideRealTerrain =
			localChunkX > -renderDistance &&
			localChunkX <= renderDistance &&
			localChunkZ > -renderDistance &&
			localChunkZ <= renderDistance;

		const positions = DistantTerrainGenerator.positions!;
		const normals = DistantTerrainGenerator.normals!;
		const surfaceTiles = DistantTerrainGenerator.surfaceTiles!;

		let y: number;

		if (isInsideRealTerrain) {
			y = DistantTerrainGenerator.INSIDE_CLIP_Y;
			normals[i3] = 0;
			normals[i3 + 1] = 127;
			normals[i3 + 2] = 0;
			surfaceTiles[i2] = DistantTerrainGenerator.DEFAULT_TILE_X;
			surfaceTiles[i2 + 1] = DistantTerrainGenerator.DEFAULT_TILE_Y;
		} else {
			const worldX = chunkX * CHUNK_SIZE;
			const worldZ = chunkZ * CHUNK_SIZE;
			y = TerrainHeightMap.getFinalTerrainHeight(worldX, worldZ);

			const hRight = TerrainHeightMap.getFinalTerrainHeight(worldX + 1, worldZ);
			const hDown = TerrainHeightMap.getFinalTerrainHeight(worldX, worldZ + 1);
			const dy1 = hRight - y;
			const dy2 = hDown - y;
			const len = Math.sqrt(dy1 * dy1 + 1 + dy2 * dy2) || 1;

			normals[i3] = (-dy1 / len) * 127;
			normals[i3 + 1] = (1 / len) * 127;
			normals[i3 + 2] = (-dy2 / len) * 127;

			const topBlockId = TerrainHeightMap.getBiome(worldX, worldZ).topBlock;
			const [tileX, tileY] =
				DistantTerrainGenerator.getTopTileForBlock(topBlockId);
			surfaceTiles[i2] = tileX;
			surfaceTiles[i2 + 1] = tileY;
		}

		positions[i3] = localChunkX * CHUNK_SIZE;
		positions[i3 + 1] = y;
		positions[i3 + 2] = localChunkZ * CHUNK_SIZE;
	}

	// =====================================================================
	// Tile lookup
	// =====================================================================

	private static getTopTileForBlock(blockId: number): [number, number] {
		const tex = (
			BlockTextures as Record<
				number,
				{ top?: [number, number]; all?: [number, number] }
			>
		)[blockId];
		const tile = tex?.top ?? tex?.all;
		return (
			tile ?? [
				DistantTerrainGenerator.DEFAULT_TILE_X,
				DistantTerrainGenerator.DEFAULT_TILE_Y,
			]
		);
	}
}
