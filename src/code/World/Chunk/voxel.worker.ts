// src/code/World/Chunk/voxel.worker.ts

import { buildLod4TerrainMesh } from "../MeshPipeline/core/Lod4TerrainMesher";
import { MeshEmitters } from "../MeshPipeline/core/MeshEmitters";
import {
	createEmptyWorkerInternalMeshData,
	createFlatVoxelMeshContext,
	toTransferableMeshData,
	type WorkerMeshBaseContext,
} from "../MeshPipeline/core/WorkerMeshHelpers";
import {
	type FullMeshMessage,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";

/**
 * The real request shape this worker consumes.
 * IMPORTANT: this replaces the old ctx/input-based request shape.
 */
export interface VoxelWorkerRequest {
	task: "voxelMesh";

	chunkId: bigint;
	lod: number;
	chunk_size: number;

	voxels: Uint16Array | null;
	light_array?: Uint8Array;

	neighbors: (Uint16Array | null | undefined)[];
	neighborLights?: (Uint8Array | undefined)[];
}

self.onmessage = (event: MessageEvent<VoxelWorkerRequest>): void => {
	const data = event.data;
	if (data.task !== "voxelMesh") return;

	const baseCtx: WorkerMeshBaseContext = {
		size: data.chunk_size,
		lod: data.lod,
	};

	const fullCtx = createFlatVoxelMeshContext(baseCtx, data);

	const opaqueOut = createEmptyWorkerInternalMeshData();
	const transparentOut = createEmptyWorkerInternalMeshData();

	const isSuperBlock = data.lod >= 4;

	if (isSuperBlock) {
		buildLod4TerrainMesh(fullCtx, data.lod, opaqueOut, transparentOut);
	} else {
		MeshEmitters.buildVoxelMesh(fullCtx, opaqueOut, transparentOut);
	}

	// 5) Convert to transferable MeshData

	const opaque =
		opaqueOut.faceCount > 0 ? toTransferableMeshData(opaqueOut) : null;

	const transparent =
		transparentOut.faceCount > 0
			? toTransferableMeshData(transparentOut)
			: null;

	const response: FullMeshMessage = {
		type: WorkerTaskType.GenerateFullMesh,
		chunkId: data.chunkId,
		lod: data.lod,
		opaque,
		transparent,
	};

	const transferables: Transferable[] = [];

	if (opaque) {
		transferables.push(opaque.faceDataA.buffer);
		transferables.push(opaque.faceDataB.buffer);
		transferables.push(opaque.faceDataC.buffer);
	}

	if (transparent) {
		transferables.push(transparent.faceDataA.buffer);
		transferables.push(transparent.faceDataB.buffer);
		transferables.push(transparent.faceDataC.buffer);
	}

	self.postMessage(response, transferables);
};
