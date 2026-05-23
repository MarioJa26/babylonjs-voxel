// MeshPipeline/core/VoxelGreedyAdapter.ts

import type {
	GreedyFaceDescriptor,
	MeshContext,
	WorkerInternalMeshData,
} from "../types/MeshTypes";

import { greedyMesh, type WritableNumberArray } from "./GreedyPipeline";
import {
	type IFaceEmitter,
	VoxelFaceEmitterAdapter,
} from "./VoxelFaceEmitterAdapter";
import { VoxelMaskExtractor } from "./VoxelMaskExtractor";

export class VoxelGreedyAdapter {
	private ctx: MeshContext;
	private maskExtractor: VoxelMaskExtractor;
	private faceEmitter: IFaceEmitter;

	constructor(ctx: MeshContext, faceEmitter?: IFaceEmitter) {
		this.ctx = ctx;
		this.maskExtractor = new VoxelMaskExtractor(ctx);
		this.faceEmitter = faceEmitter ?? new VoxelFaceEmitterAdapter();
	}

	/**
	 * Runs greedy meshing on all 3 axes.
	 * Emits quads for ALL voxel faces into the output.
	 */
	public build(
		opaqueOut: WorkerInternalMeshData,
		transparentOut: WorkerInternalMeshData,
	): void {
		for (let axis = 0; axis < 3; axis++) {
			this.runForAxis(axis, opaqueOut, transparentOut);
		}
	}

	/**
	 * Run greedy meshing for a single axis (0 = X, 1 = Y, 2 = Z).
	 */

	private runForAxis(
		axis: number,
		opaqueOut: WorkerInternalMeshData,
		transparentOut: WorkerInternalMeshData,
	): void {
		const extractMask = (
			slice: number,
			maskBuf: WritableNumberArray,
			lightBuf: WritableNumberArray,
		) => {
			this.maskExtractor.extractSliceMask(axis, slice, maskBuf, lightBuf);
		};

		const emitFace = (desc: GreedyFaceDescriptor) => {
			this.faceEmitter.emitVoxelFace(axis, desc, opaqueOut, transparentOut);
		};

		greedyMesh(this.ctx, extractMask, emitFace);
	}
}
