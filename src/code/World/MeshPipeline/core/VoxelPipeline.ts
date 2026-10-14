// MeshPipeline/core/VoxelPipeline.ts

import { emitCustomShapes } from "./CustomShapeEmitter";
import { VoxelGreedyAdapter } from "./VoxelGreedyAdapter";
import type { MeshBuildSession } from "./WorkerMeshHelpers";

/**
 * Main voxel mesh pipeline:
 *
 * 1. Emit greedy voxel faces across all three axes.
 * 2. Emit non-greedy custom shapes.
 *
 * The pipeline and its greedy adapter are created once per session and reused
 * across chunk builds. build() itself performs no allocations.
 */
export class VoxelPipeline {
	private readonly session: MeshBuildSession;
	private readonly greedy: VoxelGreedyAdapter;

	constructor(session: MeshBuildSession) {
		this.session = session;
		this.greedy = new VoxelGreedyAdapter(session);
	}

	/**
	 * Build the voxel mesh for the session's current chunk.
	 */
	public build(): void {
		this.greedy.build();
		emitCustomShapes(this.session);
	}
}
