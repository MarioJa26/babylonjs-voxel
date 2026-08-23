import { disposeMeshGpu, type Mesh, removeFromScene } from "@babylonjs/lite";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { getFinalTerrainHeight } from "@/code/Generation/TerrainHeightMap";
import { LIGHT_NIBBLE_MASK, SKY_LIGHT_SHIFT } from "@/code/Lib/VoxelMath";
import { Map1 } from "@/code/Maps/Map1";
import { onGpuWorkDone } from "../Light/liteGpuBuffer.js";

// BUGFIX: Deferred mesh disposal to prevent "buffer used in submit while
// destroyed" WebGPU validation errors. disposeMeshGpu() destroys GPU buffers
// immediately, but the GPU may still be rendering with them from a
// previously-submitted command buffer. We defer disposal until onGpuWorkDone.
const _pendingMeshDisposal: Mesh[] = [];
let _meshDisposalScheduled = false;

function deferMeshDisposal(mesh: Mesh): void {
	if (!mesh) return;

	_pendingMeshDisposal.push(mesh);
	schedulePendingMeshDisposal();
}

// PERF: module-level callbacks — no closure allocation per scheduled drain.
function _afterMeshDisposalWait(): void {
	_meshDisposalScheduled = false;
	drainPendingMeshDisposal();

	// If disposal indirectly queued more meshes, schedule another GPU-safe drain.
	if (_pendingMeshDisposal.length > 0) {
		schedulePendingMeshDisposal();
	}
}

function _onMeshDisposalWaitError(err: unknown): void {
	console.warn("Deferred mesh disposal waited on GPU work but failed", err);
}

function schedulePendingMeshDisposal(): void {
	if (_meshDisposalScheduled) return;
	_meshDisposalScheduled = true;

	const engine = Map1.engine;

	if (!engine) {
		_meshDisposalScheduled = false;
		drainPendingMeshDisposal();
		return;
	}

	void onGpuWorkDone(engine)
		.catch(_onMeshDisposalWaitError)
		.finally(_afterMeshDisposalWait);
}
function drainPendingMeshDisposal(): void {
	while (_pendingMeshDisposal.length > 0) {
		const mesh = _pendingMeshDisposal.pop();
		if (mesh) disposeMeshGpu(mesh);
	}
}
function makeSharedUint16(
	valuesOrLength: number | ArrayLike<number>,
): Uint16Array {
	if (typeof valuesOrLength === "number") {
		return new Uint16Array(new SharedArrayBuffer(valuesOrLength * 2));
	}

	const out = new Uint16Array(new SharedArrayBuffer(valuesOrLength.length * 2));
	out.set(valuesOrLength);
	return out;
}

function makeSharedUint8(length: number): Uint8Array {
	return new Uint8Array(new SharedArrayBuffer(length));
}

import {
	connectFacesMask,
	FACE_CONNECT_THRESHOLD,
	isTransparent,
} from "./ChunkFaceMasks";
import {
	packBlockValue,
	unpackBlockId,
	unpackBlockState,
} from "./DataStructures/BlockEncoding";
import { packCoords } from "./DataStructures/ChunkCoords";
import type { MeshData } from "./DataStructures/MeshData";
import { LoadedChunkIndex } from "./Loading/LoadedChunkIndex";
import { removeChunkFromGroup } from "./MergedMeshManager";
import {
	clearHeaderRow,
	LIGHT_HEADER_ROW_SIZE,
	type LightHeaderView,
	MAX_HEADER_SLOTS,
	wrapLightHeader,
	writeHeaderRow,
} from "./Worker/ChunkLightHeader";
import {
	BLOCK_TYPE,
	filtersFullSunlight,
	WATER_BLOCK_ID,
} from "./Worker/ChunkMesherConstants";

type CachedLODMesh = {
	opaque: MeshData | null;
	water: MeshData | null;
	cutout: MeshData | null;
};
type SerializedLODMeshCache = Record<
	number,
	{
		opaque?: MeshData | null;
		water?: MeshData | null;
		cutout?: MeshData | null;
	}
>;
type LightStorageSnapshot = {
	lightSAB: SharedArrayBuffer | null;
	blockSAB: SharedArrayBuffer | null;
	paletteSAB: SharedArrayBuffer | null;
	blockStorageBytesPerElement: 1 | 2;
};

const _ccVisited = new Uint8Array(GenerationParams.CHUNK_SIZE ** 3);
const _ccStack = new Int32Array(GenerationParams.CHUNK_SIZE ** 3);
const _ccFaceCounts = new Uint16Array(6);

// Reusable seed queue for initializeSunlight().  Sized once from the
// build-time CHUNK_SIZE constant; shared across all chunk loads because
// the function is synchronous and never re-enters itself.
const _sunlightSeedQueue = new Uint16Array(
	Math.max(8, 1 << Math.ceil(Math.log2(GenerationParams.CHUNK_SIZE ** 3 + 1))),
);

// ---------------------------------------------------------------------------
// Chunk dispose hooks
//
// Other modules (worker pool, loading system) hold strong references to
// Chunks in their internal queues. When a chunk is disposed we must give
// those modules a chance to drop the reference, otherwise the chunk and
// all of its voxel/light/palette SharedArrayBuffers stay alive forever.
//
// Hooks are registered via addChunkDisposeHook() at module load. They run
// at the tail of Chunk.dispose(). Exceptions are logged but do not abort
// the dispose itself.
// ---------------------------------------------------------------------------
export type ChunkDisposeHook = (chunk: Chunk) => void;
const _chunkDisposeHooks = new Set<ChunkDisposeHook>();

export function addChunkDisposeHook(hook: ChunkDisposeHook): void {
	_chunkDisposeHooks.add(hook);
}

function runChunkDisposeHooks(chunk: Chunk): void {
	for (const hook of _chunkDisposeHooks) {
		try {
			hook(chunk);
		} catch (err) {
			console.error("Chunk dispose hook threw", err);
		}
	}
}

export class Chunk {
	public readonly id: bigint;
	public lodLevel = 0;

	public static readonly SIZE = GenerationParams.CHUNK_SIZE;
	public static readonly SIZE2 = Chunk.SIZE * Chunk.SIZE;
	public static readonly SIZE3 = Chunk.SIZE * Chunk.SIZE * Chunk.SIZE;
	public static readonly SM1 = Chunk.SIZE - 1;
	public static readonly chunkInstances = new Map<bigint, Chunk>();

	public static readonly loadedChunks = new Set<Chunk>();
	public static readonly loadedChunkIndex = new LoadedChunkIndex();

	public isModified = false;
	public isBoatChunk = false;
	public isDirty = false;
	public isLoaded = false;
	public isTerrainScheduled = false;
	public isLightDirty = false;
	public persistenceRevision = 0;
	public remeshQueued = false;
	/**
	 * Set when a remesh arrives for a chunk whose mesh was superseded while
	 * the previous request was still in flight — the pool re-runs the remesh
	 * once the in-flight key clears. Flag lives on the chunk (not a Map) to
	 * avoid BigInt-keyed bookkeeping on the worker-message hot path.
	 */
	public rerunRemeshAfterInflight = false;
	/** Monotonically increases whenever a new mesh is requested for this chunk. */
	public meshRevision = 0;
	/**
	 * P2.4: Monotonically increases whenever the chunk's BLOCK content changes
	 * (setBlock / loadFromStorage / loadLodOnlyFromStorage). Unlike
	 * meshRevision — which also bumps on light-triggered remeshes — this only
	 * moves when the data behind the border slabs actually changes, so the
	 * ChunkWorker's slab cache can reuse block borders across relight rounds.
	 */
	public blockRevision = 0;
	/**
	 * P2.4: Monotonically stamped on every loadFromStorage. A chunk id is
	 * derived from world coordinates and is reused when a chunk is disposed
	 * and later re-created, so caches keyed by chunk id must also validate
	 * this generation counter.
	 */
	public generation = 0;
	private static _generationCounter = 0;

	public get isSolidOccluder(): boolean {
		return this.isLoaded && this._isUniform && this._uniformBlockId !== 0;
	}

	public static DEBUG_REMESH = false;

	public static onRequestRemesh:
		| ((chunk: Chunk, priority: boolean) => void)
		| null = null;
	public static onChunkLoaded: ((chunk: Chunk) => void) | null = null;
	public static onBlockModified: ((chunk: Chunk) => void) | null = null;

	// -------------------------------------------------------------------------
	// Batched block-edit remeshing (water / tick waves).
	//
	// A single water tick can write hundreds of blocks across a handful of
	// chunks. Without batching, every write cleared the LOD mesh cache and
	// scheduled a remesh — dozens of full greedy rebuilds for what is really
	// one intermediate flow state. Inside a batch, edits only MARK chunks
	// dirty; endBlockEditBatch() coalesces them into one remesh per chunk.
	// Light mutates still dispatch per block, so incremental lighting and
	// worker-side BFS stay exactly as before.
	// -------------------------------------------------------------------------
	private static _blockEditBatchDepth = 0;
	private static readonly _blockEditBatchChunks = new Set<Chunk>();

	public static beginBlockEditBatch(): void {
		Chunk._blockEditBatchDepth++;
	}

	public static endBlockEditBatch(): void {
		const depth = --Chunk._blockEditBatchDepth;
		if (depth > 0) return;
		if (depth < 0) {
			// Unbalanced call — clamp instead of going negative forever.
			Chunk._blockEditBatchDepth = 0;
			return;
		}
		const dirty = Chunk._blockEditBatchChunks;
		if (dirty.size === 0) return;
		for (const chunk of dirty) {
			if (!chunk.isLoaded) continue;
			chunk.clearCachedLODMeshes();
			chunk.scheduleRemesh(true);
		}
		dirty.clear();
	}

	/** Mark this chunk (or an optional neighbor) dirty for remesh — batch-aware. */
	private markDirtyForRemesh(): void {
		if (Chunk._blockEditBatchDepth > 0) {
			Chunk._blockEditBatchChunks.add(this);
			return;
		}
		this.clearCachedLODMeshes();
		this.scheduleRemesh(true);
	}

	// -------------------------------------------------------------------------
	// Light-worker integration.
	//
	// Each loaded chunk owns a slot in a workspace-wide SharedArrayBuffer
	// (Chunk.lightHeaderBuffer) that the worker reads on every BFS visit
	// to learn the chunk's block-storage layout (uniform / palette /
	// Uint8-vs-Uint16).  Slot allocation is done here; the pool's
	// static onLightChunk* hooks translate these calls into broadcast
	// postMessages.
	// -------------------------------------------------------------------------

	public static lightHeaderBuffer: SharedArrayBuffer | null = null;
	public static lightHeaderView: LightHeaderView | null = null;
	private static _lightHeaderNextSlot = 0;
	private static _lightHeaderFreeSlots: number[] = [];

	public static initLightHeader(): SharedArrayBuffer {
		if (Chunk.lightHeaderBuffer) return Chunk.lightHeaderBuffer;
		const buffer = new SharedArrayBuffer(
			LIGHT_HEADER_ROW_SIZE * MAX_HEADER_SLOTS,
		);
		Chunk.lightHeaderBuffer = buffer;
		Chunk.lightHeaderView = wrapLightHeader(buffer);
		return buffer;
	}

	private static allocLightHeaderSlot(): number {
		if (Chunk._lightHeaderFreeSlots.length > 0) {
			return Chunk._lightHeaderFreeSlots.pop()!;
		}
		if (Chunk._lightHeaderNextSlot >= MAX_HEADER_SLOTS) {
			throw new Error(
				`Chunk light header slots exhausted (max ${MAX_HEADER_SLOTS}).`,
			);
		}
		return Chunk._lightHeaderNextSlot++;
	}

	public static onLightChunkLoaded:
		| ((chunk: Chunk, fromChannel: boolean) => void)
		| null = null;
	public static onLightChunkLayoutChanged: ((chunk: Chunk) => void) | null =
		null;
	public static onLightChunkDisposed: ((chunk: Chunk) => void) | null = null;

	private _block_array: Uint8Array | Uint16Array | null = null;
	private _isUniform = true;
	private _uniformBlockId = 0;
	private _palette: Uint16Array | null = null;
	private _hasVoxelData = false;

	// Cached Uint32Array view over light_array — avoids re-allocation on every recomputeDarkCache call.
	private _la32: Uint32Array | null = null;

	// PERF: precomputed opacity lookups — one bool per palette index or dense
	// voxel, eliminating the per-voxel unpackBlockId + BLOCK_TYPE indirection.
	private _paletteOpacity: Uint8Array | null = null;
	private _denseOpacity: Uint8Array | null = null;

	public chunkY: number;
	public chunkX: number;
	public chunkZ: number;

	public mesh: Mesh | null = null;
	public waterMesh: Mesh | null = null;
	public cutoutMesh: Mesh | null = null;
	public opaqueMeshData: MeshData | null = null;
	public waterMeshData: MeshData | null = null;
	public cutoutMeshData: MeshData | null = null;

	// Merged mesh group key (packed group-grid coords + lod bucket, see
	// MergedMeshManager.makeGroupKey). null if not merged.
	public mergedGroupKey: number | null = null;

	// --- Face connectivity for occlusion BFS ---
	public faceConnectivity = 0;
	public connectivityDirty = true;

	_isDarkCached: boolean | undefined = undefined;

	public _fSteps: Uint8Array = new Uint8Array(6);

	light_array: Uint8Array;

	/**
	 * Snapshot of the worker-visible block/palette storage.  Used by
	 * ChunkWorkerPool to broadcast new SharedArrayBuffer handles after a
	 * storage layout transition (uniform->palette, palette->u16, ...).
	 * Centralised here so the pool never touches private fields directly.
	 *
	 * PERF: the snapshot object is cached on the instance and mutated in
	 * place — zero allocation per call.  Callers must consume the fields
	 * immediately (all current callers spread them into postMessage
	 * payloads); do not retain the returned object across layout changes.
	 */
	private _storageSnapshot: LightStorageSnapshot | null = null;

	public getLightStorageSnapshot(): LightStorageSnapshot {
		let s = this._storageSnapshot;
		if (s === null) {
			s = {
				lightSAB: null,
				blockSAB: null,
				paletteSAB: null,
				blockStorageBytesPerElement: 1,
			};
			this._storageSnapshot = s;
		}
		const lightBuffer = this.light_array?.buffer as
			| SharedArrayBuffer
			| ArrayBuffer
			| undefined;
		const blockBuffer = this._block_array?.buffer as
			| SharedArrayBuffer
			| ArrayBuffer
			| undefined;
		const paletteBuffer = this._palette?.buffer as
			| SharedArrayBuffer
			| ArrayBuffer
			| undefined;
		s.lightSAB = lightBuffer instanceof SharedArrayBuffer ? lightBuffer : null;
		s.blockSAB = blockBuffer instanceof SharedArrayBuffer ? blockBuffer : null;
		s.paletteSAB =
			paletteBuffer instanceof SharedArrayBuffer ? paletteBuffer : null;
		s.blockStorageBytesPerElement =
			this._block_array instanceof Uint16Array ? 2 : 1;
		return s;
	}

	/** Dense integer ID for this chunk, assigned from a static counter.
	 *  Stable and strictly increasing — safe to use as a typed-array index
	 *  in any system that wants to side-channel data onto chunks. */
	public readonly numericId: number;
	private static _nextNumericId = 0;

	/** Header SAB slot index for light-worker integration.  Allocated on
	 *  construction, released in dispose().  Index 0xFFFF means "not
	 *  allocated" so callers can cheaply detect uninitialised chunks. */
	public lightHeaderSlot: number = 0xffff_ffff;

	/** BFS pass stamp — compared against OcclusionCuller._currentQueryId. */
	public bfsQueryId: number = 0;

	/** Bitfield: bits 0–5 = face visited flags, bit 7 = BFS origin marker. */
	public bfsVisitedFaces: number = 0;

	/** True when this chunk is enqueued in OcclusionCuller._dirtyConnectivityChunks. */
	public bfsQueuedForConnectivity: boolean = false;

	/**
	 * Cached direct references to the 6 face-adjacent neighbours.
	 * Maintained eagerly: linkNeighbors() populates both sides on
	 * construction/load, dispose() nulls both sides on teardown — so there
	 * are never dangling references and no Map lookups are needed to resolve
	 * a face neighbour. The OcclusionCuller's lazy repair pass remains as a
	 * harmless no-op when links already exist.
	 *
	 * Direction layout matches neighborIds / the culler's face constants:
	 *   [0]=+X  [1]=-X  [2]=+Y  [3]=-Y  [4]=+Z  [5]=-Z
	 *
	 * Declared as a fixed-length 6-null array literal so V8 gives it
	 * PACKED_ELEMENTS (object references) from the start — no element-kind
	 * transitions, no holey-array penalties.
	 */
	public readonly neighborRefs: (Chunk | null)[] = [
		null,
		null,
		null,
		null,
		null,
		null,
	];

	public static readonly SKY_LIGHT_SHIFT = SKY_LIGHT_SHIFT;
	public static readonly BLOCK_LIGHT_MASK = LIGHT_NIBBLE_MASK;
	private static readonly SKYLIGHT_GENERATION_MIN_WORLD_Y = 32;
	private static readonly EMPTY_LIGHT_ARRAY =
		typeof SharedArrayBuffer !== "undefined"
			? new Uint8Array(new SharedArrayBuffer(0))
			: new Uint8Array(0);

	// PERF: lazily allocated — most chunks never cache an LOD mesh, so the
	// Map is only created on first set instead of once per chunk constructor.
	private _cachedLODMeshes: Map<number, CachedLODMesh> | null = null;

	private static readonly _lightEmissionLUT = (() => {
		const lut = new Uint8Array(256);
		lut[10] = 15;
		lut[11] = 15;
		lut[24] = 15;
		return lut;
	})();
	public static getLightEmission(blockId: number): number {
		return blockId >= 0 && blockId < 256 ? Chunk._lightEmissionLUT[blockId] : 0;
	}

	// =========================================================================
	// Construction
	// =========================================================================

	constructor(chunkX: number, chunkY: number, chunkZ: number) {
		this.chunkX = chunkX;
		this.chunkY = chunkY;
		this.chunkZ = chunkZ;
		this.id = packCoords(chunkX, chunkY, chunkZ);
		// numericId is a class field initializer, runs before this line,
		// but we assign here to use the static counter correctly.
		this.numericId = Chunk._nextNumericId++;
		this.light_array = Chunk.EMPTY_LIGHT_ARRAY;
		this.updateLightView();
		this.lightHeaderSlot = Chunk.allocLightHeaderSlot();
		this._isDarkCached = false;
		Chunk.chunkInstances.set(this.id, this);
		this.linkNeighbors();
	}

	// =========================================================================
	// Block storage – accessors & nibble helpers
	// =========================================================================

	get block_array(): Uint8Array | Uint16Array | null {
		return this._block_array;
	}
	get palette(): Uint16Array | null {
		return this._palette;
	}
	get isUniform(): boolean {
		return this._isUniform;
	}
	get uniformBlockId(): number {
		return this._uniformBlockId;
	}
	get hasVoxelData(): boolean {
		return this._hasVoxelData;
	}

	private getNibble(index: number): number {
		const arr = this._block_array as Uint8Array | null;
		if (!arr) return 0;
		const byte = arr[index >>> 1];
		return (index & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;
	}

	private setNibble(index: number, value: number): void {
		const arr = this._block_array as Uint8Array | null;
		if (!arr) return;
		const byteIndex = index >>> 1;
		const nibble = value & 0x0f;
		const byte = arr[byteIndex];
		arr[byteIndex] =
			(index & 1) === 0
				? (byte & 0xf0) | nibble
				: (byte & 0x0f) | (nibble << 4);
	}

	// =========================================================================
	// Load / unload
	// =========================================================================

	public loadFromStorage(
		blocks: Uint8Array | Uint16Array | null,
		palette: Uint16Array | null | undefined,
		isUniform: boolean | undefined,
		uniformBlockId: number | undefined,
		light_array?: Uint8Array,
		scheduleRemesh = true,
		_fromStorage = false,
	): void {
		this.clearCachedLODMeshes();
		this._hasVoxelData = true;

		if (isUniform && typeof uniformBlockId === "number") {
			this._isUniform = true;
			this._uniformBlockId = uniformBlockId;
			this._block_array = null;
			this._palette = null;
		} else if (palette && blocks instanceof Uint8Array) {
			this._isUniform = false;
			this._uniformBlockId = 0;
			this._palette = palette;
			this._block_array = blocks;
		} else if (blocks) {
			this._isUniform = false;
			this._uniformBlockId = 0;
			this._palette = null;
			this._block_array = blocks;
		} else {
			this._isUniform = true;
			this._uniformBlockId = 0;
			this._block_array = null;
			this._palette = null;
		}

		if (this._palette) {
			this._rebuildPaletteOpacity();
		} else if (this._block_array instanceof Uint16Array) {
			this._rebuildDenseOpacity();
		} else {
			this._paletteOpacity = null;
			this._denseOpacity = null;
		}

		if (light_array) {
			this.light_array = light_array;
		} else {
			this.initializeSunlight();
		}
		// Dark-cache scan is deferred to first occlusion use (isDarkCached) so
		// load storms don't pay a full 32 KB light scan per chunk.
		this._isDarkCached = undefined;

		this.blockRevision++;
		this.generation = ++Chunk._generationCounter;

		this.isLoaded = true;
		Chunk.loadedChunks.add(this);
		Chunk.loadedChunkIndex.register(this);
		this.isTerrainScheduled = false;

		// Storage hydration (VoxelSerializer.deserialize) hands us
		// _block_array / _palette / light_array as views into a regular
		// ArrayBuffer.  The worker can only see live mutations through a
		// SharedArrayBuffer, so copy each non-Shared buffer into a fresh
		// SAB before broadcasting to the worker pool.
		this.ensureSharedBacking();
		this.updateLightView();
		this.linkNeighbors();

		this.writeLightHeaderRow();
		Chunk.onLightChunkLoaded?.(this, _fromStorage);
		Chunk.onChunkLoaded?.(this);
		if (scheduleRemesh) this.scheduleRemesh(true, true);
	}

	private writeLightHeaderRow(): void {
		const view = Chunk.lightHeaderView;
		if (!view) return;
		const blockArr = this._block_array;
		const storageIsUint16 = blockArr instanceof Uint16Array;
		const hasPalette = this._palette !== null && !this._isUniform;
		writeHeaderRow(view, this.lightHeaderSlot, {
			chunkId: this.id,
			isUniform: this._isUniform,
			uniformBlockId: this._uniformBlockId,
			storageIsUint16,
			hasPalette,
			isLoaded: this.isLoaded,
		});
	}

	/**
	 * Copy the chunk's light_array, _block_array and _palette into fresh
	 * SharedArrayBuffers if they aren't already Shared-backed.  Storage
	 * hydration (VoxelSerializer.deserialize) hands us views into a
	 * regular ArrayBuffer, but the terrain worker can only observe
	 * future main-thread mutations through a SharedArrayBuffer.  Safe
	 * to call from loadFromStorage because that's the single synchronous
	 * choke-point before any worker broadcast.
	 */
	private ensureSharedBacking(): void {
		const light = this.light_array;
		if (light && !(light.buffer instanceof SharedArrayBuffer)) {
			const sab = new SharedArrayBuffer(Chunk.SIZE3);
			new Uint8Array(sab).set(light);
			this.light_array = new Uint8Array(sab);
		}

		const block = this._block_array;
		if (block && !(block.buffer instanceof SharedArrayBuffer)) {
			const len = block.byteLength;
			const sab = new SharedArrayBuffer(len);
			const dst = new Uint8Array(sab);
			if (block.byteOffset === 0 && block.BYTES_PER_ELEMENT === 1) {
				dst.set(block as Uint8Array);
			} else {
				dst.set(new Uint8Array(block.buffer, block.byteOffset, len));
			}
			this._block_array =
				block instanceof Uint16Array
					? new Uint16Array(sab)
					: new Uint8Array(sab);
		}

		const palette = this._palette;
		if (palette && !(palette.buffer instanceof SharedArrayBuffer)) {
			const byteLen = palette.byteLength;
			const sab = new SharedArrayBuffer(byteLen);
			const dst = new Uint8Array(sab);
			if (palette.byteOffset === 0) {
				dst.set(new Uint8Array(palette.buffer, 0, byteLen));
			} else {
				dst.set(new Uint8Array(palette.buffer, palette.byteOffset, byteLen));
			}
			this._palette = new Uint16Array(sab, 0, palette.length);
		}

		this.updateLightView();
	}

	public loadLodOnlyFromStorage(scheduleRemesh = false): void {
		this._hasVoxelData = false;
		this._isUniform = true;
		this._uniformBlockId = 0;
		this._block_array = null;
		this._palette = null;
		this._paletteOpacity = null;
		this._denseOpacity = null;
		this.light_array = Chunk.EMPTY_LIGHT_ARRAY;
		this.updateLightView();
		this._isDarkCached = false;
		this.blockRevision++;
		this.generation = ++Chunk._generationCounter;
		this.isLoaded = true;
		Chunk.loadedChunks.add(this);
		Chunk.loadedChunkIndex.register(this);
		this.isTerrainScheduled = false;
		this.linkNeighbors();
		if (scheduleRemesh) this.scheduleRemesh();
	}

	// =========================================================================
	// LOD mesh cache
	// =========================================================================

	public getCachedLODMesh(lod: number): CachedLODMesh | null {
		return this._cachedLODMeshes?.get(lod) ?? null;
	}
	public hasCachedLODMesh(lod: number): boolean {
		const c = this._cachedLODMeshes?.get(lod);
		return !!c && (!!c.opaque || !!c.water || !!c.cutout);
	}
	public setCachedLODMesh(lod: number, mesh: CachedLODMesh): void {
		let cache = this._cachedLODMeshes;
		if (cache === null) {
			cache = new Map<number, CachedLODMesh>();
			this._cachedLODMeshes = cache;
		}
		const entry = cache.get(lod);
		if (entry) {
			entry.opaque = mesh.opaque ?? null;
			entry.water = mesh.water ?? null;
			entry.cutout = mesh.cutout ?? null;
		} else {
			cache.set(lod, {
				opaque: mesh.opaque ?? null,
				water: mesh.water ?? null,
				cutout: mesh.cutout ?? null,
			});
		}
		this.pruneDistantLODCaches(lod);
	}

	// MEMORY: each cached entry holds full MeshData buffers (transferred
	// worker arrays). Chunks streaming outward through LOD bands used to
	// accumulate one entry per band ever rendered and kept them all until
	// unload — unbounded heap growth proportional to explored world area.
	// Keep only entries near the chunk's CURRENT lod (±1 covers the deliberate
	// "cache result for a neighbouring band" path in ChunkWorkerPool); distant
	// bands re-mesh from voxel data on the rare switch-back.
	private pruneDistantLODCaches(justStoredLod: number): void {
		const cache = this._cachedLODMeshes;
		if (!cache || cache.size <= 3) return;
		const cur = this.lodLevel ?? 0;
		const keepLo = Math.min(cur, justStoredLod) - 1;
		const keepHi = Math.max(cur, justStoredLod) + 1;
		for (const key of cache.keys()) {
			if (key < keepLo || key > keepHi) cache.delete(key);
		}
	}
	public clearCachedLODMeshes(): void {
		this._cachedLODMeshes?.clear();
	}

	// Diagnostics: live-chunk census for the memory HUD. A heap snapshot
	// showed ~73k Chunk shells retaining ~2.9 GB; this breakdown identifies
	// which LOD band / voxel state owns them without needing a snapshot.
	public static getCensus(): {
		total: number;
		withVoxels: number;
		lodLow: number;
		lodMid: number;
		lodHigh: number;
		cachedMeshEntries: number;
		cachedMeshBytes: number;
	} {
		let total = 0,
			withVoxels = 0,
			lodLow = 0,
			lodMid = 0,
			lodHigh = 0,
			cachedMeshEntries = 0,
			cachedMeshBytes = 0;
		for (const c of Chunk.loadedChunks) {
			total++;
			if (c.hasVoxelData) withVoxels++;
			const lod = c.lodLevel ?? 0;
			if (lod <= 1) lodLow++;
			else if (lod <= 3) lodMid++;
			else lodHigh++;
			const cache = c.getCensusCacheView();
			if (cache) {
				cachedMeshEntries += cache.size;
				for (const entry of cache.values()) {
					for (const md of [entry.opaque, entry.water, entry.cutout]) {
						if (!md) continue;
						cachedMeshBytes +=
							md.faceDataA.byteLength +
							md.faceDataB.byteLength +
							md.faceDataC.byteLength;
					}
				}
			}
		}
		return {
			total,
			withVoxels,
			lodLow,
			lodMid,
			lodHigh,
			cachedMeshEntries,
			cachedMeshBytes,
		};
	}

	/** Internal: read-only view of the LOD cache for diagnostics. */
	private getCensusCacheView(): Map<number, CachedLODMesh> | null {
		return this._cachedLODMeshes;
	}
	public getSerializableLODMeshCache(): SerializedLODMeshCache | undefined {
		if (this._cachedLODMeshes === null || this._cachedLODMeshes.size === 0) {
			return undefined;
		}
		const out: SerializedLODMeshCache = {};
		let count = 0;
		for (const [lod, mesh] of this._cachedLODMeshes.entries()) {
			if (!mesh.opaque && !mesh.water && !mesh.cutout) continue;
			out[lod] = {
				opaque: mesh.opaque ?? null,
				water: mesh.water ?? null,
				cutout: mesh.cutout ?? null,
			};
			count++;
		}
		return count === 0 ? undefined : out;
	}
	public restoreLODMeshCache(cache?: SerializedLODMeshCache): void {
		this._cachedLODMeshes?.clear();
		if (!cache) return;
		for (const key of Object.keys(cache)) {
			const lod = Number(key);
			if (!Number.isFinite(lod)) continue;
			const entry = cache[lod];
			if (!entry?.opaque && !entry?.water && !entry?.cutout) continue;
			this.setCachedLODMesh(lod, {
				opaque: entry.opaque ?? null,
				water: entry.water ?? null,
				cutout: entry.cutout ?? null,
			});
		}
	}

	// =========================================================================
	// Sunlight initialisation
	// =========================================================================

	public initializeSunlight(): void {
		const size = Chunk.SIZE;
		const size2 = Chunk.SIZE2;
		const skyShift = Chunk.SKY_LIGHT_SHIFT;
		const blockMask = Chunk.BLOCK_LIGHT_MASK;
		const topWorldY = this.chunkY * size + size - 1;
		const aboveChunk = this.getNeighbor(0, 1, 0);

		if (this.light_array.length !== Chunk.SIZE3) {
			this.light_array =
				typeof SharedArrayBuffer !== "undefined"
					? new Uint8Array(new SharedArrayBuffer(Chunk.SIZE3))
					: new Uint8Array(Chunk.SIZE3);
		}
		this.updateLightView();

		const la = this.light_array;

		// PERF: use the eagerly-cached aligned word view — no per-call
		// helper/validation, no new Uint32Array allocation.
		const wordCount = la.length >>> 2;
		const la32 = this._la32;
		if (la32) {
			for (let i = 0; i < wordCount; i++) la32[i] &= 0x0f0f0f0f;

			for (let i = wordCount << 2; i < la.length; i++) {
				la[i] &= blockMask;
			}
		} else {
			for (let i = 0; i < la.length; i++) {
				la[i] &= blockMask;
			}
		}

		const chunkBaseX = this.chunkX * size;
		const chunkBaseZ = this.chunkZ * size;
		const chunkBaseY = this.chunkY * size;
		const hasLoadedAbove = !!aboveChunk?.isLoaded;
		// PERF: The generator-height probe only applies when the chunk top
		// could possibly receive generation-time skylight at all. Hoisting the
		// constant part out of the column loop lets fully-deep chunks skip all
		// 1024 terrain-height noise evaluations on the render thread.
		const canSeedFromGeneratorHeight =
			topWorldY >= Chunk.SKYLIGHT_GENERATION_MIN_WORLD_Y;

		const seedCapacity = _sunlightSeedQueue.length;
		const seedQueue = _sunlightSeedQueue;
		let seedLength = 0;

		// PERF: hoist the storage-layout dispatch out of the voxel loop and
		// inline getBlockPacked using the already-computed flat idx — keeps
		// the hot loop free of method calls and index recomputation.
		// NOTE: mirrors getBlockPacked's isLoaded guard: loadFromStorage runs
		// this before isLoaded=true, where reads must yield air (0).
		const canReadBlocks = this.isLoaded;
		const isUniform = this._isUniform;
		const uniformBlockId = this._uniformBlockId;
		const palette = this._palette;
		const blocks = this._block_array as Uint8Array | Uint16Array | null;
		const palBytes = palette !== null ? (blocks as Uint8Array) : null;

		for (let x = 0; x < size; x++) {
			const worldX = chunkBaseX + x;

			for (let z = 0; z < size; z++) {
				const worldZ = chunkBaseZ + z;
				const colBase = x + z * size2;
				let incomingSkyLight = 0;
				let sourceFiltersFullSun = false;

				if (hasLoadedAbove) {
					const aboveBlockPacked = aboveChunk.getBlockPacked(x, 0, z);
					if (isTransparent(aboveBlockPacked, 1, -1)) {
						incomingSkyLight = aboveChunk.getSkyLight(x, 0, z);
						sourceFiltersFullSun = filtersFullSunlight(
							unpackBlockId(aboveBlockPacked),
						);
					}
				} else if (canSeedFromGeneratorHeight) {
					const terrainHeight = getFinalTerrainHeight(worldX, worldZ);
					if (topWorldY >= terrainHeight - 48) {
						incomingSkyLight = 15;
					}
				}

				let idx = colBase + (size - 1) * size;

				for (let y = size - 1; y >= 0; y--, idx -= size) {
					const worldY = chunkBaseY + y;

					if (
						!hasLoadedAbove &&
						worldY < Chunk.SKYLIGHT_GENERATION_MIN_WORLD_Y
					) {
						// Descending: every deeper row is also below the
						// generation-seed floor, and sky bits were already
						// cleared at function entry — stop scanning.
						break;
					}

					let blockPacked: number;
					if (!canReadBlocks) {
						blockPacked = 0;
					} else if (isUniform) {
						blockPacked = uniformBlockId;
					} else if (palBytes !== null) {
						const byte = palBytes[idx >>> 1];
						blockPacked =
							palette![(idx & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f];
					} else {
						blockPacked = blocks![idx];
					}

					if (!isTransparent(blockPacked, 1, 1)) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = false;
						continue;
					}

					if (incomingSkyLight <= 0) continue;

					const thisFiltersFullSun = filtersFullSunlight(
						unpackBlockId(blockPacked),
					);
					const preservesFullSun =
						incomingSkyLight === 15 &&
						!sourceFiltersFullSun &&
						!thisFiltersFullSun;
					const cellSkyLight = preservesFullSun ? 15 : incomingSkyLight - 1;

					if (cellSkyLight === 0) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = thisFiltersFullSun;
						continue;
					}

					la[idx] = (la[idx] & blockMask) | (cellSkyLight << skyShift);

					if (!thisFiltersFullSun && seedLength < seedCapacity) {
						seedQueue[seedLength++] = (x << 10) | (y << 5) | z;
					}

					if (!isTransparent(blockPacked, 1, -1)) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = thisFiltersFullSun;
						continue;
					}

					incomingSkyLight = cellSkyLight;
					sourceFiltersFullSun = thisFiltersFullSun;
				}
			}
		}

		if (seedLength > 0) {
			const pool = Chunk._lightPool;
			if (pool) {
				// slice() copies via memcpy — the element-wise loop here used to
				// show up on storage-load waves (up to 32k seeds per chunk).
				const seedCopy = seedQueue.slice(0, seedLength);
				pool.enqueueDeferredLightFromSunlightInit?.(this, seedCopy, seedLength);
			}
		}
	}
	// =========================================================================
	// Light accessors
	// =========================================================================

	public getBlockLight(lx: number, ly: number, lz: number): number {
		if (!this.isLoaded) return 0;
		return (
			this.light_array[lx + ly * Chunk.SIZE + lz * Chunk.SIZE2] &
			Chunk.BLOCK_LIGHT_MASK
		);
	}
	public getSkyLight(lx: number, ly: number, lz: number): number {
		if (!this.isLoaded) return 0;
		return (
			(this.light_array[lx + ly * Chunk.SIZE + lz * Chunk.SIZE2] >>
				Chunk.SKY_LIGHT_SHIFT) &
			Chunk.BLOCK_LIGHT_MASK
		);
	}
	public getLight(lx: number, ly: number, lz: number): number {
		if (!this.isLoaded) return 0;
		return this.light_array[lx + ly * Chunk.SIZE + lz * Chunk.SIZE2];
	}
	public setLight(x: number, y: number, z: number, level: number): void {
		if (!this.isLoaded) return;
		const idx = x + y * Chunk.SIZE + z * Chunk.SIZE2;
		if (this.light_array[idx] !== level) {
			this.light_array[idx] = level;
			this.isModified = true;
			this.persistenceRevision++;
			this._isDarkCached = undefined;
		}
	}

	// Replace recomputeDarkCache with this version.
	public recomputeDarkCache(): void {
		const la = this.light_array;

		if (!la || la.length === 0) {
			this._isDarkCached = false;
			this._la32 = null;
			return;
		}

		const len = la.length;
		const wordCount = len >>> 2;

		// PERF: _la32 is maintained eagerly by updateLightView() at every
		// light_array assignment site — no per-call helper/validation here.
		const la32 = this._la32;

		if (la32 && la32.length === wordCount) {
			for (let i = 0; i < wordCount; i++) {
				if ((la32[i] & 0xf0f0f0f0) !== 0) {
					this._isDarkCached = false;
					return;
				}
			}

			for (let i = wordCount << 2; i < len; i++) {
				if ((la[i] & 0xf0) !== 0) {
					this._isDarkCached = false;
					return;
				}
			}

			this._isDarkCached = true;
			return;
		}

		for (let i = 0; i < len; i++) {
			if ((la[i] & 0xf0) !== 0) {
				this._isDarkCached = false;
				return;
			}
		}

		this._isDarkCached = true;
	}

	/**
	 * Lazily computed dark-cache answer for the occlusion culler. The scan is
	 * only run when a chunk's state is unknown (undefined) — loadFromStorage
	 * and light mutations leave it undefined, so the 32 KB light scan is paid
	 * once per invalidation and only for chunks the culler actually touches.
	 */
	public isDarkCached(): boolean {
		if (this._isDarkCached === undefined) {
			this.recomputeDarkCache();
		}
		return this._isDarkCached === true;
	}

	public setBlockLight(x: number, y: number, z: number, level: number): void {
		const cur = this.getLight(x, y, z);
		this.setLight(
			x,
			y,
			z,
			(cur & ~Chunk.BLOCK_LIGHT_MASK) | (level & Chunk.BLOCK_LIGHT_MASK),
		);
	}
	public setSkyLight(x: number, y: number, z: number, level: number): void {
		const cur = this.getLight(x, y, z);
		this.setLight(
			x,
			y,
			z,
			(cur & Chunk.BLOCK_LIGHT_MASK) |
				((level & Chunk.BLOCK_LIGHT_MASK) << Chunk.SKY_LIGHT_SHIFT),
		);
	}

	// =========================================================================
	// Block accessors
	// =========================================================================

	public getBlock(lx: number, ly: number, lz: number): number {
		return unpackBlockId(this.getBlockPacked(lx, ly, lz));
	}
	public getBlockState(lx: number, ly: number, lz: number): number {
		return unpackBlockState(this.getBlockPacked(lx, ly, lz));
	}
	public getBlockPacked(lx: number, ly: number, lz: number): number {
		if (!this.isLoaded) return 0;
		if (this._isUniform) return this._uniformBlockId;
		const index = lx + ly * Chunk.SIZE + lz * Chunk.SIZE2;
		if (this._palette) return this._palette[this.getNibble(index)];
		const raw = this._block_array![index];
		// Dense Uint8Array stores only block IDs (no state). Water level 0 = source.
		// Uint16Array already stores the full packed value — no synthesis needed.
		if (raw === WATER_BLOCK_ID && this._block_array!.BYTES_PER_ELEMENT === 1) {
			return WATER_BLOCK_ID;
		}
		return raw;
	}

	/**
	 * Precompute opacity flag for each palette entry. Called whenever the
	 * palette is created or mutated so that isOpaqueAtIndex can do a single
	 * nibble-read + array-lookup instead of unpackBlockId + BLOCK_TYPE.
	 */
	private _rebuildPaletteOpacity(): void {
		const pal = this._palette;
		if (!pal) {
			this._paletteOpacity = null;
			return;
		}
		let opa = this._paletteOpacity;
		if (!opa || opa.length < pal.length) {
			opa = new Uint8Array(pal.length);
			this._paletteOpacity = opa;
		}
		for (let i = 0; i < pal.length; i++) {
			const packed = pal[i];
			opa[i] = packed !== 0 && BLOCK_TYPE[unpackBlockId(packed)] === 0 ? 1 : 0;
		}
	}

	/**
	 * Precompute opacity flag for every voxel in a dense (Uint16Array) block
	 * storage layout. Called once after loadFromStorage or layout transition.
	 */
	private _rebuildDenseOpacity(): void {
		const arr = this._block_array;
		if (!(arr instanceof Uint16Array)) {
			this._denseOpacity = null;
			return;
		}
		const S3 = Chunk.SIZE3;
		let opa = this._denseOpacity;
		if (!opa || opa.length < S3) {
			opa = new Uint8Array(S3);
			this._denseOpacity = opa;
		}
		for (let i = 0; i < S3; i++) {
			const packed = arr[i];
			opa[i] = packed !== 0 && BLOCK_TYPE[unpackBlockId(packed)] === 0 ? 1 : 0;
		}
	}

	/**
	 * Read the packed block value at a flat index and return 1 if opaque, 0 if not.
	 * Avoids expanding blocks to a dense array — reads directly from palette/nibble
	 * or dense storage, keeping the result in cache.
	 */
	private isOpaqueAtIndex(i: number): number {
		if (this._isUniform) {
			return this._uniformBlockId !== 0 &&
				BLOCK_TYPE[unpackBlockId(this._uniformBlockId)] === 0
				? 1
				: 0;
		}
		if (this._paletteOpacity) {
			const blockArr = this._block_array as Uint8Array;
			const byte = blockArr[i >>> 1];
			const nibble = (i & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;
			return this._paletteOpacity[nibble];
		}
		if (this._denseOpacity) {
			return this._denseOpacity[i];
		}
		return 0;
	}

	public setBlock(
		localX: number,
		localY: number,
		localZ: number,
		blockId: number,
		state = 0,
	): void {
		if (!this.isLoaded) {
			console.warn(
				"Attempted to set block on an unloaded chunk. Action ignored. ",
				this.id,
				localX,
				localY,
				localZ,
			);
			return;
		}

		const index = localX + localY * Chunk.SIZE + localZ * Chunk.SIZE2;
		const packedBlock = packBlockValue(blockId, state);
		let oldPacked = 0;
		let storageLayoutChanged = false;
		let paletteChanged = false;

		if (this._isUniform) {
			oldPacked = this._uniformBlockId;
			if (oldPacked === packedBlock) return;

			this._isUniform = false;
			this._hasVoxelData = true;
			this._palette = makeSharedUint16([oldPacked, packedBlock]);
			this._block_array = makeSharedUint8(Chunk.SIZE3 / 2);
			this.setNibble(index, 1);

			storageLayoutChanged = true;
			paletteChanged = true;
		} else if (this._palette) {
			const paletteIndex = this.getNibble(index);
			oldPacked = this._palette[paletteIndex];

			if (oldPacked === packedBlock) return;

			const pal = this._palette;
			let npi = -1;

			for (let i = 0; i < pal.length; i++) {
				if (pal[i] === packedBlock) {
					npi = i;
					break;
				}
			}

			if (npi < 0) {
				if (pal.length < 16) {
					npi = pal.length;
					const ep = makeSharedUint16(npi + 1);
					ep.set(pal);
					ep[npi] = packedBlock;
					this._palette = ep;
					this.setNibble(index, npi);
					paletteChanged = true;
				} else {
					const na = makeSharedUint16(Chunk.SIZE3);
					for (let i = 0; i < Chunk.SIZE3; i++) {
						na[i] = pal[this.getNibble(i)];
					}
					na[index] = packedBlock;
					this._block_array = na;
					this._palette = null;
					storageLayoutChanged = true;
				}
			} else {
				this.setNibble(index, npi);
			}
		} else {
			const blockArray = this._block_array!;

			if (packedBlock > 255 && blockArray instanceof Uint8Array) {
				const na = makeSharedUint16(Chunk.SIZE3);
				na.set(blockArray);
				this._block_array = na;
				storageLayoutChanged = true;
			}

			oldPacked = this._block_array![index];
			if (oldPacked === packedBlock) return;

			this._block_array![index] = packedBlock;

			if (this._denseOpacity) {
				this._denseOpacity[index] =
					packedBlock !== 0 && BLOCK_TYPE[unpackBlockId(packedBlock)] === 0
						? 1
						: 0;
			}
		}

		if (paletteChanged) {
			this._rebuildPaletteOpacity();
		} else if (
			storageLayoutChanged &&
			this._block_array instanceof Uint16Array
		) {
			this._rebuildDenseOpacity();
		} else if (storageLayoutChanged) {
			this._denseOpacity = null;
		}

		if (storageLayoutChanged) {
			this.writeLightHeaderRow();
		}

		if (storageLayoutChanged || paletteChanged) {
			Chunk.onLightChunkLayoutChanged?.(this);
		}

		this.dispatchLightMutate(localX, localY, localZ, oldPacked, packedBlock);

		this.isModified = true;
		this.persistenceRevision++;
		this.connectivityDirty = true;
		this.blockRevision++;
		this.markDirtyForRemesh();
		Chunk.onBlockModified?.(this);

		const S = Chunk.SIZE;

		if (localX === 0) this.getNeighbor(-1, 0, 0)?.markDirtyForRemesh();
		else if (localX === S - 1) this.getNeighbor(1, 0, 0)?.markDirtyForRemesh();

		if (localY === 0) this.getNeighbor(0, -1, 0)?.markDirtyForRemesh();
		else if (localY === S - 1) this.getNeighbor(0, 1, 0)?.markDirtyForRemesh();

		if (localZ === 0) this.getNeighbor(0, 0, -1)?.markDirtyForRemesh();
		else if (localZ === S - 1) this.getNeighbor(0, 0, 1)?.markDirtyForRemesh();
	}

	/**
	 * Dispatch a single LightMutate message to the worker pool, replacing
	 * the inline BFS that used to run on the main thread.  No return
	 * value: scheduling of neighbour remeshes is driven by the worker's
	 * LightDirty reply.
	 */
	private dispatchLightMutate(
		localX: number,
		localY: number,
		localZ: number,
		oldPacked: number,
		newPacked: number,
	): void {
		const pool = Chunk._lightPool;
		if (!pool) return;
		pool.postLightMutate({
			chunkId: this.id,
			headerSlot: this.lightHeaderSlot,
			x: localX,
			y: localY,
			z: localZ,
			oldPacked,
			newPacked,
			seq: pool.nextLightSeq(),
		});
	}

	/**
	 * Set by ChunkWorkerPool.getInstance() once the pool is alive.
	 * Resolved lazily inside dispatchLightMutate so importing order
	 * doesn't matter.
	 */
	public static _lightPool: {
		postLightMutate(req: any): void;
		postLightAddEmission(req: any): void;
		nextLightSeq(): number;
		enqueueDeferredLightFromSunlightInit?(
			chunk: Chunk,
			queue: Uint16Array,
			length: number,
		): void;
	} | null = null;

	public deleteBlock(localX: number, localY: number, localZ: number): void {
		this.setBlock(localX, localY, localZ, 0);
	}

	// =========================================================================
	// Remesh scheduling
	// =========================================================================

	public scheduleRemesh(priority = false, includeNeighbors = false): void {
		if (!this.isLoaded) return;

		this.isDirty = true;

		if (includeNeighbors) {
			this.getNeighbor(-1, 0, 0)?.scheduleRemesh(priority);
			this.getNeighbor(1, 0, 0)?.scheduleRemesh(priority);
			this.getNeighbor(0, -1, 0)?.scheduleRemesh(priority);
			this.getNeighbor(0, 1, 0)?.scheduleRemesh(priority);
			this.getNeighbor(0, 0, -1)?.scheduleRemesh(priority);
			this.getNeighbor(0, 0, 1)?.scheduleRemesh(priority);
		}

		// Coalescing: when a rebuild is already queued or in flight, a repeat
		// request must NOT advance meshRevision. The worker stamps the revision
		// at dispatch time and reads live voxel state from the shared buffers,
		// so the pending build already covers these requests; if a build is
		// mid-flight the pool's rerunRemeshAfterInflight path re-queues a fresh
		// build after it lands. Bumping here would mark that in-flight result
		// stale on arrival (drain drops it) and force a duplicate full rebuild —
		// the remesh storm during load waves.
		if (this.remeshQueued) return;

		this.meshRevision++;
		this.remeshQueued = true;
		Chunk.onRequestRemesh?.(this, priority);
	}

	// =========================================================================
	// Neighbour / coordinate helpers
	// =========================================================================

	public getNeighbor(dx: number, dy: number, dz: number): Chunk | undefined {
		// PERF: direct array access into eagerly-maintained neighborRefs —
		// no coordinate math, no Map hash lookup on this hot path.
		if (dx === 1) return this.neighborRefs[0] ?? undefined;
		if (dx === -1) return this.neighborRefs[1] ?? undefined;
		if (dy === 1) return this.neighborRefs[2] ?? undefined;
		if (dy === -1) return this.neighborRefs[3] ?? undefined;
		if (dz === 1) return this.neighborRefs[4] ?? undefined;
		if (dz === -1) return this.neighborRefs[5] ?? undefined;
		return undefined;
	}

	// Face-order layout matching neighborRefs / the culler's face constants:
	// [0]=+X  [1]=-X  [2]=+Y  [3]=-Y  [4]=+Z  [5]=-Z
	public getNeighborChunk(faceIdx: number): Chunk | undefined {
		return this.neighborRefs[faceIdx] ?? undefined;
	}

	/**
	 * Eagerly link face-adjacent neighbours (both directions) from
	 * chunkInstances so getNeighbor/getNeighborChunk never touch a Map.
	 * Called on construction and after each load path; idempotent.
	 */
	private linkNeighbors(): void {
		const refs = this.neighborRefs;
		const instances = Chunk.chunkInstances;

		let nbr = instances.get(
			packCoords(this.chunkX + 1, this.chunkY, this.chunkZ),
		);
		if (nbr) {
			refs[0] = nbr;
			nbr.neighborRefs[1] = this;
		}
		nbr = instances.get(packCoords(this.chunkX - 1, this.chunkY, this.chunkZ));
		if (nbr) {
			refs[1] = nbr;
			nbr.neighborRefs[0] = this;
		}
		nbr = instances.get(packCoords(this.chunkX, this.chunkY + 1, this.chunkZ));
		if (nbr) {
			refs[2] = nbr;
			nbr.neighborRefs[3] = this;
		}
		nbr = instances.get(packCoords(this.chunkX, this.chunkY - 1, this.chunkZ));
		if (nbr) {
			refs[3] = nbr;
			nbr.neighborRefs[2] = this;
		}
		nbr = instances.get(packCoords(this.chunkX, this.chunkY, this.chunkZ + 1));
		if (nbr) {
			refs[4] = nbr;
			nbr.neighborRefs[5] = this;
		}
		nbr = instances.get(packCoords(this.chunkX, this.chunkY, this.chunkZ - 1));
		if (nbr) {
			refs[5] = nbr;
			nbr.neighborRefs[4] = this;
		}
	}

	public markLightChanged(): void {
		this.isLightDirty = true;
	}
	public needsPersistence(): boolean {
		return this.isModified || this.isLightDirty;
	}

	// =========================================================================
	// Face connectivity for occlusion BFS
	// =========================================================================

	public computeFaceConnectivity(): number {
		if (!this._hasVoxelData || this._isUniform) {
			const mask =
				this._isUniform && this._uniformBlockId === 0
					? connectFacesMask(0x3f)
					: 0;

			this.faceConnectivity = mask;
			this.connectivityDirty = false;
			return mask;
		}

		const S = Chunk.SIZE;
		const S2 = Chunk.SIZE2;
		const S3 = Chunk.SIZE3;
		const SM1 = Chunk.SM1;
		const threshold = FACE_CONNECT_THRESHOLD;
		const fullConnectivity = connectFacesMask(0x3f);
		const useSize32FastPath = S === 32;

		const visited = _ccVisited;
		const stack = _ccStack;
		const fc = _ccFaceCounts;

		visited.fill(0, 0, S3);

		// Pre-mark opaque cells as visited. Transparent cells remain 0 and are
		// traversed by BFS.
		if (this._paletteOpacity) {
			const blockArr = this._block_array as Uint8Array;
			const palOp = this._paletteOpacity;

			for (let i = 0; i < S3; i++) {
				const byte = blockArr[i >>> 1];
				const nibble = (i & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;
				visited[i] = palOp[nibble];
			}
		} else if (this._denseOpacity) {
			visited.set(this._denseOpacity.subarray(0, S3));
		} else {
			// Defensive fallback for unusual non-uniform layouts.
			for (let i = 0; i < S3; i++) {
				visited[i] = this.isOpaqueAtIndex(i);
			}
		}

		let connectivity = 0;

		for (let z = 0; z < S; z++) {
			const zBase = z * S2;

			for (let y = 0; y < S; y++) {
				const yzBase = zBase + y * S;

				for (let x = 0; x < S; x++) {
					const idx = yzBase + x;

					if (visited[idx]) continue;

					let stackTop = 0;
					stack[stackTop++] = idx;
					visited[idx] = 1;

					fc[0] = 0;
					fc[1] = 0;
					fc[2] = 0;
					fc[3] = 0;
					fc[4] = 0;
					fc[5] = 0;

					while (stackTop > 0) {
						const cur = stack[--stackTop];

						let cx: number;
						let cy: number;
						let cz: number;

						if (useSize32FastPath) {
							// Fast path for the current 32x32x32 chunk layout.
							cx = cur & 31;
							cy = (cur >>> 5) & 31;
							cz = cur >>> 10;
						} else {
							// Correct fallback if CHUNK_SIZE is ever changed.
							cz = Math.floor(cur / S2);
							const rem = cur - cz * S2;
							cy = Math.floor(rem / S);
							cx = rem - cy * S;
						}

						if (cx === 0) fc[1]++;
						if (cx === SM1) fc[0]++;
						if (cy === 0) fc[3]++;
						if (cy === SM1) fc[2]++;
						if (cz === 0) fc[5]++;
						if (cz === SM1) fc[4]++;

						if (cx > 0) {
							const n = cur - 1;
							if (!visited[n]) {
								visited[n] = 1;
								stack[stackTop++] = n;
							}
						}

						if (cx < SM1) {
							const n = cur + 1;
							if (!visited[n]) {
								visited[n] = 1;
								stack[stackTop++] = n;
							}
						}

						if (cy > 0) {
							const n = cur - S;
							if (!visited[n]) {
								visited[n] = 1;
								stack[stackTop++] = n;
							}
						}

						if (cy < SM1) {
							const n = cur + S;
							if (!visited[n]) {
								visited[n] = 1;
								stack[stackTop++] = n;
							}
						}

						if (cz > 0) {
							const n = cur - S2;
							if (!visited[n]) {
								visited[n] = 1;
								stack[stackTop++] = n;
							}
						}

						if (cz < SM1) {
							const n = cur + S2;
							if (!visited[n]) {
								visited[n] = 1;
								stack[stackTop++] = n;
							}
						}
					}

					let openFaces = 0;

					if (fc[0] >= threshold) openFaces |= 1;
					if (fc[1] >= threshold) openFaces |= 2;
					if (fc[2] >= threshold) openFaces |= 4;
					if (fc[3] >= threshold) openFaces |= 8;
					if (fc[4] >= threshold) openFaces |= 16;
					if (fc[5] >= threshold) openFaces |= 32;

					if (openFaces !== 0) {
						connectivity |= connectFacesMask(openFaces);

						// Once every face pair is connected, no later component can
						// add useful information.
						if (connectivity === fullConnectivity) {
							this.faceConnectivity = connectivity;
							this.connectivityDirty = false;
							return connectivity;
						}
					}
				}
			}
		}

		this.faceConnectivity = connectivity;
		this.connectivityDirty = false;
		return connectivity;
	}

	/**
	 * Rebuild the cached Uint32Array word view over light_array.  Called
	 * eagerly at every light_array assignment site (constructor, load paths,
	 * ensureSharedBacking, initializeSunlight, dispose) so hot scans can use
	 * this._la32 directly with zero per-call validation.
	 */
	private updateLightView(): void {
		const la = this.light_array;
		if (
			la &&
			la.length >= 4 &&
			(la.byteOffset & 3) === 0 &&
			la.byteOffset + la.length <= la.buffer.byteLength
		) {
			this._la32 = new Uint32Array(la.buffer, la.byteOffset, la.length >>> 2);
		} else {
			this._la32 = null;
		}
	}

	// =========================================================================
	// Dispose
	// =========================================================================

	public dispose(): void {
		// Null our slot in each live neighbour's neighborRefs before removing
		// ourselves from chunkInstances, so no chunk holds a dangling ref to us.
		// PERF: read our own eagerly-maintained refs directly — no Map lookups.
		// d ^ 1 gives the opposite direction (the face pointing back toward us).
		const refs = this.neighborRefs;
		for (let d = 0; d < 6; d++) {
			const nbr = refs[d];
			if (nbr) nbr.neighborRefs[d ^ 1] = null;
			refs[d] = null;
		}

		// Remove from merged mesh group — the group manager handles mesh disposal.
		if (this.mergedGroupKey) {
			removeChunkFromGroup(this);
		}

		if (!this.mergedGroupKey) {
			if (this.mesh) {
				removeFromScene(Map1.mainScene, this.mesh);
				deferMeshDisposal(this.mesh);
			}
			if (this.waterMesh) {
				removeFromScene(Map1.mainScene, this.waterMesh);
				deferMeshDisposal(this.waterMesh);
			}
			if (this.cutoutMesh) {
				removeFromScene(Map1.mainScene, this.cutoutMesh);
				deferMeshDisposal(this.cutoutMesh);
			}
		}
		this.clearCachedLODMeshes();
		this.mesh = null;
		this.waterMesh = null;
		this.cutoutMesh = null;
		this.opaqueMeshData = null;
		this.waterMeshData = null;
		this.cutoutMeshData = null;
		this._block_array = null;
		this._isUniform = true;
		this._uniformBlockId = 0;
		this._palette = null;
		this._paletteOpacity = null;
		this._denseOpacity = null;
		this._la32 = null;
		this._hasVoxelData = false;
		this.light_array = Chunk.EMPTY_LIGHT_ARRAY;
		this._isDarkCached = false;
		this.isLoaded = false;

		const view = Chunk.lightHeaderView;
		if (view && this.lightHeaderSlot !== 0xffff_ffff) {
			clearHeaderRow(view, this.lightHeaderSlot);
			Chunk._lightHeaderFreeSlots.push(this.lightHeaderSlot);
			this.lightHeaderSlot = 0xffff_ffff;
		}
		Chunk.onLightChunkDisposed?.(this);

		Chunk.loadedChunks.delete(this);
		Chunk.loadedChunkIndex.unregister(this);
		this.isTerrainScheduled = false;
		this.remeshQueued = false;
		this.rerunRemeshAfterInflight = false;
		Chunk.chunkInstances.delete(this.id);
		this.bfsQueryId = 0;
		this.bfsVisitedFaces = 0;
		this.bfsQueuedForConnectivity = false;

		runChunkDisposeHooks(this);
	}
}

// Resolve a loaded/constructed chunk by chunk coordinates.  Single registry
// (chunkInstances) — the old number-keyed _chunkByCoords mirror is gone;
// hot paths use eagerly-linked neighborRefs instead of this function.
export function getChunk(
	cx: number,
	cy: number,
	cz: number,
): Chunk | undefined {
	return Chunk.chunkInstances.get(packCoords(cx, cy, cz));
}

// PERF: multi-slot chunk cache.  getChunk() builds three BigInts via packCoords
// on every call; hot per-voxel paths (collision, light sampling, raycasts)
// resolve the same few chunks repeatedly, so a small ring of recent
// (cx,cy,cz)->Chunk entries avoids the BigInt allocation on cache hits.  An
// AABB sweep spans at most 2 chunks per axis (~8 distinct chunks), so 8 slots
// keep the miss rate near zero after warmup.  Stale (disposed) entries are
// validated by callers via chunk.isLoaded / hasVoxelData, exactly as the raw
// map lookup would be.
const _FAST_SLOTS = 8;
const _fastCx = new Int32Array(_FAST_SLOTS).fill(0x7fffffff);
const _fastCy = new Int32Array(_FAST_SLOTS).fill(0x7fffffff);
const _fastCz = new Int32Array(_FAST_SLOTS).fill(0x7fffffff);
const _fastChunk: (Chunk | undefined)[] = new Array(_FAST_SLOTS).fill(
	undefined,
);
let _fastCursor = 0;

export function getChunkFast(
	cx: number,
	cy: number,
	cz: number,
): Chunk | undefined {
	for (let i = 0; i < _FAST_SLOTS; i++) {
		if (_fastCx[i] === cx && _fastCy[i] === cy && _fastCz[i] === cz) {
			return _fastChunk[i];
		}
	}
	const chunk = Chunk.chunkInstances.get(packCoords(cx, cy, cz));
	_fastCx[_fastCursor] = cx;
	_fastCy[_fastCursor] = cy;
	_fastCz[_fastCursor] = cz;
	_fastChunk[_fastCursor] = chunk;
	_fastCursor = (_fastCursor + 1) % _FAST_SLOTS;
	return chunk;
}
