// MeshPipeline/core/VoxelFaceEmitterAdapter.ts

import {
  WorkerInternalMeshData,
  GreedyFaceDescriptor,
  MaterialType,
} from "../types/MeshTypes";

import { emitQuad } from "./FaceEmitter";
import { getMaterialType } from "./ShapePipeline";

/**
 * This class bridges:
 *   - GreedyFaceDescriptor (uStart, vStart, slice, width, height)
 *   - ShapePipeline (face extents, slice-state box transform)
 *   - FaceEmitter (quad emission)
 *
 * It replaces the giant logic in your original meshSlice() implementation.
 */
export class VoxelFaceEmitterAdapter {
  /**
   * Emit a voxel quad, given a fully merged GreedyFaceDescriptor.
   *
   * @param axis The slicing axis (0=X, 1=Y, 2=Z)
   * @param desc Greedy face descriptor produced by GreedyPipeline
   * @param out Output WorkerInternalMeshData
   */

  public emitVoxelFace(
    axis: number,
    desc: GreedyFaceDescriptor,
    opaqueOut: WorkerInternalMeshData,
    transparentOut: WorkerInternalMeshData,
  ): void {
    const { slice, uStart, vStart, width, height, idState, light } = desc;

    const isBackFace = (idState & 0x80000000) !== 0;
    const packed = idState & 0xffff;

    const blockId = packed & 0xff;

    const uAxis = (axis + 1) % 3;
    const vAxis = (axis + 2) % 3;

    const axisPos = slice + 1;

    const boxMin: [number, number, number] = [0, 0, 0];
    const boxMax: [number, number, number] = [1, 1, 1];

    const axisOffset = isBackFace ? boxMin[axis] : boxMax[axis] - 1;

    const origin: [number, number, number] = [0, 0, 0];
    origin[axis] = axisPos + axisOffset;
    origin[uAxis] = uStart + boxMin[uAxis];
    origin[vAxis] = vStart + boxMin[vAxis];

    const spanU = width * (boxMax[uAxis] - boxMin[uAxis]);
    const spanV = height * (boxMax[vAxis] - boxMin[vAxis]);

    const packedAO = light & 0xff;
    const packedLightOnly = (light >>> 8) & 0xff;

    const faceName =
      axis === 0
        ? isBackFace
          ? "east"
          : "west"
        : axis === 1
          ? isBackFace
            ? "bottom"
            : "top"
          : isBackFace
            ? "north"
            : "south";

    const materialType = getMaterialType(blockId);

    const target =
      materialType === MaterialType.WaterOrGlass ? transparentOut : opaqueOut;

    emitQuad(target, {
      x: origin[0],
      y: origin[1],
      z: origin[2],
      axis,
      width: spanU,
      height: spanV,
      blockId,
      isBackFace,
      light: packedLightOnly,
      ao: packedAO,
      faceName,
      materialType,
      flip: false,
    });
  }

  getFaceName(axis: number, isBackFace: boolean): string {
    if (axis === 0) return isBackFace ? "east" : "west";
    if (axis === 1) return isBackFace ? "bottom" : "top";
    if (axis === 2) return isBackFace ? "north" : "south";
    throw new Error(`Invalid axis ${axis}`);
  }
}
