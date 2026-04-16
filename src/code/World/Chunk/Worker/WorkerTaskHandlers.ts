import { DistantTerrainGenerator } from "@/code/Generation/DistantTerrain/DistantTerrainGenerator";
import type { WorldGenerator } from "@/code/Generation/WorldGenerator";
import type { WorkerInternalMeshData } from "../DataStructures/WorkerInternalMeshData";
import {
	type GenerateDistantTerrainRequest,
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
		faceName: string,
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

export class WorkerTaskHandlers {
	public static handleGenerateTerrain(
		request: GenerateTerrainRequest,
		deps: {
			generator: WorldGenerator;
			compressBlocks: CompressBlocksFn;
		},
	): {
		payload: TerrainGeneratedMessage;
		transferables: Transferable[];
	} {
		const result = deps.generator.generateChunkData(
			request.chunkX,
			request.chunkY,
			request.chunkZ,
			{
				deferLighting: request.deferLighting === true,
			},
		);

		const compressed = deps.compressBlocks(result.blocks);

		const payload: TerrainGeneratedMessage = {
			chunkId: request.chunkId,
			type: WorkerTaskType.GenerateTerrain,
			block_array: compressed.packedBlocks,
			light_array: result.light,
			isUniform: compressed.isUniform,
			uniformBlockId: compressed.uniformBlockId,
			palette: compressed.palette,
		};

		if (result.lightSeedState) {
			payload.lightSeedQueue = result.lightSeedState.queue;
			payload.lightSeedLength = result.lightSeedState.length;
		}

		const transferables: Transferable[] = [];

		pushTransferableBuffer(
			transferables,
			compressed.packedBlocks ?? undefined,
			"packedBlocks",
		);

		pushTransferableBuffer(transferables, result.light, "light_array");

		pushTransferableBuffer(
			transferables,
			compressed.palette ?? undefined,
			"palette",
		);

		pushTransferableBuffer(
			transferables,
			result.lightSeedState?.queue,
			"lightSeedQueue",
		);

		return { payload, transferables };
	}

	public static handleGenerateDistantTerrain(
		request: GenerateDistantTerrainRequest,
	): {
		payload: {
			type: number;
			centerChunkX: number;
			centerChunkZ: number;
			positions: Int16Array;
			normals: Int8Array;
			surfaceTiles: Uint8Array;
		};
		transferables: Transferable[];
	} {
		const {
			centerChunkX,
			centerChunkZ,
			radius,
			renderDistance,
			gridStep,
			oldData,
			oldCenterChunkX,
			oldCenterChunkZ,
		} = request;

		const data = DistantTerrainGenerator.generate(
			centerChunkX,
			centerChunkZ,
			radius,
			renderDistance,
			gridStep,
			oldData,
			oldCenterChunkX,
			oldCenterChunkZ,
		);

		return {
			payload: {
				type: 0, // caller should overwrite with WorkerTaskType.GenerateDistantTerrain_Generated if desired
				centerChunkX,
				centerChunkZ,
				positions: data.positions,
				normals: data.normals,
				surfaceTiles: data.surfaceTiles,
			},
			transferables: [
				data.positions.buffer,
				data.normals.buffer,
				data.surfaceTiles.buffer,
			],
		};
	}
}
function pushTransferableBuffer(
	transferables: Transferable[],
	view: ArrayBufferView | null | undefined,
	label: string,
): void {
	if (!view) {
		return;
	}

	const buffer = view.buffer;

	if (!(buffer instanceof ArrayBuffer)) {
		throw new Error(
			`Non-transferable buffer detected for ${label}. ` +
				`Worker terrain payloads must be ArrayBuffer-backed before posting.`,
		);
	}

	transferables.push(buffer);
}
