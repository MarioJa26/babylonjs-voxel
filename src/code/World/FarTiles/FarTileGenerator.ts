import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { SurfaceGenerator } from "@/code/Generation/SurfaceGenerator";
import {
	getBiome,
	getFinalTerrainHeight,
} from "@/code/Generation/TerrainHeightMap";
import { BlockFaceTileX, BlockFaceTileY } from "../Texture/BlockTextures";
import { FaceName } from "../Texture/FaceName";
import {
	KIND_OPAQUE,
	KIND_WATER,
	LIGHT_FULL,
	LIGHT_SIDE,
} from "./FarTileFaceFormat";
import { FaceWriter } from "./FarTileFaceWriter";
import {
	BASE_CHUNK_SIZE,
	type FarTileLevelDef,
	getFarTileLevels,
} from "./FarTileLadder";

/**
 * Worker-side far-tile mesh generator.
 *
 * Produces decimated voxel-style geometry directly from terrain height and
 * biome functions, without materializing full-resolution voxel arrays.
 */

const TREE_SCAN_STRIDE = 4;

const DEFAULT_TOP_TILE_X = 14;
const DEFAULT_TOP_TILE_Y = 0;

/*
 * Texture metadata is immutable after module initialization. Cache the values
 * used in hot paths instead of recalculating them for every tile or tree.
 */
const FACE_NAME_COUNT = FaceName.Count;
const TOP_FACE_OFFSET = FaceName.Top;
const ALL_FACE_OFFSET = FaceName.All;

const TEXTURE_COUNT = Math.min(BlockFaceTileX.length, BlockFaceTileY.length);

export interface FarTileGenerateRequest {
	requestId: number;

	/**
	 * Ladder-generation token echoed back in the result. The manager bumps it
	 * on reset/rebuild and rejects results that carry an old token, so faces
	 * generated against a discarded ladder can never be meshed.
	 */
	generation: number;

	levelIndex: number;
	tileX: number;
	tileZ: number;
}

export interface FarTileResult {
	requestId: number;
	generation: number;
	levelIndex: number;
	tileX: number;
	tileZ: number;
	opaqueFaces: Uint32Array;
	waterFaces: Uint32Array;
}

interface HeightLattice {
	/** Number of unpadded height samples per axis. */
	n: number;

	/** Distance between samples in blocks. */
	step: number;

	/** Number of samples per padded row. */
	padded: number;

	/** Reused height buffer. Only the current lattice range is valid. */
	heights: Float64Array<ArrayBufferLike>;

	/** Maximum corner height for each terrain cell. */
	cellMax: Float64Array<ArrayBufferLike>;
}

/*
 * Retained between worker requests. These buffers grow only when a larger
 * far-tile level requires additional storage.
 */
let latticeHeightBuffer: Float64Array<ArrayBufferLike> = new Float64Array(1024);

let latticeCellMaxBuffer: Float64Array<ArrayBufferLike> = new Float64Array(
	1024,
);

function ensureFloat64Capacity(
	buffer: Float64Array<ArrayBufferLike>,
	requiredLength: number,
): Float64Array<ArrayBufferLike> {
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
	const cellsPerAxis = sizeBlocks / step;
	const sampleCount = cellsPerAxis + 1;
	const padded = sampleCount + 2;

	const heightCount = padded * padded;
	const cellCount = cellsPerAxis * cellsPerAxis;

	latticeHeightBuffer = ensureFloat64Capacity(latticeHeightBuffer, heightCount);

	latticeCellMaxBuffer = ensureFloat64Capacity(latticeCellMaxBuffer, cellCount);

	const heights = latticeHeightBuffer;
	const cellMax = latticeCellMaxBuffer;

	let heightIndex = 0;
	let worldZ = originZ - step;

	/*
	 * Include one sample ring around the tile. Boundary side faces can then
	 * compare against genuine neighboring terrain rather than copied edges.
	 */
	for (let latticeZ = -1; latticeZ <= sampleCount; latticeZ++) {
		let worldX = originX - step;

		for (let latticeX = -1; latticeX <= sampleCount; latticeX++) {
			/*
			 * Integerize once. Cell maxima, side extents, and tree anchors
			 * consequently use integer Y values.
			 */
			heights[heightIndex++] = Math.floor(
				getFinalTerrainHeight(worldX, worldZ),
			);

			worldX += step;
		}

		worldZ += step;
	}

	let cellIndex = 0;
	let sampleRowStart = padded + 1;

	for (let cellZ = 0; cellZ < cellsPerAxis; cellZ++) {
		let sampleIndex = sampleRowStart;

		for (let cellX = 0; cellX < cellsPerAxis; cellX++, sampleIndex++) {
			cellMax[cellIndex++] = getCellMaximum(heights, sampleIndex, padded);
		}

		sampleRowStart += padded;
	}

	return {
		n: sampleCount,
		step,
		padded,
		heights,
		cellMax,
	};
}

/**
 * Returns the nearest interior lattice sample for a local block coordinate.
 * This preserves the rounded-and-clamped tree placement behavior.
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
 * result means that the block has no valid texture entry.
 */
function getPackedBlockTile(blockId: number): number {
	if (blockId < 0) {
		return -1;
	}

	const textureIndex = blockId * FACE_NAME_COUNT + ALL_FACE_OFFSET;

	if (textureIndex < 0 || textureIndex >= TEXTURE_COUNT) {
		return -1;
	}

	return (
		(BlockFaceTileX[textureIndex] & 0xff) |
		((BlockFaceTileY[textureIndex] & 0xff) << 8)
	);
}

function createResult(
	request: FarTileGenerateRequest,
	opaque: FaceWriter,
	water: FaceWriter,
): FarTileResult {
	return {
		requestId: request.requestId,
		generation: request.generation,
		levelIndex: request.levelIndex,
		tileX: request.tileX,
		tileZ: request.tileZ,
		opaqueFaces: opaque.toUint32Array(),
		waterFaces: water.toUint32Array(),
	};
}

/**
 * Generates a decimated terrain mesh for one far-distance tile.
 */
export function generateFarTile(
	request: FarTileGenerateRequest,
): FarTileResult {
	const levels = getFarTileLevels();

	const level: FarTileLevelDef | undefined = levels[request.levelIndex];

	if (level === undefined) {
		return createResult(request, new FaceWriter(1), new FaceWriter(1));
	}

	const step = level.voxelStep;
	const sizeBlocks = level.tileSizeChunks * BASE_CHUNK_SIZE;

	const cellsPerAxis = sizeBlocks / step;
	const cellCount = cellsPerAxis * cellsPerAxis;

	/*
	 * Most terrain cells emit a top and approximately one exposed side.
	 * FaceWriter can grow if high-frequency terrain exceeds this estimate.
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

			/*
			 * Preserve existing behavior: submerged cells emit only a water
			 * surface and avoid biome and texture lookups.
			 */
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

			const topBlock = biome.topBlock;

			const textureIndex =
				topBlock >= 0 ? topBlock * FACE_NAME_COUNT + TOP_FACE_OFFSET : -1;

			let tileX = DEFAULT_TOP_TILE_X;
			let tileY = DEFAULT_TOP_TILE_Y;

			if (textureIndex >= 0 && textureIndex < TEXTURE_COUNT) {
				tileX = BlockFaceTileX[textureIndex];
				tileY = BlockFaceTileY[textureIndex];
			}

			/*
			 * Top face.
			 */
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

			/*
			 * Negative Z neighbor.
			 */
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

			/*
			 * Positive Z neighbor.
			 */
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

			/*
			 * Negative X neighbor.
			 */
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

			/*
			 * Positive X neighbor.
			 */
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

	return createResult(request, opaque, water);
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

	/*
	 * Canopy dimensions depend only on the tile's scan stride.
	 */
	let canopyRadius = stride >> 2;

	if (canopyRadius < 2) {
		canopyRadius = 2;
	} else if (canopyRadius > 8) {
		canopyRadius = 8;
	}

	const canopySize = canopyRadius * 2 + 1;
	const maximumCanopyAnchor = sizeBlocks - canopySize;

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

			/*
			 * Lattice heights were already floored while sampling.
			 */
			const surfaceY = sampleLatticeHeight(lattice, localX, localZ);

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

			const rawVariance = tree.heightVariance ?? 0;

			const variance = rawVariance > 0 ? rawVariance : 0;

			let heightOffset = 0;

			/*
			 * Avoid the hash multiplications when the selected tree type has
			 * no height variance.
			 */
			if (variance > 0) {
				const hash =
					(Math.imul(worldX, 374761393) ^ Math.imul(worldZ, 678446653)) >>> 0;

				heightOffset = hash % (variance + 1);
			}

			const trunkHeight = (tree.baseHeight ?? 5) + heightOffset;

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

			const canopyBase = baseY + (trunkHeight > 3 ? trunkHeight - 3 : 1);

			let canopyX = localX - canopyRadius;

			let canopyZ = localZ - canopyRadius;

			if (canopyX < 0) {
				canopyX = 0;
			} else if (canopyX > maximumCanopyAnchor) {
				canopyX = maximumCanopyAnchor;
			}

			if (canopyZ < 0) {
				canopyZ = 0;
			} else if (canopyZ > maximumCanopyAnchor) {
				canopyZ = maximumCanopyAnchor;
			}

			const leafTileX = packedLeafTile & 0xff;

			const leafTileY = (packedLeafTile >>> 8) & 0xff;

			/*
			 * Canopy top.
			 */
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

			/*
			 * Negative Z canopy face.
			 */
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

			/*
			 * Positive Z canopy face.
			 */
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

			/*
			 * Negative X canopy face.
			 */
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

			/*
			 * Positive X canopy face.
			 */
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
