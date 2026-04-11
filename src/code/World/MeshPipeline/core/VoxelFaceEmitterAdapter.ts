// World/MeshPipeline/core/VoxelFaceEmitterAdapter.ts

import {
  GreedyFaceDescriptor,
  WorkerInternalMeshData,
  MaterialType,
} from "../types/MeshTypes.js";
import { emitQuad } from "./FaceEmitter";
import {
  getRuntimeShapeBoxes,
  getShapeInfo,
  getMaterialType,
} from "./ShapePipeline.js";
import {
  FACE_PX,
  FACE_NX,
  FACE_PY,
  FACE_NY,
  FACE_PZ,
  FACE_NZ,
} from "../../Shape/BlockShapes.js";
import { unpackBlockId } from "../../BlockEncoding.js";

/**
 * Matches the mask bits emitted by VoxelMaskExtractor:
 * - bit 31: back face marker
 * - bit 30: non-cube marker
 * - low 16 bits: packed id/state
 */
const BACK_FACE_MASK = 0x80000000;
const NON_CUBE_MASK = 0x40000000;
const PACKED_ID_STATE_MASK = 0x0000ffff;

type FaceRect3D = {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
};

export class VoxelFaceEmitterAdapter {
  public emitVoxelFace(
    axis: number,
    desc: GreedyFaceDescriptor,
    opaqueOut: WorkerInternalMeshData,
    transparentOut: WorkerInternalMeshData,
  ): void {
    const rawMask = desc.idState | 0;
    const isBackFace = (rawMask & BACK_FACE_MASK) !== 0;
    const isNonCube = (rawMask & NON_CUBE_MASK) !== 0;
    const packedBlock = rawMask & PACKED_ID_STATE_MASK;

    if (!packedBlock) {
      return;
    }

    const blockId = unpackBlockId(packedBlock);
    const shapeInfo = getShapeInfo(packedBlock);
    const materialType = getMaterialType(blockId);

    const out =
      materialType === MaterialType.WaterOrGlass ? transparentOut : opaqueOut;

    // Light mask convention from VoxelMaskExtractor:
    // low byte  = AO
    // high byte = quantized packed light
    const ao = desc.light & 0xff;
    const light = (desc.light >> 8) & 0xff;

    if (shapeInfo.isCube && !isNonCube) {
      this.emitCubeFace(
        out,
        axis,
        desc,
        blockId,
        materialType,
        isBackFace,
        light,
        ao,
      );
      return;
    }

    this.emitCustomShapeFace(
      out,
      axis,
      desc,
      packedBlock,
      blockId,
      materialType,
      isBackFace,
      light,
      ao,
    );
  }

  public getFaceName(axis: number, isBackFace: boolean): string {
    // Match the old working worker mesher convention
    if (axis === 0) {
      return isBackFace ? "east" : "west";
    }
    if (axis === 1) {
      return isBackFace ? "bottom" : "top";
    }
    return isBackFace ? "north" : "south";
  }

  private emitCubeFace(
    out: WorkerInternalMeshData,
    axis: number,
    desc: GreedyFaceDescriptor,
    blockId: number,
    materialType: MaterialType,
    isBackFace: boolean,
    light: number,
    ao: number,
  ): void {
    const origin = this.toWorldBlockOrigin(axis, desc, isBackFace);

    emitQuad(out, {
      x: axis === 0 ? origin.x + (isBackFace ? 0 : 1) : origin.x,
      y: axis === 1 ? origin.y + (isBackFace ? 0 : 1) : origin.y,
      z: axis === 2 ? origin.z + (isBackFace ? 0 : 1) : origin.z,
      axis,
      width: desc.width,
      height: desc.height,
      blockId,
      isBackFace,
      light,
      ao,
      faceName: this.getFaceName(axis, isBackFace),
      materialType,
      flip: false,
    });
  }

  private emitCustomShapeFace(
    out: WorkerInternalMeshData,
    axis: number,
    desc: GreedyFaceDescriptor,
    packedBlock: number,
    blockId: number,
    materialType: MaterialType,
    isBackFace: boolean,
    light: number,
    ao: number,
  ): void {
    const boxes = getRuntimeShapeBoxes(packedBlock);
    if (boxes.length === 0) {
      return;
    }

    const origin = this.toWorldBlockOrigin(axis, desc, isBackFace);
    const faceBit = this.getFaceBit(axis, isBackFace);
    const faceName = this.getFaceName(axis, isBackFace);

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];

      // Only emit the face if that transformed box actually exposes it.
      if ((box.faceMask & faceBit) === 0) {
        continue;
      }

      const rect = this.computeFaceRect(
        axis,
        isBackFace,
        box,
        origin.x,
        origin.y,
        origin.z,
        desc.width,
        desc.height,
      );

      if (!rect) {
        continue;
      }

      emitQuad(out, {
        x: rect.x,
        y: rect.y,
        z: rect.z,
        axis,
        width: rect.width,
        height: rect.height,
        blockId,
        isBackFace,
        light,
        ao,
        faceName,
        materialType,
        flip: false,
      });
    }
  }

  /**
   * Reconstruct the voxel/block origin for the face being emitted.
   *
   * IMPORTANT:
   * - front/current face -> block origin is at slice
   * - back/neighbor face -> block origin is at slice + 1
   */
  private toWorldBlockOrigin(
    axis: number,
    desc: GreedyFaceDescriptor,
    isBackFace: boolean,
  ): { x: number; y: number; z: number } {
    const faceBlockCoord = isBackFace ? desc.slice + 1 : desc.slice;

    if (axis === 0) {
      return {
        x: faceBlockCoord,
        y: desc.uStart,
        z: desc.vStart,
      };
    }

    if (axis === 1) {
      return {
        x: desc.vStart,
        y: faceBlockCoord,
        z: desc.uStart,
      };
    }

    return {
      x: desc.uStart,
      y: desc.vStart,
      z: faceBlockCoord,
    };
  }

  private getFaceBit(axis: number, isBackFace: boolean): number {
    if (axis === 0) {
      return isBackFace ? FACE_NX : FACE_PX;
    }
    if (axis === 1) {
      return isBackFace ? FACE_NY : FACE_PY;
    }
    return isBackFace ? FACE_NZ : FACE_PZ;
  }

  /**
   * Compute the actual face rectangle for one transformed box.
   *
   * IMPORTANT:
   * We now work from the correct block origin, so there is NO extra "-1" correction.
   */
  private computeFaceRect(
    axis: number,
    isBackFace: boolean,
    box: {
      min: [number, number, number];
      max: [number, number, number];
      faceMask: number;
    },
    baseX: number,
    baseY: number,
    baseZ: number,
    greedyWidth: number,
    greedyHeight: number,
  ): FaceRect3D | null {
    if (axis === 0) {
      return {
        x: baseX + (isBackFace ? box.min[0] : box.max[0]),
        y: baseY + box.min[1],
        z: baseZ + box.min[2],
        width: greedyWidth * (box.max[1] - box.min[1]),
        height: greedyHeight * (box.max[2] - box.min[2]),
      };
    }

    if (axis === 1) {
      // Match the old working worker mesher convention for Y faces:
      // width = Z extent, height = X extent
      return {
        x: baseX + box.min[0],
        y: baseY + (isBackFace ? box.min[1] : box.max[1]),
        z: baseZ + box.min[2],
        width: greedyWidth * (box.max[2] - box.min[2]),
        height: greedyHeight * (box.max[0] - box.min[0]),
      };
    }

    return {
      x: baseX + box.min[0],
      y: baseY + box.min[1],
      z: baseZ + (isBackFace ? box.min[2] : box.max[2]),
      width: greedyWidth * (box.max[0] - box.min[0]),
      height: greedyHeight * (box.max[1] - box.min[1]),
    };
  }
}
