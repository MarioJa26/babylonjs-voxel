// World/MeshPipeline/core/VoxelFaceEmitterAdapter.ts

import { unpackBlockId } from "../../Chunk/DataStructures/BlockEncoding";
import {
	getLiquidDefinitionByBlockId,
	isLiquidBlockId,
} from "../../Liquid/LiquidRegistry";
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

const WATER_ABOVE_MASK = 0x10000;
const WATER_LEVEL_PAIR_MASK = 0x20000;

const PACKED_WATER_MASK =
	PACKED_ID_STATE_MASK | WATER_ABOVE_MASK | WATER_LEVEL_PAIR_MASK;

const FACE_NAME_PX = getFaceName(0, false);
const FACE_NAME_NX = getFaceName(0, true);
const FACE_NAME_PY = getFaceName(1, false);
const FACE_NAME_NY = getFaceName(1, true);
const FACE_NAME_PZ = getFaceName(2, false);
const FACE_NAME_NZ = getFaceName(2, true);

const ENCODED_POSITION_MAX = 255 / 8;

function getFaceNameByIndex(index: number): FaceName {
	switch (index) {
		case 0:
			return FACE_NAME_PX;
		case 1:
			return FACE_NAME_NX;
		case 2:
			return FACE_NAME_PY;
		case 3:
			return FACE_NAME_NY;
		case 4:
			return FACE_NAME_PZ;
		default:
			return FACE_NAME_NZ;
	}
}

function getFaceBitByIndex(index: number): number {
	switch (index) {
		case 0:
			return FACE_PX;
		case 1:
			return FACE_NX;
		case 2:
			return FACE_PY;
		case 3:
			return FACE_NY;
		case 4:
			return FACE_PZ;
		default:
			return FACE_NZ;
	}
}

function needsRawDim(blockId: number, width: number, height: number): boolean {
	if (width > 31 || height > 31) {
		return true;
	}

	return !isLiquidBlockId(blockId);
}

type SplitTransparentSession = MeshBuildSession & {
	/**
	 * Optional GPU-optimized transparent buckets.
	 *
	 * When absent, transparent faces continue to use quadTransparent.
	 */
	quadWater?: QuadBuffer;
	quadCutout?: QuadBuffer;
};

export class VoxelFaceEmitterAdapter {
	private readonly _session: SplitTransparentSession;

	/**
	 * Reusable numeric origin state.
	 *
	 * This replaces the module-level mutable origin object, avoiding object
	 * property sharing between adapter instances without allocating per face.
	 */
	private _originX = 0;
	private _originY = 0;
	private _originZ = 0;

	constructor(session: MeshBuildSession) {
		this._session = session as SplitTransparentSession;
	}

	public emitVoxelFace(axis: number, desc: GreedyFaceDescriptor): void {
		const rawMask = desc.idState | 0;
		const packedBlock = rawMask & PACKED_WATER_MASK;

		if (packedBlock === 0) {
			return;
		}

		const blockId = unpackBlockId(packedBlock);
		const materialType = getMaterialType(blockId);
		const isTransparent = materialType === MaterialType.WaterOrGlass;

		// Liquids flow and sink by level, so they reuse the water face path
		// (geometry + level packing). The render bucket decides the material.
		const liquid = isTransparent ? getLiquidDefinitionByBlockId(blockId) : null;
		const isWaterBody = liquid !== null && liquid.renderBucket === "water";

		const session = this._session;
		const step = session.lodStep;

		// Reduced-LOD liquid side faces create distant shoreline artifacts.
		if (step > 1 && liquid !== null && axis !== 1) {
			return;
		}

		let out: QuadBuffer;

		if (!isTransparent) {
			out = session.quadOpaque;
		} else if (liquid !== null && liquid.renderBucket === "water") {
			out = session.quadWater ?? session.quadTransparent;
		} else {
			out = session.quadCutout ?? session.quadTransparent;
		}

		const packedLight = desc.light;
		const ao = packedLight & 0xff;
		const light = (packedLight >>> 8) & 0xff;

		const back = rawMask >>> 31;
		const faceIndex = (axis << 1) | back;
		const faceName = getFaceNameByIndex(faceIndex);

		// Reduced-LOD meshes represent every source shape as a full cube.
		if (step > 1) {
			this.emitCubeFace(out, axis, desc, blockId, back, light, ao, faceName);
			return;
		}

		const isCube = (rawMask & NON_CUBE_MASK) === 0;

		if (isCube) {
			if (liquid !== null) {
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
					isWaterBody,
				);
			} else {
				this.emitCubeFace(out, axis, desc, blockId, back, light, ao, faceName);
			}

			return;
		}

		const faceBit = getFaceBitByIndex(faceIndex);

		if (liquid !== null) {
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
				isWaterBody,
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
				materialType,
			);
		}
	}

	/**
	 * Updates the reusable origin fields without allocating an object.
	 */
	private setOrigin(
		axis: number,
		back: number,
		desc: GreedyFaceDescriptor,
		step: number,
	): void {
		const faceBlockCoord = (desc.slice + back) * step;
		const uStart = desc.uStart * step;
		const vStart = desc.vStart * step;

		if (axis === 0) {
			this._originX = faceBlockCoord;
			this._originY = uStart;
			this._originZ = vStart;
			return;
		}

		if (axis === 1) {
			this._originX = vStart;
			this._originY = faceBlockCoord;
			this._originZ = uStart;
			return;
		}

		this._originX = uStart;
		this._originY = vStart;
		this._originZ = faceBlockCoord;
	}

	private emitCubeFace(
		out: QuadBuffer,
		axis: number,
		desc: GreedyFaceDescriptor,
		blockId: number,
		back: number,
		light: number,
		ao: number,
		faceName: FaceName,
	): void {
		const session = this._session;
		const step = session.lodStep;

		this.setOrigin(axis, back, desc, step);

		// Front faces advance one cell to the shared face plane.
		// Back faces are already positioned on the plane by setOrigin().
		const offset = (1 ^ back) * step;

		let x = this._originX;
		let y = this._originY;
		let z = this._originZ;

		if (axis === 0) {
			x += offset;
		} else if (axis === 1) {
			y += offset;
		} else {
			z += offset;
		}

		const width = desc.width * step;
		const height = desc.height * step;

		if (step > 1) {
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

		const meshGridSize =
			session.meshGridSize > 0 ? session.meshGridSize : session.size;

		const isBoundary =
			desc.slice === meshGridSize - 1 &&
			session.hasNeighborChunk(
				axis === 0 ? 1 : 0,
				axis === 1 ? 1 : 0,
				axis === 2 ? 1 : 0,
			);

		if (isBoundary) {
			// Encode at the last representable position. The boundary
			// material sentinel tells the shader to restore the true plane.
			if (x > ENCODED_POSITION_MAX) {
				x = ENCODED_POSITION_MAX;
			}

			if (y > ENCODED_POSITION_MAX) {
				y = ENCODED_POSITION_MAX;
			}

			if (z > ENCODED_POSITION_MAX) {
				z = ENCODED_POSITION_MAX;
			}

			out.emitQuadUnchecked(
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
				3,
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
		isWaterBody: boolean,
	): void {
		const step = this._session.lodStep;

		this.setOrigin(axis, back, desc, step);

		const offset = (1 ^ back) * step;

		let x = this._originX;
		let y = this._originY;
		let z = this._originZ;

		if (axis === 0) {
			x += offset;
		} else if (axis === 1) {
			y += offset;
		} else {
			z += offset;
		}

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
			isWaterBody,
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
		materialType: MaterialType,
	): void {
		const shapeKey = packedBlock & PACKED_ID_STATE_MASK;
		const boxes = getRuntimeShapeBoxes(shapeKey);
		const boxCount = boxes.length;

		if (boxCount === 0) {
			return;
		}

		const step = this._session.lodStep;

		this.setOrigin(axis, back, desc, step);

		const originX = this._originX;
		const originY = this._originY;
		const originZ = this._originZ;

		const descWidth = desc.width * step;
		const descHeight = desc.height * step;
		const rawDim = needsRawDim(blockId, descWidth, descHeight) ? 1 : 0;

		// In-plane axes:
		// axis X -> u=Y, v=Z
		// axis Y -> u=Z, v=X
		// axis Z -> u=X, v=Y
		const u = axis === 2 ? 0 : axis + 1;
		const v = axis === 0 ? 2 : axis - 1;

		for (let i = 0; i < boxCount; i++) {
			const box = boxes[i];

			if ((box.faceMask & faceBit) === 0) {
				continue;
			}

			const min = box.min;
			const max = box.max;
			const faceCoord = back ? min[axis] : max[axis];

			const x = originX + (axis === 0 ? faceCoord : min[0]);
			const y = originY + (axis === 1 ? faceCoord : min[1]);
			const z = originZ + (axis === 2 ? faceCoord : min[2]);

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
				materialType,
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
		isWaterBody: boolean,
	): void {
		// The shape cache uses only the packed ID/state region. Water flags
		// must still be forwarded unchanged to emitWaterQuad().
		const shapeKey = packedBlock & PACKED_ID_STATE_MASK;
		const boxes = getRuntimeShapeBoxes(shapeKey);
		const boxCount = boxes.length;

		if (boxCount === 0) {
			return;
		}

		const step = this._session.lodStep;

		this.setOrigin(axis, back, desc, step);

		const originX = this._originX;
		const originY = this._originY;
		const originZ = this._originZ;

		const descWidth = desc.width * step;
		const descHeight = desc.height * step;

		const u = axis === 2 ? 0 : axis + 1;
		const v = axis === 0 ? 2 : axis - 1;

		for (let i = 0; i < boxCount; i++) {
			const box = boxes[i];

			if ((box.faceMask & faceBit) === 0) {
				continue;
			}

			const min = box.min;
			const max = box.max;
			const faceCoord = back ? min[axis] : max[axis];

			const x = originX + (axis === 0 ? faceCoord : min[0]);
			const y = originY + (axis === 1 ? faceCoord : min[1]);
			const z = originZ + (axis === 2 ? faceCoord : min[2]);

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
				isWaterBody,
			);
		}
	}
}
