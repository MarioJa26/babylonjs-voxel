// World/MeshPipeline/core/ShapePipeline.ts

import { unpackBlockId, unpackBlockState } from "../../BlockEncoding.js";
import {
  FACE_ALL,
  FACE_PX,
  FACE_NX,
  FACE_PY,
  FACE_NY,
  FACE_PZ,
  FACE_NZ,
  getShapeForBlockId,
} from "../../Shape/BlockShapes.js";
import {
  getTransformedShapeBoxes,
  type ShapeBounds,
} from "../../Shape/BlockShapeTransforms.js";
import { BlockShapeInfo, MaterialType } from "../types/MeshTypes.js";

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
 */
const SHAPE_INFO_CACHE: (BlockShapeInfo | undefined)[] = new Array(
  DENSE_CACHE_SIZE,
);
const RUNTIME_BOX_CACHE: (readonly ShapeBounds[] | undefined)[] = new Array(
  DENSE_CACHE_SIZE,
);
/**
 * 0 = unknown, 1 = false, 2 = true
 */
const GREEDY_COMPAT_CACHE = new Uint8Array(DENSE_CACHE_SIZE);

/**
 * Optional tiny shape-name cache for the dense key range.
 */
const SHAPE_NAME_CACHE: (string | undefined)[] = new Array(DENSE_CACHE_SIZE);

/**
 * Sparse overflow fallback if a packed key ever exceeds the dense range.
 */
const SHAPE_INFO_OVERFLOW = new Map<number, BlockShapeInfo>();
const RUNTIME_BOX_OVERFLOW = new Map<number, readonly ShapeBounds[]>();
const GREEDY_COMPAT_OVERFLOW = new Map<number, boolean>();
const SHAPE_NAME_OVERFLOW = new Map<number, string>();

function canUseDenseCache(packedBlock: number): boolean {
  return packedBlock >= 0 && packedBlock <= DENSE_CACHE_MASK;
}

/**
 * Material bucket rules used by the voxel mesh pipeline.
 */
export function getMaterialTintBucket(blockId: number): number {
  // water/glass
  if (blockId === 30 || blockId === 60 || blockId === 61) return 4;

  // vegetation
  if (blockId === 15 || blockId === 43 || blockId === 44 || blockId === 64)
    return 3;

  // sand/dirt/soil
  if (
    blockId === 3 ||
    blockId === 8 ||
    blockId === 14 ||
    blockId === 23 ||
    blockId === 45 ||
    blockId === 46 ||
    blockId === 47
  ) {
    return 2;
  }

  // wood, logs, planks
  if (
    blockId === 10 ||
    blockId === 11 ||
    blockId === 12 ||
    blockId === 13 ||
    blockId === 22 ||
    blockId === 28 ||
    blockId === 31 ||
    (blockId >= 32 && blockId <= 42)
  ) {
    return 5;
  }

  // default: stone/mineral
  return 1;
}

/**
 * Transparent/water bucket selection.
 */
export function getMaterialType(blockId: number): MaterialType {
  return blockId === 30 || blockId === 60 || blockId === 61 || blockId === 64
    ? MaterialType.WaterOrGlass
    : MaterialType.Default;
}

export function getMaterialTypeForPackedBlock(
  packedBlock: number,
): MaterialType {
  if (!packedBlock) return MaterialType.Default;

  if (
    isCrossShapePackedBlock(packedBlock) ||
    isCrossDiagonalShapePackedBlock(packedBlock)
  ) {
    return MaterialType.Cutout;
  }

  const { blockId } = getPackedBlockParts(packedBlock);
  return getMaterialType(blockId);
}

/**
 * Helper: decode packed block into id + state.
 */
export function getPackedBlockParts(packedBlock: number): {
  blockId: number;
  blockState: number;
} {
  return {
    blockId: unpackBlockId(packedBlock),
    blockState: unpackBlockState(packedBlock),
  };
}

/**
 * Runtime helper: get the authored shape name for a packed block.
 */
export function getShapeNameForPackedBlock(packedBlock: number): string {
  if (!packedBlock) return "cube";

  if (canUseDenseCache(packedBlock)) {
    const cached = SHAPE_NAME_CACHE[packedBlock];
    if (cached) return cached;

    const { blockId } = getPackedBlockParts(packedBlock);
    const name = getShapeForBlockId(blockId).name;
    SHAPE_NAME_CACHE[packedBlock] = name;
    return name;
  }

  const overflow = SHAPE_NAME_OVERFLOW.get(packedBlock);
  if (overflow) return overflow;

  const { blockId } = getPackedBlockParts(packedBlock);
  const name = getShapeForBlockId(blockId).name;
  SHAPE_NAME_OVERFLOW.set(packedBlock, name);
  return name;
}

/**
 * Runtime helper: whether this packed block should render as a crossed plant shape.
 */
export function isCrossShapePackedBlock(packedBlock: number): boolean {
  return getShapeNameForPackedBlock(packedBlock) === "cross";
}

export function isCrossDiagonalShapePackedBlock(packedBlock: number): boolean {
  return getShapeNameForPackedBlock(packedBlock) === "cross_diagonal";
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

  rects.push({ u0: cu0, u1: cu1, v0: cv0, v1: cv1 });
}

/**
 * Returns true if the rect union fully covers [0,1]x[0,1].
 */
function doesRectUnionCoverUnitSquare(rects: FaceRect[]): boolean {
  if (rects.length === 0) return false;

  const uEdges: number[] = [0, 1];
  const vEdges: number[] = [0, 1];

  for (const r of rects) {
    uEdges.push(r.u0, r.u1);
    vEdges.push(r.v0, r.v1);
  }

  uEdges.sort((a, b) => a - b);
  vEdges.sort((a, b) => a - b);

  for (let ui = 0; ui < uEdges.length - 1; ui++) {
    const u0 = uEdges[ui];
    const u1 = uEdges[ui + 1];
    if (u1 - u0 <= EPS) continue;

    for (let vi = 0; vi < vEdges.length - 1; vi++) {
      const v0 = vEdges[vi];
      const v1 = vEdges[vi + 1];
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

  const { blockId, blockState } = getPackedBlockParts(packedBlock);
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

  const px: FaceRect[] = [];
  const nx: FaceRect[] = [];
  const py: FaceRect[] = [];
  const ny: FaceRect[] = [];
  const pz: FaceRect[] = [];
  const nz: FaceRect[] = [];

  for (const box of boxes) {
    const min = box.min;
    const max = box.max;
    const faceMask = box.faceMask;

    // +X / -X faces map to YZ
    if ((faceMask & FACE_PX) !== 0 && max[0] >= 1 - EPS) {
      pushRect(px, min[1], max[1], min[2], max[2]);
    }
    if ((faceMask & FACE_NX) !== 0 && min[0] <= EPS) {
      pushRect(nx, min[1], max[1], min[2], max[2]);
    }

    // +Y / -Y faces map to XZ
    if ((faceMask & FACE_PY) !== 0 && max[1] >= 1 - EPS) {
      pushRect(py, min[0], max[0], min[2], max[2]);
    }
    if ((faceMask & FACE_NY) !== 0 && min[1] <= EPS) {
      pushRect(ny, min[0], max[0], min[2], max[2]);
    }

    // +Z / -Z faces map to XY
    if ((faceMask & FACE_PZ) !== 0 && max[2] >= 1 - EPS) {
      pushRect(pz, min[0], max[0], min[1], max[1]);
    }
    if ((faceMask & FACE_NZ) !== 0 && min[2] <= EPS) {
      pushRect(nz, min[0], max[0], min[1], max[1]);
    }
  }

  let mask = 0;
  if (doesRectUnionCoverUnitSquare(px)) mask |= FACE_PX;
  if (doesRectUnionCoverUnitSquare(nx)) mask |= FACE_NX;
  if (doesRectUnionCoverUnitSquare(py)) mask |= FACE_PY;
  if (doesRectUnionCoverUnitSquare(ny)) mask |= FACE_NY;
  if (doesRectUnionCoverUnitSquare(pz)) mask |= FACE_PZ;
  if (doesRectUnionCoverUnitSquare(nz)) mask |= FACE_NZ;

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

  const { blockId, blockState } = getPackedBlockParts(packedBlock);
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

  const { blockId } = getPackedBlockParts(packedBlock);
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
