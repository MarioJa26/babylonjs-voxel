/// <reference lib="webworker" />

import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { WorldGenerator } from "@/code/Generation/WorldGenerator";
import {
	type WorkerRequestData,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";
import { WorkerTaskHandlers } from "./Worker/WorkerTaskHandlers";

// ---------------------------------------------------------------------------
// Shared instances
// ---------------------------------------------------------------------------
const generator = new WorldGenerator(GenerationParams);

// ---------------------------------------------------------------------------
// Block compression
// ---------------------------------------------------------------------------
function compressBlocks(blocks: Uint8Array): {
	isUniform: boolean;
	uniformBlockId: number;
	palette: Uint16Array | null;
	packedBlocks: Uint8Array | Uint16Array | null;
} {
	const seen = new Uint8Array(65536);
	let uniqueCount = 0;
	const firstId = blocks[0];

	for (let i = 0; i < blocks.length; i++) {
		const id = blocks[i];
		if (!seen[id]) {
			seen[id] = 1;
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

		for (let id = 0; id < 65536 && pi < uniqueCount; id++) {
			if (seen[id]) {
				palette[pi++] = id;
			}
		}

		for (let i = 0; i < palette.length; i++) {
			seen[palette[i]] = i;
		}

		const len = (blocks.length + 1) >> 1;
		const packedArray = new Uint8Array(new ArrayBuffer(len));

		for (let i = 0; i < blocks.length; i++) {
			const nibble = seen[blocks[i]];
			const byteIndex = i >> 1;

			if (i & 1) {
				packedArray[byteIndex] =
					(packedArray[byteIndex] & 0x0f) | ((nibble & 0x0f) << 4);
			} else {
				packedArray[byteIndex] =
					(packedArray[byteIndex] & 0xf0) | (nibble & 0x0f);
			}
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

			self.postMessage(
				{
					...payload,
					type: WorkerTaskType.GenerateTerrain,
				},
				transferables,
			);
			return;
		}

		case WorkerTaskType.GenerateDistantTerrain: {
			const { payload, transferables } =
				WorkerTaskHandlers.handleGenerateDistantTerrain(event.data);

			self.postMessage(
				{
					...payload,
					type: WorkerTaskType.GenerateDistantTerrain_Generated,
				},
				transferables,
			);
			return;
		}

		default:
			return;
	}
};

self.onmessage = onMessageHandler;
