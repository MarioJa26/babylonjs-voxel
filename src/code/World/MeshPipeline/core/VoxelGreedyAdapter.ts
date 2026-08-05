// MeshPipeline/core/VoxelGreedyAdapter.ts

import type { GreedyFaceDescriptor } from "../types/MeshTypes";

import { greedyMesh, type WritableNumberArray } from "./GreedyPipeline";
import { VoxelFaceEmitterAdapter } from "./VoxelFaceEmitterAdapter";
import { extractSliceMask } from "./VoxelMaskExtractor";
import type { MeshBuildSession } from "./WorkerMeshHelpers";

/**
 * Drives the greedy mesher across all 3 axes (X, Y, Z),
 * using the stateless VoxelMaskExtractor and VoxelFaceEmitterAdapter.
 *
 * This is the "middle layer" of the voxel meshing pipeline:
 *
 * Input:
 *   - session → padded block/light grids + scratch buffers + quad outputs
 *
 * Output:
 *   - session.quadOpaque / session.quadTransparent filled with quads
 *
 * The adapter instance is cached per session (pipeline), so the closures
 * below are created once per worker instead of once per chunk build.
 */
export class VoxelGreedyAdapter {
	private readonly _session: MeshBuildSession;
	private faceEmitter: VoxelFaceEmitterAdapter;
	// PERF: Pre-create closures once instead of re-creating per axis per build.
	private readonly _extractMask: (
		slice: number,
		maskBuf: WritableNumberArray,
		lightBuf: WritableNumberArray,
	) => void;
	private readonly _emitFace: (desc: GreedyFaceDescriptor) => void;
	// Set by build() before each axis run so the closures capture a number, not
	// a closure parameter — avoids per-axis closure re-creation.
	private _currentAxis = 0;

	constructor(session: MeshBuildSession) {
		this._session = session;
		this.faceEmitter = new VoxelFaceEmitterAdapter(session);

		this._extractMask = (
			slice: number,
			maskBuf: WritableNumberArray,
			lightBuf: WritableNumberArray,
		) => {
			extractSliceMask(
				this._session,
				this._currentAxis,
				slice,
				maskBuf,
				lightBuf,
			);
		};

		this._emitFace = (desc: GreedyFaceDescriptor) => {
			this.faceEmitter.emitVoxelFace(this._currentAxis, desc);
		};
	}

	/**
	 * Runs greedy meshing on all 3 axes.
	 * Emits quads for ALL voxel faces into the session's quad buffers.
	 */
	public build(): void {
		for (let axis = 0; axis < 3; axis++) {
			this._currentAxis = axis;
			greedyMesh(this._session, this._extractMask, this._emitFace);
		}
	}
}
