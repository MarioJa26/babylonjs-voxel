// MeshPipeline/core/VoxelPipeline.ts

import { emitCustomShapes } from "./CustomShapeEmitter";

import { VoxelGreedyAdapter } from "./VoxelGreedyAdapter";
import type { MeshBuildSession } from "./WorkerMeshHelpers";

/**
 * The main voxel pipeline:
 *
 * 1. Run greedy meshing for all 3 axes (via VoxelGreedyAdapter)
 * 2. Emit non-greedy custom shapes (crosses, fences, multi-box blocks)
 *
 * All per-build state lives on the MeshBuildSession passed in; the pipeline
 * instance is cached on the session (`session.pipeline`) so its adapter and
 * per-axis closures are created once per worker. Quads are emitted into
 * session.quadOpaque / session.quadTransparent, which buildVoxelMesh binds
 * to the worker's reused output buffers before calling build().
 */
export class VoxelPipeline {
	// PERF: Cache VoxelGreedyAdapter to avoid per-build allocations of adapter + sub-objects.
	private greedy: VoxelGreedyAdapter;

	constructor(private readonly session: MeshBuildSession) {
		this.greedy = new VoxelGreedyAdapter(session);
	}

	/**
	 * Build the voxel mesh for a full chunk.
	 */
	public build(): void {
		this.greedy.build();
		emitCustomShapes(this.session);
	}
}
