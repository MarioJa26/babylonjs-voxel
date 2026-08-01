// MeshPipeline/core/MeshEmitters.ts

import type { WorkerInternalMeshData } from "../../Chunk/DataStructures/WorkerInternalMeshData";
import { VoxelPipeline } from "./VoxelPipeline";
import type { MeshBuildSession } from "./WorkerMeshHelpers";

/**
 * Public API object exposing all meshing entry points.
 */
export const MeshEmitters = {
	buildVoxelMesh,
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
 * Build the full voxel mesh for one chunk into the worker's reused output
 * buffers.
 *
 * The session carries the padded grids, greedy scratch buffers and the cached
 * VoxelPipeline (created once per worker), so a session can be reused across
 * builds on the single-threaded worker with zero per-build allocation.
 */
export function buildVoxelMesh(
	session: MeshBuildSession,
	opaqueOut: WorkerInternalMeshData,
	transparentOut: WorkerInternalMeshData,
): void {
	// Pre-occupy capacity once so the emitters never check/grow per quad.
	// True upper bound: greedy merges to <= 3*size^2 faces; custom shapes
	// (e.g. fences, ~15 quads/block worst case) can emit many more, so size
	// for size^3 * 16 blocks + greedy headroom. Overestimate is transient
	// (arrays are sliced to actual length and discarded after the build).
	const size = session.size;
	const maxQuads = size * size * size * 16 + 3 * size * size;
	reserveMeshCapacity(opaqueOut, maxQuads);
	reserveMeshCapacity(transparentOut, maxQuads);

	// Point the session's quad buffers at the (reused) output meshes.
	// bind() zeroes the internal face counter; the worker already reset the
	// ResizableTypedArray lengths + faceCount before calling this.
	session.quadOpaque.bind(opaqueOut);
	session.quadTransparent.bind(transparentOut);

	let pipeline = session.pipeline;
	if (!pipeline) {
		pipeline = new VoxelPipeline(session);
		session.pipeline = pipeline;
	}
	pipeline.build();
}
