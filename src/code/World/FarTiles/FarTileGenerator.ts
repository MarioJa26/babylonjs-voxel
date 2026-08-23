import type { Biome } from "@/code/Generation/Biome/BiomeTypes";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { SurfaceGenerator } from "@/code/Generation/SurfaceGenerator";
import {
	getBiome,
	getFinalTerrainHeight,
} from "@/code/Generation/TerrainHeightMap";
import { BlockTextures } from "../Texture/BlockTextures";
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

function topTileFor(biome: Biome): [number, number] {
	const tex = BlockTextures[biome.topBlock];
	if (!tex) return [14, 0];
	const tile = tex[FaceName.Top] ?? tex[FaceName.All];
	return tile ? [tile[0], tile[1]] : [14, 0];
}

function tilesForBlock(blockId: number): [number, number] | null {
	const tex = BlockTextures[blockId];
	if (!tex) return null;
	const tile = tex[FaceName.All];
	return tile ? [tile[0], tile[1]] : null;
}

interface HeightLattice {
	/** Interior samples per axis (cells + 1). */
	n: number;
	step: number;
	sample(localX: number, localZ: number): number;
	/** Max over the two shared corner heights of cell (cx,cz)'s edge. */
	colPairMax(row: number, col: number): number;
	rowPairMax(row: number, col: number): number;
}

/**
 * Samples heights on a lattice padded by ONE ring (-1..n inclusive) so that
 * neighbor lookups across tile borders resolve to REAL terrain values.
 * Same-level neighbors then produce flush edges (no skirt -> no seam fins),
 * while genuine cliffs and level-ring boundaries still get exact skirts.
 */
let _latticeBuffer = new Float64Array(1024);
function buildHeightLattice(
	originX: number,
	originZ: number,
	sizeBlocks: number,
	step: number,
): HeightLattice {
	const n = sizeBlocks / step + 1;
	const padded = n + 2;
	const required = padded * padded;

	if (required > _latticeBuffer.length) {
		_latticeBuffer = new Float64Array(required * 2);
	}
	const heights = _latticeBuffer;

	for (let cz = -1; cz <= n; cz++) {
		const wz = originZ + cz * step;
		for (let cx = -1; cx <= n; cx++) {
			heights[(cz + 1) * padded + (cx + 1)] = getFinalTerrainHeight(
				originX + cx * step,
				wz,
			);
		}
	}

	const at = (cx: number, cz: number): number =>
		heights[(cz + 1) * padded + (cx + 1)];

	return {
		n,
		step,
		sample(localX: number, localZ: number): number {
			const gx = Math.min(n - 1, Math.max(0, Math.round(localX / step)));
			const gz = Math.min(n - 1, Math.max(0, Math.round(localZ / step)));
			return at(gx, gz);
		},
		colPairMax(row: number, col: number): number {
			// Two samples along X at fixed z-row: at(col,row), at(col+1,row)
			return Math.max(at(col, row), at(col + 1, row));
		},
		rowPairMax(row: number, col: number): number {
			// Two samples along Z at fixed x-col: at(col,row), at(col,row+1)
			return Math.max(at(col, row), at(col, row + 1));
		},
	};
}

export function generateFarTile(
	request: FarTileGenerateRequest,
): FarTileResult {
	const levels = getFarTileLevels();
	const level: FarTileLevelDef | undefined = levels[request.levelIndex];

	const opaque = new FaceWriter();
	const water = new FaceWriter();

	if (!level) {
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
	const seaLevel = GenerationParams.SEA_LEVEL;

	const lattice = buildHeightLattice(originX, originZ, sizeBlocks, step);
	const cellsPerAxis = lattice.n - 1;

	// --- Terrain surface cells + cliff skirts -----------------------------
	// The lattice is padded by one sample ring, so edge cells see their REAL
	// across-border neighbor heights: flush edges shared with same-level
	// neighbors emit no skirt at all (no seam fins), while genuine cliffs —
	// including ring boundaries against differently-sampled levels — get
	// exact skirts sized to the true height delta.
	const { colPairMax, rowPairMax } = lattice;

	for (let cz = 0; cz < cellsPerAxis; cz++) {
		for (let cx = 0; cx < cellsPerAxis; cx++) {
			const h00 = lattice.sample(cx * step, cz * step);
			const h10 = lattice.sample((cx + 1) * step, cz * step);
			const h01 = lattice.sample(cx * step, (cz + 1) * step);
			const h11 = lattice.sample((cx + 1) * step, (cz + 1) * step);

			const cellMax = Math.max(h00, h10, h01, h11);
			const x0 = cx * step;
			const z0 = cz * step;

			// Fully submerged cells emit ONLY the water plane: their ground
			// quad and skirts are invisible behind the water surface + fog at
			// these distances, so generating them is pure face/VRAM waste.
			// Land cells keep everything; a land skirt adjacent to a submerged
			// neighbor still spans down to that neighbor's cellMax (its
			// above-water portion is what the shoreline shows).
			const submerged = cellMax < seaLevel;

			if (!submerged) {
				const biome = getBiome(
					originX + x0 + step / 2,
					originZ + z0 + step / 2,
				);
				const [tileX, tileY] = topTileFor(biome);

				// Top surface quad at the highest corner so no neighbor pokes
				// through; skirts cover the exposed sides down to each neighbor.
				// Facing convention: backFace 0 = positive-axis normal.
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

				// -Z skirt (neighbor toward smaller z)
				const nzMax = colPairMax(cz - 1, cx);
				if (nzMax < cellMax) {
					opaque.emit(
						x0,
						nzMax,
						z0,
						step,
						cellMax - nzMax,
						2,
						1,
						tileX,
						tileY,
						LIGHT_SIDE,
						KIND_OPAQUE,
					);
				}

				// +Z skirt
				const pzMax = colPairMax(cz + 2, cx);
				if (pzMax < cellMax) {
					opaque.emit(
						x0,
						pzMax,
						z0 + step,
						step,
						cellMax - pzMax,
						2,
						0,
						tileX,
						tileY,
						LIGHT_SIDE,
						KIND_OPAQUE,
					);
				}

				// -X skirt
				const nxMax = rowPairMax(cz, cx - 1);
				if (nxMax < cellMax) {
					opaque.emit(
						x0,
						nxMax,
						z0,
						cellMax - nxMax,
						step,
						0,
						1,
						tileX,
						tileY,
						LIGHT_SIDE,
						KIND_OPAQUE,
					);
				}

				// +X skirt
				const pxMax = rowPairMax(cz, cx + 2);
				if (pxMax < cellMax) {
					opaque.emit(
						x0 + step,
						pxMax,
						z0,
						cellMax - pxMax,
						step,
						0,
						0,
						tileX,
						tileY,
						LIGHT_SIDE,
						KIND_OPAQUE,
					);
				}
			} else {
				// Ocean/lake surfaces: flat water plane at sea level above the
				// (skipped) submerged ground.
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
 * Stamp simplified trees at the SAME world positions real generation uses:
 * per-column flora noise vs biome density (SurfaceGenerator.getTreeNoiseValue).
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
	// Scale the scan stride with sampling coarseness so coarse levels stay
	// cheap; canopies remain visible because they're stamped as boxes.
	const stride = Math.max(TREE_SCAN_STRIDE, step);

	for (let lz = 0; lz < sizeBlocks; lz += stride) {
		for (let lx = 0; lx < sizeBlocks; lx += stride) {
			const wx = originX + lx;
			const wz = originZ + lz;

			const noiseValue = SurfaceGenerator.getTreeNoiseValue(wx, wz);
			const biome = getBiome(wx, wz);

			if (!biome.canSpawnTrees || noiseValue >= biome.treeDensity) continue;

			const surfaceY = Math.floor(lattice.sample(lx, lz));
			if (surfaceY < seaLevel) continue;

			const tree = biome.getTreeForBlock(biome.topBlock, noiseValue);
			if (!tree) continue;

			// Deterministic height matching the real generators' hash pattern.
			const hash = (Math.imul(wx, 374761393) ^ Math.imul(wz, 678446653)) >>> 0;
			const variance = Math.max(0, tree.heightVariance ?? 0);
			const trunkHeight =
				(tree.baseHeight ?? 5) + (variance > 0 ? hash % (variance + 1) : 0);

			const woodTile = tilesForBlock(tree.woodId);
			const leafTile = tilesForBlock(tree.leavesId);
			if (!woodTile && !leafTile) continue;

			const baseY = surfaceY + 1;

			// Trunk: a two-quad cross so it reads from every direction.
			if (woodTile) {
				out.emit(
					lx,
					baseY,
					lz + 1,
					1,
					trunkHeight,
					2,
					0,
					woodTile[0],
					woodTile[1],
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
					woodTile[0],
					woodTile[1],
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
					woodTile[0],
					woodTile[1],
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
					woodTile[0],
					woodTile[1],
					LIGHT_SIDE,
					KIND_OPAQUE,
				);
			}

			// Canopy: one coarse box around the crown. Radius scales with the
			// scan stride so canopies stay visible from far away. The anchor
			// is clamped into the tile: emit() silently rejects out-of-range
			// coords, and an unclamped anchor (lx - radius < 0 on the first
			// scan row — guaranteed to hit at stride-scaled radii) would drop
			// whole canopies, top face included.
			if (leafTile) {
				const radius = Math.min(8, Math.max(2, stride >> 2));
				const canopyBase = baseY + Math.max(1, trunkHeight - 3);
				const canopySize = radius * 2 + 1;
				const cx = Math.max(0, Math.min(sizeBlocks - canopySize, lx - radius));
				const cz = Math.max(0, Math.min(sizeBlocks - canopySize, lz - radius));

				out.emit(
					cx,
					canopyBase + 4,
					cz,
					canopySize,
					canopySize,
					1,
					0,
					leafTile[0],
					leafTile[1],
					LIGHT_FULL,
					KIND_OPAQUE,
				); // top
				out.emit(
					cx,
					canopyBase,
					cz,
					canopySize,
					4,
					2,
					1,
					leafTile[0],
					leafTile[1],
					LIGHT_SIDE,
					KIND_OPAQUE,
				); // -Z
				out.emit(
					cx,
					canopyBase,
					cz + canopySize,
					canopySize,
					4,
					2,
					0,
					leafTile[0],
					leafTile[1],
					LIGHT_SIDE,
					KIND_OPAQUE,
				); // +Z
				out.emit(
					cx,
					canopyBase,
					cz,
					4,
					canopySize,
					0,
					1,
					leafTile[0],
					leafTile[1],
					LIGHT_SIDE,
					KIND_OPAQUE,
				); // -X
				out.emit(
					cx + canopySize,
					canopyBase,
					cz,
					4,
					canopySize,
					0,
					0,
					leafTile[0],
					leafTile[1],
					LIGHT_SIDE,
					KIND_OPAQUE,
				); // +X
			}
		}
	}
}
