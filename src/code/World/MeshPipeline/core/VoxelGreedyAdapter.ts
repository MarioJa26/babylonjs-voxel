// MeshPipeline/core/VoxelGreedyAdapter.ts

import type { GreedyFaceDescriptor } from "../types/MeshTypes";

import { greedyMesh, type WritableNumberArray } from "./GreedyPipeline";
import { VoxelFaceEmitterAdapter } from "./VoxelFaceEmitterAdapter";
import {
	extractSliceMaskX,
	extractSliceMaskY,
	extractSliceMaskZ,
} from "./VoxelMaskExtractor";
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
 * The adapter instance is cached per session, so callbacks are allocated once
 * per worker pipeline, not once per chunk build.
 */
export class VoxelGreedyAdapter {
	private readonly _session: MeshBuildSession;
	private readonly _extractMaskX: ExtractMaskCallback;
	private readonly _extractMaskY: ExtractMaskCallback;
	private readonly _extractMaskZ: ExtractMaskCallback;

	private readonly _emitFaceX: EmitFaceCallback;
	private readonly _emitFaceY: EmitFaceCallback;
	private readonly _emitFaceZ: EmitFaceCallback;

	constructor(session: MeshBuildSession) {
		this._session = session;
		const faceEmitter = new VoxelFaceEmitterAdapter(session);

		// Axis-specialized extractor callbacks.
		// This avoids the extractSliceMask(session, axis, ...) branch on every
		// slice extraction.
		this._extractMaskX = (
			slice: number,
			maskBuf: WritableNumberArray,
			lightBuf: WritableNumberArray,
		): void => {
			extractSliceMaskX(session, slice, maskBuf, lightBuf);
		};

		this._extractMaskY = (
			slice: number,
			maskBuf: WritableNumberArray,
			lightBuf: WritableNumberArray,
		): void => {
			extractSliceMaskY(session, slice, maskBuf, lightBuf);
		};

		this._extractMaskZ = (
			slice: number,
			maskBuf: WritableNumberArray,
			lightBuf: WritableNumberArray,
		): void => {
			extractSliceMaskZ(session, slice, maskBuf, lightBuf);
		};

		// Axis-specialized emitter callbacks.
		// These are still closures, but they are created once and avoid a
		// mutable current-axis field in the hot greedy path.
		this._emitFaceX = (desc: GreedyFaceDescriptor): void => {
			faceEmitter.emitVoxelFace(0, desc);
		};

		this._emitFaceY = (desc: GreedyFaceDescriptor): void => {
			faceEmitter.emitVoxelFace(1, desc);
		};

		this._emitFaceZ = (desc: GreedyFaceDescriptor): void => {
			faceEmitter.emitVoxelFace(2, desc);
		};
	}

	/**
	 * Runs greedy meshing on all 3 axes.
	 * Emits quads for all voxel faces into the session's quad buffers.
	 */
	public build(): void {
		const session = this._session;

		greedyMesh(session, this._extractMaskX, this._emitFaceX);
		greedyMesh(session, this._extractMaskY, this._emitFaceY);
		greedyMesh(session, this._extractMaskZ, this._emitFaceZ);
	}
}
