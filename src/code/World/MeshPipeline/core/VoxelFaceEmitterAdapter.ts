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
	if (width > 31 || height > 31) return true;
	if (blockId === WATER_BLOCK_ID) return false;
	// Virtual water variants behave like water.
	if (typeof blockId === "number" && blockId >= 500) {
		return Math.floor((blockId - 500) / 5) + 1 !== WATER_BLOCK_ID;
	}
	return true;
}

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

	constructor(session: MeshBuildSession) {
		this._session = session as SplitTransparentSession;
	}

	public emitVoxelFace(axis: number, desc: GreedyFaceDescriptor): void {
		const rawMask = desc.idState | 0;
		const packedBlock = rawMask & PACKED_WATER_MASK;

		if (packedBlock === 0) return;

		const blockId = unpackBlockId(packedBlock);
		const materialType = getMaterialType(blockId);
		const isTransparent = materialType === MaterialType.WaterOrGlass;

		let isWater = false;

		if (isTransparent) {
			if (blockId === WATER_BLOCK_ID) {
				isWater = true;
			} else if (blockId >= 500) {
				const virtualBaseBlockId = (((blockId - 500) / 5) | 0) + 1;

				isWater = virtualBaseBlockId === WATER_BLOCK_ID;
			}
		}

		const session = this._session;
		const step = session.lodStep;

		// At reduced LOD, water side faces produce distant shoreline artifacts.
		if (step > 1 && isWater && axis !== 1) return;

		let out: QuadBuffer;

		if (!isTransparent) {
			out = session.quadOpaque;
		} else if (isWater) {
			out = session.quadWater ?? session.quadTransparent;
		} else {
			out = session.quadCutout ?? session.quadTransparent;
		}

		const packedLight = desc.light;
		const ao = packedLight & 0xff;
		const light = (packedLight >>> 8) & 0xff;

		const back = rawMask >>> 31;
		const faceIndex = (axis << 1) | back;
		const faceName = FACE_NAME_TABLE[faceIndex];
		const faceBit = FACE_BIT_TABLE[faceIndex];

		// Reduced-LOD meshes represent every source shape as a full cube.
		if (step > 1) {
			this.emitCubeFace(
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
			return;
		}

		const isCube = (rawMask & NON_CUBE_MASK) === 0;

		if (isWater) {
			if (isCube) {
				this.emitWaterFace(
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
			}

			return;
		}

		if (isCube) {
			this.emitCubeFace(
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
		const session = this._session;
		const step = session.lodStep;
		inlineOrigin(axis, back, desc, step);

		// Front faces advance one full cell (step blocks) to the shared
		// face plane; back faces already sit on it via inlineOrigin.
		const off = (1 ^ back) * step;
		const x = axis === 0 ? _origin.ox + off : _origin.ox;
		const y = axis === 1 ? _origin.oy + off : _origin.oy;
		const z = axis === 2 ? _origin.oz + off : _origin.oz;

		const width = desc.width * step;
		const height = desc.height * step;

		if (step > 1) {
			// Downsampled builds feed the dedicated LOD4+ raw-units pipeline:
			// coordinates and dimensions are whole blocks ≤ CHUNK_SIZE (32),
			// so they encode exactly in the u8 face words — no boundary clamp,
			// no materialType==3 sentinel, no POS_SCALE. Only the slim LOD4
			// "raw units" shader may be bound to meshes built this way.
			out.emitQuadRawUnits(
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
			);
			return;
		}

		// Boundary-slice detection: the last greedy slice pairs this chunk's
		// final region with the +axis neighbor's first region. Its face plane
		// sits exactly at the chunk border (coord = size), which the u8
		// position encoding clamps to size-1/8. Flag it with materialType=3;
		// the shader adds the missing +1 unit along the face axis.
		const isBoundary =
			desc.slice === session.meshGridSize - 1 &&
			session.hasNeighborChunk(
				axis === 0 ? 1 : 0,
				axis === 1 ? 1 : 0,
				axis === 2 ? 1 : 0,
			);

		if (isBoundary) {
			// The true plane (coord = size = 32) exceeds the u8 position
			// grid, so encode at the LAST representable unit (31.875) here —
			// at the source, never via a downstream clamp — and flag with
			// materialType=3; the shader adds INV_POS along the face axis,
			// restoring the exact plane.
			const ENC_MAX = 255 / 8;
			out.emitQuadUnchecked(
				Math.min(x, ENC_MAX),
				Math.min(y, ENC_MAX),
				Math.min(z, ENC_MAX),
				axis,
				width,
				height,
				blockId,
				back,
				light,
				ao,
				faceName,
				3, // boundary sentinel — shader nudges +INV_POS on the axis
				0,
				0,
				1,
			);
			return;
		}

		out.emitCubeQuadUnchecked(
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
			needsRawDim(blockId, width, height) ? 1 : 0,
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
		const step = this._session.lodStep;
		inlineOrigin(axis, back, desc, step);

		const off = (1 ^ back) * step;
		const x = axis === 0 ? _origin.ox + off : _origin.ox;
		const y = axis === 1 ? _origin.oy + off : _origin.oy;
		const z = axis === 2 ? _origin.oz + off : _origin.oz;
		out.emitWaterQuad(
			x,
			y,
			z,
			axis,
			desc.width * step,
			desc.height * step,
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

		const step = this._session.lodStep;
		inlineOrigin(axis, back, desc, step);

		const rawDim = needsRawDim(blockId, desc.width * step, desc.height * step)
			? 1
			: 0;
		const u = (axis + 1) % 3;
		const v = (axis + 2) % 3;
		const originX = _origin.ox;
		const originY = _origin.oy;
		const originZ = _origin.oz;
		const descWidth = desc.width * step;
		const descHeight = desc.height * step;

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
				getMaterialType(blockId),
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

		const step = this._session.lodStep;
		inlineOrigin(axis, back, desc, step);

		const u = (axis + 1) % 3;
		const v = (axis + 2) % 3;
		const originX = _origin.ox;
		const originY = _origin.oy;
		const originZ = _origin.oz;
		const descWidth = desc.width * step;
		const descHeight = desc.height * step;

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
	step: number,
): void {
	// Descriptor coords are grid cells; scale back to block units. `back`
	// advances one cell (= step blocks) to the face plane.
	const faceBlockCoord = (desc.slice + back) * step;
	if (axis === 0) {
		_origin.ox = faceBlockCoord;
		_origin.oy = desc.uStart * step;
		_origin.oz = desc.vStart * step;
	} else if (axis === 1) {
		_origin.ox = desc.vStart * step;
		_origin.oy = faceBlockCoord;
		_origin.oz = desc.uStart * step;
	} else {
		_origin.ox = desc.uStart * step;
		_origin.oy = desc.vStart * step;
		_origin.oz = faceBlockCoord;
	}
}
