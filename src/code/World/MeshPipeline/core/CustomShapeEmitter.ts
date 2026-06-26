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
import { emitQuad } from "./FaceEmitter";
import {
	getMaterialType,
	getRuntimeShapeBoxes,
	getShapeInfo,
	isGreedyCompatiblePackedBlock,
} from "./ShapePipeline";

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

function getFaceBit(axis: number, isBackFace: boolean): number {
	if (axis === 0) return isBackFace ? FACE_NX : FACE_PX;
	if (axis === 1) return isBackFace ? FACE_NY : FACE_PY;
	return isBackFace ? FACE_NZ : FACE_PZ;
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
						transparentOut,
					);
					continue;
				}

				if (flags & FLAG_CUSTOM_CROSS_DIAGONAL) {
					if (ctx.lod >= 2) {
						emitLOD2CrossBillboard(
							x,
							y,
							z,
							blockId,
							baseLight,
							getMaterialType(blockId),
							transparentOut,
						);
					} else {
						emitCrossDiagonalAtBlock(
							x,
							y,
							z,
							blockId,
							baseLight,
							getMaterialType(blockId),
							transparentOut,
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
	// Face normal direction: +1 for front face, -1 for back face on the given axis.
	const dir = isBackFace ? -1 : 1;

	if (axis === 0) {
		// +X face (dir=+1) is outward when x >= size; -X face (dir=-1) is outward when x < 0
		if (x < 0 && dir < 0) return true;
		if (x >= size && dir > 0) return true;
	} else if (axis === 1) {
		if (y < 0 && dir < 0) return true;
		if (y >= size && dir > 0) return true;
	} else {
		if (z < 0 && dir < 0) return true;
		if (z >= size && dir > 0) return true;
	}
	return false;
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
	emitQuad(out, {
		x: x + 0.5,
		y,
		z,
		axis: 0,
		width: 1,
		height: 1,
		blockId,
		isBackFace: false,
		light: baseLight,
		ao: 0,
		faceName: FaceName.PX,
		materialType: materialType,
		flip: false,
	});

	emitQuad(out, {
		x: x + 0.5,
		y,
		z,
		axis: 0,
		width: 1,
		height: 1,
		blockId,
		isBackFace: true,
		light: baseLight,
		ao: 0,
		faceName: FaceName.NX,
		materialType: materialType,
		flip: false,
	});

	// Z-aligned plane (perpendicular to Z axis)
	emitQuad(out, {
		x,
		y,
		z: z + 0.5,
		axis: 2,
		width: 1,
		height: 1,
		blockId,
		isBackFace: false,
		light: baseLight,
		ao: 0,
		faceName: FaceName.PZ,
		materialType: materialType,
		flip: false,
	});

	emitQuad(out, {
		x,
		y,
		z: z + 0.5,
		axis: 2,
		width: 1,
		height: 1,
		blockId,
		isBackFace: true,
		light: baseLight,
		ao: 0,
		faceName: FaceName.NZ,
		materialType: materialType,
		flip: false,
	});
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

	// Diagonal A: NW -> SE
	emitQuad(out, {
		x: cx,
		y,
		z: cz,
		axis: 0,
		width: diagWidth,
		height: 1,
		blockId,
		isBackFace: false,
		light: baseLight,
		ao: 0,
		faceName: FaceName.West,
		materialType: materialType,
		flip: false,
		diagonal: 1,
	});

	emitQuad(out, {
		x: cx,
		y,
		z: cz,
		axis: 0,
		width: diagWidth,
		height: 1,
		blockId,
		isBackFace: true,
		light: baseLight,
		ao: 0,
		faceName: FaceName.East,
		materialType: materialType,
		flip: false,
		diagonal: 1,
	});

	// Diagonal B: NE -> SW
	emitQuad(out, {
		x: cx,
		y,
		z: cz,
		axis: 0,
		width: diagWidth,
		height: 1,
		blockId,
		isBackFace: false,
		light: baseLight,
		ao: 0,
		faceName: FaceName.South,
		materialType: materialType,
		flip: false,
		diagonal: 2,
	});

	emitQuad(out, {
		x: cx,
		y,
		z: cz,
		axis: 0,
		width: diagWidth,
		height: 1,
		blockId,
		isBackFace: true,
		light: baseLight,
		ao: 0,
		faceName: FaceName.North,
		materialType: materialType,
		flip: false,
		diagonal: 2,
	});
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
	emitQuad(out, {
		x: x + 0.5,
		y,
		z,
		axis: 0,
		width: W,
		height: 1,
		blockId,
		isBackFace: false,
		light: baseLight,
		ao: 0,
		faceName: FaceName.PX,
		materialType,
		flip: false,
	});

	emitQuad(out, {
		x: x + 0.5,
		y,
		z,
		axis: 0,
		width: W,
		height: 1,
		blockId,
		isBackFace: true,
		light: baseLight,
		ao: 0,
		faceName: FaceName.NX,
		materialType,
		flip: false,
	});

	// Z-aligned plane
	emitQuad(out, {
		x,
		y,
		z: z + 0.5,
		axis: 2,
		width: W,
		height: 1,
		blockId,
		isBackFace: false,
		light: baseLight,
		ao: 0,
		faceName: FaceName.PZ,
		materialType,
		flip: false,
	});

	emitQuad(out, {
		x,
		y,
		z: z + 0.5,
		axis: 2,
		width: W,
		height: 1,
		blockId,
		isBackFace: true,
		light: baseLight,
		ao: 0,
		faceName: FaceName.NZ,
		materialType,
		flip: false,
	});
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

	const dirX = axis === 0 ? (isBackFace ? -1 : 1) : 0;
	const dirY = axis === 1 ? (isBackFace ? -1 : 1) : 0;
	const dirZ = axis === 2 ? (isBackFace ? -1 : 1) : 0;

	const nx = voxelX + dirX;
	const ny = voxelY + dirY;
	const nz = voxelZ + dirZ;

	const onBoundary =
		axis === 0
			? isBackFace
				? min[0] <= EPS
				: max[0] >= 1 - EPS
			: axis === 1
				? isBackFace
					? min[1] <= EPS
					: max[1] >= 1 - EPS
				: isBackFace
					? min[2] <= EPS
					: max[2] >= 1 - EPS;

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

			ao = computeAO(ctx, nx, ny, nz, uAxis, vAxis);
		}
	}

	const faceName = getFaceName(axis, isBackFace);

	if (axis === 0) {
		emitQuad(out, {
			x: voxelX + (isBackFace ? min[0] : max[0]),
			y: voxelY + min[1],
			z: voxelZ + min[2],
			axis,
			width: max[1] - min[1],
			height: max[2] - min[2],
			blockId,
			isBackFace,
			light,
			ao,
			faceName,
			materialType: currentBlock.materialType,
			flip: false,
		});
		return;
	}

	if (axis === 1) {
		// axis 1 convention matches the old worker:
		// width = Z extent, height = X extent
		emitQuad(out, {
			x: voxelX + min[0],
			y: voxelY + (isBackFace ? min[1] : max[1]),
			z: voxelZ + min[2],
			axis,
			width: max[2] - min[2],
			height: max[0] - min[0],
			blockId,
			isBackFace,
			light,
			ao,
			faceName,
			materialType: currentBlock.materialType,
			flip: false,
		});
		return;
	}

	// axis === 2
	emitQuad(out, {
		x: voxelX + min[0],
		y: voxelY + min[1],
		z: voxelZ + (isBackFace ? min[2] : max[2]),
		axis,
		width: max[0] - min[0],
		height: max[1] - min[1],
		blockId,
		isBackFace,
		light,
		ao,
		faceName,
		materialType: currentBlock.materialType,
		flip: false,
	});
}
