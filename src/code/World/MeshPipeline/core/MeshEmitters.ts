// MeshPipeline/core/MeshEmitters.ts

import type { WorkerInternalMeshData } from "../../Chunk/DataStructures/WorkerInternalMeshData";
import { emitLodBorderSkirts } from "./LodBorderSkirts";
import { VoxelPipeline } from "./VoxelPipeline";
import type { MeshBuildSession } from "./WorkerMeshHelpers";

/**
 * Public API object exposing all meshing entry points.
 */
export const MeshEmitters = {
	buildVoxelMesh,
};

const FACE_DATA_BYTES_PER_QUAD = 12;
// PERF: greedy emits at most 3*size*size merged faces (3072 for size 32).
// The old headroom (size^3*16 = 527k quads = 6.3MB/bucket, 19MB total)
// retained worst-case memory per worker forever. Reserve 8*size^2 (8k quads
// for size 32, ~2.6x greedy max); QuadBuffer.emitRaw grows on overflow so
// pathological custom-shape chunks stay correct and only pay growth then.
const GREEDY_QUAD_RESERVE_FACTOR = 8;

/**
 * Reserve capacity for a full chunk build once, up front, so the hot-path
 * emitters hit the branch-predicted fast path without per-emit growth.
 *
 * maxQuads is a common-case hint, not an upper bound: QuadBuffer.emitRaw
 * grows via ensureCapacity on overflow, so dense custom-shape chunks stay
 * correct and only pay growth when they actually overflow.
 *
 * ResizableTypedArray keeps backing capacity across builds, so after the first
 * large enough reservation this usually becomes a cheap no-op.
 */
export function reserveMeshCapacity(
	out: WorkerInternalMeshData,
	maxQuads: number,
): void {
	const requiredEntries = maxQuads * FACE_DATA_BYTES_PER_QUAD;

	// Avoid calling ensureCapacity repeatedly once the reused buffer is large
	// enough. This keeps the common rebuild path to a single length check.
	if (out.faceData.backingArray.length >= requiredEntries) {
		return;
	}

	out.faceData.ensureCapacity(requiredEntries);
}

/**
 * Build the full voxel mesh for one chunk into the worker's reused output
 * buffers.
 *
 * The session carries the padded grids, greedy scratch buffers and the cached
 * VoxelPipeline, so a session can be reused across builds on the single-threaded
 * worker with minimal per-build allocation.
 */
export function buildVoxelMesh(
	session: MeshBuildSession,
	opaqueOut: WorkerInternalMeshData,
	waterOut: WorkerInternalMeshData,
	cutoutOut: WorkerInternalMeshData,
): void {
	const size = session.size;
	const sizeSquared = size * size;

	const maxQuads = sizeSquared * GREEDY_QUAD_RESERVE_FACTOR;

	reserveMeshCapacity(opaqueOut, maxQuads);
	reserveMeshCapacity(waterOut, maxQuads);
	reserveMeshCapacity(cutoutOut, maxQuads);

	// bind() resets visible lengths and faceCount, then emits write directly
	// into the reused backing arrays. quadTransparent is intentionally left
	// unbound: the emitter's new-bucket fallback only fires when the session
	// lacks quadWater/quadCutout.
	session.quadOpaque.bind(opaqueOut);
	session.quadWater.bind(waterOut);
	session.quadCutout.bind(cutoutOut);

	let pipeline = session.pipeline;

	if (!pipeline) {
		pipeline = new VoxelPipeline(session);
		session.pipeline = pipeline;
	}

	pipeline.build();

	// Downsampled chunks get outward border walls so LOD band transitions
	// never show cracks against finer neighbors.
	emitLodBorderSkirts(session);

	// Publish final lengths once after all emitters have completed.
	session.quadOpaque.finish();
	session.quadWater.finish();
	session.quadCutout.finish();
}
