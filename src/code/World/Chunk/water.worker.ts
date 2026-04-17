// src/code/World/Chunk/water.worker.ts

import { MeshEmitters } from "../MeshPipeline/core/MeshEmitters";
import type { WaterSampleGrid } from "../MeshPipeline/core/WaterPipeline";
import {
	createEmptyWorkerInternalMeshData,
	createMeshContextFromPayload,
	toTransferableMeshData,
	type WorkerMeshBaseContext,
	type WorkerMeshInput,
} from "../MeshPipeline/core/WorkerMeshHelpers";
import {
	type FullMeshMessage,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";

export interface WaterWorkerRequest {
	task: "waterMesh";
	chunkId: bigint;
	ctx: WorkerMeshBaseContext;

	/**
	 * Optional raw voxel/light data so the worker can rebuild a full MeshContext.
	 * This keeps the worker future-proof if WaterPipeline later needs real getBlock/getLight.
	 */
	input: WorkerMeshInput;

	/**
	 * Precomputed water surface grid (recommended).
	 */
	grid: WaterSampleGrid;
}
const opaque = null;
self.onmessage = (event: MessageEvent<WaterWorkerRequest>): void => {
	const data = event.data;
	if (data.task !== "waterMesh") return;

	const { ctx, input, grid, chunkId } = data;

	/**
	 * Rebuild a full MeshContext inside the worker.
	 * Even if the current WaterPipeline does not use getBlock/getLight directly,
	 * this keeps the worker consistent with the rest of the mesh pipeline.
	 */
	const fullCtx = createMeshContextFromPayload(ctx, input);

	/**
	 * Internal worker-only mesh container.
	 * DO NOT post this object directly to main thread.
	 */
	const out = createEmptyWorkerInternalMeshData();

	/**
	 * Build water mesh using MeshPipeline.
	 */
	MeshEmitters.buildWaterMesh(fullCtx, grid, out);

	/**
	 * Convert to plain transferable MeshData.
	 * Water belongs in the transparent channel.
	 */
	const transparent = toTransferableMeshData(out);

	const response: FullMeshMessage = {
		type: WorkerTaskType.GenerateFullMesh,
		chunkId,
		lod: ctx.lod,
		opaque,
		transparent,
	};

	self.postMessage(response, [
		transparent.faceDataA.buffer,
		transparent.faceDataB.buffer,
		transparent.faceDataC.buffer,
	]);
};
