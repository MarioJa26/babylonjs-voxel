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
import { PaletteExpander } from "./DataStructures/PaletteExpander";
import {
	type FullMeshMessage,
	type RelightMeshMissMessage,
	type RelightMeshRequest,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";

export interface VoxelWorkerRequest {
	type: WorkerTaskType.GenerateFullMesh;

	chunkId: bigint;
	meshRevision: number;
	lod: number;
	chunk_size: number;

	// Content versioning for the relight cache.
	generation?: number;
	blockRevision?: number;

	block_array: Uint8Array | Uint16Array | null;
	uniformBlockId?: number;
	palette?: Uint8Array | Uint16Array | null;
	light_array?: Uint8Array;

	neighbors: (Uint16Array | undefined)[];
	neighborLights?: (Uint8Array | undefined)[];
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
	// 26-slot border arrays — kept only as the hasNeighborChunk presence mask
	// (the border content is already baked into grids.block).
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

function expandCenterOnly(
	request: VoxelWorkerRequest,
): Uint8Array | Uint16Array {
	const totalBlocks =
		request.chunk_size * request.chunk_size * request.chunk_size;

	if (request.block_array instanceof Uint16Array) {
		return request.block_array;
	}

	if (
		request.block_array instanceof Uint8Array &&
		(!request.palette || request.palette.length === 0)
	) {
		return request.block_array;
	}

	if (!request.block_array && request.uniformBlockId !== undefined) {
		if (request.uniformBlockId === 0) {
			return new Uint16Array(totalBlocks);
		}
		const dense = new Uint16Array(totalBlocks);
		dense.fill(request.uniformBlockId);
		return dense;
	}

	if (!request.block_array) {
		return new Uint16Array(totalBlocks);
	}

	if (request.palette && request.palette.length === 1) {
		const blockId = request.palette[0];
		if (blockId === 0) {
			return new Uint16Array(totalBlocks);
		}
		const dense = new Uint16Array(totalBlocks);
		dense.fill(blockId);
		return dense;
	}

	if (request.palette && request.palette.length > 0) {
		// PERF: PaletteExpander is stateless — one shared instance instead of
		// a fresh object per palette chunk.
		return _paletteExpander.expandPalette(
			request.block_array as Uint8Array,
			request.palette,
			totalBlocks,
		);
	}

	return request.block_array;
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
	_session.begin({ size, lod }, input, grids, skipBlockFill);
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

self.onmessage = (
	event: MessageEvent<VoxelWorkerRequest | RelightMeshRequest>,
): void => {
	const data = event.data;

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

			// Light-only rebuild: bind the session to the entry's padded grids
			// and refill only the light grid (block fill + opacity
			// classification are version-validated unchanged).
			buildVoxelMeshFromInput(
				{
					neighbors: entry.neighbors,
					light_array: data.light_array,
					neighborLights: data.neighborLights,
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
		const entry = getOrCreateRelightEntry(
			data.chunkId,
			data.generation ?? -1,
			data.blockRevision ?? -1,
			data.neighbors,
		);

		// Uniform chunks carry no dense grid — pass the fill id so the padded
		// grid is filled directly (no 64-512 KiB dense materialization).
		const uniform = data.uniformBlockId !== undefined;
		const centerBlockArray = uniform ? null : expandCenterOnly(data);

		buildVoxelMeshFromInput(
			{
				block_array: centerBlockArray,
				uniformFill: uniform ? data.uniformBlockId : undefined,
				light_array: data.light_array,
				neighbors: data.neighbors as (Uint16Array | undefined)[],
				neighborLights: data.neighborLights,
			},
			data.chunk_size,
			data.lod,
			entry.grids,
			false,
		);
		postMeshResponse(data.chunkId, data.meshRevision, data.lod);
	});
};
