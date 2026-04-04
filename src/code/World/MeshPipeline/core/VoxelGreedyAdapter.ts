// MeshPipeline/core/VoxelGreedyAdapter.ts

import {
  MeshContext,
  WorkerInternalMeshData,
  GreedyFaceDescriptor,
} from "../types/MeshTypes";

import { greedyMesh } from "./GreedyPipeline.js";
import { VoxelMaskExtractor } from "./VoxelMaskExtractor";
import { VoxelFaceEmitterAdapter } from "./VoxelFaceEmitterAdapter.js";

/**
 * Drives the greedy mesher across all 3 axes (X, Y, Z),
 * using VoxelMaskExtractor and VoxelFaceEmitterAdapter.
 *
 * This is the "middle layer" of the voxel meshing pipeline:
 *
 * Input:
 *   - ctx            → block/light access
 *   - block_array    → packed voxel data
 *   - neighbors      → array of neighbor chunk voxel arrays
 *
 * Output:
 *   - WorkerInternalMeshData filled with quads
 *
 */
export class VoxelGreedyAdapter {
  private ctx: MeshContext;
  private maskExtractor: VoxelMaskExtractor;
  private faceEmitter: VoxelFaceEmitterAdapter;

  constructor(ctx: MeshContext) {
    this.ctx = ctx;
    this.maskExtractor = new VoxelMaskExtractor(ctx);
    this.faceEmitter = new VoxelFaceEmitterAdapter();
  }

  /**
   * Runs greedy meshing on all 3 axes.
   * Emits quads for ALL voxel faces into the output.
   */
  public build(
    opaqueOut: WorkerInternalMeshData,
    transparentOut: WorkerInternalMeshData,
  ): void {
    for (let axis = 0; axis < 3; axis++) {
      this.runForAxis(axis, opaqueOut, transparentOut);
    }
  }

  /**
   * Run greedy meshing for a single axis (0 = X, 1 = Y, 2 = Z).
   */

  private runForAxis(
    axis: number,
    opaqueOut: WorkerInternalMeshData,
    transparentOut: WorkerInternalMeshData,
  ): void {
    const extractMask = (
      slice: number,
      maskBuf: number[],
      lightBuf: number[],
    ) => {
      this.maskExtractor.extractSliceMask(axis, slice, maskBuf, lightBuf);
    };

    const emitFace = (desc: GreedyFaceDescriptor) => {
      this.faceEmitter.emitVoxelFace(axis, desc, opaqueOut, transparentOut);
    };

    greedyMesh(this.ctx, axis, extractMask, emitFace);
  }
}
