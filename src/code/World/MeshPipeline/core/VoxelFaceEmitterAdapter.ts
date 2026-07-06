// World/MeshPipeline/core/VoxelFaceEmitterAdapter.ts

import { unpackBlockId } from "../../Chunk/DataStructures/BlockEncoding";
import { WATER_BLOCK_ID } from "../../Chunk/Worker/ChunkMesherConstants";
import {
	FACE_NX,
	FACE_NY,
	FACE_NZ,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
} from "../../Shape/BlockShapes";
import { type FaceName, getFaceName } from "../../Texture/FaceName";
import {
	type GreedyFaceDescriptor,
	MaterialType,
	type WorkerInternalMeshData,
} from "../types/MeshTypes";
import { emitQuadFast, emitWaterQuad } from "./FaceEmitter";
import {
	getMaterialType,
	getRuntimeShapeBoxes,
	getShapeInfo,
} from "./ShapePipeline";

const BACK_FACE_MASK = 0x80000000;
const NON_CUBE_MASK = 0x40000000;
const PACKED_ID_STATE_MASK = 0x0000ffff;
// Water-specific flags live ABOVE the id/state region and must survive the
// mask passed to emitWaterQuad (hasLevelPair / waterAbove are read there).
const WATER_ABOVE_MASK = 0x10000;
const WATER_LEVEL_PAIR_MASK = 0x20000;
// Keep id/state (0-15) plus the two water flags (16-17); strip back-face /
// non-cube markers (30-31) which are handled separately.
const PACKED_WATER_MASK =
	PACKED_ID_STATE_MASK | WATER_ABOVE_MASK | WATER_LEVEL_PAIR_MASK;

const FACE_NAME_TABLE: FaceName[] = [
	getFaceName(0, false), // PX
	getFaceName(0, true), // NX
	getFaceName(1, false), // PY
	getFaceName(1, true), // NY
	getFaceName(2, false), // PZ
	getFaceName(2, true), // NZ
];

const FACE_BIT_TABLE = [FACE_PX, FACE_NX, FACE_PY, FACE_NY, FACE_PZ, FACE_NZ];

function needsRawDim(blockId: number, width: number, height: number): boolean {
	return blockId !== WATER_BLOCK_ID || width > 31 || height > 31;
}

function inlineOrigin(
	axis: number,
	isBackFace: boolean,
	desc: GreedyFaceDescriptor,
): { ox: number; oy: number; oz: number } {
	const faceBlockCoord = isBackFace ? desc.slice + 1 : desc.slice;
	if (axis === 0)
		return { ox: faceBlockCoord, oy: desc.uStart, oz: desc.vStart };
	if (axis === 1)
		return { ox: desc.vStart, oy: faceBlockCoord, oz: desc.uStart };
	return { ox: desc.uStart, oy: desc.vStart, oz: faceBlockCoord };
}

export class VoxelFaceEmitterAdapter {
	public emitVoxelFace(
		axis: number,
		desc: GreedyFaceDescriptor,
		opaqueOut: WorkerInternalMeshData,
		transparentOut: WorkerInternalMeshData,
	): void {
		const rawMask = desc.idState | 0;
		const isBackFace = (rawMask & BACK_FACE_MASK) !== 0;
		const isNonCube = (rawMask & NON_CUBE_MASK) !== 0;
		const packedBlock = rawMask & PACKED_WATER_MASK;

		if (!packedBlock) return;

		const blockId = unpackBlockId(packedBlock);
		// getShapeInfo keys its cache on the raw value; pass the id/state-only
		// form so water flags (bits 16-17) don't fragment the cache. The full
		// packedBlock (with water flags) is still forwarded to emitWaterQuad.
		const shapeInfo = getShapeInfo(packedBlock & PACKED_ID_STATE_MASK);
		const materialType = getMaterialType(blockId);
		const isWater =
			materialType === MaterialType.WaterOrGlass && blockId === WATER_BLOCK_ID;

		const out = isWater ? transparentOut : opaqueOut;

		const ao = desc.light & 0xff;
		const light = (desc.light >> 8) & 0xff;

		const back = isBackFace ? 1 : 0;
		const faceIndex = axis * 2 + back;
		const faceName = FACE_NAME_TABLE[faceIndex];
		const faceBit = FACE_BIT_TABLE[faceIndex];

		if (shapeInfo.isCube && !isNonCube) {
			if (isWater) {
				this.emitWaterFace(
					out,
					axis,
					desc,
					blockId,
					packedBlock,
					back,
					light,
					ao,
					faceName,
				);
			} else {
				this.emitCubeFace(out, axis, desc, blockId, back, light, ao, faceName);
			}
			return;
		}

		if (isWater) {
			this.emitWaterCustomShapeFace(
				out,
				axis,
				desc,
				packedBlock,
				blockId,
				back,
				light,
				ao,
				faceName,
				faceBit,
			);
		} else {
			this.emitCustomShapeFace(
				out,
				axis,
				desc,
				packedBlock,
				blockId,
				back,
				light,
				ao,
				faceName,
				faceBit,
			);
		}
	}

	private emitCubeFace(
		out: WorkerInternalMeshData,
		axis: number,
		desc: GreedyFaceDescriptor,
		blockId: number,
		back: number,
		light: number,
		ao: number,
		faceName: FaceName,
	): void {
		const isBackFace = back === 1;
		const { ox, oy, oz } = inlineOrigin(axis, isBackFace, desc);

		const x = axis === 0 ? ox + (isBackFace ? 0 : 1) : ox;
		const y = axis === 1 ? oy + (isBackFace ? 0 : 1) : oy;
		const z = axis === 2 ? oz + (isBackFace ? 0 : 1) : oz;

		emitQuadFast(
			out,
			x,
			y,
			z,
			axis,
			desc.width,
			desc.height,
			blockId,
			back,
			light,
			ao,
			faceName,
			MaterialType.Default,
			0,
			0,
			needsRawDim(blockId, desc.width, desc.height) ? 1 : 0,
		);
	}

	private emitWaterFace(
		out: WorkerInternalMeshData,
		axis: number,
		desc: GreedyFaceDescriptor,
		blockId: number,
		packedBlock: number,
		back: number,
		light: number,
		ao: number,
		faceName: FaceName,
	): void {
		const isBackFace = back === 1;
		const { ox, oy, oz } = inlineOrigin(axis, isBackFace, desc);

		const x = axis === 0 ? ox + (isBackFace ? 0 : 1) : ox;
		const y = axis === 1 ? oy + (isBackFace ? 0 : 1) : oy;
		const z = axis === 2 ? oz + (isBackFace ? 0 : 1) : oz;

		emitWaterQuad(
			out,
			x,
			y,
			z,
			axis,
			desc.width,
			desc.height,
			blockId,
			back,
			light,
			ao,
			faceName,
			MaterialType.WaterOrGlass,
			packedBlock,
		);
	}

	private emitCustomShapeFace(
		out: WorkerInternalMeshData,
		axis: number,
		desc: GreedyFaceDescriptor,
		packedBlock: number,
		blockId: number,
		back: number,
		light: number,
		ao: number,
		faceName: FaceName,
		faceBit: number,
	): void {
		const boxes = getRuntimeShapeBoxes(packedBlock);
		if (boxes.length === 0) return;

		const isBackFace = back === 1;
		const { ox, oy, oz } = inlineOrigin(axis, isBackFace, desc);
		const rawDim = needsRawDim(blockId, desc.width, desc.height) ? 1 : 0;

		for (let i = 0; i < boxes.length; i++) {
			const box = boxes[i];
			if ((box.faceMask & faceBit) === 0) continue;

			const min = box.min;
			const max = box.max;
			let x: number;
			let y: number;
			let z: number;
			let width: number;
			let height: number;
			if (axis === 0) {
				x = ox + (isBackFace ? min[0] : max[0]);
				y = oy + min[1];
				z = oz + min[2];
				width = desc.width * (max[1] - min[1]);
				height = desc.height * (max[2] - min[2]);
			} else if (axis === 1) {
				x = ox + min[0];
				y = oy + (isBackFace ? min[1] : max[1]);
				z = oz + min[2];
				width = desc.width * (max[2] - min[2]);
				height = desc.height * (max[0] - min[0]);
			} else {
				x = ox + min[0];
				y = oy + min[1];
				z = oz + (isBackFace ? min[2] : max[2]);
				width = desc.width * (max[0] - min[0]);
				height = desc.height * (max[1] - min[1]);
			}

			emitQuadFast(
				out,
				x,
				y,
				z,
				axis,
				width,
				height,
				blockId,
				back,
				light,
				ao,
				faceName,
				MaterialType.Default,
				0,
				0,
				rawDim,
			);
		}
	}

	private emitWaterCustomShapeFace(
		out: WorkerInternalMeshData,
		axis: number,
		desc: GreedyFaceDescriptor,
		packedBlock: number,
		blockId: number,
		back: number,
		light: number,
		ao: number,
		faceName: FaceName,
		faceBit: number,
	): void {
		const boxes = getRuntimeShapeBoxes(packedBlock);
		if (boxes.length === 0) return;

		const isBackFace = back === 1;
		const { ox, oy, oz } = inlineOrigin(axis, isBackFace, desc);

		for (let i = 0; i < boxes.length; i++) {
			const box = boxes[i];
			if ((box.faceMask & faceBit) === 0) continue;

			const min = box.min;
			const max = box.max;
			let x: number;
			let y: number;
			let z: number;
			let width: number;
			let height: number;
			if (axis === 0) {
				x = ox + (isBackFace ? min[0] : max[0]);
				y = oy + min[1];
				z = oz + min[2];
				width = desc.width * (max[1] - min[1]);
				height = desc.height * (max[2] - min[2]);
			} else if (axis === 1) {
				x = ox + min[0];
				y = oy + (isBackFace ? min[1] : max[1]);
				z = oz + min[2];
				width = desc.width * (max[2] - min[2]);
				height = desc.height * (max[0] - min[0]);
			} else {
				x = ox + min[0];
				y = oy + min[1];
				z = oz + (isBackFace ? min[2] : max[2]);
				width = desc.width * (max[0] - min[0]);
				height = desc.height * (max[1] - min[1]);
			}

			emitWaterQuad(
				out,
				x,
				y,
				z,
				axis,
				width,
				height,
				blockId,
				back,
				light,
				ao,
				faceName,
				MaterialType.WaterOrGlass,
				packedBlock,
			);
		}
	}
}
