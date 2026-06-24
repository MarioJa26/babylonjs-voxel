// World/MeshPipeline/core/ShapePipeline.ts

import {
	unpackBlockId,
	unpackBlockState,
} from "../../Chunk/DataStructures/BlockEncoding";
import {
	FACE_ALL,
	FACE_NX,
	FACE_NY,
	FACE_NZ,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
	getShapeForBlockId,
	isCrossBlockId,
	isCrossDiagonalBlockId,
} from "../../Shape/BlockShapes";
import {
	getTransformedShapeBoxes,
	type ShapeBounds,
} from "../../Shape/BlockShapeTransforms";
import { type BlockShapeInfo, MaterialType } from "../types/MeshTypes";

/**
 * Dense-cache size for the current packed-block key space.
 * We keep a tiny sparse fallback for safety if a wider packed value appears later.
 */
const DENSE_CACHE_SIZE = 1 << 16;
const DENSE_CACHE_MASK = DENSE_CACHE_SIZE - 1;

/**
 * Small epsilon for face-coverage checks.
 */
const EPS = 1e-6;

/**
 * Rectangle in face-local UV space.
 */
type FaceRect = {
	u0: number;
	u1: number;
	v0: number;
	v1: number;
};

/**
 * Pre-allocated FaceRect pool to avoid per-push allocations.
 * Safe because computeClosedFaceMaskFromBoxes reads all rects
 * before the pool is reused.
 */
const FACE_RECT_POOL: FaceRect[] = [];
for (let i = 0; i < 64; i++) {
	FACE_RECT_POOL.push({ u0: 0, u1: 0, v0: 0, v1: 0 });
}
let _faceRectPoolIndex = 0;

function obtainFaceRect(): FaceRect {
	if (_faceRectPoolIndex < FACE_RECT_POOL.length) {
		return FACE_RECT_POOL[_faceRectPoolIndex++];
	}
	// Overflow: allocate (should not happen in practice)
	const r: FaceRect = { u0: 0, u1: 0, v0: 0, v1: 0 };
	FACE_RECT_POOL.push(r);
	_faceRectPoolIndex++;
	return r;
}

function resetFaceRectPool(): void {
	_faceRectPoolIndex = 0;
}

const _uEdgesScratch: number[] = [0, 1];
const _vEdgesScratch: number[] = [0, 1];

// PERF: Module-level FaceRect arrays reused across computeClosedFaceMaskFromBoxes calls.
const pxArr: FaceRect[] = [];
const nxArr: FaceRect[] = [];
const pyArr: FaceRect[] = [];
const nyArr: FaceRect[] = [];
const pzArr: FaceRect[] = [];
const nzArr: FaceRect[] = [];

/**
 * Empty shape info singleton to avoid reallocating identical objects.
 */
const EMPTY_SHAPE_INFO: BlockShapeInfo = {
	isCube: false,
	isSliceCompatible: false,
	sliceMask: 0,
	closedFaceMask: 0,
};

/**
 * Dense caches keyed by packedBlock (fast path).
 * Pre-allocated with undefined to ensure dense arrays.
 */
const SHAPE_INFO_CACHE: (BlockShapeInfo | undefined)[] = new Array(
	DENSE_CACHE_SIZE,
).fill(undefined);
const RUNTIME_BOX_CACHE: (readonly ShapeBounds[] | undefined)[] = new Array(
	DENSE_CACHE_SIZE,
).fill(undefined);
/**
 * 0 = unknown, 1 = false, 2 = true
 */
const GREEDY_COMPAT_CACHE = new Uint8Array(DENSE_CACHE_SIZE);

/**
 * Sparse overflow fallback if a packed key ever exceeds the dense range.
 */
const SHAPE_INFO_OVERFLOW = new Map<number, BlockShapeInfo>();
const RUNTIME_BOX_OVERFLOW = new Map<number, readonly ShapeBounds[]>();
const GREEDY_COMPAT_OVERFLOW = new Map<number, boolean>();

function canUseDenseCache(packedBlock: number): boolean {
	return packedBlock >= 0 && packedBlock <= DENSE_CACHE_MASK;
}

/**
 * Material bucket rules used by the voxel mesh pipeline.
 *
 * Implemented as a 128-entry Uint8Array LUT (sized to cover the BlockType
 * enum) so each call is a single typed-array load. Bucket values:
 *   0 = reserved / default
 *   1 = stone / mineral (default)
 *   2 = sand / dirt / soil
 *   3 = vegetation
 *   4 = water / glass
 *   5 = wood / logs / planks
 */
const TINT_BUCKET_LUT_SIZE = 128;
const TINT_BUCKET_LUT: Uint8Array = new Uint8Array(TINT_BUCKET_LUT_SIZE).fill(
	1,
);

for (const id of [30, 60, 61]) TINT_BUCKET_LUT[id] = 4;
for (const id of [15, 43, 44, 64, 66]) TINT_BUCKET_LUT[id] = 3;
for (const id of [3, 8, 14, 23, 45, 46, 47]) TINT_BUCKET_LUT[id] = 2;
for (const id of [10, 11, 12, 13, 22, 28, 31]) TINT_BUCKET_LUT[id] = 5;
for (let id = 32; id <= 42; id++) TINT_BUCKET_LUT[id] = 5;

export function getMaterialTintBucket(blockId: number): number {
	return TINT_BUCKET_LUT[blockId] ?? 1;
}

/**
 * Transparent/water bucket selection.
 */
export function getMaterialType(blockId: number): MaterialType {
	return blockId === 30 ||
		blockId === 60 ||
		blockId === 61 ||
		blockId === 64 ||
		blockId === 66
		? MaterialType.WaterOrGlass
		: MaterialType.Default;
}

export function getMaterialTypeForPackedBlock(
	packedBlock: number,
): MaterialType {
	if (!packedBlock) return MaterialType.Default;

	const blockId = unpackBlockId(packedBlock);
	if (isCrossBlockId(blockId) || isCrossDiagonalBlockId(blockId)) {
		return MaterialType.Cutout;
	}

	return getMaterialType(blockId);
}

/**
 * Runtime helper: whether this packed block should render as a crossed plant shape.
 */
export function isCrossShapePackedBlock(packedBlock: number): boolean {
	if (!packedBlock) return false;
	const blockId = unpackBlockId(packedBlock);
	return isCrossBlockId(blockId);
}

export function isCrossDiagonalShapePackedBlock(packedBlock: number): boolean {
	if (!packedBlock) return false;
	const blockId = unpackBlockId(packedBlock);
	return isCrossDiagonalBlockId(blockId);
}

/**
 * Clamp to [0,1]
 */
function clamp01(v: number): number {
	return Math.min(1, Math.max(0, v));
}

/**
 * Push a rectangle into a list (clamped, ordered, non-degenerate).
 */
function pushRect(
	rects: FaceRect[],
	u0: number,
	u1: number,
	v0: number,
	v1: number,
): void {
	const cu0 = clamp01(Math.min(u0, u1));
	const cu1 = clamp01(Math.max(u0, u1));
	const cv0 = clamp01(Math.min(v0, v1));
	const cv1 = clamp01(Math.max(v0, v1));

	if (cu1 - cu0 <= EPS || cv1 - cv0 <= EPS) return;

	const r = obtainFaceRect();
	r.u0 = cu0;
	r.u1 = cu1;
	r.v0 = cv0;
	r.v1 = cv1;
	rects.push(r);
}

/**
 * Returns true if the rect union fully covers [0,1]x[0,1].
 */
function doesRectUnionCoverUnitSquare(rects: FaceRect[]): boolean {
	if (rects.length === 0) return false;

	_uEdgesScratch.length = 2;
	_uEdgesScratch[0] = 0;
	_uEdgesScratch[1] = 1;
	_vEdgesScratch.length = 2;
	_vEdgesScratch[0] = 0;
	_vEdgesScratch[1] = 1;

	for (const r of rects) {
		_uEdgesScratch.push(r.u0, r.u1);
		_vEdgesScratch.push(r.v0, r.v1);
	}

	_uEdgesScratch.sort((a, b) => a - b);
	_vEdgesScratch.sort((a, b) => a - b);

	for (let ui = 0; ui < _uEdgesScratch.length - 1; ui++) {
		const u0 = _uEdgesScratch[ui];
		const u1 = _uEdgesScratch[ui + 1];
		if (u1 - u0 <= EPS) continue;

		for (let vi = 0; vi < _vEdgesScratch.length - 1; vi++) {
			const v0 = _vEdgesScratch[vi];
			const v1 = _vEdgesScratch[vi + 1];
			if (v1 - v0 <= EPS) continue;

			let covered = false;

			for (const r of rects) {
				if (
					r.u0 <= u0 + EPS &&
					r.u1 >= u1 - EPS &&
					r.v0 <= v0 + EPS &&
					r.v1 >= v1 - EPS
				) {
					covered = true;
					break;
				}
			}

			if (!covered) return false;
		}
	}

	return true;
}

/**
 * Build transformed runtime boxes once (uncached internal builder).
 */
function buildRuntimeShapeBoxes(packedBlock: number): readonly ShapeBounds[] {
	if (!packedBlock) return [];

	const blockId = unpackBlockId(packedBlock);
	const blockState = unpackBlockState(packedBlock);
	return getTransformedShapeBoxes(blockId, blockState);
}

/**
 * Public runtime-box accessor with dense cache + sparse overflow fallback.
 */
export function getRuntimeShapeBoxes(
	packedBlock: number,
): readonly ShapeBounds[] {
	if (!packedBlock) return [];

	if (canUseDenseCache(packedBlock)) {
		const cached = RUNTIME_BOX_CACHE[packedBlock];
		if (cached) return cached;

		const boxes = buildRuntimeShapeBoxes(packedBlock);
		RUNTIME_BOX_CACHE[packedBlock] = boxes;
		return boxes;
	}

	const overflow = RUNTIME_BOX_OVERFLOW.get(packedBlock);
	if (overflow) return overflow;

	const boxes = buildRuntimeShapeBoxes(packedBlock);
	RUNTIME_BOX_OVERFLOW.set(packedBlock, boxes);
	return boxes;
}

/**
 * Compute which voxel faces are fully closed by the transformed shape boxes.
 *
 * IMPORTANT:
 * We honor each transformed box's faceMask, so a face only contributes to closure
 * if that box actually exposes that face.
 */
function computeClosedFaceMaskFromBoxes(boxes: readonly ShapeBounds[]): number {
	if (boxes.length === 0) return 0;

	resetFaceRectPool();
	// PERF: Reuse module-level arrays instead of allocating 6 new arrays per call.
	pxArr.length = 0;
	nxArr.length = 0;
	pyArr.length = 0;
	nyArr.length = 0;
	pzArr.length = 0;
	nzArr.length = 0;

	for (const box of boxes) {
		const min = box.min;
		const max = box.max;
		const faceMask = box.faceMask;

		// +X / -X faces map to YZ
		if ((faceMask & FACE_PX) !== 0 && max[0] >= 1 - EPS) {
			pushRect(pxArr, min[1], max[1], min[2], max[2]);
		}
		if ((faceMask & FACE_NX) !== 0 && min[0] <= EPS) {
			pushRect(nxArr, min[1], max[1], min[2], max[2]);
		}

		// +Y / -Y faces map to XZ
		if ((faceMask & FACE_PY) !== 0 && max[1] >= 1 - EPS) {
			pushRect(pyArr, min[0], max[0], min[2], max[2]);
		}
		if ((faceMask & FACE_NY) !== 0 && min[1] <= EPS) {
			pushRect(nyArr, min[0], max[0], min[2], max[2]);
		}

		// +Z / -Z faces map to XY
		if ((faceMask & FACE_PZ) !== 0 && max[2] >= 1 - EPS) {
			pushRect(pzArr, min[0], max[0], min[1], max[1]);
		}
		if ((faceMask & FACE_NZ) !== 0 && min[2] <= EPS) {
			pushRect(nzArr, min[0], max[0], min[1], max[1]);
		}
	}

	let mask = 0;
	if (doesRectUnionCoverUnitSquare(pxArr)) mask |= FACE_PX;
	if (doesRectUnionCoverUnitSquare(nxArr)) mask |= FACE_NX;
	if (doesRectUnionCoverUnitSquare(pyArr)) mask |= FACE_PY;
	if (doesRectUnionCoverUnitSquare(nyArr)) mask |= FACE_NY;
	if (doesRectUnionCoverUnitSquare(pzArr)) mask |= FACE_PZ;
	if (doesRectUnionCoverUnitSquare(nzArr)) mask |= FACE_NZ;

	return mask;
}

/**
 * Helper: check whether the transformed runtime shape is a full unit cube.
 */
function isFullCubeFromBoxes(
	shapeBoxCount: number,
	boxes: readonly ShapeBounds[],
): boolean {
	if (shapeBoxCount !== 1 || boxes.length !== 1) {
		return false;
	}

	const box = boxes[0];

	return (
		box.min[0] === 0 &&
		box.min[1] === 0 &&
		box.min[2] === 0 &&
		box.max[0] === 1 &&
		box.max[1] === 1 &&
		box.max[2] === 1 &&
		box.faceMask === FACE_ALL
	);
}

/**
 * Build runtime shape info once (uncached internal builder).
 */
function buildShapeInfo(packedBlock: number): BlockShapeInfo {
	if (!packedBlock) {
		return EMPTY_SHAPE_INFO;
	}

	const blockId = unpackBlockId(packedBlock);
	const blockState = unpackBlockState(packedBlock);
	const shape = getShapeForBlockId(blockId);
	const boxes = getRuntimeShapeBoxes(packedBlock);

	const closedFaceMask = computeClosedFaceMaskFromBoxes(boxes);

	return {
		isCube: isFullCubeFromBoxes(shape.boxes.length, boxes),
		isSliceCompatible: shape.usesSliceState,
		sliceMask: shape.usesSliceState ? (blockState >> 3) & 0x7 : 0,
		closedFaceMask,
	};
}

/**
 * Runtime shape metadata consumed by the greedy/face/AO pipeline.
 */
export function getShapeInfo(packedBlock: number): BlockShapeInfo {
	if (!packedBlock) {
		return EMPTY_SHAPE_INFO;
	}

	if (canUseDenseCache(packedBlock)) {
		const cached = SHAPE_INFO_CACHE[packedBlock];
		if (cached) return cached;

		const info = buildShapeInfo(packedBlock);
		SHAPE_INFO_CACHE[packedBlock] = info;
		return info;
	}

	const overflow = SHAPE_INFO_OVERFLOW.get(packedBlock);
	if (overflow) return overflow;

	const info = buildShapeInfo(packedBlock);
	SHAPE_INFO_OVERFLOW.set(packedBlock, info);
	return info;
}

/**
 * Determine whether a packed block can safely participate in the fast greedy path.
 *
 * Greedy-compatible means:
 * - full cubes
 * - slice-compatible full-box shapes (your slab-style shapes)
 *
 * Everything else (stairs, panes, fences, torches, crosses, sheets, etc.)
 * should be emitted in a separate custom-shape pass.
 */
export function isGreedyCompatiblePackedBlock(packedBlock: number): boolean {
	if (!packedBlock) return false;

	if (canUseDenseCache(packedBlock)) {
		const state = GREEDY_COMPAT_CACHE[packedBlock];
		if (state !== 0) {
			return state === 2;
		}

		const result = buildGreedyCompatible(packedBlock);
		GREEDY_COMPAT_CACHE[packedBlock] = result ? 2 : 1;
		return result;
	}

	const overflow = GREEDY_COMPAT_OVERFLOW.get(packedBlock);
	if (overflow !== undefined) return overflow;

	const result = buildGreedyCompatible(packedBlock);
	GREEDY_COMPAT_OVERFLOW.set(packedBlock, result);
	return result;
}

function buildGreedyCompatible(packedBlock: number): boolean {
	if (!packedBlock) return false;

	const blockId = unpackBlockId(packedBlock);
	const shape = getShapeForBlockId(blockId);

	// Full cube is always greedy-compatible.
	if (getShapeInfo(packedBlock).isCube) {
		return true;
	}

	// Slice-compatible full-box shape (slab-style) is also greedy-compatible.
	if (
		shape.usesSliceState &&
		shape.boxes.length === 1 &&
		shape.boxes[0].faceMask === FACE_ALL &&
		shape.boxes[0].min[0] === 0 &&
		shape.boxes[0].min[1] === 0 &&
		shape.boxes[0].min[2] === 0 &&
		shape.boxes[0].max[0] === 1 &&
		shape.boxes[0].max[1] === 1 &&
		shape.boxes[0].max[2] === 1
	) {
		return true;
	}

	return false;
}
