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

const FACE_DATA_WORDS_PER_QUAD = 4;
const CUSTOM_SHAPE_QUAD_HEADROOM_PER_BLOCK = 16;
const GREEDY_FACE_HEADROOM_FACTOR = 3;

/**
 * Reserve capacity for a full chunk build once, up front, so the hot-path
 * emitters can write branchlessly without per-emit ensureCapacity checks.
 *
 * maxQuads is an intentional upper bound:
 *   - greedy emits at most 3 * size * size merged faces
 *   - custom shapes can emit many more, so reserve size^3 * 16 headroom
 *
 * ResizableTypedArray keeps backing capacity across builds, so after the first
 * large enough reservation this usually becomes a cheap no-op.
 */
export function reserveMeshCapacity(
	out: WorkerInternalMeshData,
	maxQuads: number,
): void {
	const requiredEntries = maxQuads * FACE_DATA_WORDS_PER_QUAD;

	const faceDataA = out.faceDataA;
	const faceDataB = out.faceDataB;
	const faceDataC = out.faceDataC;

	// Avoid calling ensureCapacity repeatedly once the reused buffers are large
	// enough. This keeps the common rebuild path to a few direct length checks.
	if (
		faceDataA.backingArray.length >= requiredEntries &&
		faceDataB.backingArray.length >= requiredEntries &&
		faceDataC.backingArray.length >= requiredEntries
	) {
		return;
	}

	faceDataA.ensureCapacity(requiredEntries);
	faceDataB.ensureCapacity(requiredEntries);
	faceDataC.ensureCapacity(requiredEntries);
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

	const maxQuads =
		sizeSquared *
		(size * CUSTOM_SHAPE_QUAD_HEADROOM_PER_BLOCK + GREEDY_FACE_HEADROOM_FACTOR);

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
