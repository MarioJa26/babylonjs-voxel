// src/code/World/Chunk/voxel.worker.ts

import { MeshEmitters } from "../MeshPipeline/core/MeshEmitters";
import {
	createEmptyWorkerInternalMeshData,
	MeshBuildSession,
	type PaddedGrids,
	type WorkerMeshInput,
} from "../MeshPipeline/core/WorkerMeshHelpers";
import { packCoords } from "./DataStructures/ChunkCoords";
import { MeshData } from "./DataStructures/MeshData";
import { expandPalette } from "./DataStructures/PaletteExpander";
import type { ResizableTypedArray } from "./DataStructures/ResizableTypedArray";
import type { WorkerInternalMeshData } from "./DataStructures/WorkerInternalMeshData";
import {
	type FullMeshMessage,
	type GenerateFullMeshRequest,
	type RelightMeshMissMessage,
	type RelightMeshRequest,
	type VoxelRecycleBuffersRequest,
	type VoxelRegisterChunkBatchRequest,
	type VoxelRegisterChunkRequest,
	type VoxelUnregisterChunkBatchRequest,
	type VoxelUnregisterChunkRequest,
	type VoxelUpdateChunkBuffersRequest,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";

export type VoxelWorkerRequest =
	| GenerateFullMeshRequest
	| RelightMeshRequest
	| VoxelRegisterChunkRequest
	| VoxelRegisterChunkBatchRequest
	| VoxelUnregisterChunkRequest
	| VoxelUnregisterChunkBatchRequest
	| VoxelUpdateChunkBuffersRequest
	| VoxelRecycleBuffersRequest
	| { type: WorkerTaskType.InitWorkerChannel; port: MessagePort };

// ---------------------------------------------------------------------------
// Voxel registration — SAB-direct mesh data
//
// Every chunk's block/palette/light storage is a SharedArrayBuffer. The mesh
// worker registers the handles once (VoxelRegisterChunk) and then reads the
// center grid and the 26 neighbor border slabs directly from shared memory on
// every mesh task, instead of the main thread extracting and transferring up
// to 55 copies per remesh.
//
// Handle delivery mirrors the light-worker pattern: the OPFS worker forwards
// the SAB references through a worker-to-worker MessageChannel (direct=true
// registration carries them inline instead — fresh generation, storage layout
// change, worker restart), and the main thread sends only metadata
// (coords + uniform state). The two halves are merged when both arrive; a mesh
// task racing ahead of the channel data falls back to air borders and is
// healed by the next remesh (the revision-validated relight cache guarantees
// a subsequent full rebuild).
// ---------------------------------------------------------------------------
type VoxelRegistration = {
	blockSAB: SharedArrayBuffer | null;
	paletteSAB: SharedArrayBuffer | null;
	lightSAB: SharedArrayBuffer | null;
	// Cached views. Creating typed-array views is cheap, but doing it for
	// center + 26 borders on every mesh task adds avoidable GC pressure.
	blockU8: Uint8Array | null;
	blockU16: Uint16Array | null;
	palette: Uint16Array | null;
	light: Uint8Array | null;
	blockBytesPerElement: 1 | 2;
	isUniform: boolean;
	uniformBlockId: number;
};

// SAB handles from the OPFS worker (via the worker-to-worker channel).
const _pendingChannelData = new Map<bigint, VoxelRegistration>();
// Metadata from the main thread (usually arrives after the channel data).
const _pendingMetadata = new Map<
	bigint,
	{ isUniform: boolean; uniformBlockId: number }
>();

const _voxelRegistrations = new Map<bigint, VoxelRegistration>();

// ---------------------------------------------------------------------------
// Allocation-free neighbor offsets
// ---------------------------------------------------------------------------

// Offset order remains:
// dz outer -> dy middle -> dx inner, with center omitted.
const NEIGHBOR_DX = new Int8Array(26);
const NEIGHBOR_DY = new Int8Array(26);
const NEIGHBOR_DZ = new Int8Array(26);

{
	let slot = 0;

	for (let dz = -1; dz <= 1; dz++) {
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0 && dz === 0) continue;

				NEIGHBOR_DX[slot] = dx;
				NEIGHBOR_DY[slot] = dy;
				NEIGHBOR_DZ[slot] = dz;
				slot++;
			}
		}
	}
}

// chunk_size is always Chunk.SIZE (32); 32^2 covers the largest face slab.
const _MAX_BORDER = 32 * 32;

const _blockBorderScratch: Uint16Array[] = new Array(26);
const _lightBorderScratch: Uint8Array[] = new Array(26);

for (let i = 0; i < 26; i++) {
	_blockBorderScratch[i] = new Uint16Array(_MAX_BORDER);
	_lightBorderScratch[i] = new Uint8Array(_MAX_BORDER);
}

const _neighborBlocks: (Uint16Array | undefined)[] = new Array(26);
const _neighborLights: (Uint8Array | undefined)[] = new Array(26);

// Truthy presence marker. It is never dereferenced.
const _PRESENT = new Uint16Array(0);

const _presenceMaskCache = new Map<number, (Uint16Array | undefined)[]>();
const _PRESENCE_MASK_CACHE_MAX = 64;

function presenceFromMask(mask: number): (Uint16Array | undefined)[] {
	const normalizedMask = mask >>> 0;
	const cached = _presenceMaskCache.get(normalizedMask);

	if (cached !== undefined) {
		// Maintain true LRU order. This does not allocate a replacement array.
		_presenceMaskCache.delete(normalizedMask);
		_presenceMaskCache.set(normalizedMask, cached);
		return cached;
	}

	const presence = new Array<Uint16Array | undefined>(26);
	let bits = normalizedMask;

	for (let i = 0; i < 26; i++) {
		presence[i] = (bits & 1) !== 0 ? _PRESENT : undefined;
		bits >>>= 1;
	}

	if (_presenceMaskCache.size >= _PRESENCE_MASK_CACHE_MAX) {
		const oldest = _presenceMaskCache.keys().next();

		if (!oldest.done) {
			_presenceMaskCache.delete(oldest.value);
		}
	}

	_presenceMaskCache.set(normalizedMask, presence);
	return presence;
}

// ---------------------------------------------------------------------------
// Voxel registration
// ---------------------------------------------------------------------------

function createVoxelRegistration(args: {
	blockSAB?: SharedArrayBuffer | null;
	paletteSAB?: SharedArrayBuffer | null;
	lightSAB?: SharedArrayBuffer | null;
	blockBytesPerElement: 1 | 2;
	isUniform: boolean;
	uniformBlockId: number;
}): VoxelRegistration {
	const blockSAB = args.blockSAB ?? null;
	const paletteSAB = args.paletteSAB ?? null;
	const lightSAB = args.lightSAB ?? null;

	let blockU8: Uint8Array | null = null;
	let blockU16: Uint16Array | null = null;

	if (blockSAB !== null) {
		if (args.blockBytesPerElement === 1) {
			blockU8 = new Uint8Array(blockSAB);
		} else {
			blockU16 = new Uint16Array(blockSAB);
		}
	}

	return {
		blockSAB,
		paletteSAB,
		lightSAB,
		blockU8,
		blockU16,
		palette: paletteSAB === null ? null : new Uint16Array(paletteSAB),
		light: lightSAB === null ? null : new Uint8Array(lightSAB),
		blockBytesPerElement: args.blockBytesPerElement,
		isUniform: args.isUniform,
		uniformBlockId: args.uniformBlockId,
	};
}

/**
 * Primitive-argument implementation used by both single and batch messages.
 * This avoids constructing one temporary request object per batch item.
 */
function registerVoxel(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	blockSAB: SharedArrayBuffer | null,
	paletteSAB: SharedArrayBuffer | null,
	lightSAB: SharedArrayBuffer | null,
	blockBytesPerElement: 1 | 2,
	isUniform: boolean,
	uniformBlockId: number,
	direct: boolean,
): void {
	const key = packCoords(chunkX, chunkY, chunkZ);

	if (direct) {
		_pendingMetadata.delete(key);
		_pendingChannelData.delete(key);

		_voxelRegistrations.set(
			key,
			createVoxelRegistration({
				blockSAB,
				paletteSAB,
				lightSAB,
				blockBytesPerElement,
				isUniform,
				uniformBlockId,
			}),
		);
		return;
	}

	const pending = _pendingChannelData.get(key);

	if (pending !== undefined) {
		_pendingChannelData.delete(key);

		pending.isUniform = isUniform;
		pending.uniformBlockId = uniformBlockId;

		_voxelRegistrations.set(key, pending);
		return;
	}

	const metadata = _pendingMetadata.get(key);

	if (metadata !== undefined) {
		// Reuse the existing metadata object if duplicate metadata arrives
		// before the worker-to-worker SAB message.
		metadata.isUniform = isUniform;
		metadata.uniformBlockId = uniformBlockId;
	} else {
		_pendingMetadata.set(key, {
			isUniform,
			uniformBlockId,
		});
	}
}

function _handleVoxelRegister(req: {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	blockSAB: SharedArrayBuffer | null;
	paletteSAB: SharedArrayBuffer | null;
	lightSAB: SharedArrayBuffer | null;
	blockStorageBytesPerElement: 1 | 2;
	isUniform: boolean;
	uniformBlockId: number;
	direct?: boolean;
}): void {
	registerVoxel(
		req.chunkX,
		req.chunkY,
		req.chunkZ,
		req.blockSAB,
		req.paletteSAB,
		req.lightSAB,
		req.blockStorageBytesPerElement,
		req.isUniform,
		req.uniformBlockId,
		req.direct === true,
	);
}

function unregisterVoxel(chunkX: number, chunkY: number, chunkZ: number): void {
	const key = packCoords(chunkX, chunkY, chunkZ);

	_voxelRegistrations.delete(key);
	_pendingChannelData.delete(key);
	_pendingMetadata.delete(key);

	// These caches are keyed by chunkId rather than coordinates, so they
	// cannot safely be cleared here without the chunkId.
}

function _handleVoxelUnregister(req: VoxelUnregisterChunkRequest): void {
	unregisterVoxel(req.chunkX, req.chunkY, req.chunkZ);
}

function _handleChannelMessage(event: MessageEvent): void {
	const data = event.data;
	if (!data || (data as { _type?: string })._type !== "voxelData") return;

	const key = packCoords(data.chunkX | 0, data.chunkY | 0, data.chunkZ | 0);
	const meta = _pendingMetadata.get(key);

	const voxel = createVoxelRegistration({
		blockSAB: data.blocksSAB ?? null,
		paletteSAB: data.paletteSAB ?? null,
		lightSAB: data.lightSAB ?? null,
		blockBytesPerElement: data.blockBytesPerElement,
		isUniform: meta ? meta.isUniform : false,
		uniformBlockId: meta ? meta.uniformBlockId : 0,
	});

	if (meta) {
		_pendingMetadata.delete(key);
		_voxelRegistrations.set(key, voxel);
	} else {
		_pendingChannelData.set(key, voxel);
	}
}

function _handleVoxelUpdateBuffers(req: VoxelUpdateChunkBuffersRequest): void {
	const key = packCoords(req.chunkX, req.chunkY, req.chunkZ);

	_pendingMetadata.delete(key);
	_pendingChannelData.delete(key);

	_voxelRegistrations.set(
		key,
		createVoxelRegistration({
			blockSAB: req.blockSAB,
			paletteSAB: req.paletteSAB,
			lightSAB: req.lightSAB,
			blockBytesPerElement: req.blockStorageBytesPerElement,
			isUniform: req.isUniform,
			uniformBlockId: req.uniformBlockId,
		}),
	);
}

// ---------------------------------------------------------------------------
// Allocation-free border copying
// ---------------------------------------------------------------------------

function extractBlockBorder(
	reg: VoxelRegistration,
	slot: number,
	size: number,
	dx: number,
	dy: number,
	dz: number,
): Uint16Array {
	const xCount = dx === 0 ? size : 1;
	const yCount = dy === 0 ? size : 1;
	const zCount = dz === 0 ? size : 1;
	const total = xCount * yCount * zCount;
	const out = _blockBorderScratch[slot];

	if (reg.isUniform) {
		out.fill(reg.uniformBlockId, 0, total);
		return out;
	}

	const lxStart = dx < 0 ? size - 1 : 0;
	const lyStart = dy < 0 ? size - 1 : 0;
	const lzStart = dz < 0 ? size - 1 : 0;
	const size2 = size * size;

	const dense16 = reg.blockU16;

	if (dense16 !== null) {
		let write = 0;

		for (let bz = 0; bz < zCount; bz++) {
			const zBase = (lzStart + bz) * size2;

			for (let by = 0; by < yCount; by++) {
				const rowBase = zBase + (lyStart + by) * size;

				if (dx === 0) {
					// Avoid dense16.subarray(...), which creates a new view.
					const rowEnd = rowBase + xCount;

					for (let read = rowBase; read < rowEnd; read++) {
						out[write++] = dense16[read];
					}
				} else {
					out[write++] = dense16[rowBase + lxStart];
				}
			}
		}

		return out;
	}

	const packed = reg.blockU8;

	if (packed === null) {
		out.fill(0, 0, total);
		return out;
	}

	const palette = reg.palette;
	const paletteLength = palette?.length ?? 0;

	if (palette !== null && paletteLength > 1) {
		let write = 0;

		for (let bz = 0; bz < zCount; bz++) {
			const zBase = (lzStart + bz) * size2;

			for (let by = 0; by < yCount; by++) {
				const rowBase = zBase + (lyStart + by) * size;

				if (dx === 0) {
					let blockIndex = rowBase;
					const rowEnd = rowBase + xCount;

					while (blockIndex + 1 < rowEnd) {
						const byte = packed[blockIndex >>> 1];
						const low = byte & 0x0f;
						const high = byte >>> 4;

						out[write++] = low < paletteLength ? palette[low] : 0;
						out[write++] = high < paletteLength ? palette[high] : 0;

						blockIndex += 2;
					}

					// Retains correct behavior if a non-standard odd chunk
					// size is ever passed.
					if (blockIndex < rowEnd) {
						const byte = packed[blockIndex >>> 1];
						const paletteIndex =
							(blockIndex & 1) === 0 ? byte & 0x0f : byte >>> 4;

						out[write++] =
							paletteIndex < paletteLength ? palette[paletteIndex] : 0;
					}
				} else {
					const blockIndex = rowBase + lxStart;
					const byte = packed[blockIndex >>> 1];
					const paletteIndex =
						(blockIndex & 1) === 0 ? byte & 0x0f : byte >>> 4;

					out[write++] =
						paletteIndex < paletteLength ? palette[paletteIndex] : 0;
				}
			}
		}

		return out;
	}

	let write = 0;

	for (let bz = 0; bz < zCount; bz++) {
		const zBase = (lzStart + bz) * size2;

		for (let by = 0; by < yCount; by++) {
			const rowBase = zBase + (lyStart + by) * size;

			if (dx === 0) {
				// Preserve the original no-palette byte interpretation while
				// avoiding packed.subarray(...).
				const rowEnd = rowBase + xCount;

				for (let read = rowBase; read < rowEnd; read++) {
					out[write++] = packed[read];
				}
			} else {
				out[write++] = packed[rowBase + lxStart];
			}
		}
	}

	return out;
}

function extractLightBorder(
	reg: VoxelRegistration,
	slot: number,
	size: number,
	dx: number,
	dy: number,
	dz: number,
): Uint8Array | undefined {
	const light = reg.light;

	if (light === null) return undefined;

	const xCount = dx === 0 ? size : 1;
	const yCount = dy === 0 ? size : 1;
	const zCount = dz === 0 ? size : 1;
	const lxStart = dx < 0 ? size - 1 : 0;
	const lyStart = dy < 0 ? size - 1 : 0;
	const lzStart = dz < 0 ? size - 1 : 0;
	const size2 = size * size;

	const out = _lightBorderScratch[slot];
	let write = 0;

	for (let bz = 0; bz < zCount; bz++) {
		const zBase = (lzStart + bz) * size2;

		for (let by = 0; by < yCount; by++) {
			const rowBase = zBase + (lyStart + by) * size;

			if (dx === 0) {
				// Avoid light.subarray(...), which creates one typed-array
				// view for every copied face row.
				const rowEnd = rowBase + xCount;

				for (let read = rowBase; read < rowEnd; read++) {
					out[write++] = light[read];
				}
			} else {
				out[write++] = light[rowBase + lxStart];
			}
		}
	}

	return out;
}

function buildNeighborArrays(
	cx: number,
	cy: number,
	cz: number,
	size: number,
	mask: number,
	includeBlocks = true,
): void {
	let bits = mask >>> 0;

	for (let i = 0; i < 26; i++) {
		if ((bits & 1) === 0) {
			_neighborBlocks[i] = undefined;
			_neighborLights[i] = undefined;
			bits >>>= 1;
			continue;
		}

		const dx = NEIGHBOR_DX[i];
		const dy = NEIGHBOR_DY[i];
		const dz = NEIGHBOR_DZ[i];
		const key = packCoords(cx + dx, cy + dy, cz + dz);
		const reg = _voxelRegistrations.get(key);

		if (reg === undefined) {
			_neighborBlocks[i] = undefined;
			_neighborLights[i] = undefined;
			bits >>>= 1;
			continue;
		}

		_neighborBlocks[i] = includeBlocks
			? extractBlockBorder(reg, i, size, dx, dy, dz)
			: undefined;

		_neighborLights[i] = extractLightBorder(reg, i, size, dx, dy, dz);

		bits >>>= 1;
	}
}

// ---------------------------------------------------------------------------
// Decoded center cache
// ---------------------------------------------------------------------------

type DecodedBlocksEntry = {
	generation: number;
	blockRevision: number;
	blocks: Uint8Array | Uint16Array;
};

// PERF: sized for streaming bursts — a worker can touch dozens of distinct
// chunks between two touches of the same one, and every miss here means a
// fresh 64 KiB expandPalette allocation. 32 entries ≈ 2 MiB per worker.
const DECODED_BLOCKS_CACHE_MAX = 32;
const decodedBlocksCache = new Map<bigint, DecodedBlocksEntry>();

function getDecodedCenterBlocks(
	reg: VoxelRegistration | undefined,
	chunkId: bigint,
	generation: number,
	blockRevision: number,
	size: number,
): Uint8Array | Uint16Array | null {
	if (reg === undefined || reg.blockSAB === null) return null;

	if (reg.blockU16 !== null) {
		return reg.blockU16;
	}

	const packed = reg.blockU8;

	if (packed === null) return null;

	const palette = reg.palette;

	if (palette === null || palette.length === 0) {
		return packed;
	}

	const totalBlocks = size * size * size;
	const cached = decodedBlocksCache.get(chunkId);

	if (
		cached !== undefined &&
		cached.generation === generation &&
		cached.blockRevision === blockRevision &&
		cached.blocks.length === totalBlocks
	) {
		decodedBlocksCache.delete(chunkId);
		decodedBlocksCache.set(chunkId, cached);
		return cached.blocks;
	}

	let blocks: Uint8Array | Uint16Array;

	if (palette.length === 1) {
		const blockId = palette[0];

		if (blockId === 0) return null;

		blocks = new Uint16Array(totalBlocks);
		blocks.fill(blockId);
	} else {
		blocks = expandPalette(packed, palette, totalBlocks);
	}

	if (decodedBlocksCache.size >= DECODED_BLOCKS_CACHE_MAX) {
		const oldest = decodedBlocksCache.keys().next();

		if (!oldest.done) {
			decodedBlocksCache.delete(oldest.value);
		}
	}

	const existing = cached;

	if (existing !== undefined) {
		// Reuse the cache-entry shell even when its decoded storage became
		// stale. The decoded array itself must still be replaced.
		existing.generation = generation;
		existing.blockRevision = blockRevision;
		existing.blocks = blocks;
		decodedBlocksCache.set(chunkId, existing);
	} else {
		decodedBlocksCache.set(chunkId, {
			generation,
			blockRevision,
			blocks,
		});
	}

	return blocks;
}

function centerLightArray(
	reg: VoxelRegistration | undefined,
): Uint8Array | undefined {
	return reg?.light ?? undefined;
}

// ---------------------------------------------------------------------------
// T2-8 + micro: relight block-grid cache.
//
// A light-only remesh re-runs the identical greedy pipeline with a fresh
// light grid, so the worker can reuse the block grid (center + neighbor
// borders) it received for the chunk's last full mesh — the main thread then
// skips the block-border extraction and block/palette transfers entirely.
// Entries are validated against (generation, blockRevision) so disposed-and-
// recreated chunks (reused chunk ids) and block mutations can never serve
// stale borders. Uniform chunks fill the padded grid directly from the fill
// id instead of a dense grid.
//
// Each entry OWNS its (size+2)^3 padded grids (block/light/opaque/needsCustom).
// The full build fills them; a light-only rebuild binds the session to them
// and refills only the light grid — skipping the ~33k center stores, the 26
// border copies and the full-grid opacity classification.
// ---------------------------------------------------------------------------
type RelightCacheEntry = {
	generation: number;
	blockRevision: number;
	grids: PaddedGrids;
	// 26-slot presence array — kept only as the hasNeighborChunk gate for the
	// light-border copy on light-only rebuilds (the border content is already
	// baked into grids.block). Built from the full mesh's neighborMask, so
	// scratch reuse across tasks can never change a chunk's presence.
	neighbors: (Uint16Array | undefined)[];
};

// PERF: each entry owns ~190 KiB of padded grids; 16 entries ≈ 3 MiB per
// worker. The old cap of 6 fell over during streaming bursts (each worker sees
// far more than 6 distinct chunks between repeats), forcing light-only remeshes
// down the full-rebuild fallback path.
const RELIGHT_CACHE_MAX = 16;
const relightCache = new Map<bigint, RelightCacheEntry>();

/** Refresh insertion order so Map-order eviction stays true LRU. */
function touchRelightEntry(chunkId: bigint, entry: RelightCacheEntry): void {
	relightCache.delete(chunkId);
	relightCache.set(chunkId, entry);
}

function getOrCreateRelightEntry(
	chunkId: bigint,
	generation: number,
	blockRevision: number,
	neighbors: (Uint16Array | undefined)[],
): RelightCacheEntry {
	const existing = relightCache.get(chunkId);
	if (existing) {
		// Same chunk re-meshed: refresh versions + presence mask. The grids
		// are refilled in full by the build itself (skipBlockFill=false).
		existing.generation = generation;
		existing.blockRevision = blockRevision;
		existing.neighbors = neighbors;
		touchRelightEntry(chunkId, existing);
		return existing;
	}
	if (relightCache.size >= RELIGHT_CACHE_MAX) {
		// Map iteration order = insertion order, so the first key is the
		// oldest entry.
		const oldest = relightCache.keys().next();
		if (!oldest.done) relightCache.delete(oldest.value);
	}
	const entry: RelightCacheEntry = {
		generation,
		blockRevision,
		grids: {
			block: new Uint16Array(0),
			light: new Uint8Array(0),
			opaque: new Uint8Array(0),
			needsCustom: new Uint8Array(0),
		},
		neighbors,
	};
	relightCache.set(chunkId, entry);
	return entry;
}

// PERF: Reuse the session (padded grids, greedy scratch, cached pipeline) and
// the output buffers across every mesh task in this worker.
// buildVoxelMesh reserves a worst-case (size^3 * 16) capacity up front so the
// hot-path emitters can write branchlessly; allocating fresh WorkerInternalMeshData
// per task threw away ~12 MB of backing storage on every chunk. The
// ResizableTypedArray keeps its capacity across builds — reset() only zeroes
// length — so we allocate once and clear between tasks. toTransferableMeshData
// slices to a right-sized copy for transfer, so these reused buffers are never
// detached.
const _session = new MeshBuildSession();
const _opaqueOut = createEmptyWorkerInternalMeshData();
const _waterOut = createEmptyWorkerInternalMeshData();
const _cutoutOut = createEmptyWorkerInternalMeshData();

function resetMeshOut(): void {
	_opaqueOut.faceData.reset();
	_opaqueOut.faceCount = 0;
	_waterOut.faceData.reset();
	_waterOut.faceCount = 0;
	_cutoutOut.faceData.reset();
	_cutoutOut.faceCount = 0;
}

function buildVoxelMeshFromInput(
	input: WorkerMeshInput,
	size: number,
	lod: number,
	grids?: PaddedGrids,
	skipBlockFill = false,
): void {
	_session.begin(size, lod, input, grids, skipBlockFill);
	_session.borderSkirtSides = input.borderSkirtSides ?? 0xf;
	_session.borderSkirtNearInset = input.borderSkirtNearInset ?? 0;
	resetMeshOut();
	MeshEmitters.buildVoxelMesh(_session, _opaqueOut, _waterOut, _cutoutOut);
}

// ---------------------------------------------------------------------------
// Mesh output buffer pool (T3-2).
//
// toTransferableMeshData slices a fresh exact-size copy per response buffer
// (up to 9 per mesh). The main thread copies those bytes into merged group
// buffers, so every dropped result generation became garbage on BOTH sides.
// Dropped results (stale revision / unknown chunk / LOD skip) are now
// transferred back here and reused: takeTransferableOutput copies into a
// pooled exact-size buffer when one is available, else falls back to the
// plain slice. Exact-size invariant is preserved — downstream consumers
// derive face counts from array lengths, so pooled buffers must match
// byteLength exactly (no slack).
//
// Only dropped results are ever recycled. Applied results stay alive in the
// main thread's LOD caches and member lastBuilt* references; recycling those
// would be use-after-free.
// ---------------------------------------------------------------------------
// PERF: size-keyed pool (Map<byteLength, stack>) gives O(1) lookup instead of
// the previous O(n) linear scan over up to 96 buffers (9 lookups per mesh).
const _recyclePool = new Map<number, Uint8Array[]>();
let _recyclePoolBytes = 0;
let _recyclePoolCount = 0;
const RECYCLE_POOL_MAX_BUFFERS = 96;
const RECYCLE_POOL_MAX_BYTES = 12 * 1024 * 1024;

function takePooledMeshBuffer(byteLength: number): Uint8Array | null {
	const stack = _recyclePool.get(byteLength);
	if (stack === undefined || stack.length === 0) return null;
	const buf = stack.pop()!;
	_recyclePoolBytes -= byteLength;
	_recyclePoolCount--;
	return buf;
}

function givePooledMeshBuffer(buf: Uint8Array): void {
	if (_recyclePoolCount >= RECYCLE_POOL_MAX_BUFFERS) return;
	if (_recyclePoolBytes + buf.length > RECYCLE_POOL_MAX_BYTES) return;
	let stack = _recyclePool.get(buf.length);
	if (stack === undefined) {
		stack = [];
		_recyclePool.set(buf.length, stack);
	}
	stack.push(buf);
	_recyclePoolBytes += buf.length;
	_recyclePoolCount++;
}

// ---------------------------------------------------------------------------
// Transfer buffer handling
// ---------------------------------------------------------------------------

function copyMeshBytes(
	source: Uint8Array,
	target: Uint8Array,
	byteLength: number,
): void {
	// A manual copy avoids allocating source.subarray(0, byteLength).
	for (let i = 0; i < byteLength; i++) {
		target[i] = source[i];
	}
}

function fillMeshBuffer(
	rta: ResizableTypedArray<Uint8Array>,
	byteLength: number,
): Uint8Array {
	const pooled = takePooledMeshBuffer(byteLength);

	if (pooled !== null) {
		copyMeshBytes(rta.backingArray, pooled, byteLength);
		return pooled;
	}

	// This exact-size allocation is required because the buffer is transferred
	// and downstream code derives counts from its exact byte length.
	return rta.finalArray;
}

// Reused relight-miss message.
const _relightMissScratch: RelightMeshMissMessage = {
	type: WorkerTaskType.RelightMesh,
	chunkId: 0n,
	meshRevision: 0,
	lod: 0,
};

function postRelightMiss(
	chunkId: bigint,
	meshRevision: number,
	lod: number,
): void {
	const miss = _relightMissScratch;
	miss.chunkId = chunkId;
	miss.meshRevision = meshRevision;
	miss.lod = lod;
	self.postMessage(miss);
}

// PERF: MeshData shells are reused across responses. self.postMessage clones
// the payload synchronously (same reasoning as _meshResponseScratch) and the
// transfer list detaches only the backing ArrayBuffers, so every field of the
// shell can be overwritten on the next use without aliasing. Pool size
// naturally stabilizes at ≤3 (one per output bucket).
const _meshShellPool: MeshData[] = [];

function takeTransferableOutput(data: WorkerInternalMeshData): MeshData | null {
	if (data.faceCount <= 0) return null;

	const bytes = data.faceCount * 12;
	const out = _meshShellPool.pop() ?? new MeshData();
	out.faceCount = data.faceCount;
	out.faceData = fillMeshBuffer(data.faceData, bytes);
	return out;
}

// PERF: reused across postMeshResponse calls. self.postMessage structured-clones
// the message synchronously, so the same object can be reused each call without
// aliasing. Avoids one FullMeshMessage object + one Transferable[] allocation
// per mesh result.
const _meshResponseScratch: FullMeshMessage = {
	type: WorkerTaskType.GenerateFullMesh,
	chunkId: 0n,
	meshRevision: 0,
	lod: 0,
	opaque: null,
	water: null,
	cutout: null,
};
const _localTransferablesScratch: Transferable[] = [];

function postMeshResponse(
	chunkId: bigint,
	meshRevision: number,
	lod: number,
): void {
	const opaque = takeTransferableOutput(_opaqueOut);

	const water = takeTransferableOutput(_waterOut);

	const cutout = takeTransferableOutput(_cutoutOut);

	const response = _meshResponseScratch;
	response.type = WorkerTaskType.GenerateFullMesh;
	response.chunkId = chunkId;
	response.meshRevision = meshRevision;
	response.lod = lod;
	response.opaque = opaque;
	response.water = water;
	response.cutout = cutout;

	const localTransferables = _localTransferablesScratch;
	localTransferables.length = 0;

	if (opaque) {
		localTransferables.push(opaque.faceData.buffer);
	}

	if (water) {
		localTransferables.push(water.faceData.buffer);
	}

	if (cutout) {
		localTransferables.push(cutout.faceData.buffer);
	}

	self.postMessage(response, localTransferables);

	// Clones completed synchronously above — reclaim the shells for the next
	// response instead of allocating fresh MeshData objects per bucket.
	if (opaque) _meshShellPool.push(opaque);
	if (water) _meshShellPool.push(water);
	if (cutout) _meshShellPool.push(cutout);
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

self.onmessage = (event: MessageEvent<VoxelWorkerRequest>): void => {
	const data = event.data;

	switch (data.type) {
		case WorkerTaskType.VoxelRegisterChunk: {
			_handleVoxelRegister(data);
			return;
		}

		case WorkerTaskType.VoxelRegisterChunkBatch: {
			const count = data.chunkIds.length;

			if (data.coords.length !== count * 3 || data.meta.length !== count * 3) {
				throw new Error(
					`bad VoxelRegisterChunkBatch lengths (ids ${count}, ` +
						`coords ${data.coords.length}, meta ${data.meta.length})`,
				);
			}

			for (let i = 0, offset = 0; i < count; i++, offset += 3) {
				registerVoxel(
					data.coords[offset],
					data.coords[offset + 1],
					data.coords[offset + 2],
					data.blockSABs[i],
					data.paletteSABs[i],
					data.lightSABs[i],
					data.meta[offset + 2] as 1 | 2,
					data.meta[offset] === 1,
					data.meta[offset + 1],
					true,
				);
			}

			return;
		}

		case WorkerTaskType.VoxelUnregisterChunk: {
			unregisterVoxel(data.chunkX, data.chunkY, data.chunkZ);
			return;
		}

		case WorkerTaskType.VoxelUnregisterChunkBatch: {
			const coords = data.coords;

			for (let offset = 0; offset + 2 < coords.length; offset += 3) {
				unregisterVoxel(coords[offset], coords[offset + 1], coords[offset + 2]);
			}

			return;
		}

		case WorkerTaskType.VoxelUpdateChunkBuffers: {
			_handleVoxelUpdateBuffers(data);
			return;
		}

		case WorkerTaskType.VoxelRecycleBuffers: {
			const buffers = data.buffers;

			for (let i = 0; i < buffers.length; i++) {
				// The Uint8Array shell is required to access and pool the
				// transferred ArrayBuffer. Its backing memory is not copied.
				givePooledMeshBuffer(new Uint8Array(buffers[i]));
			}

			return;
		}

		case WorkerTaskType.RelightMesh: {
			const entry = relightCache.get(data.chunkId);
			const paddedSize = data.chunk_size + 2;
			const expectedPaddedVolume = paddedSize * paddedSize * paddedSize;

			if (
				entry === undefined ||
				entry.generation !== data.generation ||
				entry.blockRevision !== data.blockRevision ||
				entry.grids.block.length !== expectedPaddedVolume
			) {
				postRelightMiss(data.chunkId, data.meshRevision, data.lod);
				return;
			}

			touchRelightEntry(data.chunkId, entry);

			const reg = _voxelRegistrations.get(
				packCoords(data.chunkX, data.chunkY, data.chunkZ),
			);

			buildNeighborArrays(
				data.chunkX,
				data.chunkY,
				data.chunkZ,
				data.chunk_size,
				data.neighborMask,
				false,
			);

			// This object remains a per-task allocation because WorkerMeshInput
			// is consumed synchronously by begin(). If begin() retains input,
			// reusing a shared object would be unsafe.
			buildVoxelMeshFromInput(
				{
					neighbors: entry.neighbors,
					light_array: centerLightArray(reg),
					neighborLights: _neighborLights,
					borderSkirtSides: data.borderSkirtSides,
					borderSkirtNearInset: data.borderSkirtNearInset,
				},
				data.chunk_size,
				data.lod,
				entry.grids,
				true,
			);

			postMeshResponse(data.chunkId, data.meshRevision, data.lod);
			return;
		}

		case WorkerTaskType.InitWorkerChannel: {
			const port = data.port;
			port.onmessage = _handleChannelMessage;
			port.start();
			return;
		}

		case WorkerTaskType.GenerateFullMesh: {
			const size = data.chunk_size;
			const lod = data.lod ?? 0;
			const generation = data.generation ?? -1;
			const blockRevision = data.blockRevision ?? -1;

			const reg = _voxelRegistrations.get(
				packCoords(data.chunkX, data.chunkY, data.chunkZ),
			);

			buildNeighborArrays(
				data.chunkX,
				data.chunkY,
				data.chunkZ,
				size,
				data.neighborMask,
				true,
			);

			const uniformBlockId = data.uniformBlockId;
			const isUniform = uniformBlockId !== undefined;

			const centerBlockArray = isUniform
				? null
				: getDecodedCenterBlocks(
						reg,
						data.chunkId,
						generation,
						blockRevision,
						size,
					);

			const entry = getOrCreateRelightEntry(
				data.chunkId,
				generation,
				blockRevision,
				presenceFromMask(data.neighborMask),
			);

			buildVoxelMeshFromInput(
				{
					block_array: centerBlockArray,
					uniformFill: isUniform ? uniformBlockId : undefined,
					light_array: centerLightArray(reg),
					neighbors: _neighborBlocks,
					neighborLights: _neighborLights,
					borderSkirtSides: data.borderSkirtSides,
					borderSkirtNearInset: data.borderSkirtNearInset,
				},
				size,
				lod,
				entry.grids,
				false,
			);

			postMeshResponse(data.chunkId, data.meshRevision, lod);
			return;
		}

		default:
			return;
	}
};
