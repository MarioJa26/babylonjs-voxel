// MeshPipeline/core/VoxelPipeline.ts

import type { MeshContext, WorkerInternalMeshData } from "../types/MeshTypes";
import { emitCustomShapes } from "./CustomShapeEmitter";

import { VoxelGreedyAdapter } from "./VoxelGreedyAdapter";

/**
 * Structured input format for voxel meshing.
 * This matches what your worker passes to MeshEmitters.buildVoxelMesh().
 */
export interface VoxelPipelineInput {
	block_array: Uint16Array | Uint8Array;
	light_array?: Uint8Array; // currently unused — context.getLight handles lookup
	neighbors: (Uint16Array | Uint8Array | undefined)[];
	neighborLights?: (Uint8Array | undefined)[];
}

/**
 * The main voxel pipeline:
 *
 * 1. Wrap input data via VoxelGreedyAdapter
 * 2. Run greedy meshing for all 3 axes
 * 3. Emit quads into WorkerInternalMeshData
 *
 * This file *completes* the entire voxel meshing system.
 */
export class VoxelPipeline {
	private ctx: MeshContext;
	// PERF: Cache VoxelGreedyAdapter to avoid per-build allocations of adapter + sub-objects.
	private greedy: VoxelGreedyAdapter;

	constructor(ctx: MeshContext) {
		this.ctx = ctx;
		this.greedy = new VoxelGreedyAdapter(ctx);
	}

	/**
	 * Build the voxel mesh for a full chunk.
	 */
	public build(
		opaqueOut: WorkerInternalMeshData,
		transparentOut: WorkerInternalMeshData,
	): void {
		// PERF: Reuse cached adapter, just update the context reference.
		this.greedy.setCtx(this.ctx);

		this.greedy.build(opaqueOut, transparentOut);
		emitCustomShapes(this.ctx, opaqueOut, transparentOut);
	}
}
