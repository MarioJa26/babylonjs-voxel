// MeshPipeline/core/VoxelGreedyAdapter.ts

import type {
	GreedyFaceDescriptor,
	MeshContext,
	WorkerInternalMeshData,
} from "../types/MeshTypes";

import { greedyMesh, type WritableNumberArray } from "./GreedyPipeline";
import { VoxelFaceEmitterAdapter } from "./VoxelFaceEmitterAdapter";
import { VoxelMaskExtractor } from "./VoxelMaskExtractor";

/**
 * Drives the greedy mesher across all 3 axes (X, Y, Z),
 * using VoxelMaskExtractor and VoxelFaceEmitterAdapter.
 *
 * This is the "middle layer" of the voxel meshing pipeline:
 *
 * Input:
 *   - ctx            → block/light access
 *   - block_array    → packed voxel data
 *   - neighbors      → array of neighbor chunk voxel arrays
 *
 * Output:
 *   - WorkerInternalMeshData filled with quads
 *
 */
export class VoxelGreedyAdapter {
	private ctx: MeshContext;
	private maskExtractor: VoxelMaskExtractor;
	private faceEmitter: VoxelFaceEmitterAdapter;
	// PERF: Pre-create closures once instead of re-creating per axis per build.
	private readonly _extractMask: (
		slice: number,
		maskBuf: WritableNumberArray,
		lightBuf: WritableNumberArray,
	) => void;
	private readonly _emitFace: (desc: GreedyFaceDescriptor) => void;
	// Temporary output targets updated before each axis run.
	private _opaqueOut!: WorkerInternalMeshData;
	private _transparentOut!: WorkerInternalMeshData;

	constructor(ctx: MeshContext) {
		this.ctx = ctx;
		this.maskExtractor = new VoxelMaskExtractor(ctx);
		this.faceEmitter = new VoxelFaceEmitterAdapter();

		this._extractMask = (
			slice: number,
			maskBuf: WritableNumberArray,
			lightBuf: WritableNumberArray,
		) => {
			this.maskExtractor.extractSliceMask(
				this._currentAxis,
				slice,
				maskBuf,
				lightBuf,
			);
		};

		this._emitFace = (desc: GreedyFaceDescriptor) => {
			this.faceEmitter.emitVoxelFace(
				this._currentAxis,
				desc,
				this._opaqueOut,
				this._transparentOut,
			);
		};
	}

	// Set by build() before each axis run so the closures capture a number, not
	// a closure parameter — avoids per-axis closure re-creation.
	private _currentAxis = 0;

	/** PERF: Update context reference instead of creating a new adapter. */
	public setCtx(ctx: MeshContext): void {
		this.ctx = ctx;
		this.maskExtractor.setCtx(ctx);
	}

	/**
	 * Runs greedy meshing on all 3 axes.
	 * Emits quads for ALL voxel faces into the output.
	 */
	public build(
		opaqueOut: WorkerInternalMeshData,
		transparentOut: WorkerInternalMeshData,
	): void {
		this._opaqueOut = opaqueOut;
		this._transparentOut = transparentOut;
		for (let axis = 0; axis < 3; axis++) {
			this._currentAxis = axis;
			greedyMesh(this.ctx, this._extractMask, this._emitFace);
		}
	}
}
