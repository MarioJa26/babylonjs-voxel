import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { SurfaceGenerator } from "@/code/Generation/SurfaceGenerator";
import {
	getBiome,
	getFinalTerrainHeight,
} from "@/code/Generation/TerrainHeightMap";
import { BlockFaceTileX, BlockFaceTileY } from "../Texture/BlockTextures";
import { FaceName } from "../Texture/FaceName";
import {
	FAR_TILE_Y_OFFSET,
	KIND_OPAQUE,
	KIND_WATER,
	LIGHT_FULL,
	LIGHT_SIDE,
	packWord1,
} from "./FarTileFaceFormat";
import type { FarTileLevelDef } from "./FarTileLadder";
import { getFarTileLevels } from "./FarTileLadder";

/**
 * Worker-side far-tile mesh generator.
 *
 * Produces decimated voxel-style geometry directly from terrain height and
 * biome functions, without materializing full-resolution voxel arrays.
 */

const BASE_CHUNK_SIZE = 32;
const TREE_SCAN_STRIDE = 4;
const WORDS_PER_FACE = 4;

const DEFAULT_TOP_TILE_X = 14;
const DEFAULT_TOP_TILE_Y = 0;

export interface FarTileGenerateRequest {
	requestId: number;
	levelIndex: number;
	tileX: number;
	tileZ: number;
}

export interface FarTileResult {
	requestId: number;
	levelIndex: number;
	tileX: number;
	tileZ: number;
	opaqueFaces: Uint32Array;
	waterFaces: Uint32Array;
}

class FaceWriter {
	private faces: Uint32Array;
	private wordCount = 0;

	constructor(initialFaceCapacity = 4096) {
		const faceCapacity = initialFaceCapacity > 0 ? initialFaceCapacity : 1;

		this.faces = new Uint32Array(faceCapacity * WORDS_PER_FACE);
	}

	public emit(
		x: number,
		y: number,
		z: number,
		w: number,
		h: number,
		axis: number,
		backFace: number,
		tileX: number,
		tileY: number,
		light: number,
		kind: number,
	): void {
		const yBiased = y + FAR_TILE_Y_OFFSET;

		if (
			x < 0 ||
			z < 0 ||
			yBiased < 0 ||
			x > 1023 ||
			z > 1023 ||
			yBiased > 4095 ||
			w < 0 ||
			h < 0 ||
			w > 1023 ||
			h > 1023
		) {
			return;
		}

		const requiredWordCount = this.wordCount + WORDS_PER_FACE;

		if (requiredWordCount > this.faces.length) {
			let newLength = this.faces.length * 2;

			if (newLength < requiredWordCount) {
				newLength = requiredWordCount;
			}

			const expanded = new Uint32Array(newLength);
			expanded.set(this.faces);
			this.faces = expanded;
		}

		const index = this.wordCount;

		this.faces[index] = x | (yBiased << 10) | (z << 22);

		this.faces[index + 1] = packWord1(w, h, axis, backFace);

		this.faces[index + 2] =
			(tileX & 0xff) | ((tileY & 0xff) << 8) | ((light & 0xff) << 16);

		this.faces[index + 3] = kind & 0xff;

		this.wordCount = requiredWordCount;
	}

	public toUint32Array(): Uint32Array {
		// Creates an independently transferable buffer.
		return this.faces.slice(0, this.wordCount);
	}
}

interface HeightLattice {
	/** Number of unpadded height samples per axis. */
	n: number;

	/** Distance between samples in blocks. */
	step: number;

	/** Number of samples per padded row. */
	padded: number;

	/** Reused height buffer. Only the current lattice range is valid. */
	heights: Float64Array;

	/** Maximum corner height for each terrain cell. */
	cellMax: Float64Array;
}

let latticeHeightBuffer: Float64Array = new Float64Array(1024);
let latticeCellMaxBuffer: Float64Array = new Float64Array(1024);

function ensureFloat64Capacity(
	buffer: Float64Array,
	requiredLength: number,
): Float64Array {
	if (requiredLength <= buffer.length) {
		return buffer;
	}

	return new Float64Array(Math.max(requiredLength, buffer.length * 2));
}

/**
 * Returns the maximum of the four height samples forming the cell whose
 * upper-left corner is at `topLeftIndex`.
 */
function getCellMaximum(
	heights: Float64Array,
	topLeftIndex: number,
	rowStride: number,
): number {
	const h00 = heights[topLeftIndex];
	const h10 = heights[topLeftIndex + 1];
	const h01 = heights[topLeftIndex + rowStride];
	const h11 = heights[topLeftIndex + rowStride + 1];

	const upperMaximum = h00 > h10 ? h00 : h10;
	const lowerMaximum = h01 > h11 ? h01 : h11;

	return upperMaximum > lowerMaximum ? upperMaximum : lowerMaximum;
}

/**
 * Samples heights on a lattice padded by one ring so tile-boundary neighbor
 * heights come from real terrain instead of duplicated edge values.
 */
function buildHeightLattice(
	originX: number,
	originZ: number,
	sizeBlocks: number,
	step: number,
): HeightLattice {
	const n = sizeBlocks / step + 1;
	const padded = n + 2;

	const heightCount = padded * padded;
	const cellsPerAxis = n - 1;
	const cellCount = cellsPerAxis * cellsPerAxis;

	latticeHeightBuffer = ensureFloat64Capacity(latticeHeightBuffer, heightCount);

	latticeCellMaxBuffer = ensureFloat64Capacity(latticeCellMaxBuffer, cellCount);

	const heights = latticeHeightBuffer;
	const cellMax = latticeCellMaxBuffer;

	let heightIndex = 0;
	let worldZ = originZ - step;

	for (let latticeZ = -1; latticeZ <= n; latticeZ++) {
		let worldX = originX - step;

		for (let latticeX = -1; latticeX <= n; latticeX++) {
			heights[heightIndex++] = getFinalTerrainHeight(worldX, worldZ);

			worldX += step;
		}

		worldZ += step;
	}

	let cellIndex = 0;
	let rowStart = padded + 1;

	for (let cellZ = 0; cellZ < cellsPerAxis; cellZ++) {
		let sampleIndex = rowStart;

		for (let cellX = 0; cellX < cellsPerAxis; cellX++, sampleIndex++) {
			cellMax[cellIndex++] = getCellMaximum(heights, sampleIndex, padded);
		}

		rowStart += padded;
	}

	return {
		n,
		step,
		padded,
		heights,
		cellMax,
	};
}

/**
 * Returns the nearest interior lattice sample for a local block coordinate.
 * This preserves the existing rounded-and-clamped tree placement behavior.
 */
function sampleLatticeHeight(
	lattice: HeightLattice,
	localX: number,
	localZ: number,
): number {
	const maximumSample = lattice.n - 1;
	const inverseStep = 1 / lattice.step;

	let gridX = Math.round(localX * inverseStep);
	let gridZ = Math.round(localZ * inverseStep);

	if (gridX < 0) {
		gridX = 0;
	} else if (gridX > maximumSample) {
		gridX = maximumSample;
	}

	if (gridZ < 0) {
		gridZ = 0;
	} else if (gridZ > maximumSample) {
		gridZ = maximumSample;
	}

	return lattice.heights[(gridZ + 1) * lattice.padded + gridX + 1];
}

/**
 * Packs a block's "all faces" texture coordinates into one integer.
 *
 * The low byte contains tile X and the next byte contains tile Y. A negative
 * result means that the block does not have a valid texture entry.
 */
function getPackedBlockTile(blockId: number): number {
	if (blockId < 0) {
		return -1;
	}

	const textureIndex = blockId * FaceName.Count + FaceName.All;

	if (
		textureIndex < 0 ||
		textureIndex >= BlockFaceTileX.length ||
		textureIndex >= BlockFaceTileY.length
	) {
		return -1;
	}

	return (
		(BlockFaceTileX[textureIndex] & 0xff) |
		((BlockFaceTileY[textureIndex] & 0xff) << 8)
	);
}

function getTopTextureIndex(blockId: number): number {
	if (blockId < 0) {
		return -1;
	}

	const textureIndex = blockId * FaceName.Count + FaceName.Top;

	if (
		textureIndex < 0 ||
		textureIndex >= BlockFaceTileX.length ||
		textureIndex >= BlockFaceTileY.length
	) {
		return -1;
	}

	return textureIndex;
}

function createEmptyResult(
	request: FarTileGenerateRequest,
	opaque: FaceWriter,
	water: FaceWriter,
): FarTileResult {
	return {
		requestId: request.requestId,
		levelIndex: request.levelIndex,
		tileX: request.tileX,
		tileZ: request.tileZ,
		opaqueFaces: opaque.toUint32Array(),
		waterFaces: water.toUint32Array(),
	};
}

export function generateFarTile(
	request: FarTileGenerateRequest,
): FarTileResult {
	const level: FarTileLevelDef | undefined =
		getFarTileLevels()[request.levelIndex];

	if (level === undefined) {
		const opaque = new FaceWriter(1);
		const water = new FaceWriter(1);

		return createEmptyResult(request, opaque, water);
	}

	const sizeBlocks = level.tileSizeChunks * BASE_CHUNK_SIZE;

	const step = level.voxelStep;
	const cellsPerAxis = sizeBlocks / step;
	const cellCount = cellsPerAxis * cellsPerAxis;

	/*
	 * Every land cell can emit one top and up to four sides. Pre-sizing for
	 * two faces per cell handles typical terrain without allocating for the
	 * pathological five-face maximum.
	 */
	const opaque = new FaceWriter(cellCount * 2);
	const water = new FaceWriter(cellCount);

	const originX = request.tileX * sizeBlocks;
	const originZ = request.tileZ * sizeBlocks;

	const halfStep = step * 0.5;
	const seaLevel = GenerationParams.SEA_LEVEL;

	const lattice = buildHeightLattice(originX, originZ, sizeBlocks, step);

	const padded = lattice.padded;
	const heights = lattice.heights;
	const cellMaxima = lattice.cellMax;

	const lastCell = cellsPerAxis - 1;

	let cellIndex = 0;
	let sampleRowStart = padded + 1;
	let z0 = 0;

	for (let cellZ = 0; cellZ < cellsPerAxis; cellZ++) {
		let sampleIndex = sampleRowStart;
		let x0 = 0;

		for (
			let cellX = 0;
			cellX < cellsPerAxis;
			cellX++, x0 += step, sampleIndex++, cellIndex++
		) {
			const cellMaximum = cellMaxima[cellIndex];

			if (cellMaximum < seaLevel) {
				water.emit(
					x0,
					seaLevel,
					z0,
					step,
					step,
					1,
					0,
					0,
					0,
					LIGHT_FULL,
					KIND_WATER,
				);

				continue;
			}

			const biome = getBiome(originX + x0 + halfStep, originZ + z0 + halfStep);

			const textureIndex = getTopTextureIndex(biome.topBlock);

			let tileX = DEFAULT_TOP_TILE_X;
			let tileY = DEFAULT_TOP_TILE_Y;

			if (textureIndex >= 0) {
				tileX = BlockFaceTileX[textureIndex];
				tileY = BlockFaceTileY[textureIndex];
			}

			opaque.emit(
				x0,
				cellMaximum,
				z0,
				step,
				step,
				1,
				0,
				tileX,
				tileY,
				LIGHT_FULL,
				KIND_OPAQUE,
			);

			const negativeZMaximum =
				cellZ > 0
					? cellMaxima[cellIndex - cellsPerAxis]
					: getCellMaximum(heights, sampleIndex - padded, padded);

			if (negativeZMaximum < cellMaximum) {
				opaque.emit(
					x0,
					negativeZMaximum,
					z0,
					step,
					cellMaximum - negativeZMaximum,
					2,
					1,
					tileX,
					tileY,
					LIGHT_SIDE,
					KIND_OPAQUE,
				);
			}

			const positiveZMaximum =
				cellZ < lastCell
					? cellMaxima[cellIndex + cellsPerAxis]
					: getCellMaximum(heights, sampleIndex + padded, padded);

			if (positiveZMaximum < cellMaximum) {
				opaque.emit(
					x0,
					positiveZMaximum,
					z0 + step,
					step,
					cellMaximum - positiveZMaximum,
					2,
					0,
					tileX,
					tileY,
					LIGHT_SIDE,
					KIND_OPAQUE,
				);
			}

			const negativeXMaximum =
				cellX > 0
					? cellMaxima[cellIndex - 1]
					: getCellMaximum(heights, sampleIndex - 1, padded);

			if (negativeXMaximum < cellMaximum) {
				opaque.emit(
					x0,
					negativeXMaximum,
					z0,
					cellMaximum - negativeXMaximum,
					step,
					0,
					1,
					tileX,
					tileY,
					LIGHT_SIDE,
					KIND_OPAQUE,
				);
			}

			const positiveXMaximum =
				cellX < lastCell
					? cellMaxima[cellIndex + 1]
					: getCellMaximum(heights, sampleIndex + 1, padded);

			if (positiveXMaximum < cellMaximum) {
				opaque.emit(
					x0 + step,
					positiveXMaximum,
					z0,
					cellMaximum - positiveXMaximum,
					step,
					0,
					0,
					tileX,
					tileY,
					LIGHT_SIDE,
					KIND_OPAQUE,
				);
			}
		}

		sampleRowStart += padded;
		z0 += step;
	}

	stampTrees(opaque, lattice, originX, originZ, sizeBlocks, step, seaLevel);

	return {
		requestId: request.requestId,
		levelIndex: request.levelIndex,
		tileX: request.tileX,
		tileZ: request.tileZ,
		opaqueFaces: opaque.toUint32Array(),
		waterFaces: water.toUint32Array(),
	};
}

/**
 * Stamps simplified trees at the same world positions used by normal terrain
 * generation.
 */
function stampTrees(
	out: FaceWriter,
	lattice: HeightLattice,
	originX: number,
	originZ: number,
	sizeBlocks: number,
	step: number,
	seaLevel: number,
): void {
	const stride = step > TREE_SCAN_STRIDE ? step : TREE_SCAN_STRIDE;

	let worldZ = originZ;

	for (
		let localZ = 0;
		localZ < sizeBlocks;
		localZ += stride, worldZ += stride
	) {
		let worldX = originX;

		for (
			let localX = 0;
			localX < sizeBlocks;
			localX += stride, worldX += stride
		) {
			const noiseValue = SurfaceGenerator.getTreeNoiseValue(worldX, worldZ);

			const biome = getBiome(worldX, worldZ);

			if (!biome.canSpawnTrees || noiseValue >= biome.treeDensity) {
				continue;
			}

			const surfaceY = Math.floor(sampleLatticeHeight(lattice, localX, localZ));

			if (surfaceY < seaLevel) {
				continue;
			}

			const tree = biome.getTreeForBlock(biome.topBlock, noiseValue);

			if (tree == null) {
				continue;
			}

			const packedWoodTile = getPackedBlockTile(tree.woodId);

			const packedLeafTile = getPackedBlockTile(tree.leavesId);

			if (packedWoodTile < 0 && packedLeafTile < 0) {
				continue;
			}

			const hash =
				(Math.imul(worldX, 374761393) ^ Math.imul(worldZ, 678446653)) >>> 0;

			const rawVariance = tree.heightVariance ?? 0;
			const variance = rawVariance > 0 ? rawVariance : 0;

			const trunkHeight =
				(tree.baseHeight ?? 5) + (variance > 0 ? hash % (variance + 1) : 0);

			const baseY = surfaceY + 1;

			if (packedWoodTile >= 0) {
				const woodTileX = packedWoodTile & 0xff;

				const woodTileY = (packedWoodTile >>> 8) & 0xff;

				out.emit(
					localX,
					baseY,
					localZ + 1,
					1,
					trunkHeight,
					2,
					0,
					woodTileX,
					woodTileY,
					LIGHT_SIDE,
					KIND_OPAQUE,
				);

				out.emit(
					localX,
					baseY,
					localZ,
					1,
					trunkHeight,
					2,
					1,
					woodTileX,
					woodTileY,
					LIGHT_SIDE,
					KIND_OPAQUE,
				);

				out.emit(
					localX + 1,
					baseY,
					localZ,
					trunkHeight,
					1,
					0,
					0,
					woodTileX,
					woodTileY,
					LIGHT_SIDE,
					KIND_OPAQUE,
				);

				out.emit(
					localX,
					baseY,
					localZ,
					trunkHeight,
					1,
					0,
					1,
					woodTileX,
					woodTileY,
					LIGHT_SIDE,
					KIND_OPAQUE,
				);
			}

			if (packedLeafTile < 0) {
				continue;
			}

			let radius = stride >> 2;

			if (radius < 2) {
				radius = 2;
			} else if (radius > 8) {
				radius = 8;
			}

			const canopyBase = baseY + (trunkHeight > 3 ? trunkHeight - 3 : 1);

			const canopySize = radius * 2 + 1;
			const maximumAnchor = sizeBlocks - canopySize;

			let canopyX = localX - radius;
			let canopyZ = localZ - radius;

			if (canopyX < 0) {
				canopyX = 0;
			} else if (canopyX > maximumAnchor) {
				canopyX = maximumAnchor;
			}

			if (canopyZ < 0) {
				canopyZ = 0;
			} else if (canopyZ > maximumAnchor) {
				canopyZ = maximumAnchor;
			}

			const leafTileX = packedLeafTile & 0xff;

			const leafTileY = (packedLeafTile >>> 8) & 0xff;

			out.emit(
				canopyX,
				canopyBase + 4,
				canopyZ,
				canopySize,
				canopySize,
				1,
				0,
				leafTileX,
				leafTileY,
				LIGHT_FULL,
				KIND_OPAQUE,
			);

			out.emit(
				canopyX,
				canopyBase,
				canopyZ,
				canopySize,
				4,
				2,
				1,
				leafTileX,
				leafTileY,
				LIGHT_SIDE,
				KIND_OPAQUE,
			);

			out.emit(
				canopyX,
				canopyBase,
				canopyZ + canopySize,
				canopySize,
				4,
				2,
				0,
				leafTileX,
				leafTileY,
				LIGHT_SIDE,
				KIND_OPAQUE,
			);

			out.emit(
				canopyX,
				canopyBase,
				canopyZ,
				4,
				canopySize,
				0,
				1,
				leafTileX,
				leafTileY,
				LIGHT_SIDE,
				KIND_OPAQUE,
			);

			out.emit(
				canopyX + canopySize,
				canopyBase,
				canopyZ,
				4,
				canopySize,
				0,
				0,
				leafTileX,
				leafTileY,
				LIGHT_SIDE,
				KIND_OPAQUE,
			);
		}
	}
}
