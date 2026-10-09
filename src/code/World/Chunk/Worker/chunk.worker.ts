/// <reference lib="webworker" />

import { resetCacheAndTracking as resetDistantTerrainCache } from "@/code/Generation/DistantTerrain/DistantTerrainGenerator";
import type { GenerationParamsType } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { setTerrainSeed } from "@/code/Generation/TerrainHeightMap";
import { WorldGenerator } from "@/code/Generation/WorldGenerator";
import { enableWasmNoise } from "@/code/Lib/WasmNoise";
import { packCoords } from "../DataStructures/ChunkCoords";
import {
	type LightRegisterChunkBatchRequest,
	type LightRegisterChunkRequest,
	WorkerTaskType,
} from "../DataStructures/WorkerMessageType";
import { WATER_BLOCK_ID } from "./ChunkMesherConstants";
import { LightTaskHandlers } from "./LightTaskHandlers";
import {
	handleGenerateDistantTerrain,
	handleGenerateFarTile,
	handleGenerateTerrain,
	handleInitDistantTerrainShared,
} from "./WorkerTaskHandlers";

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
const _pendingVoxelData = new Map<bigint, PendingVoxelData>();
// Coord → registration metadata from main thread (arrives before channel)
const _pendingRegistrations = new Map<
	bigint,
	{ seq: number; chunkId: bigint; headerSlot: number }
>();

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
	const key = packCoords(data.chunkX | 0, data.chunkY | 0, data.chunkZ | 0);
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
// The default generator uses the baked-in constant seed; a SetWorldSeed
// message (sent by the pool right after worker creation, before any
// generation task) swaps it for the world-name-derived seed. Assigned in the
// boot gate below once the wasm noise backend has settled — never undefined
// by the time any message is handled.
let generator: WorldGenerator;

// ---------------------------------------------------------------------------
// Block compression
// ---------------------------------------------------------------------------

const MAX_PALETTE_SIZE = 16;
const BYTE_VALUE_COUNT = 256;

/*
 * Generation-stamped lookup tables remove the 65,536-byte membership clear
 * that used to run on every call.
 *
 * compressBlocks takes a Uint8Array, so only 256 block IDs are reachable and
 * a value belongs to the current call when its stamp equals _compressStamp.
 */
const _compressSeenStamp = new Uint32Array(BYTE_VALUE_COUNT);
const _compressPaletteIndex = new Uint8Array(BYTE_VALUE_COUNT);
const _compressUniqueIds = new Uint8Array(MAX_PALETTE_SIZE + 1);

let _compressStamp = 0;

// PERF: Allocate compressed-block outputs in SharedArrayBuffers so they are
// *shared* (not transferred) to the main thread and can be handed directly to
// the mesh worker without the main-thread SAB copy in Chunk.ensureSharedBacking.
// Falls back to a plain ArrayBuffer where SharedArrayBuffer is unavailable.
const _HAS_SAB = typeof SharedArrayBuffer !== "undefined";
function sharedU8(length: number): Uint8Array {
	return new Uint8Array(
		_HAS_SAB ? new SharedArrayBuffer(length) : new ArrayBuffer(length),
	);
}
function sharedU16(length: number): Uint16Array {
	const byteLength = length * Uint16Array.BYTES_PER_ELEMENT;
	return new Uint16Array(
		_HAS_SAB ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength),
	);
}

/*
 * Advance the compression generation stamp. Uint32 wraparound is ~4 billion
 * calls away, but stamp 0 is also the initial value of every entry, so the
 * reset has to be handled rather than assumed unreachable.
 */
function nextCompressStamp(): number {
	let stamp = (_compressStamp + 1) >>> 0;

	if (stamp === 0) {
		_compressSeenStamp.fill(0);
		stamp = 1;
	}

	_compressStamp = stamp;
	return stamp;
}

function compressBlocks(blocks: Uint8Array): {
	isUniform: boolean;
	uniformBlockId: number;
	palette: Uint16Array | null;
	packedBlocks: Uint8Array | Uint16Array | null;
} {
	const length = blocks.length;

	/*
	 * Guard the empty input. Production chunks are 32³ entries, so blocks[0]
	 * would read back undefined and the loops below would produce garbage.
	 */
	if (length === 0) {
		return {
			isUniform: false,
			uniformBlockId: 0,
			palette: sharedU16(0),
			packedBlocks: sharedU8(0),
		};
	}

	const stamp = nextCompressStamp();
	const seenStamp = _compressSeenStamp;
	const uniqueIds = _compressUniqueIds;

	let uniqueCount = 0;

	/*
	 * Bail out on the seventeenth distinct ID: the chunk cannot use a
	 * four-bit palette, so scanning the remaining voxels cannot change the
	 * compression decision.
	 */
	for (let i = 0; i < length; i++) {
		const id = blocks[i];

		if (seenStamp[id] === stamp) continue;

		seenStamp[id] = stamp;
		uniqueIds[uniqueCount++] = id;

		if (uniqueCount > MAX_PALETTE_SIZE) {
			/*
			 * Dense Uint8 chunks already hold the complete packed values —
			 * packBlockValue puts state above bit 10, so water's level-zero
			 * source state is the bare ID. Returning the input preserves the
			 * existing zero-copy path.
			 */
			return {
				isUniform: false,
				uniformBlockId: 0,
				palette: null,
				packedBlocks: blocks,
			};
		}
	}

	if (uniqueCount === 1) {
		const id = uniqueIds[0];

		return {
			isUniform: true,
			uniformBlockId: id === WATER_BLOCK_ID ? WATER_BLOCK_ID : id,
			palette: null,
			packedBlocks: null,
		};
	}

	const palette = sharedU16(uniqueCount);
	const paletteIndex = _compressPaletteIndex;

	/*
	 * Build the palette and the reverse lookup from the compact unique-ID
	 * list — only 2 to 16 entries are touched. The lookup is keyed by raw
	 * block ID so water maps to its palette index rather than the scan
	 * sentinel.
	 */
	for (let i = 0; i < uniqueCount; i++) {
		const rawId = uniqueIds[i];

		palette[i] = rawId === WATER_BLOCK_ID ? WATER_BLOCK_ID : rawId;
		paletteIndex[rawId] = i;
	}

	const packedBlocks = sharedU8((length + 1) >>> 1);

	/*
	 * PERF: four voxels per iteration halves the loop-control and index
	 * arithmetic versus a two-voxel loop. For 32³ = 32768 voxels this is
	 * 8192 iterations, and length & ~3 keeps the main loop branch-free
	 * apart from the loop-back edge itself.
	 */
	let inputIndex = 0;
	let outputIndex = 0;

	const unrolledEnd = length & ~3;

	for (; inputIndex < unrolledEnd; inputIndex += 4, outputIndex += 2) {
		packedBlocks[outputIndex] =
			paletteIndex[blocks[inputIndex]] |
			(paletteIndex[blocks[inputIndex + 1]] << 4);

		packedBlocks[outputIndex + 1] =
			paletteIndex[blocks[inputIndex + 2]] |
			(paletteIndex[blocks[inputIndex + 3]] << 4);
	}

	// Trailing complete pair. Skipped for 32³ chunks (length % 4 === 0).
	if (inputIndex + 1 < length) {
		packedBlocks[outputIndex++] =
			paletteIndex[blocks[inputIndex]] |
			(paletteIndex[blocks[inputIndex + 1]] << 4);

		inputIndex += 2;
	}

	// Preserve support for odd-length inputs, which only tests produce.
	if (inputIndex < length) {
		packedBlocks[outputIndex] = paletteIndex[blocks[inputIndex]];
	}

	return {
		isUniform: false,
		uniformBlockId: 0,
		palette,
		packedBlocks,
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
				self.postMessage(payload, transferables);
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

		case WorkerTaskType.GenerateFarTile: {
			try {
				const { payload, transferables } = handleGenerateFarTile(event.data);
				self.postMessage(payload, transferables);
			} catch (err) {
				console.error("GenerateFarTile failed:", err);
				self.postMessage({
					type: WorkerTaskType.GenerateFarTile,
					requestId: event.data.requestId,
					levelIndex: event.data.levelIndex,
					tileX: event.data.tileX,
					tileZ: event.data.tileZ,
					opaqueFaces: new Uint32Array(0),
					waterFaces: new Uint32Array(0),
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
			const key = packCoords(req.chunkX, req.chunkY, req.chunkZ);
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
		case WorkerTaskType.LightRegisterChunkBatch: {
			const chunks = (event.data as LightRegisterChunkBatchRequest).chunks;
			for (let i = 0; i < chunks.length; i++) {
				const item = chunks[i];

				if (item.blockSAB !== null) {
					LightTaskHandlers.handleRegisterChunkFields(item);
					continue;
				}

				const key = packCoords(item.chunkX, item.chunkY, item.chunkZ);
				const voxel = _pendingVoxelData.get(key);
				if (voxel) {
					_pendingVoxelData.delete(key);
					_registerFromBoth(
						{
							seq: item.seq,
							chunkId: item.chunkId,
							chunkX: item.chunkX,
							chunkY: item.chunkY,
							chunkZ: item.chunkZ,
							headerSlot: item.headerSlot,
						},
						voxel,
					);
				} else {
					_pendingRegistrations.set(key, {
						seq: item.seq,
						chunkId: item.chunkId,
						headerSlot: item.headerSlot,
					});
				}
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
		case WorkerTaskType.LightUnregisterChunkBatch: {
			LightTaskHandlers.handleUnregisterChunkBatch(event.data);
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
		case WorkerTaskType.LightMutateBatch: {
			LightTaskHandlers.handleMutateBatch(event.data);
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

		case WorkerTaskType.SetWorldSeed: {
			// Re-seed the shared terrain module (height map, biomes, rivers)
			// and rebuild the generator with the world seed. Sent before any
			// generation task, so no chunk can be generated with a stale seed.
			const { seed } = event.data as { seed: string };
			setTerrainSeed(seed);
			resetDistantTerrainCache();
			generator = new WorldGenerator({
				...GenerationParams,
				SEED: seed,
			} as GenerationParamsType);
			self.postMessage({ type: WorkerTaskType.SetWorldSeed }); // ← ack
			return;
		}

		default:
			return;
	}
};

// ---------------------------------------------------------------------------
// Worker boot
//
// The SIMD wasm noise backend must be active before the generator is built
// (SetWorldSeed), or generator instances would be bound to the JS backend.
//
// self.onmessage is attached synchronously (module top level) so no message
// can be silently dropped: browsers dispatch a queued message to the CURRENT
// value of self.onmessage, and a message that arrives while onmessage is
// null is discarded, not queued for later. Instead, messages posted during
// the wasm load window are buffered and replayed in arrival order once the
// load settles — SetWorldSeed arrives first, so the generator is still
// built on the SIMD backend. On failure the JS backend stays active and the
// worker boots normally.
// ---------------------------------------------------------------------------
const _pendingMessages: MessageEvent[] = [];
let _wasmReady = false;

self.onmessage = (event: MessageEvent) => {
	if (_wasmReady) {
		onMessageHandler(event);
		return;
	}
	_pendingMessages.push(event);
};

void enableWasmNoise().finally(() => {
	// Default generator (baked-in constant seed) so generation can never
	// dereference an undefined generator; SetWorldSeed replaces it as the
	// buffered message is replayed below.
	generator = new WorldGenerator({
		...GenerationParams,
	} as GenerationParamsType);
	_wasmReady = true;
	for (const ev of _pendingMessages) {
		onMessageHandler(ev);
	}
	_pendingMessages.length = 0;
	self.postMessage({ type: WorkerTaskType.WorkerReady });
});
