// MeshPipeline/core/VoxelGreedyAdapter.ts

import type { GreedyFaceDescriptor } from "../types/MeshTypes";

import { greedyMesh } from "./GreedyPipeline";
import { VoxelFaceEmitterAdapter } from "./VoxelFaceEmitterAdapter";
import {
	extractAllSliceMasksX,
	extractAllSliceMasksY,
	extractAllSliceMasksZ,
} from "./VoxelMaskExtractor";
import type { MeshBuildSession } from "./WorkerMeshHelpers";

type EmitFaceCallback = (desc: GreedyFaceDescriptor) => void;

/**
 * Drives the greedy mesher across all 3 axes (X, Y, Z).
 *
 * Masks are pre-extracted per axis in ONE contiguous sweep
 * (extractAllSliceMasks*) into the session's reusable mask/light banks, then
 * greedyMesh runs in banked mode over the precomputed slices. This replaces
 * the old per-slice extraction callbacks whose strided grid walks dominated
 * worker profiles.
 *
 * The adapter instance is cached per session, so the face-emitter closures
 * are allocated once per worker pipeline, not once per chunk build.
 */
export class VoxelGreedyAdapter {
	private readonly _session: MeshBuildSession;

	private readonly _emitFaceX: EmitFaceCallback;
	private readonly _emitFaceY: EmitFaceCallback;
	private readonly _emitFaceZ: EmitFaceCallback;

	constructor(session: MeshBuildSession) {
		this._session = session;
		const faceEmitter = new VoxelFaceEmitterAdapter(session);

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
		// Bank layout follows the greedy grid (compacted when lodStep > 1),
		// matching what the stride-aware extractors write.
		const gridSize =
			session.meshGridSize > 0 ? session.meshGridSize : session.size;
		const bankLength = (gridSize + 1) * gridSize * gridSize;

		const maskBank = session.ensureMaskBank(bankLength);
		const lightBank = session.ensureLightBank(bankLength);

		extractAllSliceMasksX(session, maskBank, lightBank);
		greedyMesh(session, null, this._emitFaceX, maskBank, lightBank);

		extractAllSliceMasksY(session, maskBank, lightBank);
		greedyMesh(session, null, this._emitFaceY, maskBank, lightBank);

		extractAllSliceMasksZ(session, maskBank, lightBank);
		greedyMesh(session, null, this._emitFaceZ, maskBank, lightBank);
	}
}
