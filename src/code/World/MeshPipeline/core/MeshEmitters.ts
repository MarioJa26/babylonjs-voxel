// MeshPipeline/core/MeshEmitters.ts

import { ResizableTypedArray } from "../../Chunk/DataStructures/ResizableTypedArray";
import type { WorkerInternalMeshData } from "../../Chunk/DataStructures/WorkerInternalMeshData";
import type { MeshContext } from "../types/MeshTypes";
import { mergeMeshData } from "./MeshAssembler";
import { createMeshContext } from "./MeshContext";
import { VoxelPipeline } from "./VoxelPipeline";

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

// PERF: Cache VoxelPipeline instance to avoid per-build allocations of
// VoxelPipeline + VoxelGreedyAdapter + VoxelMaskExtractor + VoxelFaceEmitterAdapter.
let _cachedPipeline: VoxelPipeline | null = null;
let _cachedPipelineCtx: MeshContext | null = null;

export function buildVoxelMesh(
	ctx: MeshContext,
	opaqueOut: WorkerInternalMeshData,
	transparentOut: WorkerInternalMeshData,
): void {
	if (_cachedPipeline && _cachedPipelineCtx === ctx) {
		_cachedPipeline.build(opaqueOut, transparentOut);
	} else {
		_cachedPipeline = new VoxelPipeline(ctx);
		_cachedPipelineCtx = ctx;
		_cachedPipeline.build(opaqueOut, transparentOut);
	}
}

/**
 * Public API object exposing all meshing entry points.
 */
export const MeshEmitters = {
	createContext: createMeshContext,

	createEmptyMeshData,

	buildVoxelMesh,

	mergeMeshData,
};
