// MeshPipeline/core/VoxelPipeline.ts

import type { MeshContext, WorkerInternalMeshData } from "../types/MeshTypes";
import { emitCustomShapes } from "./CustomShapeEmitter";

import { VoxelGreedyAdapter } from "./VoxelGreedyAdapter";
import type { IFaceEmitter } from "./VoxelFaceEmitterAdapter";

export class VoxelPipeline {
	private ctx: MeshContext;
	private faceEmitter: IFaceEmitter | undefined;

	constructor(ctx: MeshContext, faceEmitter?: IFaceEmitter) {
		this.ctx = ctx;
		this.faceEmitter = faceEmitter;
	}

	public build(
		opaqueOut: WorkerInternalMeshData,
		transparentOut: WorkerInternalMeshData,
	): void {
		const greedy = new VoxelGreedyAdapter(this.ctx, this.faceEmitter);

		greedy.build(opaqueOut, transparentOut);
		emitCustomShapes(this.ctx, opaqueOut, transparentOut);
	}
}
