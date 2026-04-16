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

	constructor(ctx: MeshContext) {
		this.ctx = ctx;
	}

	/**
	 * Build the voxel mesh for a full chunk.
	 */
	public build(
		opaqueOut: WorkerInternalMeshData,
		transparentOut: WorkerInternalMeshData,
	): void {
		// PRIMARY VOXEL MESHER
		const greedy = new VoxelGreedyAdapter(this.ctx);

		greedy.build(opaqueOut, transparentOut);
		emitCustomShapes(this.ctx, opaqueOut, transparentOut);

		// After this, `out` contains:
		// - faceDataA (x,y,z,axisFace)
		// - faceDataB (width,height,uvX,uvY)
		// - faceDataC (ao,light,tint,meta)
		// - faceCount
	}
}
