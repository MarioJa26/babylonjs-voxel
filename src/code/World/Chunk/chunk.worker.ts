/// <reference lib="webworker" />

import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { WorldGenerator } from "@/code/Generation/WorldGenerator";
import {
	type WorkerRequestData,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";
import { LightTaskHandlers } from "./Worker/LightTaskHandlers";
import { WorkerTaskHandlers } from "./Worker/WorkerTaskHandlers";

// ---------------------------------------------------------------------------
// Shared instances
// ---------------------------------------------------------------------------
const generator = new WorldGenerator(GenerationParams);

// ---------------------------------------------------------------------------
// Block compression
// ---------------------------------------------------------------------------

// _compressSeen dual-use in compressBlocks:
//   Pass 1: seen[id] = 1 for each unique block ID encountered.
//   Pass 2: seen[palette[i]] = i overwrites flags with palette indices
//           for O(1) nibble lookup in the packing loop.
//   Safe because palette index 0 sets seen[id] = 0 (falsy), but the
//   packing loop only reads seen[blocks[i]] for block IDs that were
//   already confirmed to be in the palette — and index 0 is the correct
//   nibble value for palette[0].  The zero-fill at the start of each
//   call clears both passes' state.
const _compressSeen = new Uint8Array(65536);
const _compressUniqueIds = new Uint16Array(17);

function compressBlocks(blocks: Uint8Array): {
	isUniform: boolean;
	uniformBlockId: number;
	palette: Uint16Array | null;
	packedBlocks: Uint8Array | Uint16Array | null;
} {
	const seen = _compressSeen;
	seen.fill(0);
	let uniqueCount = 0;
	let uniqueIdCount = 0;
	const firstId = blocks[0];

	for (let i = 0; i < blocks.length; i++) {
		const id = blocks[i];
		if (!seen[id]) {
			seen[id] = 1;
			_compressUniqueIds[uniqueIdCount++] = id;
			uniqueCount++;
			if (uniqueCount > 16) break;
		}
	}

	if (uniqueCount === 1) {
		return {
			isUniform: true,
			uniformBlockId: firstId,
			palette: null,
			packedBlocks: null,
		};
	}

	if (uniqueCount <= 16) {
		const palette = new Uint16Array(uniqueCount);
		let pi = 0;

		// Build palette from tracked unique IDs (avoids scanning all 65536 entries).
		for (let i = 0; i < uniqueIdCount && pi < uniqueCount; i++) {
			palette[pi++] = _compressUniqueIds[i];
		}

		// Overwrite seen[] with palette indices for O(1) lookup in the pack loop.
		for (let i = 0; i < palette.length; i++) {
			seen[palette[i]] = i;
		}

		const len = (blocks.length + 1) >> 1;
		const packedArray = new Uint8Array(new ArrayBuffer(len));

		// PERF: process pairs to eliminate the per-voxel branch and let V8
		// auto-vectorise the inner loop.  For 32³ = 32768 voxels this halves
		// the iteration count (32768 → 16384) and removes the branch predictor
		// pressure entirely.
		const len32 = blocks.length >> 1;
		for (let i = 0; i < len32; i++) {
			packedArray[i] =
				(seen[blocks[i * 2]!]! & 0x0f) |
				((seen[blocks[i * 2 + 1]!]! & 0x0f) << 4);
		}
		// Handle a trailing odd element if blocks.length is odd.
		if (blocks.length & 1) {
			packedArray[len32] = seen[blocks[blocks.length - 1]!]! & 0x0f;
		}

		return {
			isUniform: false,
			uniformBlockId: 0,
			palette,
			packedBlocks: packedArray,
		};
	}

	return {
		isUniform: false,
		uniformBlockId: 0,
		palette: null,
		packedBlocks: blocks,
	};
}

// ---------------------------------------------------------------------------
// Worker message handler
// ---------------------------------------------------------------------------

const onMessageHandler = (event: MessageEvent<WorkerRequestData>) => {
	const { type } = event.data;

	switch (type) {
		case WorkerTaskType.GenerateTerrain: {
			const { payload, transferables } =
				WorkerTaskHandlers.handleGenerateTerrain(event.data, {
					generator,
					compressBlocks,
				});

			self.postMessage(payload, transferables);
			return;
		}

		case WorkerTaskType.InitDistantTerrainShared: {
			WorkerTaskHandlers.handleInitDistantTerrainShared(event.data);
			self.postMessage({ type: WorkerTaskType.InitDistantTerrainShared }); // ← ack
			return;
		}

		case WorkerTaskType.GenerateDistantTerrain: {
			try {
				const { payload, transferables } =
					WorkerTaskHandlers.handleGenerateDistantTerrain(event.data);
				self.postMessage(
					{ ...payload, type: WorkerTaskType.GenerateDistantTerrain_Generated },
					transferables,
				);
			} catch (err) {
				console.error("GenerateDistantTerrain failed:", err);
				const { requestId, centerChunkX, centerChunkZ } = event.data;
				self.postMessage({
					type: WorkerTaskType.GenerateDistantTerrain_Generated,
					requestId,
					centerChunkX,
					centerChunkZ,
					failed: true,
				});
			}
			return;
		}

		case WorkerTaskType.InitLightShared: {
			LightTaskHandlers.handleInitLightShared(event.data);
			return;
		}
		case WorkerTaskType.LightSetClosedFaceMask: {
			LightTaskHandlers.handleSetClosedFaceMask(event.data);
			return;
		}
		case WorkerTaskType.LightRegisterChunk: {
			LightTaskHandlers.handleRegisterChunk(event.data);
			return;
		}
		case WorkerTaskType.LightUnregisterChunk: {
			LightTaskHandlers.handleUnregisterChunk(event.data);
			return;
		}
		case WorkerTaskType.LightUpdateChunkBuffers: {
			LightTaskHandlers.handleUpdateBuffers(event.data);
			return;
		}
		case WorkerTaskType.LightMutate: {
			LightTaskHandlers.handleMutate(event.data);
			return;
		}
		case WorkerTaskType.LightAddEmission: {
			LightTaskHandlers.handleAddEmission(event.data);
			return;
		}
		case WorkerTaskType.LightSkyReconcile: {
			LightTaskHandlers.handleSkyReconcile(event.data);
			return;
		}
		case WorkerTaskType.LightPropagateDeferred: {
			LightTaskHandlers.handlePropagateDeferred(event.data);
			return;
		}

		default:
			return;
	}
};

self.onmessage = onMessageHandler;
self.postMessage({ type: WorkerTaskType.WorkerReady });
