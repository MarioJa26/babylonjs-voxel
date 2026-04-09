// World/MeshPipeline/core/CustomShapeEmitter.ts

import {
  MeshContext,
  WorkerInternalMeshData,
  MaterialType,
} from "../types/MeshTypes.js";
import { emitQuad } from "./FaceEmitter.js";
import {
  getShapeInfo,
  getRuntimeShapeBoxes,
  getMaterialType,
  isGreedyCompatiblePackedBlock,
} from "./ShapePipeline.js";
import { computeAO } from "./AOPipeline.js";
import {
  FACE_PX,
  FACE_NX,
  FACE_PY,
  FACE_NY,
  FACE_PZ,
  FACE_NZ,
} from "../../Shape/BlockShapes.js";
import { unpackBlockId } from "../../BlockEncoding.js";

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

        const boxes = getRuntimeShapeBoxes(packed);
        if (boxes.length === 0) continue;

        const baseLight = getLight(x, y, z, 0);

        for (let i = 0; i < boxes.length; i++) {
          const box = boxes[i];

          // +X
          if ((box.faceMask & FACE_PX) !== 0) {
            emitBoxFace(
              ctx,
              x,
              y,
              z,
              blockId,
              packed,
              box,
              0,
              false,
              baseLight,
              out,
            );
          }

          // -X
          if ((box.faceMask & FACE_NX) !== 0) {
            emitBoxFace(
              ctx,
              x,
              y,
              z,
              blockId,
              packed,
              box,
              0,
              true,
              baseLight,
              out,
            );
          }

          // +Y
          if ((box.faceMask & FACE_PY) !== 0) {
            emitBoxFace(
              ctx,
              x,
              y,
              z,
              blockId,
              packed,
              box,
              1,
              false,
              baseLight,
              out,
            );
          }

          // -Y
          if ((box.faceMask & FACE_NY) !== 0) {
            emitBoxFace(
              ctx,
              x,
              y,
              z,
              blockId,
              packed,
              box,
              1,
              true,
              baseLight,
              out,
            );
          }

          // +Z
          if ((box.faceMask & FACE_PZ) !== 0) {
            emitBoxFace(
              ctx,
              x,
              y,
              z,
              blockId,
              packed,
              box,
              2,
              false,
              baseLight,
              out,
            );
          }

          // -Z
          if ((box.faceMask & FACE_NZ) !== 0) {
            emitBoxFace(
              ctx,
              x,
              y,
              z,
              blockId,
              packed,
              box,
              2,
              true,
              baseLight,
              out,
            );
          }
        }
      }
    }
  }
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
