// World/MeshPipeline/core/CustomShapeEmitter.ts

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
import {
	computeFenceNeighborMask,
	getFenceDynamicShape,
} from "../../Shape/FenceConnect";
import { getSourceBlockId } from "../../Texture/BlockMaterial";
import { FaceName, getFaceName } from "../../Texture/FaceName";
import { type BlockShapeInfo, MaterialType } from "../types/MeshTypes";

import { computeAO } from "./AOPipeline";
import {
	FLAG_CUSTOM_CROSS,
	FLAG_CUSTOM_CROSS_DIAGONAL,
	FLAG_CUSTOM_FENCE,
	FLAG_WATER_GLASS,
	getCachedBlockId,
	getCachedFlags,
	getMaterialType,
	getRuntimeShapeBoxes,
	getShapeInfo,
} from "./BlockInfoCache";
import type { QuadBuffer } from "./QuadBuffer";
import type { MeshBuildSession } from "./WorkerMeshHelpers";

const EPS = 1e-6;
const DIAGONAL_WIDTH = Math.SQRT2;
const LOD2_BILLBOARD_WIDTH = 1.2;

type ShapeBox = {
	min: [number, number, number];
	max: [number, number, number];
	faceMask: number;
};

/**
 * Returns the face bit for an axis and direction without table lookups.
 */
function getFaceBit(axis: number, back: number): number {
	if (axis === 0) {
		return back !== 0 ? FACE_NX : FACE_PX;
	}

	if (axis === 1) {
		return back !== 0 ? FACE_NY : FACE_PY;
	}

	return back !== 0 ? FACE_NZ : FACE_PZ;
}

/**
 * Emits all non-greedy custom shapes.
 *
 * Greedy-compatible blocks are skipped because they are handled by the greedy
 * pipeline. Border blocks are processed only for faces pointing into the
 * current chunk.
 */
export function emitCustomShapes(session: MeshBuildSession): void {
	// Reduced-LOD builds represent custom shapes as full greedy cubes.
	if (session.lodStep > 1 || session.needsCustomCount === 0) {
		return;
	}

	const size = session.size;
	const ps = session.ps;
	const ps2 = session.ps2;

	const blocks = session.block;
	const lights = session.light;
	const needsCustom = session.needsCustom;

	const isLOD2 = session.lod >= 2;

	const opaqueOut = session.quadOpaque;
	const transparentOut = session.quadTransparent;
	const waterOut = session.quadWater ?? transparentOut;
	const cutoutOut = session.quadCutout ?? transparentOut;

	// getBlock is already an instance-bound arrow function, so it can be
	// forwarded directly without allocating a wrapper closure per build.
	const fenceGetBlock = session.getBlock;

	for (let y = -1; y <= size; y++) {
		const paddedY = (y + 1) * ps;

		for (let z = -1; z <= size; z++) {
			const rowBase = paddedY + (z + 1) * ps2;
			let paddedIndex = rowBase;

			for (let x = -1; x <= size; x++, paddedIndex++) {
				if (needsCustom[paddedIndex] === 0) {
					continue;
				}

				const packed = blocks[paddedIndex];

				// needsCustom should guarantee a nonzero custom block, but
				// retain this guard for stale or externally supplied grids.
				if (packed === 0) {
					continue;
				}

				const flags = getCachedFlags(packed);
				const blockId = getCachedBlockId(packed);
				const sourceBlockId = getSourceBlockId(blockId);
				const materialType = getMaterialType(blockId);
				const baseLight = lights[paddedIndex];

				let out: QuadBuffer;

				if ((flags & FLAG_WATER_GLASS) === 0) {
					out = opaqueOut;
				} else if (sourceBlockId === WATER_BLOCK_ID) {
					out = waterOut;
				} else {
					out = cutoutOut;
				}

				if ((flags & FLAG_CUSTOM_CROSS) !== 0) {
					emitCrossShapeAtBlock(x, y, z, blockId, baseLight, materialType, out);
					continue;
				}

				if ((flags & FLAG_CUSTOM_CROSS_DIAGONAL) !== 0) {
					if (isLOD2) {
						emitLOD2CrossBillboard(
							x,
							y,
							z,
							blockId,
							baseLight,
							materialType,
							out,
						);
					} else {
						emitCrossDiagonalAtBlock(
							x,
							y,
							z,
							blockId,
							baseLight,
							materialType,
							out,
						);
					}

					continue;
				}

				const currentShape = getShapeInfo(packed);

				if ((flags & FLAG_CUSTOM_FENCE) !== 0) {
					const neighborMask = computeFenceNeighborMask(x, y, z, fenceGetBlock);

					const boxes = getFenceDynamicShape(neighborMask).boxes;

					emitShapeBoxes(
						session,
						x,
						y,
						z,
						blockId,
						sourceBlockId,
						packed,
						currentShape,
						materialType,
						baseLight,
						boxes,
						size,
						out,
					);

					continue;
				}

				const boxes = getRuntimeShapeBoxes(packed);

				if (boxes.length === 0) {
					continue;
				}

				emitShapeBoxes(
					session,
					x,
					y,
					z,
					blockId,
					sourceBlockId,
					packed,
					currentShape,
					materialType,
					baseLight,
					boxes,
					size,
					out,
				);
			}
		}
	}
}

/**
 * Emits all enabled faces for a cached collection of shape boxes.
 *
 * Current-block classification is passed in so it is computed once per voxel,
 * rather than once for every box face.
 */
function emitShapeBoxes(
	session: MeshBuildSession,
	voxelX: number,
	voxelY: number,
	voxelZ: number,
	blockId: number,
	sourceBlockId: number,
	packedBlock: number,
	currentShape: BlockShapeInfo,
	materialType: MaterialType,
	baseLight: number,
	boxes: readonly ShapeBox[],
	size: number,
	out: QuadBuffer,
): void {
	const boxCount = boxes.length;

	for (let i = 0; i < boxCount; i++) {
		const box = boxes[i];
		const faceMask = box.faceMask;

		if ((faceMask & FACE_PX) !== 0 && voxelX < size) {
			emitBoxFace(
				session,
				voxelX,
				voxelY,
				voxelZ,
				blockId,
				sourceBlockId,
				packedBlock,
				currentShape,
				materialType,
				box,
				0,
				0,
				baseLight,
				out,
			);
		}

		if ((faceMask & FACE_NX) !== 0 && voxelX >= 0) {
			emitBoxFace(
				session,
				voxelX,
				voxelY,
				voxelZ,
				blockId,
				sourceBlockId,
				packedBlock,
				currentShape,
				materialType,
				box,
				0,
				1,
				baseLight,
				out,
			);
		}

		if ((faceMask & FACE_PY) !== 0 && voxelY < size) {
			emitBoxFace(
				session,
				voxelX,
				voxelY,
				voxelZ,
				blockId,
				sourceBlockId,
				packedBlock,
				currentShape,
				materialType,
				box,
				1,
				0,
				baseLight,
				out,
			);
		}

		if ((faceMask & FACE_NY) !== 0 && voxelY >= 0) {
			emitBoxFace(
				session,
				voxelX,
				voxelY,
				voxelZ,
				blockId,
				sourceBlockId,
				packedBlock,
				currentShape,
				materialType,
				box,
				1,
				1,
				baseLight,
				out,
			);
		}

		if ((faceMask & FACE_PZ) !== 0 && voxelZ < size) {
			emitBoxFace(
				session,
				voxelX,
				voxelY,
				voxelZ,
				blockId,
				sourceBlockId,
				packedBlock,
				currentShape,
				materialType,
				box,
				2,
				0,
				baseLight,
				out,
			);
		}

		if ((faceMask & FACE_NZ) !== 0 && voxelZ >= 0) {
			emitBoxFace(
				session,
				voxelX,
				voxelY,
				voxelZ,
				blockId,
				sourceBlockId,
				packedBlock,
				currentShape,
				materialType,
				box,
				2,
				1,
				baseLight,
				out,
			);
		}
	}
}

/**
 * Emits a cross shape as two intersecting axis-aligned planes.
 */
function emitCrossShapeAtBlock(
	x: number,
	y: number,
	z: number,
	blockId: number,
	baseLight: number,
	materialType: MaterialType,
	out: QuadBuffer,
): void {
	const centerX = x + 0.5;
	const centerZ = z + 0.5;

	out.emitQuad(
		centerX,
		y,
		z,
		0,
		1,
		1,
		blockId,
		0,
		baseLight,
		0,
		FaceName.PX,
		materialType,
		0,
		0,
		0,
	);

	out.emitQuad(
		centerX,
		y,
		z,
		0,
		1,
		1,
		blockId,
		1,
		baseLight,
		0,
		FaceName.NX,
		materialType,
		0,
		0,
		0,
	);

	out.emitQuad(
		x,
		y,
		centerZ,
		2,
		1,
		1,
		blockId,
		0,
		baseLight,
		0,
		FaceName.PZ,
		materialType,
		0,
		0,
		0,
	);

	out.emitQuad(
		x,
		y,
		centerZ,
		2,
		1,
		1,
		blockId,
		1,
		baseLight,
		0,
		FaceName.NZ,
		materialType,
		0,
		0,
		0,
	);
}

/**
 * Emits a true diagonal X-shaped cross.
 */
function emitCrossDiagonalAtBlock(
	x: number,
	y: number,
	z: number,
	blockId: number,
	baseLight: number,
	materialType: MaterialType,
	out: QuadBuffer,
): void {
	const centerX = x + 0.5;
	const centerZ = z + 0.5;

	out.emitQuad(
		centerX,
		y,
		centerZ,
		0,
		DIAGONAL_WIDTH,
		1,
		blockId,
		0,
		baseLight,
		0,
		FaceName.West,
		materialType,
		0,
		2,
		0,
	);

	out.emitQuad(
		centerX,
		y,
		centerZ,
		0,
		DIAGONAL_WIDTH,
		1,
		blockId,
		1,
		baseLight,
		0,
		FaceName.East,
		materialType,
		0,
		2,
		0,
	);

	out.emitQuad(
		centerX,
		y,
		centerZ,
		0,
		DIAGONAL_WIDTH,
		1,
		blockId,
		0,
		baseLight,
		0,
		FaceName.South,
		materialType,
		0,
		1,
		0,
	);

	out.emitQuad(
		centerX,
		y,
		centerZ,
		0,
		DIAGONAL_WIDTH,
		1,
		blockId,
		1,
		baseLight,
		0,
		FaceName.North,
		materialType,
		0,
		1,
		0,
	);
}

/**
 * Emits a wider crossed billboard for LOD2+ vegetation.
 */
function emitLOD2CrossBillboard(
	x: number,
	y: number,
	z: number,
	blockId: number,
	baseLight: number,
	materialType: MaterialType,
	out: QuadBuffer,
): void {
	const centerX = x + 0.5;
	const centerZ = z + 0.5;

	out.emitQuad(
		centerX,
		y,
		z,
		0,
		LOD2_BILLBOARD_WIDTH,
		1,
		blockId,
		0,
		baseLight,
		0,
		FaceName.PX,
		materialType,
		0,
		0,
		0,
	);

	out.emitQuad(
		centerX,
		y,
		z,
		0,
		LOD2_BILLBOARD_WIDTH,
		1,
		blockId,
		1,
		baseLight,
		0,
		FaceName.NX,
		materialType,
		0,
		0,
		0,
	);

	out.emitQuad(
		x,
		y,
		centerZ,
		2,
		LOD2_BILLBOARD_WIDTH,
		1,
		blockId,
		0,
		baseLight,
		0,
		FaceName.PZ,
		materialType,
		0,
		0,
		0,
	);

	out.emitQuad(
		x,
		y,
		centerZ,
		2,
		LOD2_BILLBOARD_WIDTH,
		1,
		blockId,
		1,
		baseLight,
		0,
		FaceName.NZ,
		materialType,
		0,
		0,
		0,
	);
}

function emitBoxFace(
	session: MeshBuildSession,
	voxelX: number,
	voxelY: number,
	voxelZ: number,
	blockId: number,
	sourceBlockId: number,
	packedBlock: number,
	currentShape: BlockShapeInfo,
	materialType: MaterialType,
	box: ShapeBox,
	axis: number,
	back: number,
	baseLight: number,
	out: QuadBuffer,
): void {
	const min = box.min;
	const max = box.max;

	const faceBoundary = back !== 0 ? min[axis] : max[axis];

	const onVoxelBoundary =
		back !== 0 ? faceBoundary <= EPS : faceBoundary >= 1 - EPS;

	let light = baseLight;
	let ao = 0;

	if (onVoxelBoundary) {
		const direction = back !== 0 ? -1 : 1;

		const neighborX = axis === 0 ? voxelX + direction : voxelX;

		const neighborY = axis === 1 ? voxelY + direction : voxelY;

		const neighborZ = axis === 2 ? voxelZ + direction : voxelZ;

		const neighborIndex =
			neighborX +
			1 +
			(neighborY + 1) * session.ps +
			(neighborZ + 1) * session.ps2;

		const neighborPacked = session.block[neighborIndex];

		if (neighborPacked !== 0) {
			const neighborBlockId = unpackBlockId(neighborPacked);
			const neighborShape = getShapeInfo(neighborPacked);
			const neighborMaterialType = getMaterialType(neighborBlockId);

			const oppositeFaceBit = getFaceBit(axis, back ^ 1);

			const neighborCloses =
				(neighborShape.closedFaceMask & oppositeFaceBit) !== 0;

			const currentTransparent = materialType === MaterialType.WaterOrGlass;

			const neighborTransparent =
				neighborMaterialType === MaterialType.WaterOrGlass;

			let preserveTransparentInterface = false;

			if (currentTransparent && neighborTransparent) {
				const neighborSourceBlockId = getSourceBlockId(neighborBlockId);

				if (sourceBlockId !== neighborSourceBlockId) {
					preserveTransparentInterface = true;
				} else {
					// Same-source glass has no visible internal face.
					// Different-height water columns still need the interface.
					if (sourceBlockId !== WATER_BLOCK_ID) {
						return;
					}

					const currentLevel = (packedBlock >>> 10) & 0xf;

					const neighborLevel = (neighborPacked >>> 10) & 0xf;

					if (currentLevel === neighborLevel) {
						return;
					}
				}
			}

			if (neighborCloses && !preserveTransparentInterface) {
				return;
			}
		}

		light = session.light[neighborIndex];

		if (!session.disableAO) {
			let uAxis: number;
			let vAxis: number;

			if (axis === 0) {
				uAxis = 1;
				vAxis = 2;
			} else if (axis === 1) {
				uAxis = 2;
				vAxis = 0;
			} else {
				uAxis = 0;
				vAxis = 1;
			}

			ao = computeAO(session, neighborX, neighborY, neighborZ, uAxis, vAxis);
		}
	}

	let u: number;
	let v: number;

	if (axis === 0) {
		u = 1;
		v = 2;
	} else if (axis === 1) {
		u = 2;
		v = 0;
	} else {
		u = 0;
		v = 1;
	}

	const x = voxelX + (axis === 0 ? faceBoundary : min[0]);

	const y = voxelY + (axis === 1 ? faceBoundary : min[1]);

	const z = voxelZ + (axis === 2 ? faceBoundary : min[2]);

	out.emitQuad(
		x,
		y,
		z,
		axis,
		max[u] - min[u],
		max[v] - min[v],
		blockId,
		back,
		light,
		ao,
		getFaceName(axis, back !== 0),
		materialType,
		0,
		0,
		0,
	);
}
