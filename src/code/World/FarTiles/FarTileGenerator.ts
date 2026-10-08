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
 * Produces decimated voxel-style geometry for one far LOD tile directly from
 * the terrain height/biome functions — full-resolution voxel arrays are never
 * materialized. Output is the compact face format defined in
 * FarTileFaceFormat.ts (encoding + decode + CPU expansion all live there so
 * the pipeline stays verifiable end-to-end).
 */

// Tree candidate scan stride in blocks. Real trees are stamped per block
// column; at far distance every 4th column still catches every canopy while
// keeping per-tile cost bounded.
const TREE_SCAN_STRIDE = 4;

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
	public faces: Uint32Array;
	public count: number = 0;

	constructor(initialCapacity: number = 4096) {
		this.faces = new Uint32Array(initialCapacity * 4); // 4 words per face
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
			w > 1023 ||
			h > 1023
		)
			return;

		if (this.count + 4 > this.faces.length) {
			const newFaces = new Uint32Array(this.faces.length * 2);
			newFaces.set(this.faces);
			this.faces = newFaces;
		}

		const i = this.count;
		this.faces[i] = x | (yBiased << 10) | (z << 22);
		this.faces[i + 1] = packWord1(w, h, axis, backFace);
		this.faces[i + 2] =
			(tileX & 0xff) | ((tileY & 0xff) << 8) | ((light & 0xff) << 16);
		this.faces[i + 3] = kind & 0xff;

		this.count += 4;
	}

	public toUint32Array(): Uint32Array {
		// Slice creates a new ArrayBuffer, safe to transfer to main thread
		// without detaching the worker's reusable buffer.
		return this.faces.slice(0, this.count);
	}
}

function tilesForBlock(blockId: number): [number, number] | null {
	if (blockId < 0 || blockId * FaceName.Count >= BlockFaceTileX.length)
		return null;
	const base = blockId * FaceName.Count + FaceName.All;
	return [BlockFaceTileX[base], BlockFaceTileY[base]];
}

interface HeightLattice {
	/** Number of unpadded height samples per axis. */
	n: number;
	step: number;
	padded: number;
	heights: Float64Array;
	/** Maximum corner height for every terrain cell. */
	cellMax: Float64Array;
}

let _latticeHeightBuffer = new Float64Array(1024);
let _latticeCellMaxBuffer = new Float64Array(1024);

/**
 * Samples heights on a lattice padded by ONE ring (-1..n inclusive) so that
 * neighbor lookups across tile borders resolve to REAL terrain values.
 * Same-level neighbors then produce flush edges (no skirt -> no seam fins),
 * while genuine cliffs and level-ring boundaries still get exact skirts.
 */
const _latticeBuffer = new Float64Array(1024);

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

	if (heightCount > _latticeHeightBuffer.length) {
		_latticeHeightBuffer = new Float64Array(
			Math.max(heightCount, _latticeHeightBuffer.length * 2),
		);
	}

	if (cellCount > _latticeCellMaxBuffer.length) {
		_latticeCellMaxBuffer = new Float64Array(
			Math.max(cellCount, _latticeCellMaxBuffer.length * 2),
		);
	}

	const heights = _latticeHeightBuffer;
	const cellMax = _latticeCellMaxBuffer;

	let writeIndex = 0;

	for (let cz = -1; cz <= n; cz++) {
		const worldZ = originZ + cz * step;
		let worldX = originX - step;

		for (let cx = -1; cx <= n; cx++) {
			heights[writeIndex++] = getFinalTerrainHeight(worldX, worldZ);
			worldX += step;
		}
	}

	// Precompute the maximum of each cell's four corners once. The terrain
	// loop, neighbor skirts, and tree sampling can then use direct reads.
	let cellIndex = 0;

	for (let cz = 0; cz < cellsPerAxis; cz++) {
		let topLeftIndex = (cz + 1) * padded + 1;

		for (let cx = 0; cx < cellsPerAxis; cx++, topLeftIndex++) {
			const h00 = heights[topLeftIndex];
			const h10 = heights[topLeftIndex + 1];
			const h01 = heights[topLeftIndex + padded];
			const h11 = heights[topLeftIndex + padded + 1];

			const topMax = h00 > h10 ? h00 : h10;
			const bottomMax = h01 > h11 ? h01 : h11;

			cellMax[cellIndex++] = topMax > bottomMax ? topMax : bottomMax;
		}
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
 * This preserves the original round-and-clamp behavior used by tree stamping.
 */
function sampleLatticeHeight(
	lattice: HeightLattice,
	localX: number,
	localZ: number,
): number {
	const maxSample = lattice.n - 1;

	let gx = Math.round(localX / lattice.step);
	let gz = Math.round(localZ / lattice.step);

	if (gx < 0) gx = 0;
	else if (gx > maxSample) gx = maxSample;

	if (gz < 0) gz = 0;
	else if (gz > maxSample) gz = maxSample;

	return lattice.heights[(gz + 1) * lattice.padded + gx + 1];
}

export function generateFarTile(
	request: FarTileGenerateRequest,
): FarTileResult {
	const levels = getFarTileLevels();
	const level: FarTileLevelDef | undefined = levels[request.levelIndex];

	const opaque = new FaceWriter();
	const water = new FaceWriter();

	if (level === undefined) {
		return {
			requestId: request.requestId,
			levelIndex: request.levelIndex,
			tileX: request.tileX,
			tileZ: request.tileZ,
			opaqueFaces: opaque.toUint32Array(),
			waterFaces: water.toUint32Array(),
		};
	}

	const sizeBlocks = level.tileSizeChunks * 32;
	const originX = request.tileX * sizeBlocks;
	const originZ = request.tileZ * sizeBlocks;
	const step = level.voxelStep;
	const halfStep = step * 0.5;
	const seaLevel = GenerationParams.SEA_LEVEL;

	const lattice = buildHeightLattice(originX, originZ, sizeBlocks, step);

	const cellsPerAxis = lattice.n - 1;
	const padded = lattice.padded;
	const heights = lattice.heights;
	const cellMaxima = lattice.cellMax;

	const lastCell = cellsPerAxis - 1;

	let cellIndex = 0;

	for (let cz = 0, z0 = 0; cz < cellsPerAxis; cz++, z0 += step) {
		/*
		 * Sample (0, cz) in the padded height lattice. The interior lattice
		 * begins at padded coordinate (1, 1).
		 */
		let sampleIndex = (cz + 1) * padded + 1;

		for (
			let cx = 0, x0 = 0;
			cx < cellsPerAxis;
			cx++, x0 += step, sampleIndex++, cellIndex++
		) {
			const cellMax = cellMaxima[cellIndex];

			if (cellMax < seaLevel) {
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

			const topBlockId = biome.topBlock;

			let tileX = 14;
			let tileY = 0;

			if (topBlockId >= 0) {
				const textureIndex = topBlockId * FaceName.Count + FaceName.Top;

				if (textureIndex < BlockFaceTileX.length) {
					tileX = BlockFaceTileX[textureIndex];
					tileY = BlockFaceTileY[textureIndex];
				}
			}

			opaque.emit(
				x0,
				cellMax,
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
			 * Interior neighbor maxima have already been calculated by
			 * buildHeightLattice(). Only tile-boundary neighbors require
			 * reading four corners from the padded height lattice.
			 */

			let negativeZMax: number;

			if (cz > 0) {
				negativeZMax = cellMaxima[cellIndex - cellsPerAxis];
			} else {
				const rowAbove = sampleIndex - padded;

				const h00 = heights[rowAbove];
				const h10 = heights[rowAbove + 1];
				const h01 = heights[sampleIndex];
				const h11 = heights[sampleIndex + 1];

				const upperMax = h00 > h10 ? h00 : h10;
				const lowerMax = h01 > h11 ? h01 : h11;

				negativeZMax = upperMax > lowerMax ? upperMax : lowerMax;
			}

			if (negativeZMax < cellMax) {
				opaque.emit(
					x0,
					negativeZMax,
					z0,
					step,
					cellMax - negativeZMax,
					2,
					1,
					tileX,
					tileY,
					LIGHT_SIDE,
					KIND_OPAQUE,
				);
			}

			let positiveZMax: number;

			if (cz < lastCell) {
				positiveZMax = cellMaxima[cellIndex + cellsPerAxis];
			} else {
				const neighborTopLeft = sampleIndex + padded;

				const h00 = heights[neighborTopLeft];
				const h10 = heights[neighborTopLeft + 1];
				const h01 = heights[neighborTopLeft + padded];
				const h11 = heights[neighborTopLeft + padded + 1];

				const upperMax = h00 > h10 ? h00 : h10;
				const lowerMax = h01 > h11 ? h01 : h11;

				positiveZMax = upperMax > lowerMax ? upperMax : lowerMax;
			}

			if (positiveZMax < cellMax) {
				opaque.emit(
					x0,
					positiveZMax,
					z0 + step,
					step,
					cellMax - positiveZMax,
					2,
					0,
					tileX,
					tileY,
					LIGHT_SIDE,
					KIND_OPAQUE,
				);
			}

			let negativeXMax: number;

			if (cx > 0) {
				negativeXMax = cellMaxima[cellIndex - 1];
			} else {
				const neighborTopLeft = sampleIndex - 1;

				const h00 = heights[neighborTopLeft];
				const h10 = heights[neighborTopLeft + 1];
				const h01 = heights[neighborTopLeft + padded];
				const h11 = heights[neighborTopLeft + padded + 1];

				const upperMax = h00 > h10 ? h00 : h10;
				const lowerMax = h01 > h11 ? h01 : h11;

				negativeXMax = upperMax > lowerMax ? upperMax : lowerMax;
			}

			if (negativeXMax < cellMax) {
				opaque.emit(
					x0,
					negativeXMax,
					z0,
					cellMax - negativeXMax,
					step,
					0,
					1,
					tileX,
					tileY,
					LIGHT_SIDE,
					KIND_OPAQUE,
				);
			}

			let positiveXMax: number;

			if (cx < lastCell) {
				positiveXMax = cellMaxima[cellIndex + 1];
			} else {
				const neighborTopLeft = sampleIndex + 1;

				const h00 = heights[neighborTopLeft];
				const h10 = heights[neighborTopLeft + 1];
				const h01 = heights[neighborTopLeft + padded];
				const h11 = heights[neighborTopLeft + padded + 1];

				const upperMax = h00 > h10 ? h00 : h10;
				const lowerMax = h01 > h11 ? h01 : h11;

				positiveXMax = upperMax > lowerMax ? upperMax : lowerMax;
			}

			if (positiveXMax < cellMax) {
				opaque.emit(
					x0 + step,
					positiveXMax,
					z0,
					cellMax - positiveXMax,
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
 * Stamp simplified trees at the same world positions used by normal terrain
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

	for (let lz = 0, wz = originZ; lz < sizeBlocks; lz += stride, wz += stride) {
		for (
			let lx = 0, wx = originX;
			lx < sizeBlocks;
			lx += stride, wx += stride
		) {
			const noiseValue = SurfaceGenerator.getTreeNoiseValue(wx, wz);

			const biome = getBiome(wx, wz);

			if (!biome.canSpawnTrees || noiseValue >= biome.treeDensity) {
				continue;
			}

			const surfaceY = Math.floor(sampleLatticeHeight(lattice, lx, lz));

			if (surfaceY < seaLevel) {
				continue;
			}

			const tree = biome.getTreeForBlock(biome.topBlock, noiseValue);

			if (tree === null || tree === undefined) {
				continue;
			}

			const hash = (Math.imul(wx, 374761393) ^ Math.imul(wz, 678446653)) >>> 0;

			const rawVariance = tree.heightVariance ?? 0;
			const variance = rawVariance > 0 ? rawVariance : 0;

			const trunkHeight =
				(tree.baseHeight ?? 5) + (variance > 0 ? hash % (variance + 1) : 0);

			const woodTile = tilesForBlock(tree.woodId);
			const leafTile = tilesForBlock(tree.leavesId);

			if (woodTile === null && leafTile === null) {
				continue;
			}

			const baseY = surfaceY + 1;

			if (woodTile !== null) {
				const woodTileX = woodTile[0];
				const woodTileY = woodTile[1];

				out.emit(
					lx,
					baseY,
					lz + 1,
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
					lx,
					baseY,
					lz,
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
					lx + 1,
					baseY,
					lz,
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
					lx,
					baseY,
					lz,
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

			if (leafTile === null) {
				continue;
			}

			let radius = stride >> 2;

			if (radius < 2) radius = 2;
			else if (radius > 8) radius = 8;

			const canopyBase = baseY + (trunkHeight > 3 ? trunkHeight - 3 : 1);

			const canopySize = radius * 2 + 1;
			const maximumAnchor = sizeBlocks - canopySize;

			let canopyX = lx - radius;
			let canopyZ = lz - radius;

			if (canopyX < 0) canopyX = 0;
			else if (canopyX > maximumAnchor) {
				canopyX = maximumAnchor;
			}

			if (canopyZ < 0) canopyZ = 0;
			else if (canopyZ > maximumAnchor) {
				canopyZ = maximumAnchor;
			}

			const leafTileX = leafTile[0];
			const leafTileY = leafTile[1];

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
