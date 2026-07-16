// src/code/World/Chunk/voxel.worker.ts

import { MeshEmitters } from "../MeshPipeline/core/MeshEmitters";
import {
	createEmptyWorkerInternalMeshData,
	createMeshContextFromPayload,
	toTransferableMeshData,
	type WorkerMeshBaseContext,
	type WorkerMeshInput,
} from "../MeshPipeline/core/WorkerMeshHelpers";
import { shapeInitPromise } from "../Shape/BlockShapes";
import { PaletteExpander } from "./DataStructures/PaletteExpander";
import {
	type FullMeshMessage,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";

export interface VoxelWorkerRequest {
	type: WorkerTaskType.GenerateFullMesh;

	chunkId: bigint;
	meshRevision: number;
	lod: number;
	chunk_size: number;

	block_array: Uint8Array | Uint16Array | null;
	uniformBlockId?: number;
	palette?: Uint8Array | Uint16Array | null;
	light_array?: Uint8Array;

	neighbors: (Uint16Array | undefined)[];
	neighborLights?: (Uint8Array | undefined)[];
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

// Mesh generation depends on the async block-shape/block JSON. If we mesh
// before that finishes loading, the shape-dependent caches are permanently
// populated with the cube fallback (e.g. grass crosses render as transparent
// cubes). Await shape init once per worker before the first mesh task.
let _shapesReady: Promise<void> | null = null;
function ensureShapesReady(): Promise<void> {
	if (!_shapesReady) _shapesReady = shapeInitPromise;
	return _shapesReady;
}

// PERF: Reuse the output buffers across every mesh task in this worker.
// buildVoxelMesh reserves a worst-case (size^3 * 16) capacity up front so the
// hot-path emitters can write branchlessly; allocating fresh WorkerInternalMeshData
// per task threw away ~12 MB of backing storage on every chunk. The
// ResizableTypedArray keeps its capacity across builds — reset() only zeroes
// length — so we allocate once and clear between tasks. toTransferableMeshData
// slices to a right-sized copy for transfer, so these reused buffers are never
// detached.
const _opaqueOut = createEmptyWorkerInternalMeshData();
const _transparentOut = createEmptyWorkerInternalMeshData();

function resetMeshOut(): void {
	_opaqueOut.faceDataA.reset();
	_opaqueOut.faceDataB.reset();
	_opaqueOut.faceDataC.reset();
	_opaqueOut.faceCount = 0;
	_transparentOut.faceDataA.reset();
	_transparentOut.faceDataB.reset();
	_transparentOut.faceDataC.reset();
	_transparentOut.faceCount = 0;
}

self.onmessage = (event: MessageEvent<VoxelWorkerRequest>): void => {
	const data = event.data;
	if (data.type !== WorkerTaskType.GenerateFullMesh) return;

	void ensureShapesReady().then(() => {
		const centerBlockArray = expandCenterOnly(data);

		const meshInput: WorkerMeshInput = {
			block_array: centerBlockArray,
			light_array: data.light_array,
			neighbors: data.neighbors as (Uint16Array | undefined)[],
			neighborLights: data.neighborLights,
		};

		const baseCtx: WorkerMeshBaseContext = {
			size: data.chunk_size,
			lod: data.lod,
		};

		const fullCtx = createMeshContextFromPayload(baseCtx, meshInput);

		resetMeshOut();
		const opaqueOut = _opaqueOut;
		const transparentOut = _transparentOut;

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
			meshRevision: data.meshRevision,
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
	});
};
