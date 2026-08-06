// MeshPipeline/core/BlockInfoCache.ts

// Unified per-packed-block cache.
//
// Previously the pipeline kept FOUR separate dense caches keyed by the same
// packed-block value (FLAGS_ID_CACHE in BlockFlags.ts, plus SHAPE_INFO_CACHE,
// RUNTIME_BOX_CACHE and GREEDY_COMPAT_CACHE in ShapePipeline.ts), and
// BlockFlags.buildEntry re-derived shape info that ShapePipeline already held.
// A single cell on the hot path could therefore probe several cache
// structures and pay duplicated derivation work.
//
// This module owns ONE cache: a Uint32 entry per packed value holding
// (ready | isCube | blockId | flags), with parallel arrays for the lazily
// built BlockShapeInfo and runtime shape boxes. Every accessor is a single
// probe; building an entry computes flags, isCube, shape info, boxes and
// greedy-compatibility exactly once, and every accessor shares that result.
//
// The cache is immutable after fill (block data itself never changes inside a
// worker build), so module-level storage is safe: entries are computed lazily
// and never mutated once written.

import {
	unpackBlockId,
	unpackBlockState,
} from "../../Chunk/DataStructures/BlockEncoding";
import {
	BLOCK_TYPE,
	WATER_BLOCK_ID,
} from "../../Chunk/Worker/ChunkMesherConstants";
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
import { isFenceBlockId } from "../../Shape/FenceConnect";
import { type BlockShapeInfo, MaterialType } from "../types/MeshTypes";

// ---------------------------------------------------------------------------
// Block flag bits (derived once per packed value, stored in the cache entry)
// ---------------------------------------------------------------------------

export const FLAG_SOLID = 1 << 0;
export const FLAG_TRANSPARENT = 1 << 1;
export const FLAG_PARTIAL = 1 << 2;
export const FLAG_GREEDY = 1 << 3;
export const FLAG_WATER_GLASS = 1 << 4;
export const FLAG_CUSTOM_CROSS = 1 << 5;
export const FLAG_CUSTOM_CROSS_DIAGONAL = 1 << 6;
export const FLAG_CUSTOM_FENCE = 1 << 7;

// ---------------------------------------------------------------------------
// Cache entry layout (Uint32 per packed value):
//   bit 31     = ready
//   bit 30     = isCube
//   bits 16-25 = block id (BLOCK_ID_BITS = 10)
//   bits 0-15  = flags
// ---------------------------------------------------------------------------

const DENSE_CACHE_SIZE = 1 << 16;
const DENSE_CACHE_MASK = DENSE_CACHE_SIZE - 1;

const FIC_READY = 1 << 31;
const FIC_ISCUBE = 1 << 30;
const FIC_ID_SHIFT = 16;
const FIC_ID_MASK = 0x3ff << FIC_ID_SHIFT;
const FIC_FLAGS_MASK = 0xffff;

const ENTRIES = new Uint32Array(DENSE_CACHE_SIZE);
const SHAPES: (BlockShapeInfo | undefined)[] = new Array(DENSE_CACHE_SIZE).fill(
	undefined,
);
const BOXES: (readonly ShapeBounds[] | undefined)[] = new Array(
	DENSE_CACHE_SIZE,
).fill(undefined);

// Sparse overflow fallback (only for packed keys beyond the dense range).
const ENTRIES_OVERFLOW = new Map<number, number>();
const SHAPES_OVERFLOW = new Map<number, BlockShapeInfo>();
const BOXES_OVERFLOW = new Map<number, readonly ShapeBounds[]>();

function canUseDenseCache(packed: number): boolean {
	return packed >= 0 && packed <= DENSE_CACHE_MASK;
}

// ---------------------------------------------------------------------------
// Glass-specific flag — set for block IDs that are glass (not water).
// Used by VoxelMaskExtractor for transparent interface preference.
// ---------------------------------------------------------------------------

const GLASS_BLOCK_IDS = new Set([60, 61]);
const GLASS_LUT = (() => {
	const lut = new Uint8Array(256);
	for (const id of GLASS_BLOCK_IDS) lut[id] = 1;
	return lut;
})();

export function isGlassBlock(blockId: number): boolean {
	return blockId >= 0 && blockId < 256 && GLASS_LUT[blockId] !== 0;
}

// ---------------------------------------------------------------------------
// Material / tint LUTs (indexed by block id, not packed value)
// ---------------------------------------------------------------------------

const TINT_BUCKET_LUT_SIZE = 128;
const TINT_BUCKET_LUT: Uint8Array = new Uint8Array(TINT_BUCKET_LUT_SIZE).fill(
	1,
);

for (const id of [WATER_BLOCK_ID, 60, 61]) TINT_BUCKET_LUT[id] = 4;
for (const id of [15, 43, 44, 64, 66]) TINT_BUCKET_LUT[id] = 3;
for (const id of [3, 8, 14, 23, 45, 46, 47]) TINT_BUCKET_LUT[id] = 2;
for (const id of [10, 11, 12, 13, 22, 28, 31]) TINT_BUCKET_LUT[id] = 5;
for (let id = 32; id <= 42; id++) TINT_BUCKET_LUT[id] = 5;

/**
 * Packed tint lookup table for hot-path access.
 * Sized to cover BlockType enum range. Built once at module load.
 */
export const BlockTint: Uint8Array = new Uint8Array(TINT_BUCKET_LUT_SIZE);
for (let id = 0; id < TINT_BUCKET_LUT_SIZE; id++) {
	BlockTint[id] = TINT_BUCKET_LUT[id];
}

const MATERIAL_TYPE_LUT_SIZE = 128;
const MATERIAL_TYPE_LUT: Uint8Array = new Uint8Array(MATERIAL_TYPE_LUT_SIZE);
for (const id of [WATER_BLOCK_ID, 60, 61]) {
	MATERIAL_TYPE_LUT[id] = MaterialType.WaterOrGlass;
}

/**
 * Transparent/water bucket selection.
 */
export function getMaterialType(blockId: number): MaterialType {
	return (MATERIAL_TYPE_LUT[blockId] ?? MaterialType.Default) as MaterialType;
}

// ---------------------------------------------------------------------------
// Shape metadata derivation (shared by every cache accessor)
// ---------------------------------------------------------------------------

const EPS = 1e-6;

/**
 * Empty shape info singleton to avoid reallocating identical objects.
 */
const EMPTY_SHAPE_INFO: BlockShapeInfo = {
	isCube: false,
	isSliceCompatible: false,
	sliceMask: 0,
	closedFaceMask: 0,
};

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
 *
 * PERF: Optimized for small N (typical block shapes have 1-3 rects per face).
 * Uses direct geometric checks instead of the general O(n²) edge-sweep
 * algorithm for the common cases.
 */
function doesRectUnionCoverUnitSquare(rects: FaceRect[]): boolean {
	const n = rects.length;
	if (n === 0) return false;

	// Fast path: single rect must cover [0,1]x[0,1]
	if (n === 1) {
		const r = rects[0];
		if (!r) return false;
		return r.u0 <= EPS && r.u1 >= 1 - EPS && r.v0 <= EPS && r.v1 >= 1 - EPS;
	}

	// Fast path: two rects — check if either fully covers, or if they
	// partition the square along one axis (horizontal or vertical split).
	if (n === 2) {
		const a = rects[0];
		const b = rects[1];
		if (!a || !b) return false;
		// Single rect covers everything
		if (a.u0 <= EPS && a.u1 >= 1 - EPS && a.v0 <= EPS && a.v1 >= 1 - EPS)
			return true;
		if (b.u0 <= EPS && b.u1 >= 1 - EPS && b.v0 <= EPS && b.v1 >= 1 - EPS)
			return true;
		// Vertical split: a covers left, b covers right
		if (
			a.v0 <= EPS &&
			a.v1 >= 1 - EPS &&
			b.v0 <= EPS &&
			b.v1 >= 1 - EPS &&
			a.u0 <= EPS &&
			a.u1 + EPS >= b.u0 &&
			b.u1 >= 1 - EPS
		)
			return true;
		// Horizontal split: a covers bottom, b covers top
		if (
			a.u0 <= EPS &&
			a.u1 >= 1 - EPS &&
			b.u0 <= EPS &&
			b.u1 >= 1 - EPS &&
			a.v0 <= EPS &&
			a.v1 + EPS >= b.v0 &&
			b.v1 >= 1 - EPS
		)
			return true;
		// L-shaped: check all 4 corners are covered by either rect
		return doesTwoRectsCoverUnitSquare(a, b);
	}

	// Fast path: 3-4 rects — check if any single rect covers everything
	// (common for cross/fence shapes with a full-cover face)
	for (let i = 0; i < n; i++) {
		const r = rects[i];
		if (!r) continue;
		if (r.u0 <= EPS && r.u1 >= 1 - EPS && r.v0 <= EPS && r.v1 >= 1 - EPS)
			return true;
	}

	// General case (5+ rects or complex 3-4 rect arrangements):
	// Use edge-sweep algorithm. Bounded by at most 10 edges per axis
	// (2 origin + 2 per rect), so O(10² × N) = O(N) effectively.
	return doesRectUnionCoverUnitSquareGeneral(rects);
}

/** Check if two L/T-shaped rects cover the unit square. */
function doesTwoRectsCoverUnitSquare(a: FaceRect, b: FaceRect): boolean {
	// All 4 corners of [0,1]x[0,1] must be covered by at least one rect.
	const corners: Array<[number, number]> = [
		[0, 0],
		[1, 0],
		[0, 1],
		[1, 1],
	];
	for (const [u, v] of corners) {
		const inA =
			u >= a.u0 - EPS && u <= a.u1 + EPS && v >= a.v0 - EPS && v <= a.v1 + EPS;
		const inB =
			u >= b.u0 - EPS && u <= b.u1 + EPS && v >= b.v0 - EPS && v <= b.v1 + EPS;
		if (!inA && !inB) return false;
	}
	// Corners covered — for convex shapes this is sufficient, but we need
	// to also verify the center edge isn't missed. Check the intersection
	// of the two rects' coverage on each edge.
	// Actually for the unit square with only 2 rects, if all 4 corners
	// are covered AND the rects overlap or touch, the full square is covered.
	// Verify overlap/touch on at least one axis:
	const uOverlap = Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0) >= -EPS;
	const vOverlap = Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0) >= -EPS;
	return uOverlap || vOverlap;
}

/** General edge-sweep coverage check for complex multi-rect arrangements. */
function doesRectUnionCoverUnitSquareGeneral(rects: FaceRect[]): boolean {
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
 * Determine whether a packed block can safely participate in the fast greedy path.
 *
 * Greedy-compatible means:
 * - full cubes
 * - slice-compatible full-box shapes (slab-style shapes)
 *
 * Everything else (stairs, panes, fences, torches, crosses, sheets, etc.)
 * should be emitted in a separate custom-shape pass.
 */
function isGreedyCompatibleFromShape(
	blockId: number,
	packedBlock: number,
	shapeInfo: BlockShapeInfo,
	boxes: readonly ShapeBounds[],
): boolean {
	if (!packedBlock) return false;

	const shape = getShapeForBlockId(blockId);

	// Full cube is always greedy-compatible.
	if (shapeInfo.isCube) {
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

	void boxes;
	return false;
}

/**
 * Build the full cached entry for a packed block:
 *   - Uint32 entry (ready | isCube | id | flags)
 *   - shape info + runtime boxes (parallel arrays)
 *
 * Every cache accessor funnels through here, so each derived value is
 * computed exactly once per packed value.
 */
function buildEntry(packed: number): number {
	const id = unpackBlockId(packed);
	const blockState = unpackBlockState(packed);
	const shape = getShapeForBlockId(id);
	const boxes = getTransformedShapeBoxes(id, blockState);

	const shapeInfo: BlockShapeInfo = {
		isCube: isFullCubeFromBoxes(shape.boxes.length, boxes),
		isSliceCompatible: shape.usesSliceState,
		sliceMask: shape.usesSliceState ? (blockState >> 3) & 0x7 : 0,
		closedFaceMask: computeClosedFaceMaskFromBoxes(boxes),
	};

	const materialType = getMaterialType(id);
	const greedyCompatible = isGreedyCompatibleFromShape(
		id,
		packed,
		shapeInfo,
		boxes,
	);

	let flags = 0;
	if (id !== 0) flags |= FLAG_SOLID;
	if (materialType === MaterialType.WaterOrGlass || BLOCK_TYPE[id] !== 0) {
		flags |= FLAG_TRANSPARENT;
	}
	if (!shapeInfo.isCube) flags |= FLAG_PARTIAL;
	if (greedyCompatible) flags |= FLAG_GREEDY;
	if (materialType === MaterialType.WaterOrGlass) flags |= FLAG_WATER_GLASS;
	if (!greedyCompatible) {
		if (isCrossBlockId(id)) flags |= FLAG_CUSTOM_CROSS;
		else if (isCrossDiagonalBlockId(id)) flags |= FLAG_CUSTOM_CROSS_DIAGONAL;
		else if (isFenceBlockId(id)) flags |= FLAG_CUSTOM_FENCE;
	}

	const entry =
		FIC_READY |
		(id << FIC_ID_SHIFT) |
		(flags & FIC_FLAGS_MASK) |
		(shapeInfo.isCube ? FIC_ISCUBE : 0);

	if (canUseDenseCache(packed)) {
		ENTRIES[packed] = entry >>> 0;
		SHAPES[packed] = shapeInfo;
		BOXES[packed] = boxes;
	} else {
		ENTRIES_OVERFLOW.set(packed, entry >>> 0);
		SHAPES_OVERFLOW.set(packed, shapeInfo);
		BOXES_OVERFLOW.set(packed, boxes);
	}

	return entry >>> 0;
}

/**
 * Fetch the stored Uint32 entry for a packed value (building it on first
 * access). Returns 0 only for air (packed === 0) or unknown overflow keys
 * are handled via buildEntry above, so callers can treat 0 as "air".
 */
function getEntry(packed: number): number {
	if (!packed) return 0;

	if (canUseDenseCache(packed)) {
		const e = ENTRIES[packed];
		if (e & FIC_READY) return e;
		return buildEntry(packed);
	}

	const overflow = ENTRIES_OVERFLOW.get(packed);
	if (overflow !== undefined) return overflow;
	return buildEntry(packed);
}

// ---------------------------------------------------------------------------
// Public accessors — each is a single cache probe
// ---------------------------------------------------------------------------

/**
 * Combined flags + id lookup — the hot path. Flags in the low 16 bits,
 * id in bits 16-25. Returns 0 only for air (packed === 0).
 */
export function getCachedFlagsAndId(packed: number): number {
	return getEntry(packed) & (FIC_FLAGS_MASK | FIC_ID_MASK);
}

const FLAGS_AND_ID_ID_MASK = 0xffff0000;

export function getFlagsFromCombined(combined: number): number {
	return combined & 0xffff;
}

export function getIdFromCombined(combined: number): number {
	return (combined & FLAGS_AND_ID_ID_MASK) >>> 16;
}

export function getCachedFlags(packed: number): number {
	return getEntry(packed) & FIC_FLAGS_MASK;
}

export function getCachedBlockId(packed: number): number {
	if (!packed) return 0;
	return (getEntry(packed) & FIC_ID_MASK) >>> FIC_ID_SHIFT;
}

export function getCachedIsCube(packed: number): boolean {
	if (!packed) return false;
	return (getEntry(packed) & FIC_ISCUBE) !== 0;
}

export function isGreedyCompatiblePackedBlock(packed: number): boolean {
	if (!packed) return false;
	return (getEntry(packed) & FLAG_GREEDY) !== 0;
}

/**
 * Runtime shape metadata consumed by the greedy/face/AO pipeline.
 */
export function getShapeInfo(packed: number): BlockShapeInfo {
	if (!packed) return EMPTY_SHAPE_INFO;

	if (canUseDenseCache(packed)) {
		const cached = SHAPES[packed];
		if (cached) return cached;

		buildEntry(packed);
		return SHAPES[packed] ?? EMPTY_SHAPE_INFO;
	}

	const overflow = SHAPES_OVERFLOW.get(packed);
	if (overflow) return overflow;

	buildEntry(packed);
	return SHAPES_OVERFLOW.get(packed) ?? EMPTY_SHAPE_INFO;
}

/**
 * Public runtime-box accessor with dense cache + sparse overflow fallback.
 */
export function getRuntimeShapeBoxes(packed: number): readonly ShapeBounds[] {
	if (!packed) return [];

	if (canUseDenseCache(packed)) {
		const cached = BOXES[packed];
		if (cached) return cached;

		buildEntry(packed);
		return BOXES[packed] ?? [];
	}

	const overflow = BOXES_OVERFLOW.get(packed);
	if (overflow) return overflow;

	buildEntry(packed);
	return BOXES_OVERFLOW.get(packed) ?? [];
}
