// MeshPipeline/core/MeshEmitters.ts

import { ResizableTypedArray } from "../../Chunk/DataStructures/ResizableTypedArray";
import type { WorkerInternalMeshData } from "../../Chunk/DataStructures/WorkerInternalMeshData";
import type { MeshContext } from "../types/MeshTypes";
import { mergeMeshData } from "./MeshAssembler";
import { createMeshContext } from "./MeshContext";
import { VoxelPipeline } from "./VoxelPipeline";

/**
 * Public API object exposing all meshing entry points.
 */
export const MeshEmitters = {
	createContext: createMeshContext,

	createEmptyMeshData,

	buildVoxelMesh,

	mergeMeshData,
};

/**
 * Reserve capacity for a full chunk build ONCE, up front, so the hot-path
 * emitters can write branchlessly without per-emit ensureCapacity checks.
 *
 * maxQuads is a true upper bound: greedy emits at most 3*size*size merged
 * faces; custom shapes (fences, etc.) add more, so we size for size^3 blocks
 * with headroom. The ResizableTypedArray keeps capacity across builds (reset()
 * only zeroes length), so this stays allocated after the first build.
 */
export function reserveMeshCapacity(
	out: WorkerInternalMeshData,
	maxQuads: number,
): void {
	const cap = maxQuads << 2; // 4 entries per face
	out.faceDataA.ensureCapacity(cap);
	out.faceDataB.ensureCapacity(cap);
	out.faceDataC.ensureCapacity(cap);
}

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
	// Pre-occupy capacity once so the emitters never check/grow per quad.
	// True upper bound: greedy merges to <= 3*size^2 faces; custom shapes
	// (e.g. fences, ~15 quads/block worst case) can emit many more, so size
	// for size^3 * 16 blocks + greedy headroom. Overestimate is transient
	// (arrays are sliced to actual length and discarded after the build).
	const maxQuads =
		ctx.size * ctx.size * ctx.size * 16 + 3 * ctx.size * ctx.size;
	reserveMeshCapacity(opaqueOut, maxQuads);
	reserveMeshCapacity(transparentOut, maxQuads);

	if (_cachedPipeline && _cachedPipelineCtx === ctx) {
		_cachedPipeline.build(opaqueOut, transparentOut);
	} else {
		_cachedPipeline = new VoxelPipeline(ctx);
		_cachedPipelineCtx = ctx;
		_cachedPipeline.build(opaqueOut, transparentOut);
	}
}
