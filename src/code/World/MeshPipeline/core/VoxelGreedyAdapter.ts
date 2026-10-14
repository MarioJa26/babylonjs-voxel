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

/**
 * Drives greedy meshing across all three axes.
 *
 * Slice masks are extracted into reusable session-owned banks before each
 * greedy pass. A single callback is reused for every axis to avoid allocating
 * three axis-capturing closures per adapter.
 */
export class VoxelGreedyAdapter {
	private readonly _session: MeshBuildSession;
	private readonly _faceEmitter: VoxelFaceEmitterAdapter;

	/**
	 * Axis consumed by the shared greedy callback.
	 *
	 * build() is synchronous, so the axis remains stable for the duration of
	 * each greedyMesh() call.
	 */
	private _currentAxis = 0;

	/**
	 * One callback allocation per adapter instead of one closure per axis.
	 */
	private readonly _emitFace: (desc: GreedyFaceDescriptor) => void;

	constructor(session: MeshBuildSession) {
		this._session = session;
		this._faceEmitter = new VoxelFaceEmitterAdapter(session);
		this._emitFace = this.emitFace.bind(this);
	}

	/**
	 * Shared greedy-mesher callback.
	 */
	private emitFace(desc: GreedyFaceDescriptor): void {
		this._faceEmitter.emitVoxelFace(this._currentAxis, desc);
	}

	/**
	 * Runs greedy meshing on all three axes.
	 *
	 * Axis order remains X, Z, Y. Water is alpha-blended without per-face
	 * sorting, so Y faces are emitted last to keep nearby water surfaces above
	 * distant side walls for the dominant top-down view.
	 */
	public build(): void {
		const session = this._session;

		// Bank layout follows the potentially downsampled greedy grid.
		const gridSize =
			session.meshGridSize > 0 ? session.meshGridSize : session.size;

		const area = gridSize * gridSize;
		const bankLength = area * (gridSize + 1);

		const maskBank = session.ensureMaskBank(bankLength);
		const lightBank = session.ensureLightBank(bankLength);
		const emitFace = this._emitFace;

		// X axis
		extractAllSliceMasksX(session, maskBank, lightBank);
		this._currentAxis = 0;
		greedyMesh(session, null, emitFace, maskBank, lightBank);

		// Z axis
		extractAllSliceMasksZ(session, maskBank, lightBank);
		this._currentAxis = 2;
		greedyMesh(session, null, emitFace, maskBank, lightBank);

		// Y axis, intentionally emitted last for transparent water ordering.
		extractAllSliceMasksY(session, maskBank, lightBank);
		this._currentAxis = 1;
		greedyMesh(session, null, emitFace, maskBank, lightBank);
	}
}
