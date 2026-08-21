import {
	getBiome,
	getFinalTerrainHeight,
} from "@/code/Generation/TerrainHeightMap";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { SurfaceGenerator } from "@/code/Generation/SurfaceGenerator";
import type { Biome } from "@/code/Generation/Biome/BiomeTypes";
import { BlockTextures } from "../Texture/BlockTextures";
import { FaceName } from "../Texture/FaceName";
import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
import type { FarTileLevelDef } from "./FarTileLadder";
import { getFarTileLevels } from "./FarTileLadder";

/**
 * Worker-side far-tile mesh generator.
 *
 * Produces decimated voxel-style geometry for one far LOD tile directly from
 * the terrain height/biome functions — full-resolution voxel arrays are never
 * materialized. Output is a compact 16-byte-per-face format expanded into
 * vertex buffers on the main thread (see FarTileManager).
 *
 * Face encoding (4 x u32):
 *   w0: x:u10 | (y+Y_BIAS):u12 | z:u10          tile-local block coords
 *   w1: w:u10 | h:u10 | axis:u2 | backFace:u1   quad size in blocks
 *   w2: tileX:u8 | tileY:u8 | light:u8 | kind:u8  atlas tile + light + material
 *       kind: 0 = opaque, 1 = water
 */

const Y_OFFSET = -SETTING_PARAMS.MIN_CHUNK_Y * 32;
const Y_BIAS_SHIFT = 12;

const KIND_OPAQUE = 0;
const KIND_WATER = 1;

const LIGHT_FULL = 0xf0;
const LIGHT_SIDE = 0xc0;

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
	public faces: number[] = [];

	private axisFace(axis: number, backFace: number): number {
		return ((axis << 1) | backFace) & 0x3;
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
		const yBiased = y + Y_OFFSET;

		if (
			x < 0 ||
			z < 0 ||
			yBiased < 0 ||
			x > 1023 ||
			z > 1023 ||
			yBiased > 4095 ||
			w > 1023 ||
			h > 1023
		) {
			return;
		}

		this.faces.push(
			x | (yBiased << 10) | (z << 22),
			w | (h << 10) | (this.axisFace(axis, backFace) << 20),
			(tileX & 0xff) | ((tileY & 0xff) << 8) | ((light & 0xff) << 16),
			kind & 0xff,
		);
	}

	public toUint32Array(): Uint32Array {
		return new Uint32Array(this.faces);
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
	n: number;
	step: number;
	heights: Float64Array;
	sample(localX: number, localZ: number): number;
}

function buildHeightLattice(
	originX: number,
	originZ: number,
	sizeBlocks: number,
	step: number,
): HeightLattice {
	const n = sizeBlocks / step + 1;
	const heights = new Float64Array(n * n);

	for (let cz = 0; cz < n; cz++) {
		const wz = originZ + cz * step;
		for (let cx = 0; cx < n; cx++) {
			heights[cz * n + cx] = getFinalTerrainHeight(originX + cx * step, wz);
		}
	}

	return {
		n,
		step,
		heights,
		sample(localX: number, localZ: number): number {
			const gx = Math.min(n - 1, Math.round(localX / step));
			const gz = Math.min(n - 1, Math.round(localZ / step));
			return heights[gz * n + gx];
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
	for (let cz = 0; cz < cellsPerAxis; cz++) {
		for (let cx = 0; cx < cellsPerAxis; cx++) {
			const h00 = lattice.heights[cz * lattice.n + cx];
			const h10 = lattice.heights[cz * lattice.n + cx + 1];
			const h01 = lattice.heights[(cz + 1) * lattice.n + cx];
			const h11 = lattice.heights[(cz + 1) * lattice.n + cx + 1];

			const cellMax = Math.max(h00, h10, h01, h11);
			const x0 = cx * step;
			const z0 = cz * step;

			const biome = getBiome(originX + x0 + step / 2, originZ + z0 + step / 2);
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
			const nzMax =
				cz > 0
					? Math.max(
							lattice.heights[(cz - 1) * lattice.n + cx],
							lattice.heights[(cz - 1) * lattice.n + cx + 1],
						)
					: cellMax;
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
			const pzMax =
				cz < cellsPerAxis - 1
					? Math.max(
							lattice.heights[(cz + 2) * lattice.n + cx],
							lattice.heights[(cz + 2) * lattice.n + cx + 1],
						)
					: cellMax;
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
			const nxMax =
				cx > 0
					? Math.max(
							lattice.heights[cz * lattice.n + cx - 1],
							lattice.heights[(cz + 1) * lattice.n + cx - 1],
						)
					: cellMax;
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
			const pxMax =
				cx < cellsPerAxis - 1
					? Math.max(
							lattice.heights[cz * lattice.n + cx + 2],
							lattice.heights[(cz + 1) * lattice.n + cx + 2],
						)
					: cellMax;
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

			// Ocean/lake surfaces: flat water plane at sea level above submerged
			// ground.
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
	_step: number,
	seaLevel: number,
): void {
	const stride = TREE_SCAN_STRIDE;
	const seedAsInt = SurfaceGenerator.getSeedAsInt();

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

			// Canopy: one coarse box around the crown. Radius scales with
			// sampling coarseness so canopies stay visible from far away.
			if (leafTile) {
				const radius = 2;
				const canopyBase = baseY + Math.max(1, trunkHeight - 3);
				const canopySize = radius * 2 + 1;
				const cx = lx - radius;
				const cz = lz - radius;

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

/** Decode helper shared with the manager (kept in sync with emit()). */
export function decodeFarTileFace(
	faces: Uint32Array,
	faceIndex: number,
): {
	x: number;
	y: number;
	z: number;
	w: number;
	h: number;
	axis: number;
	backFace: number;
	tileX: number;
	tileY: number;
	light: number;
	kind: number;
} {
	const i = faceIndex * 4;
	const w0 = faces[i];
	const w1 = faces[i + 1];
	const w2 = faces[i + 2];

	return {
		x: w0 & 0x3ff,
		y: ((w0 >>> 10) & 0xfff) - Y_OFFSET,
		z: (w0 >>> 22) & 0x3ff,
		w: w1 & 0x3ff,
		h: (w1 >>> 10) & 0x3ff,
		axis: (w1 >>> 20) & 0x3,
		backFace: (w1 >>> 22) & 0x1,
		tileX: w2 & 0xff,
		tileY: (w2 >>> 8) & 0xff,
		light: (w2 >>> 16) & 0xff,
		kind: faces[i + 3] & 0xff,
	};
}

export function faceCountOf(faces: Uint32Array): number {
	return faces.length >> 2;
}
