// src/code/World/Chunk/voxel.worker.ts

import { MeshEmitters } from "../MeshPipeline/core/MeshEmitters";
import {
	createEmptyWorkerInternalMeshData,
	createMeshContextFromPayload,
	toTransferableMeshData,
	type WorkerMeshBaseContext,
	type WorkerMeshInput,
} from "../MeshPipeline/core/WorkerMeshHelpers";
import { PaletteExpander } from "./DataStructures/PaletteExpander";
import {
	type FullMeshMessage,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";

export interface VoxelWorkerRequest {
	task: "voxelMesh";

	chunkId: bigint;
	lod: number;
	chunk_size: number;

	block_array: Uint8Array | Uint16Array | null;
	uniformBlockId?: number;
	palette?: Uint8Array | Uint16Array | null;
	light_array?: Uint8Array;

	neighbors: (Uint8Array | Uint16Array | null | undefined)[];
	neighborLights?: (Uint8Array | undefined)[];
	neighborUniformIds?: (number | undefined)[];
	neighborPalettes?: (Uint8Array | Uint16Array | null | undefined)[];
}

function expandCenterOnly(
	request: VoxelWorkerRequest,
): Uint8Array | Uint16Array {
	const totalBlocks =
		request.chunk_size * request.chunk_size * request.chunk_size;

	if (request.block_array instanceof Uint16Array) {
		return request.block_array;
	}

	if (
		request.block_array instanceof Uint8Array &&
		(!request.palette || request.palette.length === 0)
	) {
		return request.block_array;
	}

	if (!request.block_array && request.uniformBlockId !== undefined) {
		if (request.uniformBlockId === 0) {
			return new Uint16Array(totalBlocks);
		}
		const dense = new Uint16Array(totalBlocks);
		dense.fill(request.uniformBlockId);
		return dense;
	}

	if (!request.block_array) {
		return new Uint16Array(totalBlocks);
	}

	if (request.palette && request.palette.length === 1) {
		const blockId = request.palette[0];
		if (blockId === 0) {
			return new Uint16Array(totalBlocks);
		}
		const dense = new Uint16Array(totalBlocks);
		dense.fill(blockId);
		return dense;
	}

	if (request.palette && request.palette.length > 0) {
		const expander = new PaletteExpander();
		return expander.expandPalette(
			request.block_array as Uint8Array,
			request.palette,
			totalBlocks,
		);
	}

	return request.block_array;
}

self.onmessage = (event: MessageEvent<VoxelWorkerRequest>): void => {
	const data = event.data;
	if (data.task !== "voxelMesh") return;

	const centerBlockArray = expandCenterOnly(data);

	const meshInput: WorkerMeshInput = {
		block_array: centerBlockArray,
		light_array: data.light_array,
		neighbors: data.neighbors as (Uint8Array | Uint16Array | undefined)[],
		neighborLights: data.neighborLights,
		neighborPalettes: data.neighborPalettes,
		neighborUniformIds: data.neighborUniformIds,
	};

	const baseCtx: WorkerMeshBaseContext = {
		size: data.chunk_size,
		lod: data.lod,
	};

	const fullCtx = createMeshContextFromPayload(baseCtx, meshInput);

	const opaqueOut = createEmptyWorkerInternalMeshData();
	const transparentOut = createEmptyWorkerInternalMeshData();

	MeshEmitters.buildVoxelMesh(fullCtx, opaqueOut, transparentOut);

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
