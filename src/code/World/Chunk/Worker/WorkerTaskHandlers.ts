import {
	generate,
	initSharedBuffers,
	setRenderDistance,
} from "@/code/Generation/DistantTerrain/DistantTerrainGenerator";
import type { WorldGenerator } from "@/code/Generation/WorldGenerator";
import { generateFarTile } from "@/code/World/FarTiles/FarTileGenerator";
import type { FaceName } from "@/code/World/Texture/FaceName";
import type { WorkerInternalMeshData } from "../DataStructures/WorkerInternalMeshData";
import {
	type DistantTerrainGeneratedMessage,
	type FarTileGeneratedMessage,
	type GenerateDistantTerrainRequest,
	type GenerateFarTileRequest,
	type GenerateTerrainRequest,
	type TerrainGeneratedMessage,
	WorkerTaskType,
} from "../DataStructures/WorkerMessageType";

export type MeshBuilderLike = {
	generateMesh(data: {
		block_array: Uint8Array | Uint16Array;
		chunk_size: number;
		light_array?: Uint8Array;
		neighbors: (Uint8Array | Uint16Array | undefined)[];
		neighborLights?: (Uint8Array | undefined)[];
		lod?: number;
	}): {
		opaque: WorkerInternalMeshData;
		transparent: WorkerInternalMeshData;
	};

	addQuad: (
		x: number,
		y: number,
		z: number,
		axis: number,
		width: number,
		height: number,
		blockId: number,
		isBackFace: boolean,
		faceName: FaceName,
		lightLevel: number,
		packedAO: number,
		meshData: WorkerInternalMeshData,
	) => void;
};

export type DistantTerrainGenerateOutput = {
	centerChunkX: number;
	centerChunkZ: number;
};

/*
 * Safe to reuse in a worker because generate() and this handler are
 * synchronous. Each invocation fully overwrites both fields.
 */
const distantTerrainOutput: DistantTerrainGenerateOutput = {
	centerChunkX: 0,
	centerChunkZ: 0,
};

export type CompressBlocksFn = (blocks: Uint8Array) => {
	isUniform: boolean;
	uniformBlockId: number;
	palette: Uint16Array | null;
	packedBlocks: Uint8Array | Uint16Array | null;
};

type TerrainHandlerDependencies = {
	generator: WorldGenerator;
	compressBlocks: CompressBlocksFn;
};

type InitDistantTerrainSharedRequest = {
	positionsBuffer: SharedArrayBuffer;
	normalsBuffer: SharedArrayBuffer;
	surfaceTilesBuffer: SharedArrayBuffer;
	radius: number;
	gridStep: number;
};

/*
 * Do not expose one shared mutable empty array. Although it would remove a
 * small allocation, a caller could mutate it and affect later responses.
 */
function createEmptyTransferables(): Transferable[] {
	return [];
}

/**
 * Appends an ArrayBuffer-backed view to a preallocated transfer list.
 *
 * SharedArrayBuffers are cloneable but not transferable, so they return early.
 * Duplicate ArrayBuffers are skipped because including the same buffer more
 * than once in a postMessage transfer list can throw DataCloneError.
 *
 * `ArrayBufferView["buffer"]` is `ArrayBufferLike`, i.e. exactly
 * `ArrayBuffer | SharedArrayBuffer`. Once SharedArrayBuffer is excluded there
 * is no third case, so no further narrowing is needed at runtime.
 */
function appendUniqueTransferable(
	transferables: Transferable[],
	count: number,
	view: ArrayBufferView | null | undefined,
): number {
	if (view == null) return count;

	const buffer = view.buffer;

	if (
		typeof SharedArrayBuffer !== "undefined" &&
		buffer instanceof SharedArrayBuffer
	) {
		return count;
	}

	// Transfer lists must not contain the same ArrayBuffer more than once.
	// The list has at most four entries, so a small linear scan is cheaper
	// than allocating a Set for every generated chunk.
	for (let i = 0; i < count; i++) {
		if (transferables[i] === buffer) {
			return count;
		}
	}

	transferables[count] = buffer;
	return count + 1;
}

export function handleGenerateTerrain(
	request: GenerateTerrainRequest,
	deps: TerrainHandlerDependencies,
): {
	payload: TerrainGeneratedMessage;
	transferables: Transferable[];
} {
	const generated = deps.generator.generateChunkData(
		request.chunkX,
		request.chunkY,
		request.chunkZ,
		{
			deferLighting: request.deferLighting === true,
			skipDecorations: request.skipDecorations === true,
		},
	);

	const compressed = deps.compressBlocks(generated.blocks);
	const packedBlocks = compressed.packedBlocks;
	const palette = compressed.palette;
	const light = generated.light;
	const lightSeedState = generated.lightSeedState;

	const payload: TerrainGeneratedMessage = {
		chunkId: request.chunkId,
		type: WorkerTaskType.GenerateTerrain,
		block_array: packedBlocks,
		light_array: light,
		isUniform: compressed.isUniform,
		uniformBlockId: compressed.uniformBlockId,
		palette,
	};

	// Maximum possible entries:
	// packed blocks, light data, palette, and light-seed queue.
	const transferables = new Array<Transferable>(4);
	let count = 0;

	count = appendUniqueTransferable(transferables, count, packedBlocks);

	count = appendUniqueTransferable(transferables, count, light);

	count = appendUniqueTransferable(transferables, count, palette);

	if (lightSeedState != null) {
		const lightSeedQueue = lightSeedState.queue;

		payload.lightSeedQueue = lightSeedQueue;
		payload.lightSeedLength = lightSeedState.length;

		count = appendUniqueTransferable(transferables, count, lightSeedQueue);
	}

	transferables.length = count;

	return {
		payload,
		transferables,
	};
}

export function handleInitDistantTerrainShared(
	request: InitDistantTerrainSharedRequest,
): {
	payload: { type: number };
	transferables: Transferable[];
} {
	initSharedBuffers(
		request.positionsBuffer,
		request.normalsBuffer,
		request.surfaceTilesBuffer,
		request.radius,
		request.gridStep,
	);

	return {
		payload: {
			type: WorkerTaskType.InitDistantTerrainShared,
		},
		transferables: createEmptyTransferables(),
	};
}

export function handleGenerateDistantTerrain(
	request: GenerateDistantTerrainRequest,
): {
	payload: DistantTerrainGeneratedMessage;
	transferables: Transferable[];
} {
	setRenderDistance(request.renderDistance);

	generate(
		request.centerChunkX,
		request.centerChunkZ,
		request.radius,
		request.gridStep,
		distantTerrainOutput,
	);

	return {
		payload: {
			type: WorkerTaskType.GenerateDistantTerrain_Generated,
			requestId: request.requestId,
			centerChunkX: distantTerrainOutput.centerChunkX,
			centerChunkZ: distantTerrainOutput.centerChunkZ,
		},
		transferables: [],
	};
}

export function handleGenerateFarTile(request: GenerateFarTileRequest): {
	payload: FarTileGeneratedMessage;
	transferables: Transferable[];
} {
	const generated = generateFarTile({
		requestId: request.requestId,
		levelIndex: request.levelIndex,
		tileX: request.tileX,
		tileZ: request.tileZ,
	});

	const opaqueFaces = generated.opaqueFaces;
	const waterFaces = generated.waterFaces;

	const transferables = new Array<Transferable>(2);
	let transferableCount = 0;

	transferableCount = appendTransferable(
		transferables,
		transferableCount,
		opaqueFaces,
	);

	transferableCount = appendTransferable(
		transferables,
		transferableCount,
		waterFaces,
	);

	transferables.length = transferableCount;

	return {
		payload: {
			type: WorkerTaskType.GenerateFarTile,
			requestId: generated.requestId,
			levelIndex: generated.levelIndex,
			tileX: generated.tileX,
			tileZ: generated.tileZ,
			opaqueFaces,
			waterFaces,
		},
		transferables,
	};
}

/**
 * Appends an ArrayBuffer-backed view without using Array.push().
 *
 * The returned index allows callers to fill a pre-sized transfer list without
 * allocating callback functions or temporary entries.
 */
function appendTransferable(
	transferables: Transferable[],
	index: number,
	view: ArrayBufferView | null | undefined,
): number {
	if (view == null) return index;

	const buffer = view.buffer;

	/*
	 * SharedArrayBuffer is cloneable between compatible contexts but is not
	 * transferable and must not be included in the transfer list.
	 */
	if (
		typeof SharedArrayBuffer !== "undefined" &&
		buffer instanceof SharedArrayBuffer
	) {
		return index;
	}

	transferables[index] = buffer;
	return index + 1;
}
