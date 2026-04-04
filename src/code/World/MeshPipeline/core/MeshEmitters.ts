// MeshPipeline/core/MeshEmitters.ts

import { MeshContext, WorkerInternalMeshData } from "../types/MeshTypes";

import { createMeshContext } from "./MeshContext";
import { buildWaterMesh } from "./WaterPipeline";
import { mergeMeshData } from "./MeshAssembler";
import { VoxelPipeline } from "./VoxelPipeline";
import { ResizableTypedArray } from "../../Chunk/DataStructures/ResizableTypedArray";

/**
 * Create an empty WorkerInternalMeshData object (strict TS).
 * The caller must provide your engine's ResizableTypedArray & WorkerInternalMeshData classes.
 *
 * THIS FUNCTION mirrors how your engine constructs the output mesh data.
 */

export function createEmptyMeshData(): WorkerInternalMeshData {
  return {
    faceDataA: new ResizableTypedArray(Uint8Array),
    faceDataB: new ResizableTypedArray(Uint8Array),
    faceDataC: new ResizableTypedArray(Uint8Array),
    faceCount: 0,
  };
}

/**
 * Placeholder for voxel meshing until Phase 7.
 * This will call:
 *  - GreedyPipeline
 *  - AO pipeline
 *  - FaceEmitter
 *  - ShapePipeline
 *
 * For now we define the signature.
 */

export function buildVoxelMesh(
  ctx: MeshContext,
  opaqueOut: WorkerInternalMeshData,
  transparentOut: WorkerInternalMeshData,
): void {
  const pipeline = new VoxelPipeline(ctx);
  pipeline.build(opaqueOut, transparentOut);
}

/**
 * Water mesh builder façade.
 * Internally calls the WaterPipeline module.
 */
export function buildWaterSurfaceMesh(
  ctx: MeshContext,
  grid: any, // Strict type imported in Phase 4: WaterSampleGrid
  out: WorkerInternalMeshData,
): void {
  buildWaterMesh(ctx, grid, out);
}

/**
 * Public API object exposing all meshing entry points.
 */
export const MeshEmitters = {
  createContext: createMeshContext,

  createEmptyMeshData,

  buildVoxelMesh, // stub until Phase 7
  buildWaterMesh: buildWaterSurfaceMesh,

  mergeMeshData,
};
