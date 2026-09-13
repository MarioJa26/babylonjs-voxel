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

	/*
	 * At most four buffers can be transferred:
	 * packed blocks, lighting, palette, and the optional light seed queue.
	 *
	 * Pre-sizing avoids backing-store growth as items are appended. The final
	 * length is trimmed before returning.
	 */
	const transferables = new Array<Transferable>(4);
	let transferableCount = 0;

	transferableCount = appendTransferable(
		transferables,
		transferableCount,
		packedBlocks,
		"packedBlocks",
	);

	transferableCount = appendTransferable(
		transferables,
		transferableCount,
		light,
		"light_array",
	);

	transferableCount = appendTransferable(
		transferables,
		transferableCount,
		palette,
		"palette",
	);

	if (lightSeedState) {
		payload.lightSeedQueue = lightSeedState.queue;
		payload.lightSeedLength = lightSeedState.length;

		transferableCount = appendTransferable(
			transferables,
			transferableCount,
			lightSeedState.queue,
			"lightSeedQueue",
		);
	}

	transferables.length = transferableCount;

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
		"opaqueFaces",
	);

	transferableCount = appendTransferable(
		transferables,
		transferableCount,
		waterFaces,
		"waterFaces",
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
	label: string,
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

	if (!(buffer instanceof ArrayBuffer)) {
		throw new Error(
			`Non-transferable buffer for "${label}". Must be ArrayBuffer-backed before posting.`,
		);
	}

	transferables[index] = buffer;
	return index + 1;
}
