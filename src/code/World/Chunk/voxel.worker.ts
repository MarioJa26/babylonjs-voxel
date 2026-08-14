// src/code/World/Chunk/voxel.worker.ts

import { MeshEmitters } from "../MeshPipeline/core/MeshEmitters";
import {
	createEmptyWorkerInternalMeshData,
	MeshBuildSession,
	type PaddedGrids,
	toTransferableMeshData,
	type WorkerMeshInput,
} from "../MeshPipeline/core/WorkerMeshHelpers";
import { shapeInitPromise } from "../Shape/BlockShapes";
import { packCoords } from "./DataStructures/ChunkCoords";
import { PaletteExpander } from "./DataStructures/PaletteExpander";
import {
	type FullMeshMessage,
	type GenerateFullMeshRequest,
	type RelightMeshMissMessage,
	type RelightMeshRequest,
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

function _handleChannelMessage(event: MessageEvent): void {
	const data = event.data;
	if (!data || (data as { _type?: string })._type !== "voxelData") return;
	const key = packCoords(data.chunkX | 0, data.chunkY | 0, data.chunkZ | 0);
	const meta = _pendingMetadata.get(key);
	const voxel: VoxelRegistration = {
		blockSAB: data.blocksSAB ?? null,
		paletteSAB: data.paletteSAB ?? null,
		lightSAB: data.lightSAB ?? null,
		blockBytesPerElement: data.blockBytesPerElement,
		isUniform: meta ? meta.isUniform : false,
		uniformBlockId: meta ? meta.uniformBlockId : 0,
	};
	if (meta) {
		_pendingMetadata.delete(key);
		_voxelRegistrations.set(key, voxel);
	} else {
		_pendingChannelData.set(key, voxel);
	}
}

function _handleVoxelRegister(req: VoxelRegisterChunkRequest): void {
	const key = packCoords(req.chunkX, req.chunkY, req.chunkZ);
	const reg: VoxelRegistration = {
		blockSAB: req.blockSAB,
		paletteSAB: req.paletteSAB,
		lightSAB: req.lightSAB,
		blockBytesPerElement: req.blockStorageBytesPerElement,
		isUniform: req.isUniform,
		uniformBlockId: req.uniformBlockId,
	};

	if (req.direct) {
		_pendingMetadata.delete(key);
		_pendingChannelData.delete(key);
		_voxelRegistrations.set(key, reg);
		return;
	}

	const pending = _pendingChannelData.get(key);
	if (pending) {
		_pendingChannelData.delete(key);
		pending.isUniform = reg.isUniform;
		pending.uniformBlockId = reg.uniformBlockId;
		_voxelRegistrations.set(key, pending);
	} else {
		_pendingMetadata.set(key, {
			isUniform: reg.isUniform,
			uniformBlockId: reg.uniformBlockId,
		});
	}
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
	_voxelRegistrations.set(key, {
		blockSAB: req.blockSAB,
		paletteSAB: req.paletteSAB,
		lightSAB: req.lightSAB,
		blockBytesPerElement: req.blockStorageBytesPerElement,
		isUniform: req.isUniform,
		uniformBlockId: req.uniformBlockId,
	});
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

function presenceFromMask(mask: number): (Uint16Array | undefined)[] {
	const arr = new Array<Uint16Array | undefined>(26);
	for (let i = 0; i < 26; i++) {
		arr[i] = (mask & (1 << i)) !== 0 ? _PRESENT : undefined;
	}
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
		// PERF: the whole border is one repeated block id — skip the
		// triple-nested loop entirely for uniform chunks.
		out.fill(reg.uniformBlockId, 0, total);
		return out;
	}

	if (!reg.blockSAB) {
		out.fill(0, 0, total);
		return out;
	}

	const lxStart = dx < 0 ? size - 1 : 0;
	const lyStart = dy < 0 ? size - 1 : 0;
	const lzStart = dz < 0 ? size - 1 : 0;
	const size2 = size * size;

	if (reg.blockBytesPerElement === 2) {
		// Dense Uint16 storage — indices are always in-bounds of the SAB, so
		// no `?? 0` guard is needed.
		const dense = new Uint16Array(reg.blockSAB);
		let ci = 0;
		for (let bz = 0; bz < zCount; bz++) {
			const nlz = lzStart + bz;
			for (let by = 0; by < yCount; by++) {
				const nly = lyStart + by;
				const rowBase = nly * size + nlz * size2;
				if (dx === 0) {
					// Full contiguous row — bulk copy instead of a per-voxel
					// scalar loop.
					out.set(dense.subarray(rowBase, rowBase + xCount), ci);
					ci += xCount;
				} else {
					for (let bx = 0; bx < xCount; bx++) {
						out[ci++] = dense[lxStart + bx + rowBase];
					}
				}
			}
		}
		return out;
	}

	const packed = new Uint8Array(reg.blockSAB);
	const palette = reg.paletteSAB ? new Uint16Array(reg.paletteSAB) : null;

	if (palette && palette.length > 1) {
		// 4-bit nibble-packed palette storage — must decode per voxel, but
		// when dx === 0 the run is a full contiguous `size`-length row
		// starting at an even index (size is always a power of two), so we
		// can decode both nibbles of each packed byte in one iteration.
		let ci = 0;
		for (let bz = 0; bz < zCount; bz++) {
			const nlz = lzStart + bz;
			for (let by = 0; by < yCount; by++) {
				const nly = lyStart + by;
				const rowBase = nly * size + nlz * size2;
				if (dx === 0) {
					let idx = rowBase; // lxStart is 0 when dx === 0
					for (let bx = 0; bx < xCount; bx += 2) {
						const byte = packed[idx >>> 1];
						out[ci++] = palette[byte & 0x0f] ?? 0;
						out[ci++] = palette[(byte >>> 4) & 0x0f] ?? 0;
						idx += 2;
					}
				} else {
					for (let bx = 0; bx < xCount; bx++) {
						const idx = lxStart + bx + rowBase;
						const byte = packed[idx >>> 1];
						const pIdx = (idx & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;
						out[ci++] = palette[pIdx] ?? 0;
					}
				}
			}
		}
		return out;
	}

	// Dense Uint8 storage.
	let ci = 0;
	for (let bz = 0; bz < zCount; bz++) {
		const nlz = lzStart + bz;
		for (let by = 0; by < yCount; by++) {
			const nly = lyStart + by;
			const rowBase = nly * size + nlz * size2;
			if (dx === 0) {
				out.set(packed.subarray(rowBase, rowBase + xCount), ci);
				ci += xCount;
			} else {
				for (let bx = 0; bx < xCount; bx++) {
					out[ci++] = packed[lxStart + bx + rowBase];
				}
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
	if (!reg.lightSAB) return undefined;

	const xCount = dx === 0 ? size : 1;
	const yCount = dy === 0 ? size : 1;
	const zCount = dz === 0 ? size : 1;
	const lxStart = dx < 0 ? size - 1 : 0;
	const lyStart = dy < 0 ? size - 1 : 0;
	const lzStart = dz < 0 ? size - 1 : 0;
	const size2 = size * size;

	const nLight = new Uint8Array(reg.lightSAB);
	const lb = _lightBorderScratch[slot];
	let li = 0;
	for (let bz = 0; bz < zCount; bz++) {
		const nlz = lzStart + bz;
		for (let by = 0; by < yCount; by++) {
			const nly = lyStart + by;
			const rowBase = nly * size + nlz * size2;
			if (dx === 0) {
				lb.set(nLight.subarray(rowBase, rowBase + xCount), li);
				li += xCount;
			} else {
				for (let bx = 0; bx < xCount; bx++) {
					lb[li++] = nLight[lxStart + bx + rowBase];
				}
			}
		}
	}
	return lb;
}

function buildNeighborArrays(
	cx: number,
	cy: number,
	cz: number,
	size: number,
	mask: number,
	includeBlocks = true,
): void {
	for (let i = 0; i < 26; i++) {
		if ((mask & (1 << i)) === 0) {
			_neighborBlocks[i] = undefined;
			_neighborLights[i] = undefined;
			continue;
		}

		const { dx, dy, dz } = NEIGHBOR_OFFSETS[i];
		const reg = _voxelRegistrations.get(packCoords(cx + dx, cy + dy, cz + dz));

		if (!reg) {
			// Benign race: the neighbor's registration has not completed yet.
			// Treat as air/unlit; the next remesh heals it.
			_neighborBlocks[i] = undefined;
			_neighborLights[i] = undefined;
			continue;
		}

		// Full remesh needs block + light borders.
		// Light-only remesh already owns the validated block grid in the relight cache,
		// so extracting block borders here is wasted hot-path work.
		_neighborBlocks[i] = includeBlocks
			? extractBlockBorder(reg, i, size, dx, dy, dz)
			: undefined;

		_neighborLights[i] = extractLightBorder(reg, i, size, dx, dy, dz);
	}
}

function decodeCenterBlocks(
	reg: VoxelRegistration | undefined,
	size: number,
): Uint8Array | Uint16Array | null {
	if (!reg?.blockSAB) return null;
	const totalBlocks = size * size * size;

	if (reg.blockBytesPerElement === 2) {
		// Dense Uint16 storage — the SAB view IS the dense array.
		return new Uint16Array(reg.blockSAB);
	}

	const packed = new Uint8Array(reg.blockSAB);
	const palette = reg.paletteSAB ? new Uint16Array(reg.paletteSAB) : null;

	if (palette && palette.length > 1) {
		// PERF: PaletteExpander is stateless — one shared instance instead of
		// a fresh object per palette chunk.
		return _paletteExpander.expandPalette(packed, palette, totalBlocks);
	}

	if (palette && palette.length === 1) {
		const blockId = palette[0];
		if (blockId === 0) return null;
		const dense = new Uint16Array(totalBlocks);
		dense.fill(blockId);
		return dense;
	}

	// Dense Uint8 storage.
	return packed;
}

function centerLightArray(
	reg: VoxelRegistration | undefined,
): Uint8Array | undefined {
	return reg?.lightSAB ? new Uint8Array(reg.lightSAB) : undefined;
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

const RELIGHT_CACHE_MAX = 6;
const relightCache = new Map<bigint, RelightCacheEntry>();

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

// Mesh generation depends on the async block-shape/block JSON. If we mesh
// before that finishes loading, the shape-dependent caches are permanently
// populated with the cube fallback (e.g. grass crosses render as transparent
// cubes). Await shape init once per worker before the first mesh task.
let _shapesReady: Promise<void> | null = null;
function ensureShapesReady(): Promise<void> {
	if (!_shapesReady) _shapesReady = shapeInitPromise;
	return _shapesReady;
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
const _transparentOut = createEmptyWorkerInternalMeshData();

function resetMeshOut(): void {
	_opaqueOut.faceDataA.reset();
	_opaqueOut.faceDataB.reset();
	_opaqueOut.faceDataC.reset();
	_opaqueOut.faceCount = 0;
	_transparentOut.faceDataA.reset();
	_transparentOut.faceDataB.reset();
	_transparentOut.faceDataC.reset();
	_transparentOut.faceCount = 0;
}

let transferables: Transferable[];

function buildVoxelMeshFromInput(
	input: WorkerMeshInput,
	size: number,
	lod: number,
	grids?: PaddedGrids,
	skipBlockFill = false,
): void {
	_session.begin(size, lod, input, grids, skipBlockFill);
	resetMeshOut();
	MeshEmitters.buildVoxelMesh(_session, _opaqueOut, _transparentOut);
}

function postMeshResponse(
	chunkId: bigint,
	meshRevision: number,
	lod: number,
): void {
	const opaque =
		_opaqueOut.faceCount > 0 ? toTransferableMeshData(_opaqueOut) : null;

	const transparent =
		_transparentOut.faceCount > 0
			? toTransferableMeshData(_transparentOut)
			: null;

	const response: FullMeshMessage = {
		type: WorkerTaskType.GenerateFullMesh,
		chunkId,
		meshRevision,
		lod,
		opaque,
		transparent,
	};

	transferables = [];

	if (opaque) {
		transferables.push(opaque.faceDataA.buffer);
		transferables.push(opaque.faceDataB.buffer);
		transferables.push(opaque.faceDataC.buffer);
	}

	if (transparent) {
		transferables.push(transparent.faceDataA.buffer);
		transferables.push(transparent.faceDataB.buffer);
		transferables.push(transparent.faceDataC.buffer);
	}

	self.postMessage(response, transferables);
}

self.onmessage = (event: MessageEvent<VoxelWorkerRequest>): void => {
	const data = event.data;

	if (data.type === WorkerTaskType.InitWorkerChannel) {
		const port = data.port;
		port.onmessage = _handleChannelMessage;
		port.start();
		return;
	}

	if (data.type === WorkerTaskType.VoxelRegisterChunk) {
		_handleVoxelRegister(data);
		return;
	}

	if (data.type === WorkerTaskType.VoxelRegisterChunkBatch) {
		const chunks = data.chunks;
		for (let i = 0; i < chunks.length; i++) {
			_handleVoxelRegister({
				type: WorkerTaskType.VoxelRegisterChunk,
				...chunks[i],
			});
		}
		return;
	}

	if (data.type === WorkerTaskType.VoxelUnregisterChunk) {
		_handleVoxelUnregister(data);
		return;
	}

	if (data.type === WorkerTaskType.VoxelUnregisterChunkBatch) {
		const chunks = data.chunks;
		for (let i = 0; i < chunks.length; i++) {
			_handleVoxelUnregister({
				type: WorkerTaskType.VoxelUnregisterChunk,
				chunkX: chunks[i].chunkX,
				chunkY: chunks[i].chunkY,
				chunkZ: chunks[i].chunkZ,
			});
		}
		return;
	}

	if (data.type === WorkerTaskType.VoxelUpdateChunkBuffers) {
		_handleVoxelUpdateBuffers(data);
		return;
	}

	if (data.type === WorkerTaskType.RelightMesh) {
		void ensureShapesReady().then(() => {
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

			// Light-only rebuild: bind the session to the entry's padded grids
			// and refill only the light grid (block fill + opacity
			// classification are version-validated unchanged).
			buildVoxelMeshFromInput(
				{
					neighbors: entry.neighbors,
					light_array: centerLightArray(reg),
					neighborLights: _neighborLights,
				},
				data.chunk_size,
				data.lod,
				entry.grids,
				true,
			);
			postMeshResponse(data.chunkId, data.meshRevision, data.lod);
		});
		return;
	}

	if (data.type !== WorkerTaskType.GenerateFullMesh) return;

	void ensureShapesReady().then(() => {
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

		// Uniform chunks carry no dense grid — pass the fill id so the padded
		// grid is filled directly (no 64-512 KiB dense materialization).
		const uniform = data.uniformBlockId !== undefined;
		const centerBlockArray = uniform ? null : decodeCenterBlocks(reg, size);

		const entry = getOrCreateRelightEntry(
			data.chunkId,
			data.generation ?? -1,
			data.blockRevision ?? -1,
			presenceFromMask(data.neighborMask),
		);

		buildVoxelMeshFromInput(
			{
				block_array: centerBlockArray,
				uniformFill: uniform ? data.uniformBlockId : undefined,
				light_array: centerLightArray(reg),
				neighbors: _neighborBlocks,
				neighborLights: _neighborLights,
			},
			size,
			data.lod ?? 0,
			entry.grids,
			false,
		);
		postMeshResponse(data.chunkId, data.meshRevision, data.lod ?? 0);
	});
};
