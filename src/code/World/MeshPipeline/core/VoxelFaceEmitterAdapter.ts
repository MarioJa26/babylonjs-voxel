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

const _origin = { ox: 0, oy: 0, oz: 0 };

function inlineOrigin(
	axis: number,
	back: number,
	desc: GreedyFaceDescriptor,
): { ox: number; oy: number; oz: number } {
	const faceBlockCoord = desc.slice + back;
	if (axis === 0) {
		_origin.ox = faceBlockCoord;
		_origin.oy = desc.uStart;
		_origin.oz = desc.vStart;
	} else if (axis === 1) {
		_origin.ox = desc.vStart;
		_origin.oy = faceBlockCoord;
		_origin.oz = desc.uStart;
	} else {
		_origin.ox = desc.uStart;
		_origin.oy = desc.vStart;
		_origin.oz = faceBlockCoord;
	}
	return _origin;
}

type EmitFn = (
	adapter: VoxelFaceEmitterAdapter,
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
) => void;

function emitCubeWrap(
	a: VoxelFaceEmitterAdapter,
	out: WorkerInternalMeshData,
	axis: number,
	desc: GreedyFaceDescriptor,
	_packed: number,
	blockId: number,
	back: number,
	light: number,
	ao: number,
	faceName: FaceName,
	_faceBit: number,
): void {
	a["emitCubeFace"](out, axis, desc, blockId, back, light, ao, faceName);
}

function emitWaterWrap(
	a: VoxelFaceEmitterAdapter,
	out: WorkerInternalMeshData,
	axis: number,
	desc: GreedyFaceDescriptor,
	packedBlock: number,
	blockId: number,
	back: number,
	light: number,
	ao: number,
	faceName: FaceName,
	_faceBit: number,
): void {
	a["emitWaterFace"](
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
}

function emitCustomWrap(
	a: VoxelFaceEmitterAdapter,
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
	a["emitCustomShapeFace"](
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

function emitWaterCustomWrap(
	a: VoxelFaceEmitterAdapter,
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
	a["emitWaterCustomShapeFace"](
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

// Dispatch LUT indexed by (isWater << 1) | isCube:
//   0 = custom shape non-water, 1 = cube non-water, 2 = custom shape water, 3 = cube water
const EMIT_DISPATCH: EmitFn[] = [
	emitCustomWrap,
	emitCubeWrap,
	emitWaterCustomWrap,
	emitWaterWrap,
];

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

		const out =
			materialType === MaterialType.WaterOrGlass ? transparentOut : opaqueOut;

		const ao = desc.light & 0xff;
		const light = (desc.light >> 8) & 0xff;

		const back = isBackFace ? 1 : 0;
		const faceIndex = axis * 2 + back;
		const faceName = FACE_NAME_TABLE[faceIndex];
		const faceBit = FACE_BIT_TABLE[faceIndex];

		const isCube = shapeInfo.isCube && !isNonCube;
		const dispatchKey = (isWater ? 2 : 0) | (isCube ? 1 : 0);
		EMIT_DISPATCH[dispatchKey](
			this,
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
		const { ox, oy, oz } = inlineOrigin(axis, back, desc);

		const off = 1 ^ back;
		const x = axis === 0 ? ox + off : ox;
		const y = axis === 1 ? oy + off : oy;
		const z = axis === 2 ? oz + off : oz;

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
		const { ox, oy, oz } = inlineOrigin(axis, back, desc);

		const off = 1 ^ back;
		const x = axis === 0 ? ox + off : ox;
		const y = axis === 1 ? oy + off : oy;
		const z = axis === 2 ? oz + off : oz;

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

		const { ox, oy, oz } = inlineOrigin(axis, back, desc);
		const rawDim = needsRawDim(blockId, desc.width, desc.height) ? 1 : 0;

		for (let i = 0; i < boxes.length; i++) {
			const box = boxes[i];
			if ((box.faceMask & faceBit) === 0) continue;

			const min = box.min;
			const max = box.max;
			const bc = back ? min[axis] : max[axis];
			const x = ox + (axis === 0 ? bc : min[0]);
			const y = oy + (axis === 1 ? bc : min[1]);
			const z = oz + (axis === 2 ? bc : min[2]);
			const u = (axis + 1) % 3;
			const v = (axis + 2) % 3;
			const width = desc.width * (max[u] - min[u]);
			const height = desc.height * (max[v] - min[v]);

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

		const { ox, oy, oz } = inlineOrigin(axis, back, desc);

		for (let i = 0; i < boxes.length; i++) {
			const box = boxes[i];
			if ((box.faceMask & faceBit) === 0) continue;

			const min = box.min;
			const max = box.max;
			const bc = back ? min[axis] : max[axis];
			const x = ox + (axis === 0 ? bc : min[0]);
			const y = oy + (axis === 1 ? bc : min[1]);
			const z = oz + (axis === 2 ? bc : min[2]);
			const u = (axis + 1) % 3;
			const v = (axis + 2) % 3;
			const width = desc.width * (max[u] - min[u]);
			const height = desc.height * (max[v] - min[v]);

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
