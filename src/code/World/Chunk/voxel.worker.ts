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
import { PaletteExpander } from "./DataStructures/PaletteExpander";
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
	const blockBytesPerElement = args.blockBytesPerElement;

	let blockU8: Uint8Array | null = null;
	let blockU16: Uint16Array | null = null;

	if (blockSAB) {
		if (blockBytesPerElement === 1) {
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
		palette: paletteSAB ? new Uint16Array(paletteSAB) : null,
		light: lightSAB ? new Uint8Array(lightSAB) : null,

		blockBytesPerElement,
		isUniform: args.isUniform,
		uniformBlockId: args.uniformBlockId,
	};
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
	const key = packCoords(req.chunkX, req.chunkY, req.chunkZ);

	if (req.direct) {
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
		return;
	}

	const pending = _pendingChannelData.get(key);
	if (pending) {
		_pendingChannelData.delete(key);
		pending.isUniform = req.isUniform;
		pending.uniformBlockId = req.uniformBlockId;
		_voxelRegistrations.set(key, pending);
		return;
	}

	_pendingMetadata.set(key, {
		isUniform: req.isUniform,
		uniformBlockId: req.uniformBlockId,
	});
}

function _handleVoxelUnregister(req: VoxelUnregisterChunkRequest): void {
	const key = packCoords(req.chunkX, req.chunkY, req.chunkZ);
	_voxelRegistrations.delete(key);
	_pendingChannelData.delete(key);
	_pendingMetadata.delete(key);
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
// SAB border extraction
//
// Ported from the main thread's postFullRemesh extraction (which is deleted):
// the worker now builds the 26 block/light border slabs itself, directly from
// the neighbor chunks' SharedArrayBuffers. Slab values are written into
// per-slot scratch buffers (reused across tasks — begin() copies them into
// the padded grid before the scratch is next touched).
// ---------------------------------------------------------------------------

// Offset order must match the main thread's remesh mask (slot i = mask bit i):
// dz outer → dx inner, center (0,0,0) omitted.
const NEIGHBOR_OFFSETS: readonly {
	readonly dx: number;
	readonly dy: number;
	readonly dz: number;
}[] = (() => {
	const out: { dx: number; dy: number; dz: number }[] = [];
	for (let z = -1; z <= 1; z++) {
		for (let y = -1; y <= 1; y++) {
			for (let x = -1; x <= 1; x++) {
				if (x === 0 && y === 0 && z === 0) continue;
				out.push({ dx: x, dy: y, dz: z });
			}
		}
	}
	return out;
})();

// chunk_size is always Chunk.SIZE (32); 32^2 covers the largest (face) slab.
const _MAX_BORDER = 32 * 32;

const _blockBorderScratch: Uint16Array[] = Array.from(
	{ length: 26 },
	() => new Uint16Array(_MAX_BORDER),
);
const _lightBorderScratch: Uint8Array[] = Array.from(
	{ length: 26 },
	() => new Uint8Array(_MAX_BORDER),
);

// 26-slot input arrays consumed by begin() within the same task.
const _neighborBlocks: (Uint16Array | undefined)[] = new Array(26);
const _neighborLights: (Uint8Array | undefined)[] = new Array(26);

// Truthy presence marker for the relight cache's per-entry presence array —
// never dereferenced (block borders are skipped on light-only rebuilds).
const _PRESENT = new Uint16Array(0);
// Avoid allocating a fresh 26-slot presence array on every full mesh.
// These arrays must be treated as immutable after creation.
const _presenceMaskCache = new Map<number, (Uint16Array | undefined)[]>();
const _PRESENCE_MASK_CACHE_MAX = 64;
function presenceFromMask(mask: number): (Uint16Array | undefined)[] {
	const cached = _presenceMaskCache.get(mask);
	if (cached) return cached;

	const arr = new Array<Uint16Array | undefined>(26);
	for (let i = 0; i < 26; i++) {
		arr[i] = (mask & (1 << i)) !== 0 ? _PRESENT : undefined;
	}

	if (_presenceMaskCache.size >= _PRESENCE_MASK_CACHE_MAX) {
		const oldest = _presenceMaskCache.keys().next();
		if (!oldest.done) _presenceMaskCache.delete(oldest.value);
	}

	_presenceMaskCache.set(mask, arr);
	return arr;
}

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
	if (dense16) {
		let ci = 0;

		for (let bz = 0; bz < zCount; bz++) {
			const zBase = (lzStart + bz) * size2;

			for (let by = 0; by < yCount; by++) {
				const rowBase = zBase + (lyStart + by) * size;

				if (dx === 0) {
					out.set(dense16.subarray(rowBase, rowBase + xCount), ci);
					ci += xCount;
				} else {
					out[ci++] = dense16[rowBase + lxStart];
				}
			}
		}

		return out;
	}

	const packed = reg.blockU8;
	if (!packed) {
		out.fill(0, 0, total);
		return out;
	}

	const palette = reg.palette;
	const paletteLen = palette?.length ?? 0;

	if (palette && paletteLen > 1) {
		let ci = 0;

		for (let bz = 0; bz < zCount; bz++) {
			const zBase = (lzStart + bz) * size2;

			for (let by = 0; by < yCount; by++) {
				const rowBase = zBase + (lyStart + by) * size;

				if (dx === 0) {
					let packedIndex = rowBase >>> 1;
					const pairCount = xCount >>> 1;

					for (let pair = 0; pair < pairCount; pair++) {
						const byte = packed[packedIndex++];
						const lo = byte & 0x0f;
						const hi = (byte >>> 4) & 0x0f;

						out[ci++] = lo < paletteLen ? palette[lo] : 0;
						out[ci++] = hi < paletteLen ? palette[hi] : 0;
					}
				} else {
					const idx = rowBase + lxStart;
					const byte = packed[idx >>> 1];
					const pIdx = (idx & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;

					out[ci++] = pIdx < paletteLen ? palette[pIdx] : 0;
				}
			}
		}

		return out;
	}

	let ci = 0;

	for (let bz = 0; bz < zCount; bz++) {
		const zBase = (lzStart + bz) * size2;

		for (let by = 0; by < yCount; by++) {
			const rowBase = zBase + (lyStart + by) * size;

			if (dx === 0) {
				out.set(packed.subarray(rowBase, rowBase + xCount), ci);
				ci += xCount;
			} else {
				out[ci++] = packed[rowBase + lxStart];
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
	const nLight = reg.light;
	if (!nLight) return undefined;

	const xCount = dx === 0 ? size : 1;
	const yCount = dy === 0 ? size : 1;
	const zCount = dz === 0 ? size : 1;
	const lxStart = dx < 0 ? size - 1 : 0;
	const lyStart = dy < 0 ? size - 1 : 0;
	const lzStart = dz < 0 ? size - 1 : 0;
	const size2 = size * size;

	const lb = _lightBorderScratch[slot];
	let li = 0;

	for (let bz = 0; bz < zCount; bz++) {
		const zBase = (lzStart + bz) * size2;

		for (let by = 0; by < yCount; by++) {
			const rowBase = zBase + (lyStart + by) * size;

			if (dx === 0) {
				lb.set(nLight.subarray(rowBase, rowBase + xCount), li);
				li += xCount;
			} else {
				lb[li++] = nLight[rowBase + lxStart];
			}
		}
	}

	return lb;
}

const NEIGHBOR_DX = new Int8Array(26);
const NEIGHBOR_DY = new Int8Array(26);
const NEIGHBOR_DZ = new Int8Array(26);

for (let i = 0; i < 26; i++) {
	NEIGHBOR_DX[i] = NEIGHBOR_OFFSETS[i].dx;
	NEIGHBOR_DY[i] = NEIGHBOR_OFFSETS[i].dy;
	NEIGHBOR_DZ[i] = NEIGHBOR_OFFSETS[i].dz;
}

function buildNeighborArrays(
	cx: number,
	cy: number,
	cz: number,
	size: number,
	mask: number,
	includeBlocks = true,
): void {
	const regs = _voxelRegistrations;
	const neighborBlocks = _neighborBlocks;
	const neighborLights = _neighborLights;
	const dxs = NEIGHBOR_DX;
	const dys = NEIGHBOR_DY;
	const dzs = NEIGHBOR_DZ;

	// Force unsigned 32-bit shifting. The neighbor mask only uses 26 bits.
	let bits = mask >>> 0;

	for (let i = 0; i < 26; i++, bits >>>= 1) {
		if ((bits & 1) === 0) {
			neighborBlocks[i] = undefined;
			neighborLights[i] = undefined;
			continue;
		}

		const dx = dxs[i];
		const dy = dys[i];
		const dz = dzs[i];

		const reg = regs.get(packCoords(cx + dx, cy + dy, cz + dz));
		if (!reg) {
			neighborBlocks[i] = undefined;
			neighborLights[i] = undefined;
			continue;
		}

		neighborBlocks[i] = includeBlocks
			? extractBlockBorder(reg, i, size, dx, dy, dz)
			: undefined;

		neighborLights[i] = extractLightBorder(reg, i, size, dx, dy, dz);
	}
}

// T3-1: decoded center-block cache.
//
// Palette-encoded chunks paid a fresh 64 KiB expandPalette allocation on
// every full remesh (decodeCenterBlocks), feeding minor GC on busy remesh
// frames. Dense results are cached per chunk and validated against
// (generation, blockRevision) — the same staleness contract as the relight
// cache — so repeated full rebuilds of an unmodified chunk reuse the expanded
// grid. Direct SAB views (dense16/packed) are returned as-is and never
// cached; they are stable and need no copy.
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
	if (!reg?.blockSAB) return null;

	const dense16 = reg.blockU16;
	if (dense16) return dense16;

	const packed = reg.blockU8;
	if (!packed) return null;

	const palette = reg.palette;
	if (!palette || palette.length <= 0) return packed;

	const totalBlocks = size * size * size;

	const cached = decodedBlocksCache.get(chunkId);
	if (
		cached &&
		cached.generation === generation &&
		cached.blockRevision === blockRevision &&
		cached.blocks.length === totalBlocks
	) {
		// Refresh insertion order so Map eviction stays LRU.
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
		blocks = _paletteExpander.expandPalette(packed, palette, totalBlocks);
	}

	if (decodedBlocksCache.size >= DECODED_BLOCKS_CACHE_MAX) {
		const oldest = decodedBlocksCache.keys().next();
		if (!oldest.done) decodedBlocksCache.delete(oldest.value);
	}
	decodedBlocksCache.set(chunkId, { generation, blockRevision, blocks });

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

const _paletteExpander = new PaletteExpander();

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
	_opaqueOut.faceDataA.reset();
	_opaqueOut.faceDataB.reset();
	_opaqueOut.faceDataC.reset();
	_opaqueOut.faceCount = 0;
	_waterOut.faceDataA.reset();
	_waterOut.faceDataB.reset();
	_waterOut.faceDataC.reset();
	_waterOut.faceCount = 0;
	_cutoutOut.faceDataA.reset();
	_cutoutOut.faceDataB.reset();
	_cutoutOut.faceDataC.reset();
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
const _recyclePool: Uint8Array[] = [];
let _recyclePoolBytes = 0;
const RECYCLE_POOL_MAX_BUFFERS = 96;
const RECYCLE_POOL_MAX_BYTES = 12 * 1024 * 1024;

function takePooledMeshBuffer(byteLength: number): Uint8Array | null {
	for (let i = 0; i < _recyclePool.length; i++) {
		const buf = _recyclePool[i];
		if (buf.length === byteLength) {
			_recyclePool[i] = _recyclePool[_recyclePool.length - 1];
			_recyclePool.pop();
			_recyclePoolBytes -= byteLength;
			return buf;
		}
	}
	return null;
}

function givePooledMeshBuffer(buf: Uint8Array): void {
	if (_recyclePool.length >= RECYCLE_POOL_MAX_BUFFERS) return;
	if (_recyclePoolBytes + buf.length > RECYCLE_POOL_MAX_BYTES) return;
	_recyclePool.push(buf);
	_recyclePoolBytes += buf.length;
}

function fillMeshBuffer(
	rta: ResizableTypedArray<Uint8Array>,
	byteLength: number,
): Uint8Array {
	const pooled = takePooledMeshBuffer(byteLength);
	if (pooled) {
		pooled.set(rta.backingArray.subarray(0, byteLength));
		return pooled;
	}
	return rta.finalArray;
}

function takeTransferableOutput(data: WorkerInternalMeshData): MeshData | null {
	if (data.faceCount <= 0) return null;

	const bytes = data.faceCount << 2;
	const out = new MeshData();
	out.faceCount = data.faceCount;
	out.faceDataA = fillMeshBuffer(data.faceDataA, bytes);
	out.faceDataB = fillMeshBuffer(data.faceDataB, bytes);
	out.faceDataC = fillMeshBuffer(data.faceDataC, bytes);
	return out;
}

function postMeshResponse(
	chunkId: bigint,
	meshRevision: number,
	lod: number,
): void {
	const opaque = takeTransferableOutput(_opaqueOut);

	const water = takeTransferableOutput(_waterOut);

	const cutout = takeTransferableOutput(_cutoutOut);

	const response: FullMeshMessage = {
		type: WorkerTaskType.GenerateFullMesh,
		chunkId,
		meshRevision,
		lod,
		opaque,
		water,
		cutout,
	};

	const localTransferables: Transferable[] = [];

	if (opaque) {
		localTransferables.push(
			opaque.faceDataA.buffer,
			opaque.faceDataB.buffer,
			opaque.faceDataC.buffer,
		);
	}

	if (water) {
		localTransferables.push(
			water.faceDataA.buffer,
			water.faceDataB.buffer,
			water.faceDataC.buffer,
		);
	}

	if (cutout) {
		localTransferables.push(
			cutout.faceDataA.buffer,
			cutout.faceDataB.buffer,
			cutout.faceDataC.buffer,
		);
	}

	self.postMessage(response, localTransferables);
}

self.onmessage = (event: MessageEvent<VoxelWorkerRequest>): void => {
	const data = event.data;

	if (data.type === WorkerTaskType.VoxelRegisterChunk) {
		_handleVoxelRegister(data);
		return;
	}

	if (data.type === WorkerTaskType.VoxelRegisterChunkBatch) {
		const n = data.chunkIds.length;
		if (data.coords.length !== n * 3 || data.meta.length !== n * 3) {
			throw new Error(
				`bad VoxelRegisterChunkBatch lengths (ids ${n}, ` +
					`coords ${data.coords.length}, meta ${data.meta.length})`,
			);
		}
		for (let i = 0; i < n; i++) {
			_handleVoxelRegister({
				chunkX: data.coords[i * 3],
				chunkY: data.coords[i * 3 + 1],
				chunkZ: data.coords[i * 3 + 2],
				isUniform: data.meta[i * 3] === 1,
				uniformBlockId: data.meta[i * 3 + 1],
				blockStorageBytesPerElement: data.meta[i * 3 + 2] as 1 | 2,
				direct: true,
				blockSAB: data.blockSABs[i],
				paletteSAB: data.paletteSABs[i],
				lightSAB: data.lightSABs[i],
			});
		}
		return;
	}

	if (data.type === WorkerTaskType.VoxelUnregisterChunk) {
		_handleVoxelUnregister(data);
		return;
	}

	if (data.type === WorkerTaskType.VoxelUnregisterChunkBatch) {
		const n = data.coords.length / 3;
		for (let i = 0; i < n; i++) {
			_handleVoxelUnregister({
				type: WorkerTaskType.VoxelUnregisterChunk,
				chunkX: data.coords[i * 3],
				chunkY: data.coords[i * 3 + 1],
				chunkZ: data.coords[i * 3 + 2],
			});
		}
		return;
	}

	if (data.type === WorkerTaskType.VoxelUpdateChunkBuffers) {
		_handleVoxelUpdateBuffers(data);
		return;
	}

	if (data.type === WorkerTaskType.VoxelRecycleBuffers) {
		const buffers = data.buffers;
		for (let i = 0; i < buffers.length; i++) {
			givePooledMeshBuffer(new Uint8Array(buffers[i]));
		}
		return;
	}

	if (data.type === WorkerTaskType.RelightMesh) {
		const entry = relightCache.get(data.chunkId);
		const expectedPaddedVol =
			(data.chunk_size + 2) * (data.chunk_size + 2) * (data.chunk_size + 2);

		if (
			!entry ||
			entry.generation !== data.generation ||
			entry.blockRevision !== data.blockRevision ||
			entry.grids.block.length !== expectedPaddedVol
		) {
			const miss: RelightMeshMissMessage = {
				type: WorkerTaskType.RelightMesh,
				chunkId: data.chunkId,
				meshRevision: data.meshRevision,
				lod: data.lod,
			};
			self.postMessage(miss);
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
	if (data.type === WorkerTaskType.InitWorkerChannel) {
		const port = data.port;
		port.onmessage = _handleChannelMessage;
		port.start();
		return;
	}
	if (data.type !== WorkerTaskType.GenerateFullMesh) return;

	{
		const size = data.chunk_size;
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

		const generation = data.generation ?? -1;
		const blockRevision = data.blockRevision ?? -1;
		const uniform = data.uniformBlockId !== undefined;
		const centerBlockArray = uniform
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
				uniformFill: uniform ? data.uniformBlockId : undefined,
				light_array: centerLightArray(reg),
				neighbors: _neighborBlocks,
				neighborLights: _neighborLights,
				borderSkirtSides: data.borderSkirtSides,
				borderSkirtNearInset: data.borderSkirtNearInset,
			},
			size,
			data.lod ?? 0,
			entry.grids,
			false,
		);

		postMeshResponse(data.chunkId, data.meshRevision, data.lod ?? 0);
	}
};
