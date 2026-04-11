// World/MeshPipeline/core/CustomShapeEmitter.ts

import {
  MeshContext,
  WorkerInternalMeshData,
  MaterialType,
} from "../types/MeshTypes";
import { emitQuad } from "./FaceEmitter";

import {
  getShapeInfo,
  getRuntimeShapeBoxes,
  getMaterialType,
  isGreedyCompatiblePackedBlock,
  isCrossShapePackedBlock,
  isCrossDiagonalShapePackedBlock,
} from "./ShapePipeline";

import { computeAO } from "./AOPipeline";
import {
  FACE_PX,
  FACE_NX,
  FACE_PY,
  FACE_NY,
  FACE_PZ,
  FACE_NZ,
} from "../../Shape/BlockShapes";
import { unpackBlockId } from "../../BlockEncoding";

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

function parseBlock(packed: number): ParsedBlock {
  if (!packed) {
    return {
      packed: 0,
      blockId: 0,
      shape: getShapeInfo(0),
      materialType: MaterialType.Default,
      isSolid: false,
      isTransparent: true,
      greedyCompatible: false,
    };
  }

  const blockId = unpackBlockId(packed);
  const shape = getShapeInfo(packed);
  const materialType = getMaterialType(blockId);

  return {
    packed,
    blockId,
    shape,
    materialType,
    isSolid: blockId !== 0,
    isTransparent: materialType === MaterialType.WaterOrGlass,
    greedyCompatible: isGreedyCompatiblePackedBlock(packed),
  };
}

function getFaceName(axis: number, isBackFace: boolean): string {
  // Match the old working worker mesher convention
  if (axis === 0) return isBackFace ? "east" : "west";
  if (axis === 1) return isBackFace ? "bottom" : "top";
  return isBackFace ? "north" : "south";
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
 */
export function emitCustomShapes(
  ctx: MeshContext,
  opaqueOut: WorkerInternalMeshData,
  transparentOut: WorkerInternalMeshData,
): void {
  const size = ctx.size;
  const getBlock = ctx.getBlock;
  const getLight = ctx.getLight;

  for (let y = 0; y < size; y++) {
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const packed = getBlock(x, y, z, 0);
        if (!packed) continue;

        if (isGreedyCompatiblePackedBlock(packed)) {
          continue;
        }

        const blockId = unpackBlockId(packed);
        const materialType = getMaterialType(blockId);
        const out =
          materialType === MaterialType.WaterOrGlass
            ? transparentOut
            : opaqueOut;

        const baseLight = getLight(x, y, z, 0);

        // Cross-shape vegetation lives here now too.
        if (isCrossShapePackedBlock(packed)) {
          emitCrossShapeAtBlock(
            x,
            y,
            z,
            blockId,
            baseLight,
            materialType,
            transparentOut,
          );
          continue;
        }

        // New true diagonal cross
        if (isCrossDiagonalShapePackedBlock(packed)) {
          emitCrossDiagonalAtBlock(
            x,
            y,
            z,
            blockId,
            baseLight,
            materialType,
            transparentOut,
          );
          continue;
        }

        const boxes = getRuntimeShapeBoxes(packed);
        if (boxes.length === 0) continue;

        for (let i = 0; i < boxes.length; i++) {
          const box = boxes[i];

          for (const face of FACE_DESCRIPTORS) {
            if ((box.faceMask & face.bit) === 0) continue;

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
    faceName: "+x",
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
    faceName: "-x",
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
    faceName: "+z",
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
    faceName: "-z",
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
    faceName: "west",
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
    faceName: "east",
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
    faceName: "south",
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
    faceName: "north",
    materialType: materialType,
    flip: false,
    diagonal: 2,
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
  const currentBlock = parseBlock(packedBlock);

  const dir =
    axis === 0
      ? [isBackFace ? -1 : 1, 0, 0]
      : axis === 1
        ? [0, isBackFace ? -1 : 1, 0]
        : [0, 0, isBackFace ? -1 : 1];

  const nx = voxelX + dir[0];
  const ny = voxelY + dir[1];
  const nz = voxelZ + dir[2];

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
    const neighbor = parseBlock(neighborPacked);

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

      ao = computeAO(
        ctx,
        nx,
        ny,
        nz,
        axis,
        isBackFace,
        uAxis,
        vAxis,
        getShapeInfo,
      );
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
