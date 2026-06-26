// MeshPipeline/core/FaceEmitter.ts

import { POS_SCALE } from "../../Chunk/Worker/ChunkMesherConstants";
import { BlockTextures } from "../../Texture/BlockTextures";
import { FaceName } from "../../Texture/FaceName";
import {
	type EmitQuadParams,
	MaterialType,
	type WorkerInternalMeshData,
} from "../types/MeshTypes";
import { getMaterialTintBucket } from "./ShapePipeline";

export function emitQuad(
	out: WorkerInternalMeshData,
	params: EmitQuadParams,
): void {
	const {
		x,
		y,
		z,
		axis,
		width,
		height,
		blockId,
		isBackFace,
		light,
		ao,
		faceName,
		materialType,
		flip,
		diagonal = 0,
		rawDim = false,
	} = params;

	const tex = BlockTextures[blockId];
	if (!tex) return;
	const tile = tex[faceName] ?? tex[FaceName.All]!;

	const tx = tile[0];
	const ty = tile[1];

	const axisFace = axis * 2 + (isBackFace ? 1 : 0);

	const isWater =
		materialType === MaterialType.WaterOrGlass && blockId === 30 ? 1 : 0;

	const diagEnabled = diagonal !== 0 ? 1 : 0;
	const diagVariant = diagonal === 2 ? 1 : 0;

	const meta =
		(flip ? 1 : 0) |
		((materialType & 0x3) << 1) |
		(isWater << 3) |
		(diagEnabled << 4) |
		(diagVariant << 5) |
		(rawDim ? 64 : 0);

	const tint = getMaterialTintBucket(blockId);

	// PERF: Use bitwise rounding (faster than Math.round) for integer conversion.
	// Positions are non-negative, so (x + 0.5) | 0 is safe and ~2x faster.
	const sx = (x * POS_SCALE + 0.5) | 0;
	const sy = (y * POS_SCALE + 0.5) | 0;
	const sz = (z * POS_SCALE + 0.5) | 0;

	// Faces at chunk boundary (position >= size) overflow Uint8Array.
	// Faces at negative positions also overflow (Uint8Array wraps).
	// These should be rendered by the adjacent chunk.
	if (sx < 0 || sy < 0 || sz < 0 || sx >= 256 || sy >= 256 || sz >= 256) return;

	const sw = rawDim ? (width + 0.5) | 0 : (width * POS_SCALE + 0.5) | 0;
	const sh = rawDim ? (height + 0.5) | 0 : (height * POS_SCALE + 0.5) | 0;

	out.faceDataA.push4(sx, sy, sz, axisFace);
	out.faceDataB.push4(sw, sh, tx, ty);
	out.faceDataC.push4(ao, light, tint, meta);

	out.faceCount++;
}
