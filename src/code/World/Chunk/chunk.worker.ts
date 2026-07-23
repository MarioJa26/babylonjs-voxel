/// <reference lib="webworker" />

import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { WorldGenerator } from "@/code/Generation/WorldGenerator";
import {
	type LightRegisterChunkRequest,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";
import { WATER_BLOCK_ID } from "./Worker/ChunkMesherConstants";
import { LightTaskHandlers } from "./Worker/LightTaskHandlers";
import {
	handleGenerateDistantTerrain,
	handleGenerateTerrain,
	handleInitDistantTerrainShared,
} from "./Worker/WorkerTaskHandlers";

// ---------------------------------------------------------------------------
// Worker-to-worker channel: The OPFS worker sends SAB refs + coords through
// a MessageChannel. The main thread sends only metadata (chunkId, headerSlot,
// seq). The terrain worker merges both halves before registering.
// ---------------------------------------------------------------------------
interface PendingVoxelData {
	blocksSAB: SharedArrayBuffer | null;
	paletteSAB: SharedArrayBuffer | null;
	lightSAB: SharedArrayBuffer;
	blockBytesPerElement: 1 | 2;
}
// Coord → voxel data from OPFS worker
const _pendingVoxelData = new Map<number, PendingVoxelData>();
// Coord → registration metadata from main thread (arrives before channel)
const _pendingRegistrations = new Map<
	number,
	{ seq: number; chunkId: bigint; headerSlot: number }
>();

function _packCoordKey(x: number, y: number, z: number): number {
	return ((x + 512) << 20) | ((y + 512) << 10) | (z + 512);
}

function _registerFromBoth(
	meta: {
		seq: number;
		chunkId: bigint;
		chunkX: number;
		chunkY: number;
		chunkZ: number;
		headerSlot: number;
	},
	voxel: PendingVoxelData,
): void {
	LightTaskHandlers.handleRegisterChunk({
		type: WorkerTaskType.LightRegisterChunk,
		seq: meta.seq,
		chunkId: meta.chunkId,
		chunkX: meta.chunkX,
		chunkY: meta.chunkY,
		chunkZ: meta.chunkZ,
		headerSlot: meta.headerSlot,
		blockSAB: voxel.blocksSAB,
		lightSAB: voxel.lightSAB,
		paletteSAB: voxel.paletteSAB,
		blockStorageBytesPerElement: voxel.blockBytesPerElement,
	});
}

function _handleChannelMessage(event: MessageEvent): void {
	const data = event.data;
	if (!data || (data as { _type?: string })._type !== "voxelData") return;
	const key = _packCoordKey(data.chunkX | 0, data.chunkY | 0, data.chunkZ | 0);
	const voxel: PendingVoxelData = {
		blocksSAB: data.blocksSAB,
		paletteSAB: data.paletteSAB,
		lightSAB: data.lightSAB,
		blockBytesPerElement: data.blockBytesPerElement,
	};
	const meta = _pendingRegistrations.get(key);
	if (meta) {
		_pendingRegistrations.delete(key);
		_registerFromBoth(
			{
				seq: meta.seq,
				chunkId: meta.chunkId,
				chunkX: data.chunkX,
				chunkY: data.chunkY,
				chunkZ: data.chunkZ,
				headerSlot: meta.headerSlot,
			},
			voxel,
		);
	} else {
		_pendingVoxelData.set(key, voxel);
	}
}

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

// PERF: Allocate compressed-block outputs in SharedArrayBuffers so they are
// *shared* (not transferred) to the main thread and can be handed directly to
// the mesh worker without the main-thread SAB copy in Chunk.ensureSharedBacking.
// Falls back to a plain ArrayBuffer where SharedArrayBuffer is unavailable.
const _HAS_SAB = typeof SharedArrayBuffer !== "undefined";
function sharedU8(len: number): Uint8Array {
	return new Uint8Array(
		_HAS_SAB ? new SharedArrayBuffer(len) : new ArrayBuffer(len),
	);
}
function sharedU16(len: number): Uint16Array {
	return new Uint16Array(
		_HAS_SAB ? new SharedArrayBuffer(len * 2) : new ArrayBuffer(len * 2),
	);
}

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
		// Water blocks get source state: bit 3 = source marker, bits 0-2 = level 0
		const packedId = firstId === WATER_BLOCK_ID ? WATER_BLOCK_ID : firstId;
		return {
			isUniform: true,
			uniformBlockId: packedId,
			palette: null,
			packedBlocks: null,
		};
	}

	if (uniqueCount <= 16) {
		const palette = sharedU16(uniqueCount);
		let pi = 0;

		// Build palette from tracked unique IDs (avoids scanning all 65536 entries).
		for (let i = 0; i < uniqueIdCount && pi < uniqueCount; i++) {
			const rawId = _compressUniqueIds[i];
			// Water blocks use raw ID — level 0 = source
			palette[pi++] = rawId === WATER_BLOCK_ID ? WATER_BLOCK_ID : rawId;
		}

		// Overwrite seen[] with palette indices for O(1) lookup in the pack loop.
		// Key by raw block ID (not palette entry) so water blocks (ID 30) map to
		// their correct palette index instead of the stale pass-1 sentinel.
		for (let i = 0; i < uniqueIdCount; i++) {
			seen[_compressUniqueIds[i]] = i;
		}

		const len = (blocks.length + 1) >> 1;
		const packedArray = sharedU8(len);

		// PERF: process pairs to eliminate the per-voxel branch and let V8
		// auto-vectorise the inner loop.  For 32³ = 32768 voxels this halves
		// the iteration count (32768 → 16384) and removes the branch predictor
		// pressure entirely.
		const len32 = blocks.length >> 1;
		for (let i = 0; i < len32; i++) {
			packedArray[i] =
				(seen[blocks[i * 2]] & 0x0f) | ((seen[blocks[i * 2 + 1]] & 0x0f) << 4);
		}
		// Handle a trailing odd element if blocks.length is odd.
		if (blocks.length & 1) {
			packedArray[len32] = seen[blocks[blocks.length - 1]] & 0x0f;
		}

		return {
			isUniform: false,
			uniformBlockId: 0,
			palette,
			packedBlocks: packedArray,
		};
	}

	// Dense path: >16 unique block types. Convert to Uint16Array and pack
	// water source state so state survives serialization round-trips.
	const hasWater = seen[WATER_BLOCK_ID] !== 0;
	if (hasWater) {
		const u16 = sharedU16(blocks.length);
		for (let i = 0; i < blocks.length; i++) {
			const id = blocks[i];
			u16[i] = id === WATER_BLOCK_ID ? WATER_BLOCK_ID : id;
		}
		return {
			isUniform: false,
			uniformBlockId: 0,
			palette: null,
			packedBlocks: u16,
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

const onMessageHandler = (event: MessageEvent) => {
	const { type } = event.data;

	switch (type) {
		case WorkerTaskType.GenerateTerrain: {
			const { payload, transferables } = handleGenerateTerrain(event.data, {
				generator,
				compressBlocks,
			});

			self.postMessage(payload, transferables);
			return;
		}

		case WorkerTaskType.InitDistantTerrainShared: {
			handleInitDistantTerrainShared(event.data);
			self.postMessage({ type: WorkerTaskType.InitDistantTerrainShared }); // ← ack
			return;
		}

		case WorkerTaskType.GenerateDistantTerrain: {
			try {
				const { payload, transferables } = handleGenerateDistantTerrain(
					event.data,
				);
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
			const req = event.data as LightRegisterChunkRequest;
			// If blockSAB is provided (fresh generation / worker restart), register directly.
			if (req.blockSAB !== null) {
				LightTaskHandlers.handleRegisterChunk(req);
				return;
			}
			// Null SABs → main thread uses worker-to-worker channel for SABs.
			// Merge with pending voxel data from OPFS worker.
			const key = _packCoordKey(req.chunkX, req.chunkY, req.chunkZ);
			const voxel = _pendingVoxelData.get(key);
			if (voxel) {
				_pendingVoxelData.delete(key);
				_registerFromBoth(
					{
						seq: req.seq,
						chunkId: req.chunkId,
						chunkX: req.chunkX,
						chunkY: req.chunkY,
						chunkZ: req.chunkZ,
						headerSlot: req.headerSlot,
					},
					voxel,
				);
			} else {
				_pendingRegistrations.set(key, {
					seq: req.seq,
					chunkId: req.chunkId,
					headerSlot: req.headerSlot,
				});
			}
			return;
		}

		case WorkerTaskType.InitWorkerChannel: {
			const port = (event.data as { port: MessagePort }).port;
			port.onmessage = _handleChannelMessage;
			port.start();
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
