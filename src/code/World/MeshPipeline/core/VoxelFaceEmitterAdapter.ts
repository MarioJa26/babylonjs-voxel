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
import { type GreedyFaceDescriptor, MaterialType } from "../types/MeshTypes";
import { getMaterialType, getRuntimeShapeBoxes } from "./BlockInfoCache";
import type { QuadBuffer } from "./QuadBuffer";
import type { MeshBuildSession } from "./WorkerMeshHelpers";

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

/**
 * P2.5: All four emit paths share one signature so they can be dispatched
 * through a per-instance array of bound method references. The previous
 * version routed through module-level wrappers that called
 * `a["emitCubeFace"](...)` — string-keyed property dispatch that defeats V8
 * inlining. Binding once in the constructor gives direct method calls with
 * none of the per-call megamorphic overhead.
 */
type EmitFn = (
	out: QuadBuffer,
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

type SplitTransparentSession = MeshBuildSession & {
	/**
	 * Optional GPU-optimized buckets.
	 *
	 * If these do not exist yet, this adapter falls back to quadTransparent,
	 * preserving current behavior.
	 */
	quadWater?: QuadBuffer;
	quadCutout?: QuadBuffer;
};

export class VoxelFaceEmitterAdapter {
	private readonly _session: SplitTransparentSession;

	// Dispatch LUT indexed by (isWater << 1) | isCube:
	//   0 = custom shape non-water, 1 = cube non-water,
	//   2 = custom shape water, 3 = cube water
	private readonly _dispatch: readonly EmitFn[];

	constructor(session: MeshBuildSession) {
		this._session = session as SplitTransparentSession;
		this._dispatch = [
			this.emitCustomShapeFace.bind(this),
			this.emitCubeFace.bind(this),
			this.emitWaterCustomShapeFace.bind(this),
			this.emitWaterFace.bind(this),
		];
	}

	public emitVoxelFace(axis: number, desc: GreedyFaceDescriptor): void {
		const rawMask = desc.idState | 0;
		const packedBlock = rawMask & PACKED_WATER_MASK;

		if (!packedBlock) return;

		const blockId = unpackBlockId(packedBlock);
		// PERF: NON_CUBE_MASK is set by the mask extractor exactly when the
		// block's shape is non-cube (it compares against getShapeInfo().isCube
		// itself), so the per-face getShapeInfo cache probe is redundant —
		// isCube is simply !isNonCube.
		const materialType = getMaterialType(blockId);

		const isTransparentMaterial = materialType === MaterialType.WaterOrGlass;
		const isWater = isTransparentMaterial && blockId === WATER_BLOCK_ID;

		const session = this._session;

		// GPU-important split:
		// - true water goes to quadWater if available
		// - other transparent/cutout/glass goes to quadCutout if available
		// - old path falls back to quadTransparent
		const out = isTransparentMaterial
			? isWater
				? (session.quadWater ?? session.quadTransparent)
				: (session.quadCutout ?? session.quadTransparent)
			: session.quadOpaque;

		const ao = desc.light & 0xff;
		const light = (desc.light >> 8) & 0xff;

		const back = (rawMask >>> 31) & 1;
		const faceIndex = (axis << 1) | back;
		const faceName = FACE_NAME_TABLE[faceIndex];
		const faceBit = FACE_BIT_TABLE[faceIndex];

		const isNonCube = (rawMask & NON_CUBE_MASK) !== 0;
		const isCube = !isNonCube;
		const dispatchKey = (isWater ? 2 : 0) | (isCube ? 1 : 0);
		this._dispatch[dispatchKey](
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
		out: QuadBuffer,
		axis: number,
		desc: GreedyFaceDescriptor,
		_packedBlock: number,
		blockId: number,
		back: number,
		light: number,
		ao: number,
		faceName: FaceName,
		_faceBit: number,
	): void {
		inlineOrigin(axis, back, desc);

		const off = 1 ^ back;
		const x = axis === 0 ? _origin.ox + off : _origin.ox;
		const y = axis === 1 ? _origin.oy + off : _origin.oy;
		const z = axis === 2 ? _origin.oz + off : _origin.oz;
		// P3.8: unchecked emit — greedy cube faces sit at positions 0..size-1,
		// so the scaled coordinates can never leave the u8 range.
		out.emitQuadUnchecked(
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
		out: QuadBuffer,
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
		inlineOrigin(axis, back, desc);

		const off = 1 ^ back;
		const x = axis === 0 ? _origin.ox + off : _origin.ox;
		const y = axis === 1 ? _origin.oy + off : _origin.oy;
		const z = axis === 2 ? _origin.oz + off : _origin.oz;
		out.emitWaterQuad(
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
		out: QuadBuffer,
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
		const boxes = getRuntimeShapeBoxes(packedBlock & PACKED_ID_STATE_MASK);
		if (boxes.length === 0) return;

		inlineOrigin(axis, back, desc);

		const rawDim = needsRawDim(blockId, desc.width, desc.height) ? 1 : 0;
		const u = (axis + 1) % 3;
		const v = (axis + 2) % 3;
		const originX = _origin.ox;
		const originY = _origin.oy;
		const originZ = _origin.oz;
		const descWidth = desc.width;
		const descHeight = desc.height;

		for (let i = 0; i < boxes.length; i++) {
			const box = boxes[i];

			if ((box.faceMask & faceBit) === 0) continue;

			const min = box.min;
			const max = box.max;
			const bc = back ? min[axis] : max[axis];

			const x = originX + (axis === 0 ? bc : min[0]);
			const y = originY + (axis === 1 ? bc : min[1]);
			const z = originZ + (axis === 2 ? bc : min[2]);

			out.emitQuad(
				x,
				y,
				z,
				axis,
				descWidth * (max[u] - min[u]),
				descHeight * (max[v] - min[v]),
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
		out: QuadBuffer,
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
		// getRuntimeShapeBoxes keys its cache on the id/state-only form —
		// water flags (bits 16-17) would fall off the dense cache into the
		// overflow Map for every custom water face. The full packedBlock is
		// still forwarded to emitWaterQuad.
		const boxes = getRuntimeShapeBoxes(packedBlock & PACKED_ID_STATE_MASK);
		if (boxes.length === 0) return;

		inlineOrigin(axis, back, desc);

		const u = (axis + 1) % 3;
		const v = (axis + 2) % 3;
		const originX = _origin.ox;
		const originY = _origin.oy;
		const originZ = _origin.oz;
		const descWidth = desc.width;
		const descHeight = desc.height;

		for (let i = 0; i < boxes.length; i++) {
			const box = boxes[i];

			if ((box.faceMask & faceBit) === 0) continue;

			const min = box.min;
			const max = box.max;
			const bc = back ? min[axis] : max[axis];

			const x = originX + (axis === 0 ? bc : min[0]);
			const y = originY + (axis === 1 ? bc : min[1]);
			const z = originZ + (axis === 2 ? bc : min[2]);

			out.emitWaterQuad(
				x,
				y,
				z,
				axis,
				descWidth * (max[u] - min[u]),
				descHeight * (max[v] - min[v]),
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

const _origin = { ox: 0, oy: 0, oz: 0 };

function inlineOrigin(
	axis: number,
	back: number,
	desc: GreedyFaceDescriptor,
): void {
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
}
