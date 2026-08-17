// MeshPipeline/core/VoxelGreedyAdapter.ts

import type { GreedyFaceDescriptor } from "../types/MeshTypes";

import { greedyMesh, type WritableNumberArray } from "./GreedyPipeline";
import { VoxelFaceEmitterAdapter } from "./VoxelFaceEmitterAdapter";
import { extractSliceMask } from "./VoxelMaskExtractor";
import type { MeshBuildSession } from "./WorkerMeshHelpers";

type ExtractMaskCallback = (
	slice: number,
	maskBuf: WritableNumberArray,
	lightBuf: WritableNumberArray,
) => void;

type EmitFaceCallback = (desc: GreedyFaceDescriptor) => void;

/**
 * Drives the greedy mesher across all 3 axes (X, Y, Z),
 * using the stateless VoxelMaskExtractor and VoxelFaceEmitterAdapter.
 *
 * This is the "middle layer" of the voxel meshing pipeline:
 *
 * Input:
 *   - session -> padded block/light grids + scratch buffers + quad outputs
 *
 * Output:
 *   - session.quadOpaque / session.quadWater / session.quadCutout filled
 *     with quads (transparent bucket split into animated water + alpha-tested
 *     cutout)
 *
 * The adapter instance is cached per session, so all callbacks below are
 * created once per worker pipeline instead of once per chunk build.
 */
export class VoxelGreedyAdapter {
	private readonly _session: MeshBuildSession;
	private readonly _faceEmitter: VoxelFaceEmitterAdapter;

	/**
	 * Axis-specialized callbacks.
	 *
	 * Slightly more closures upfront, but avoids reading a mutable
	 * `_currentAxis` property inside the hot greedy callback path.
	 */
	private readonly _extractMaskByAxis: readonly [
		ExtractMaskCallback,
		ExtractMaskCallback,
		ExtractMaskCallback,
	];

	private readonly _emitFaceByAxis: readonly [
		EmitFaceCallback,
		EmitFaceCallback,
		EmitFaceCallback,
	];

	constructor(session: MeshBuildSession) {
		this._session = session;

		const faceEmitter = new VoxelFaceEmitterAdapter(session);
		this._faceEmitter = faceEmitter;

		this._extractMaskByAxis = [
			(
				slice: number,
				maskBuf: WritableNumberArray,
				lightBuf: WritableNumberArray,
			): void => {
				extractSliceMask(session, 0, slice, maskBuf, lightBuf);
			},
			(
				slice: number,
				maskBuf: WritableNumberArray,
				lightBuf: WritableNumberArray,
			): void => {
				extractSliceMask(session, 1, slice, maskBuf, lightBuf);
			},
			(
				slice: number,
				maskBuf: WritableNumberArray,
				lightBuf: WritableNumberArray,
			): void => {
				extractSliceMask(session, 2, slice, maskBuf, lightBuf);
			},
		];

		this._emitFaceByAxis = [
			(desc: GreedyFaceDescriptor): void => {
				faceEmitter.emitVoxelFace(0, desc);
			},
			(desc: GreedyFaceDescriptor): void => {
				faceEmitter.emitVoxelFace(1, desc);
			},
			(desc: GreedyFaceDescriptor): void => {
				faceEmitter.emitVoxelFace(2, desc);
			},
		];
	}

	/**
	 * Runs greedy meshing on all 3 axes.
	 * Emits quads for all voxel faces into the session's quad buffers.
	 */
	public build(): void {
		const session = this._session;
		const extractMaskByAxis = this._extractMaskByAxis;
		const emitFaceByAxis = this._emitFaceByAxis;

		greedyMesh(session, extractMaskByAxis[0], emitFaceByAxis[0]);
		greedyMesh(session, extractMaskByAxis[1], emitFaceByAxis[1]);
		greedyMesh(session, extractMaskByAxis[2], emitFaceByAxis[2]);
	}
}
