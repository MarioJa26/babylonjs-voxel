// World/MeshPipeline/core/CustomShapeEmitter.ts

import { unpackBlockId } from "../../Chunk/DataStructures/BlockEncoding";
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
import { FaceName, getFaceName } from "../../Texture/FaceName";
import {
	MaterialType,
	type MeshContext,
	type WorkerInternalMeshData,
} from "../types/MeshTypes";

import { computeAO } from "./AOPipeline";
import {
	FLAG_CUSTOM_CROSS,
	FLAG_CUSTOM_CROSS_DIAGONAL,
	FLAG_CUSTOM_FENCE,
	FLAG_GREEDY,
	FLAG_WATER_GLASS,
	getCachedBlockId,
	getCachedFlags,
} from "./BlockFlags";
import { emitQuadFast } from "./FaceEmitter";
import {
	getMaterialType,
	getRuntimeShapeBoxes,
	getShapeInfo,
	isGreedyCompatiblePackedBlock,
} from "./ShapePipeline";
import { PaddedGrid } from "./WorkerMeshHelpers";

const EPS = 1e-6;

type ParsedBlock = {
	packed: number;
	blockId: number;
	shape: ReturnType<typeof getShapeInfo>;
	materialType: MaterialType;
	isSolid: boolean;
	isTransparent: boolean;
	greedyCompatible: boolean;
};

type FaceDescriptor = {
	bit: number;
	axis: 0 | 1 | 2;
	isBackFace: boolean;
};

const FACE_DESCRIPTORS: readonly FaceDescriptor[] = [
	{ bit: FACE_PX, axis: 0, isBackFace: false },
	{ bit: FACE_NX, axis: 0, isBackFace: true },
	{ bit: FACE_PY, axis: 1, isBackFace: false },
	{ bit: FACE_NY, axis: 1, isBackFace: true },
	{ bit: FACE_PZ, axis: 2, isBackFace: false },
	{ bit: FACE_NZ, axis: 2, isBackFace: true },
] as const;

const _parsedBlockScratch1: ParsedBlock = {
	packed: 0,
	blockId: 0,
	shape: getShapeInfo(0),
	materialType: MaterialType.Default,
	isSolid: false,
	isTransparent: true,
	greedyCompatible: false,
};
const _parsedBlockScratch2: ParsedBlock = {
	packed: 0,
	blockId: 0,
	shape: getShapeInfo(0),
	materialType: MaterialType.Default,
	isSolid: false,
	isTransparent: true,
	greedyCompatible: false,
};

function parseBlockInto(packed: number, out: ParsedBlock): void {
	if (!packed) {
		out.packed = 0;
		out.blockId = 0;
		out.shape = getShapeInfo(0);
		out.materialType = MaterialType.Default;
		out.isSolid = false;
		out.isTransparent = true;
		out.greedyCompatible = false;
		return;
	}

	out.packed = packed;
	out.blockId = unpackBlockId(packed);
	out.shape = getShapeInfo(packed);
	out.materialType = getMaterialType(out.blockId);
	out.isSolid = out.blockId !== 0;
	out.isTransparent = out.materialType === MaterialType.WaterOrGlass;
	out.greedyCompatible = isGreedyCompatiblePackedBlock(packed);
}

const FACE_BIT_FRONT = [FACE_PX, FACE_PY, FACE_PZ];
const FACE_BIT_BACK = [FACE_NX, FACE_NY, FACE_NZ];
const FACE_BIT_LUT = [FACE_BIT_FRONT, FACE_BIT_BACK];

function getFaceBit(axis: number, isBackFace: boolean): number {
	return FACE_BIT_LUT[+isBackFace][axis];
}

function isWaterGlassInterface(curr: ParsedBlock, nbr: ParsedBlock): boolean {
	if (!curr.isSolid || !nbr.isSolid) return false;
	if (!curr.isTransparent || !nbr.isTransparent) return false;

	return (
		curr.materialType === MaterialType.WaterOrGlass &&
		nbr.materialType === MaterialType.WaterOrGlass &&
		curr.blockId !== nbr.blockId
	);
}

/**
 * Emit all non-greedy custom shapes directly.
 *
 * Greedy-compatible blocks are skipped here because they are already handled
 * by the fast greedy path.
 *
 * Border blocks (from adjacent chunks, at positions -1 and size) are also
 * processed. For these, only faces that point INTO the current chunk are emitted
 * so the adjacent chunk's own mesher handles the outward-facing side.
 */
export function emitCustomShapes(
	ctx: MeshContext,
	opaqueOut: WorkerInternalMeshData,
	transparentOut: WorkerInternalMeshData,
): void {
	const size = ctx.size;
	const getBlock = ctx.getBlock;
	const getLight = ctx.getLight;
	const isLOD2 = ctx.lod >= 2;

	for (let y = -1; y <= size; y++) {
		for (let z = -1; z <= size; z++) {
			for (let x = -1; x <= size; x++) {
				const packed = getBlock(x, y, z, 0);
				if (!packed) continue;

				const flags = getCachedFlags(packed);

				if (flags & FLAG_GREEDY) {
					continue;
				}

				const blockId = getCachedBlockId(packed);
				const out = flags & FLAG_WATER_GLASS ? transparentOut : opaqueOut;

				const baseLight = getLight(x, y, z, 0);

				if (flags & FLAG_CUSTOM_CROSS) {
					emitCrossShapeAtBlock(
						x,
						y,
						z,
						blockId,
						baseLight,
						getMaterialType(blockId),
						out,
					);
					continue;
				}

				if (flags & FLAG_CUSTOM_CROSS_DIAGONAL) {
					if (isLOD2) {
						emitLOD2CrossBillboard(
							x,
							y,
							z,
							blockId,
							baseLight,
							getMaterialType(blockId),
							out,
						);
					} else {
						emitCrossDiagonalAtBlock(
							x,
							y,
							z,
							blockId,
							baseLight,
							getMaterialType(blockId),
							out,
						);
					}
					continue;
				}

				if (flags & FLAG_CUSTOM_FENCE) {
					const neighborMask = computeFenceNeighborMask(x, y, z, (nx, ny, nz) =>
						getBlock(nx, ny, nz, 0),
					);
					const fenceShape = getFenceDynamicShape(neighborMask);

					for (let i = 0; i < fenceShape.boxes.length; i++) {
						const box = fenceShape.boxes[i];
						for (let fi = 0; fi < 6; fi++) {
							const face = FACE_DESCRIPTORS[fi];
							if ((box.faceMask & face.bit) === 0) continue;
							if (
								isBorderOutwardFace(x, y, z, size, face.axis, face.isBackFace)
							)
								continue;
							emitBoxFace(
								ctx,
								x,
								y,
								z,
								blockId,
								packed,
								box,
								face.axis,
								face.isBackFace,
								baseLight,
								out,
							);
						}
					}
					continue;
				}

				const boxes = getRuntimeShapeBoxes(packed);
				if (boxes.length === 0) continue;

				for (let i = 0; i < boxes.length; i++) {
					const box = boxes[i];

					for (let fi = 0; fi < 6; fi++) {
						const face = FACE_DESCRIPTORS[fi];
						if ((box.faceMask & face.bit) === 0) continue;
						if (isBorderOutwardFace(x, y, z, size, face.axis, face.isBackFace))
							continue;

						emitBoxFace(
							ctx,
							x,
							y,
							z,
							blockId,
							packed,
							box,
							face.axis,
							face.isBackFace,
							baseLight,
							out,
						);
					}
				}
			}
		}
	}
}

/**
 * Returns true when a face on a border block points away from the chunk
 * (i.e. into the adjacent chunk that owns the block). Those faces are
 * rendered by the adjacent chunk's own mesher.
 *
 * Border positions: x/y/z === -1 or x/y/z === size.
 */
function isBorderOutwardFace(
	x: number,
	y: number,
	z: number,
	size: number,
	axis: number,
	isBackFace: boolean,
): boolean {
	// A back face (dir = -1) points outward at the p < 0 border; a front
	// face (dir = +1) points outward at the p >= size border.
	const p = axis === 0 ? x : axis === 1 ? y : z;
	return isBackFace ? p < 0 : p >= size;
}

/**
 * Emit a "cross" shape as two intersecting transparent planes centered in the block.
 */
function emitCrossShapeAtBlock(
	x: number,
	y: number,
	z: number,
	blockId: number,
	baseLight: number,
	materialType: MaterialType = MaterialType.Cutout,
	out: WorkerInternalMeshData,
): void {
	// X-aligned plane (perpendicular to X axis)
	emitQuadFast(
		out,
		x + 0.5,
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

	emitQuadFast(
		out,
		x + 0.5,
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

	// Z-aligned plane (perpendicular to Z axis)
	emitQuadFast(
		out,
		x,
		y,
		z + 0.5,
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

	emitQuadFast(
		out,
		x,
		y,
		z + 0.5,
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
} /**
 * Emit a true diagonal "X" cross centered in the block.
 *
 * This uses diagonal metadata so the runtime reconstruction can rotate
 * the planes corner-to-corner across the voxel.
 */
function emitCrossDiagonalAtBlock(
	x: number,
	y: number,
	z: number,
	blockId: number,
	baseLight: number,
	materialType: MaterialType = MaterialType.Cutout,
	out: WorkerInternalMeshData,
): void {
	const cx = x + 0.5;
	const cz = z + 0.5;

	// diagonal across a unit square corner-to-corner
	const diagWidth = Math.SQRT2;

	// Diagonal A: SW -> NE (variant 1 → NE normal catches SE light)
	emitQuadFast(
		out,
		cx,
		y,
		cz,
		0,
		diagWidth,
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

	emitQuadFast(
		out,
		cx,
		y,
		cz,
		0,
		diagWidth,
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

	// Diagonal B: NW -> SE (variant 0 → NW normal, tangent NE)
	emitQuadFast(
		out,
		cx,
		y,
		cz,
		0,
		diagWidth,
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

	emitQuadFast(
		out,
		cx,
		y,
		cz,
		0,
		diagWidth,
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
 * Emit a wider crossed-billboard for LOD2+ vegetation.
 * Two axis-aligned planes (X-facing, Z-facing) slightly wider than 1.0
 * so the plant doesn't look too thin compared to the sqrt(2) diagonal cross.
 */
function emitLOD2CrossBillboard(
	x: number,
	y: number,
	z: number,
	blockId: number,
	baseLight: number,
	materialType: MaterialType,
	out: WorkerInternalMeshData,
): void {
	const W = 1.2;

	// X-aligned plane
	emitQuadFast(
		out,
		x + 0.5,
		y,
		z,
		0,
		W,
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

	emitQuadFast(
		out,
		x + 0.5,
		y,
		z,
		0,
		W,
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

	// Z-aligned plane
	emitQuadFast(
		out,
		x,
		y,
		z + 0.5,
		2,
		W,
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

	emitQuadFast(
		out,
		x,
		y,
		z + 0.5,
		2,
		W,
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
	ctx: MeshContext,
	voxelX: number,
	voxelY: number,
	voxelZ: number,
	blockId: number,
	packedBlock: number,
	box: {
		min: [number, number, number];
		max: [number, number, number];
		faceMask: number;
	},
	axis: number,
	isBackFace: boolean,
	baseLight: number,
	out: WorkerInternalMeshData,
): void {
	const faceBit = getFaceBit(axis, isBackFace);
	if ((box.faceMask & faceBit) === 0) {
		return;
	}

	const min = box.min;
	const max = box.max;
	parseBlockInto(packedBlock, _parsedBlockScratch1);
	const currentBlock = _parsedBlockScratch1;

	const back = isBackFace ? 1 : 0;
	const d = 1 - 2 * back;
	const dirX = axis === 0 ? d : 0;
	const dirY = axis === 1 ? d : 0;
	const dirZ = axis === 2 ? d : 0;

	const nx = voxelX + dirX;
	const ny = voxelY + dirY;
	const nz = voxelZ + dirZ;

	const onBoundary = back ? min[axis] <= EPS : max[axis] >= 1 - EPS;

	let light = baseLight;
	let ao = 0;

	if (onBoundary) {
		const neighborPacked = ctx.getBlock(nx, ny, nz, 0);
		parseBlockInto(neighborPacked, _parsedBlockScratch2);
		const neighbor = _parsedBlockScratch2;

		const oppositeFaceBit = getFaceBit(axis, !isBackFace);
		const neighborCloses =
			neighbor.isSolid &&
			(neighbor.shape.closedFaceMask & oppositeFaceBit) !== 0;

		const preserveTransparentInterface = isWaterGlassInterface(
			currentBlock,
			neighbor,
		);

		// If the neighbor closes this boundary, cull the face,
		// except for water/glass interfaces which should remain visible.
		if (neighborCloses && !preserveTransparentInterface) {
			return;
		}

		light = ctx.getLight(nx, ny, nz, baseLight);

		if (!ctx.disableAO) {
			// AO anchor must be on the outside side of the emitted face.
			const uAxis = (axis + 1) % 3;
			const vAxis = (axis + 2) % 3;

			ao = computeAO(PaddedGrid.block, nx, ny, nz, uAxis, vAxis);
		}
	}

	const faceName = getFaceName(axis, isBackFace);

	const faceIdx = back;
	const bc = back ? min[axis] : max[axis];
	const x = voxelX + (axis === 0 ? bc : min[0]);
	const y = voxelY + (axis === 1 ? bc : min[1]);
	const z = voxelZ + (axis === 2 ? bc : min[2]);
	const u = (axis + 1) % 3;
	const v = (axis + 2) % 3;

	emitQuadFast(
		out,
		x,
		y,
		z,
		axis,
		max[u] - min[u],
		max[v] - min[v],
		blockId,
		faceIdx,
		light,
		ao,
		faceName,
		currentBlock.materialType,
		0,
		0,
		0,
	);
}
