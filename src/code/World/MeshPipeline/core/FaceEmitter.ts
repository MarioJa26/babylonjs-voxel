// MeshPipeline/core/FaceEmitter.ts

import { POS_SCALE } from "../../Chunk/Worker/ChunkMesherConstants";
import { BlockFaceTileX, BlockFaceTileY } from "../../Texture/BlockTextures";
import { FaceName } from "../../Texture/FaceName";
import type { WorkerInternalMeshData } from "../types/MeshTypes";
import { BlockTint } from "./ShapePipeline";

const WATER_FRAC_SCALE = [8, 7, 6, 5, 4, 3, 2, 1];
const WATER_TOP_OFFSET_SCALE = [0, -1, -2, -3, -4, -5, -6, -7];
const WATER_ABOVE_MASK = 0x10000;
const WATER_LEVEL_PAIR_MASK = 0x20000; // bit 17 — indicates water level pair is set

/**
 * General-purpose quad emitter — no water logic.
 * Used for all non-water faces (opaque, cutout, custom shapes).
 */
export function emitQuadFast(
	out: WorkerInternalMeshData,
	x: number,
	y: number,
	z: number,
	axis: number,
	width: number,
	height: number,
	blockId: number,
	backFace: number,
	light: number,
	ao: number,
	faceName: FaceName,
	materialType: number,
	flip: number,
	diagonal: number,
	rawDim: number,
): void {
	const tileIdx = blockId * FaceName.Count + faceName;
	const tx = BlockFaceTileX[tileIdx];
	const ty = BlockFaceTileY[tileIdx];

	const axisFace = axis * 2 + backFace;

	const diagEnabled = diagonal !== 0 ? 1 : 0;
	const diagVariant = diagonal === 2 ? 1 : 0;

	const posOffX = (x * POS_SCALE) % 1 !== 0 ? 1 : 0;
	const posOffZ = (z * POS_SCALE) % 1 !== 0 ? 1 : 0;

	const meta =
		(flip ? 1 : 0) |
		((materialType & 0x3) << 1) |
		(posOffX << 3) |
		(diagEnabled << 4) |
		(diagVariant << 5) |
		(rawDim ? 64 : 0) |
		(posOffZ << 7);

	const tint = BlockTint[blockId];

	const sx = (x * POS_SCALE + 0.5) | 0;
	const sy = (y * POS_SCALE + 0.5) | 0;
	const sz = (z * POS_SCALE + 0.5) | 0;

	if (sx < 0 || sy < 0 || sz < 0 || sx >= 256 || sy >= 256 || sz >= 256) return;

	const sw = rawDim ? width : width * POS_SCALE;
	const sh = rawDim ? height : height * POS_SCALE;

	const i = out.faceCount << 2;
	const next = i + 4;

	const a = out.faceDataA.backingArray;
	const b = out.faceDataB.backingArray;
	const c = out.faceDataC.backingArray;
	a[i] = sx;
	a[i + 1] = sy;
	a[i + 2] = sz;
	a[i + 3] = axisFace;
	b[i] = sw;
	b[i + 1] = sh;
	b[i + 2] = tx;
	b[i + 3] = ty;
	c[i] = ao;
	c[i + 1] = light;
	c[i + 2] = tint;
	c[i + 3] = meta;
	out.faceDataA.length = next;
	out.faceDataB.length = next;
	out.faceDataC.length = next;
	out.faceCount++;
}

/**
 * Water-only quad emitter.
 * Handles water-level scaling, rawDim override for large faces,
 * and waterLevelBase Y-offset — all water concerns in one place.
 */
export function emitWaterQuad(
	out: WorkerInternalMeshData,
	x: number,
	y: number,
	z: number,
	axis: number,
	width: number,
	height: number,
	blockId: number,
	backFace: number,
	light: number,
	ao: number,
	faceName: FaceName,
	materialType: number,
	packedBlock: number,
): void {
	const tileIdx = blockId * FaceName.Count + faceName;
	const tx = BlockFaceTileX[tileIdx];
	const ty = BlockFaceTileY[tileIdx];

	const axisFace = axis * 2 + backFace;

	// Check if this is a water-to-water level pair interface
	const hasLevelPair = (packedBlock & WATER_LEVEL_PAIR_MASK) !== 0;
	// neighborLevel is the TALLER column (higher level number, smaller frac) and
	// is stored in bits 10-12 (3 bits, 0-7). Must mask with 0x7, NOT 0xf: bit 13
	// belongs to shallowerLevel (<< 13) and would otherwise corrupt this read.
	const neighborLevel = (packedBlock >> 10) & 0x7; // taller side, only valid if hasLevelPair
	const ownLevel = hasLevelPair
		? (packedBlock >> 13) & 0x7
		: (packedBlock >> 10) & 0xf; // normal single-level case

	const waterAbove = (packedBlock & WATER_ABOVE_MASK) !== 0;
	const rawDim = width > 31 || height > 31 ? 1 : 0;

	const meta = ((materialType & 0x3) << 1) | (1 << 3) | (rawDim ? 64 : 0);

	const tint = BlockTint[blockId];

	const sx = (x * POS_SCALE + 0.5) | 0;
	let sy = (y * POS_SCALE + 0.5) | 0;
	const sz = (z * POS_SCALE + 0.5) | 0;

	let sw: number;
	let sh: number;

	if (axis === 1) {
		if (ownLevel > 0) sy += WATER_TOP_OFFSET_SCALE[ownLevel];
		sw = rawDim ? width : width * POS_SCALE;
		sh = rawDim ? height : height * POS_SCALE;
	} else {
		// For a level-pair face the sliver is strictly bounded by the two
		// column tops, so topScale is ALWAYS the shallower column's top.
		// waterAbove (meant for single-level columns) must NOT force POS_SCALE
		// here, or the sliver overdraws up to the full block top.
		const topScale = hasLevelPair
			? WATER_FRAC_SCALE[ownLevel]
			: waterAbove
				? POS_SCALE
				: WATER_FRAC_SCALE[ownLevel];
		const baseScale = hasLevelPair ? WATER_FRAC_SCALE[neighborLevel] : 0;
		const spanScale = topScale - baseScale;

		sy += baseScale;

		if (axis === 0) {
			sw = rawDim ? width : width * spanScale;
			sh = rawDim ? height : height * POS_SCALE;
		} else {
			sw = rawDim ? width : width * POS_SCALE;
			sh = rawDim ? height : height * spanScale;
		}
	}

	//	if (sx < 0 || sy < 0 || sz < 0 || sx >= 256 || sy >= 256 || sz >= 256) return;

	const i = out.faceCount << 2;
	const next = i + 4;

	const a = out.faceDataA.backingArray;
	const b = out.faceDataB.backingArray;
	const c = out.faceDataC.backingArray;
	a[i] = sx;
	a[i + 1] = sy;
	a[i + 2] = sz;
	a[i + 3] = axisFace;
	b[i] = sw;
	b[i + 1] = sh;
	b[i + 2] = tx;
	b[i + 3] = ty;
	c[i] = ao;
	c[i + 1] = light;
	c[i + 2] = tint;
	c[i + 3] = meta;
	out.faceDataA.length = next;
	out.faceDataB.length = next;
	out.faceDataC.length = next;
	out.faceCount++;
}
