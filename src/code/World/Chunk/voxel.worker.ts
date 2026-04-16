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

/**
 * The real request shape this worker consumes.
 * IMPORTANT: this replaces the old ctx/input-based request shape.
 */
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

/**
 * Expand a center/neighbor block payload into a dense block array.
 *
 * Handles:
 * - already-dense arrays
 * - palette-packed arrays
 * - uniform chunks (block_array === null, uniformBlockId set)
 * - empty chunks
 */
function expandBlockPayload(
	raw: Uint8Array | Uint16Array | null | undefined,
	palette: Uint8Array | Uint16Array | null | undefined,
	uniformBlockId: number | undefined,
	totalBlocks: number,
	paletteExpander: PaletteExpander,
): Uint8Array | Uint16Array {
	// 1) Already dense 16-bit data → return as-is
	if (raw instanceof Uint16Array) {
		return raw;
	}

	// 2) Dense 8-bit data with no palette → return as-is
	if (raw instanceof Uint8Array && (!palette || palette.length === 0)) {
		return raw;
	}

	// 3) Missing raw array but explicitly uniform
	if (!raw && uniformBlockId !== undefined) {
		// Fast path for empty air chunk
		if (uniformBlockId === 0) {
			return new Uint16Array(totalBlocks);
		}

		const dense = new Uint16Array(totalBlocks);
		dense.fill(uniformBlockId);
		return dense;
	}

	// 4) Missing raw array and no uniform id → empty
	if (!raw) {
		return new Uint16Array(totalBlocks);
	}

	// 5) Palette exists but has only one entry → uniform chunk in disguise
	if (palette && palette.length === 1) {
		const blockId = palette[0];
		if (blockId === 0) {
			return new Uint16Array(totalBlocks);
		}

		const dense = new Uint16Array(totalBlocks);
		dense.fill(blockId);
		return dense;
	}

	// 6) Real palette-compressed case → expand fully
	if (palette && palette.length > 0) {
		return paletteExpander.expandPalette(raw, palette, totalBlocks);
	}

	// 7) Fallback
	return raw;
}

/**
 * Expand the full worker payload into dense block/light inputs
 * suitable for MeshPipeline.
 */
function expandVoxelPayload(request: VoxelWorkerRequest): WorkerMeshInput {
	const totalBlocks =
		request.chunk_size * request.chunk_size * request.chunk_size;

	const paletteExpander = new PaletteExpander();

	const centerBlockArray = expandBlockPayload(
		request.block_array,
		request.palette,
		request.uniformBlockId,
		totalBlocks,
		paletteExpander,
	);

	const expandedNeighbors: (Uint8Array | Uint16Array | undefined)[] = [];

	for (let i = 0; i < request.neighbors.length; i++) {
		const rawNeighbor = request.neighbors[i];
		const neighborPalette = request.neighborPalettes?.[i];
		const neighborUniformId = request.neighborUniformIds?.[i];

		// Completely missing neighbor stays undefined
		if (!rawNeighbor && neighborUniformId === undefined) {
			expandedNeighbors.push(undefined);
			continue;
		}

		expandedNeighbors.push(
			expandBlockPayload(
				rawNeighbor,
				neighborPalette,
				neighborUniformId,
				totalBlocks,
				paletteExpander,
			),
		);
	}

	return {
		block_array: centerBlockArray,
		light_array: request.light_array,
		neighbors: expandedNeighbors,
		neighborLights: request.neighborLights ?? [],
	};
}

self.onmessage = (event: MessageEvent<VoxelWorkerRequest>): void => {
	const data = event.data;
	if (data.task !== "voxelMesh") return;

	// 1) Expand payload into dense arrays
	const expandedInput = expandVoxelPayload(data);

	// 2) Rebuild worker-side mesh context
	const baseCtx: WorkerMeshBaseContext = {
		size: data.chunk_size,
		lod: data.lod,
	};

	const fullCtx = createMeshContextFromPayload(baseCtx, expandedInput);

	// 3) Allocate worker-internal buffers

	const opaqueOut = createEmptyWorkerInternalMeshData();
	const transparentOut = createEmptyWorkerInternalMeshData();

	// 4) Build voxel mesh
	MeshEmitters.buildVoxelMesh(fullCtx, opaqueOut, transparentOut);

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
