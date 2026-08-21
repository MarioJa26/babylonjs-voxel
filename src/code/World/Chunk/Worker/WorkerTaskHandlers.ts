import {
	generate,
	initSharedBuffers,
	setRenderDistance,
} from "@/code/Generation/DistantTerrain/DistantTerrainGenerator";
import { generateFarTile } from "@/code/World/FarTiles/FarTileGenerator";
import type { WorldGenerator } from "@/code/Generation/WorldGenerator";
import type { FaceName } from "@/code/World/Texture/FaceName";
import type { WorkerInternalMeshData } from "../DataStructures/WorkerInternalMeshData";
import {
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

export type CompressBlocksFn = (blocks: Uint8Array) => {
	isUniform: boolean;
	uniformBlockId: number;
	palette: Uint16Array | null;
	packedBlocks: Uint8Array | Uint16Array | null;
};

export function handleGenerateTerrain(
	request: GenerateTerrainRequest,
	deps: { generator: WorldGenerator; compressBlocks: CompressBlocksFn },
): { payload: TerrainGeneratedMessage; transferables: Transferable[] } {
	const result = deps.generator.generateChunkData(
		request.chunkX,
		request.chunkY,
		request.chunkZ,
		{
			deferLighting: request.deferLighting === true,
			skipDecorations: request.skipDecorations === true,
		},
	);

	const compressed = deps.compressBlocks(result.blocks);
	const lightSeedState = result.lightSeedState;

	const payload: TerrainGeneratedMessage = {
		chunkId: request.chunkId,
		type: WorkerTaskType.GenerateTerrain,
		block_array: compressed.packedBlocks,
		light_array: result.light,
		isUniform: compressed.isUniform,
		uniformBlockId: compressed.uniformBlockId,
		palette: compressed.palette,
	};

	if (lightSeedState) {
		payload.lightSeedQueue = lightSeedState.queue;
		payload.lightSeedLength = lightSeedState.length;
	}

	const transferables: Transferable[] = [];

	pushTransferable(
		transferables,
		compressed.packedBlocks ?? undefined,
		"packedBlocks",
	);
	pushTransferable(transferables, result.light, "light_array");
	pushTransferable(transferables, compressed.palette ?? undefined, "palette");

	if (lightSeedState) {
		pushTransferable(transferables, lightSeedState.queue, "lightSeedQueue");
	}

	return { payload, transferables };
}

export function handleInitDistantTerrainShared(request: {
	positionsBuffer: SharedArrayBuffer;
	normalsBuffer: SharedArrayBuffer;
	surfaceTilesBuffer: SharedArrayBuffer;
	radius: number;
	gridStep: number;
}): { payload: { type: number }; transferables: Transferable[] } {
	initSharedBuffers(
		request.positionsBuffer,
		request.normalsBuffer,
		request.surfaceTilesBuffer,
		request.radius,
		request.gridStep,
	);

	return {
		payload: { type: WorkerTaskType.InitDistantTerrainShared },
		transferables: [],
	};
}

export function handleGenerateDistantTerrain(
	request: GenerateDistantTerrainRequest,
): {
	payload: {
		type: number;
		requestId: number;
		centerChunkX: number;
		centerChunkZ: number;
	};
	transferables: Transferable[];
} {
	const {
		requestId,
		centerChunkX,
		centerChunkZ,
		radius,
		gridStep,
		renderDistance,
	} = request;

	setRenderDistance(renderDistance);
	const data = generate(centerChunkX, centerChunkZ, radius, gridStep);

	return {
		payload: {
			type: WorkerTaskType.GenerateDistantTerrain,
			requestId,
			centerChunkX: data.centerChunkX,
			centerChunkZ: data.centerChunkZ,
		},
		transferables: [],
	};
}

export function handleGenerateFarTile(request: GenerateFarTileRequest): {
	payload: FarTileGeneratedMessage;
	transferables: Transferable[];
} {
	const result = generateFarTile({
		requestId: request.requestId,
		levelIndex: request.levelIndex,
		tileX: request.tileX,
		tileZ: request.tileZ,
	});

	return {
		payload: {
			type: WorkerTaskType.GenerateFarTile,
			requestId: result.requestId,
			levelIndex: result.levelIndex,
			tileX: result.tileX,
			tileZ: result.tileZ,
			opaqueFaces: result.opaqueFaces,
			waterFaces: result.waterFaces,
		},
		transferables: [result.opaqueFaces.buffer, result.waterFaces.buffer],
	};
}

function pushTransferable(
	transferables: Transferable[],
	view: ArrayBufferView | null | undefined,
	label: string,
): void {
	if (view == null) return;

	const buffer = view.buffer;

	// SharedArrayBuffer cannot be transferred.
	if (buffer instanceof SharedArrayBuffer) return;

	if (!(buffer instanceof ArrayBuffer)) {
		throw new Error(
			`Non-transferable buffer for "${label}". Must be ArrayBuffer-backed before posting.`,
		);
	}

	transferables.push(buffer);
}
