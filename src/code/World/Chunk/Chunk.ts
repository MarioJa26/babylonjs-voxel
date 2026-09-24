import type { Mesh } from "@babylonjs/lite";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { LIGHT_NIBBLE_MASK, SKY_LIGHT_SHIFT } from "@/code/Lib/VoxelMath";
import { Map1 } from "@/code/Maps/Map1";
import {
	packBlockValue,
	unpackBlockId,
	unpackBlockState,
} from "./DataStructures/BlockEncoding";
import { packCoords } from "./DataStructures/ChunkCoords";
import type { MeshData } from "./DataStructures/MeshData";
import { LoadedChunkIndex } from "./Loading/LoadedChunkIndex";
import { connectFacesMask } from "./Meshing/ChunkFaceMasks";
import { removeChunkFromGroup } from "./Meshing/MergedMeshManager";
import { computeStoredFaceConnectivity } from "./Runtime/ChunkConnectivity";
import {
	beginChunkEditBatch,
	type ChunkLightPool,
	discardChunkEditState,
	endChunkEditBatch,
	markChunkDirtyForRemesh,
	recordLightMutation,
} from "./Runtime/ChunkEditBatching";
import { deferChunkMeshes } from "./Runtime/ChunkMeshDisposal";
import { releasePooledChunk, takePooledChunk } from "./Runtime/ChunkPool";
import {
	getChunkFast,
	invalidateFastChunkCache,
	registerChunk,
	chunkByNumericKey as registryChunkByNumericKey,
	chunkInstances as registryChunkInstances,
	unregisterChunk,
} from "./Runtime/ChunkRegistry";
import { copySunlightSeeds, seedSunlight } from "./Runtime/ChunkSunlight";
import {
	clearHeaderRow,
	LIGHT_HEADER_ROW_SIZE,
	type LightHeaderView,
	MAX_HEADER_SLOTS,
	wrapLightHeader,
	writeHeaderRow,
} from "./Worker/ChunkLightHeader";
import { BLOCK_TYPE, WATER_BLOCK_ID } from "./Worker/ChunkMesherConstants";

export { getChunkFast };

function makeSharedUint16(length: number): Uint16Array {
	return new Uint16Array(
		new SharedArrayBuffer(length * Uint16Array.BYTES_PER_ELEMENT),
	);
}

function makeSharedUint8(length: number): Uint8Array {
	return new Uint8Array(new SharedArrayBuffer(length));
}

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
	public id: bigint = 0n;
	public lodLevel = 0;

	public static readonly SIZE = GenerationParams.CHUNK_SIZE;
	public static readonly SIZE2 = Chunk.SIZE * Chunk.SIZE;
	public static readonly SIZE3 = Chunk.SIZE * Chunk.SIZE * Chunk.SIZE;
	public static readonly SM1 = Chunk.SIZE - 1;
	public static readonly chunkInstances = registryChunkInstances;
	public static readonly chunkByNumericKey = registryChunkByNumericKey;

	private static allocPooledChunk(x: number, y: number, z: number): Chunk {
		const c = takePooledChunk();
		if (c !== undefined) {
			// Rehydrate minimal fields – mirrors constructor without extra allocations
			(c as any).chunkX = x;
			(c as any).chunkY = y;
			(c as any).chunkZ = z;
			(c as any).id = packCoords(x, y, z);
			(c as any).numericId = Chunk._nextNumericId++;
			c.light_array = Chunk.EMPTY_LIGHT_ARRAY;
			(c as any)._la32 = null;
			(c as any).lightHeaderSlot = Chunk.allocLightHeaderSlot();
			(c as any)._isDarkCached = false;
			(c as any)._block_array = null;
			(c as any)._isUniform = true;
			(c as any)._uniformBlockId = 0;
			(c as any)._palette = null;
			(c as any)._paletteOpacity = null;
			(c as any)._hasVoxelData = false;
			(c as any)._cachedLODMeshes = null;
			c.isLoaded = false;
			c.isBoatChunk = false;
			c.isModified = false;
			c.isDirty = false;
			c.isTerrainScheduled = false;
			c.isLightDirty = false;
			c.persistenceRevision = 0;
			c.remeshQueued = false;
			c.rerunRemeshAfterInflight = false;
			c.meshRevision = 0;
			// blockRevision / generation keep their pooled values + bump on next loadFromStorage
			c.mergedGroupKey = null;
			c.faceConnectivity = 0;
			c.connectivityDirty = true;
			c.bfsQueryId = 0;
			c.bfsVisitedFaces = 0;
			c.bfsSteps0 = 0;
			c.bfsSteps1 = 0;
			c.bfsQueuedForConnectivity = false;
			// neighborRefs already nulled in dispose – keep the same 6-length array
			if (!c.neighborRefs || c.neighborRefs.length !== 6) {
				(c as any).neighborRefs = [null, null, null, null, null, null];
			}
			c.mesh = null;
			c.waterMesh = null;
			c.cutoutMesh = null;
			c.opaqueMeshData = null;
			c.waterMeshData = null;
			c.cutoutMeshData = null;
			registerChunk(c);
			c.linkNeighbors();
			return c;
		}
		return new Chunk(x, y, z);
	}

	public static obtain(x: number, y: number, z: number): Chunk {
		// Fast-path via 8-slot MRU cache (getChunkFast) — avoids BigInt alloc
		// on cache hit. Streaming creates many chunks per frame.
		const existing = getChunkFast(x, y, z);
		if (existing) return existing;
		return Chunk.allocPooledChunk(x, y, z);
	}

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

	public static beginBlockEditBatch(): void {
		beginChunkEditBatch();
	}

	public static endBlockEditBatch(): void {
		endChunkEditBatch(Chunk._lightPool);
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

	// PERF: precomputed opacity lookups — one bool per palette index, eliminating
	// the per-voxel unpackBlockId + BLOCK_TYPE indirection for palette chunks.
	// Dense chunks read BLOCK_TYPE directly in connectivity scans.
	private _paletteOpacity: Uint8Array | null = null;

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
		let snapshot = this._storageSnapshot;

		if (snapshot === null) {
			snapshot = {
				lightSAB: null,
				blockSAB: null,
				paletteSAB: null,
				blockStorageBytesPerElement: 1,
			};
			this._storageSnapshot = snapshot;
		}

		const lightBuffer = this.light_array.buffer;
		const blockArray = this._block_array;
		const palette = this._palette;

		snapshot.lightSAB =
			lightBuffer instanceof SharedArrayBuffer ? lightBuffer : null;

		snapshot.blockSAB =
			blockArray !== null && blockArray.buffer instanceof SharedArrayBuffer
				? blockArray.buffer
				: null;

		snapshot.paletteSAB =
			palette !== null && palette.buffer instanceof SharedArrayBuffer
				? palette.buffer
				: null;

		snapshot.blockStorageBytesPerElement =
			blockArray instanceof Uint16Array ? 2 : 1;

		return snapshot;
	}

	/** Dense integer ID for this chunk, assigned from a static counter.
	 *  Stable and strictly increasing — safe to use as a typed-array index
	 *  in any system that wants to side-channel data onto chunks. */
	public readonly numericId: number;
	private static _nextNumericId = 0;

	/** Header SAB slot index for light-worker integration.  Allocated on
	 *  construction, released in dispose().  0xFFFF_FFFF means unallocated. */
	public lightHeaderSlot: number = 0xffff_ffff;

	/** BFS pass stamp — compared against OcclusionCuller._currentQueryId. */
	public bfsQueryId: number = 0;

	/** Bitfield: bits 0–5 = face visited flags, bit 7 = BFS origin marker. */
	public bfsVisitedFaces: number = 0;
	public bfsSteps0 = 0;
	public bfsSteps1 = 0;

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
	private static readonly EMPTY_LIGHT_ARRAY =
		typeof SharedArrayBuffer !== "undefined"
			? new Uint8Array(new SharedArrayBuffer(0))
			: new Uint8Array(0);

	// PERF: fixed Array[7] (lod 0..6) instead of Map — saves ~2KiB Map bucket
	// + buckets per chunk (600×2KiB=1.2MiB) and avoids BigInt-like hashing.
	// 0..5 = MAX_CHUNK_LOD (ChunkLodRules.ts), 6 = DISTANT_LOD_LEVEL.
	private static readonly MAX_CACHED_LOD = 6;
	private static readonly LOD_CACHE_SIZE = Chunk.MAX_CACHED_LOD + 1;
	private _cachedLODMeshes: (CachedLODMesh | null)[] | null = null;

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
		registerChunk(this);
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
		} else {
			this._paletteOpacity = null;
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
		// PERF: self-only remesh on load. Neighbors schedule their own remesh
		// when they load; fan-out here caused 7x greedy rebuilds per streamed
		// chunk during load storms. Border faces resolve when the neighbor's
		// own remesh pulls border slabs lazily.
		if (scheduleRemesh) this.scheduleRemesh(true, false);
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

		if (!(light.buffer instanceof SharedArrayBuffer)) {
			const sharedLight = makeSharedUint8(light.length);
			sharedLight.set(light);
			this.light_array = sharedLight;
		}

		const block = this._block_array;

		if (block !== null && !(block.buffer instanceof SharedArrayBuffer)) {
			if (block instanceof Uint16Array) {
				const sharedBlock = makeSharedUint16(block.length);
				sharedBlock.set(block);
				this._block_array = sharedBlock;
			} else {
				const sharedBlock = makeSharedUint8(block.length);
				sharedBlock.set(block);
				this._block_array = sharedBlock;
			}
		}

		const palette = this._palette;

		if (palette !== null && !(palette.buffer instanceof SharedArrayBuffer)) {
			const sharedPalette = makeSharedUint16(palette.length);
			sharedPalette.set(palette);
			this._palette = sharedPalette;
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
		if (lod < 0 || lod > Chunk.MAX_CACHED_LOD) return null;
		return this._cachedLODMeshes?.[lod] ?? null;
	}
	public hasCachedLODMesh(lod: number): boolean {
		if (lod < 0 || lod > Chunk.MAX_CACHED_LOD) return false;
		const c = this._cachedLODMeshes?.[lod];
		return !!c && (!!c.opaque || !!c.water || !!c.cutout);
	}
	public setCachedLODMesh(lod: number, mesh: CachedLODMesh): void {
		this.setCachedLODMeshParts(lod, mesh.opaque, mesh.water, mesh.cutout);
	}

	private getOrCreateLODCache(): (CachedLODMesh | null)[] {
		let cache = this._cachedLODMeshes;
		if (cache !== null) return cache;
		cache = new Array<CachedLODMesh | null>(Chunk.LOD_CACHE_SIZE);
		for (let i = 0; i < cache.length; i++) cache[i] = null;
		this._cachedLODMeshes = cache;
		return cache;
	}

	private setCachedLODMeshParts(
		lod: number,
		opaque: MeshData | null,
		water: MeshData | null,
		cutout: MeshData | null,
	): void {
		if (lod < 0 || lod > Chunk.MAX_CACHED_LOD) return;
		const cache = this.getOrCreateLODCache();
		const existing = cache[lod];
		if (existing !== null) {
			existing.opaque = opaque;
			existing.water = water;
			existing.cutout = cutout;
		} else {
			cache[lod] = { opaque, water, cutout };
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
		if (!cache) return;
		// Count live entries — skip if ≤3 to avoid scanning.
		let live = 0;
		for (let i = 0; i < cache.length; i++) if (cache[i] !== null) live++;
		if (live <= 3) return;
		const cur = this.lodLevel ?? 0;
		const keepLo = Math.min(cur, justStoredLod) - 1;
		const keepHi = Math.max(cur, justStoredLod) + 1;
		for (let lod = 0; lod < cache.length; lod++) {
			if ((lod < keepLo || lod > keepHi) && cache[lod] !== null) {
				cache[lod] = null;
			}
		}
	}
	public clearCachedLODMeshes(): void {
		if (this._cachedLODMeshes === null) return;
		this._cachedLODMeshes = null;
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
		let total = 0;
		let withVoxels = 0;
		let lodLow = 0;
		let lodMid = 0;
		let lodHigh = 0;
		let cachedMeshEntries = 0;
		let cachedMeshBytes = 0;

		for (const chunk of Chunk.loadedChunks) {
			total++;

			if (chunk._hasVoxelData) {
				withVoxels++;
			}

			const lod = chunk.lodLevel;

			if (lod <= 1) {
				lodLow++;
			} else if (lod <= 3) {
				lodMid++;
			} else {
				lodHigh++;
			}

			const cache = chunk._cachedLODMeshes;

			if (cache === null) {
				continue;
			}

			for (let lod = 0; lod < cache.length; lod++) {
				const entry = cache[lod];
				if (entry === null) continue;
				cachedMeshEntries++;
				// The previous [opaque, water, cutout] expression allocated
				// one temporary JavaScript array for every cached LOD entry.
				const opaque = entry.opaque;
				if (opaque !== null) {
					cachedMeshBytes += opaque.faceData.byteLength;
				}

				const water = entry.water;
				if (water !== null) {
					cachedMeshBytes += water.faceData.byteLength;
				}

				const cutout = entry.cutout;
				if (cutout !== null) {
					cachedMeshBytes += cutout.faceData.byteLength;
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

	public getSerializableLODMeshCache(): SerializedLODMeshCache | undefined {
		const cache = this._cachedLODMeshes;

		if (cache === null) {
			return undefined;
		}

		let empty = true;
		for (let lod = 0; lod < cache.length; lod++) {
			if (cache[lod] !== null) {
				empty = false;
				break;
			}
		}
		if (empty) return undefined;

		const output: SerializedLODMeshCache = {};
		let hasEntries = false;

		for (let lod = 0; lod < cache.length; lod++) {
			const mesh = cache[lod];
			if (mesh === null) continue;
			if (mesh.opaque === null && mesh.water === null && mesh.cutout === null) {
				continue;
			}

			output[lod] = {
				opaque: mesh.opaque,
				water: mesh.water,
				cutout: mesh.cutout,
			};

			hasEntries = true;
		}

		return hasEntries ? output : undefined;
	}

	public restoreLODMeshCache(serialized?: SerializedLODMeshCache): void {
		this._cachedLODMeshes = null;
		if (serialized === undefined) return;

		for (const key in serialized) {
			if (!Object.hasOwn(serialized, key)) continue;

			const lod = Number(key);
			if (!Number.isInteger(lod) || lod < 0 || lod > Chunk.MAX_CACHED_LOD) {
				continue;
			}

			const entry = serialized[lod];
			if (entry === undefined) continue;

			const opaque = entry.opaque ?? null;
			const water = entry.water ?? null;
			const cutout = entry.cutout ?? null;
			if (opaque === null && water === null && cutout === null) continue;

			this.setCachedLODMeshParts(lod, opaque, water, cutout);
		}
	}

	// =========================================================================
	// Sunlight initialisation
	// =========================================================================

	public initializeSunlight(): void {
		const aboveChunk = this.getNeighbor(0, 1, 0);
		if (this.light_array.length !== Chunk.SIZE3) {
			this.light_array =
				typeof SharedArrayBuffer !== "undefined"
					? new Uint8Array(new SharedArrayBuffer(Chunk.SIZE3))
					: new Uint8Array(Chunk.SIZE3);
		}
		this.updateLightView();

		const light = this.light_array;
		const wordCount = light.length >>> 2;
		const light32 = this._la32;
		if (light32 !== null) {
			for (let i = 0; i < wordCount; i++) light32[i] &= 0x0f0f0f0f;
			for (let i = wordCount << 2; i < light.length; i++) {
				light[i] &= Chunk.BLOCK_LIGHT_MASK;
			}
		} else {
			for (let i = 0; i < light.length; i++) {
				light[i] &= Chunk.BLOCK_LIGHT_MASK;
			}
		}

		const seedLength = seedSunlight(
			this,
			aboveChunk,
			light,
			this._block_array,
			this._palette,
			this._isUniform,
			this._uniformBlockId,
			this.isLoaded,
		);
		const pool = Chunk._lightPool;
		if (seedLength > 0 && pool !== null) {
			pool.enqueueDeferredLightFromSunlightInit?.(
				this,
				copySunlightSeeds(seedLength),
				seedLength,
			);
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
		return this._block_array![index];
	}

	/**
	 * Precompute opacity for each palette entry.
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

		let oldPacked: number;
		let storageLayoutChanged = false;
		let paletteChanged = false;

		if (this._isUniform) {
			oldPacked = this._uniformBlockId;

			if (oldPacked === packedBlock) {
				return;
			}

			this._isUniform = false;
			this._hasVoxelData = true;

			// Avoid makeSharedUint16([oldPacked, packedBlock]), which creates
			// a temporary JavaScript array on every uniform-to-palette change.
			const palette = makeSharedUint16(2);
			palette[0] = oldPacked;
			palette[1] = packedBlock;

			this._palette = palette;
			this._block_array = makeSharedUint8(Chunk.SIZE3 >>> 1);
			this.setNibble(index, 1);

			storageLayoutChanged = true;
			paletteChanged = true;
		} else {
			const palette = this._palette;

			if (palette !== null) {
				const paletteIndex = this.getNibble(index);
				oldPacked = palette[paletteIndex];

				if (oldPacked === packedBlock) {
					return;
				}

				let newPaletteIndex = -1;

				for (let i = 0; i < palette.length; i++) {
					if (palette[i] === packedBlock) {
						newPaletteIndex = i;
						break;
					}
				}

				if (newPaletteIndex >= 0) {
					this.setNibble(index, newPaletteIndex);
				} else if (palette.length < 16) {
					newPaletteIndex = palette.length;

					const expandedPalette = makeSharedUint16(newPaletteIndex + 1);

					expandedPalette.set(palette);
					expandedPalette[newPaletteIndex] = packedBlock;

					this._palette = expandedPalette;
					this.setNibble(index, newPaletteIndex);
					paletteChanged = true;
				} else {
					// Palette is full. Expand directly to dense packed values.
					const dense = makeSharedUint16(Chunk.SIZE3);
					const nibbleStorage = this._block_array as Uint8Array;

					for (let i = 0; i < Chunk.SIZE3; i++) {
						const byte = nibbleStorage[i >>> 1];
						const nibble = (i & 1) === 0 ? byte & 0x0f : byte >>> 4;

						dense[i] = palette[nibble];
					}

					dense[index] = packedBlock;
					this._block_array = dense;
					this._palette = null;
					this._paletteOpacity = null;
					storageLayoutChanged = true;
				}
			} else {
				let blockArray = this._block_array!;

				if (packedBlock > 0xff && blockArray instanceof Uint8Array) {
					const dense = makeSharedUint16(Chunk.SIZE3);
					dense.set(blockArray);

					blockArray = dense;
					this._block_array = dense;
					storageLayoutChanged = true;
				}

				oldPacked = blockArray[index];

				if (oldPacked === packedBlock) {
					return;
				}

				blockArray[index] = packedBlock;
			}
		}

		if (paletteChanged) {
			this._rebuildPaletteOpacity();
		}

		if (storageLayoutChanged) {
			this.writeLightHeaderRow();
		}

		if (storageLayoutChanged || paletteChanged) {
			Chunk.onLightChunkLayoutChanged?.(this);
		}

		recordLightMutation(
			this,
			Chunk._lightPool,
			localX,
			localY,
			localZ,
			oldPacked,
			packedBlock,
		);

		this.isModified = true;
		this.persistenceRevision++;
		this.connectivityDirty = true;
		this.blockRevision++;

		markChunkDirtyForRemesh(this);
		Chunk.onBlockModified?.(this);

		const last = Chunk.SM1;
		const neighbors = this.neighborRefs;

		if (localX === 0) markChunkDirtyForRemesh(neighbors[1]);
		else if (localX === last) markChunkDirtyForRemesh(neighbors[0]);

		if (localY === 0) markChunkDirtyForRemesh(neighbors[3]);
		else if (localY === last) markChunkDirtyForRemesh(neighbors[2]);

		if (localZ === 0) markChunkDirtyForRemesh(neighbors[5]);
		else if (localZ === last) markChunkDirtyForRemesh(neighbors[4]);
	}

	/**
	 * Set by ChunkWorkerPool.getInstance() once the pool is alive.
	 * Resolved lazily inside dispatchLightMutate so importing order
	 * doesn't matter.
	 */
	public static _lightPool:
		| (ChunkLightPool & {
				postLightAddEmission(request: any): void;
				enqueueDeferredLightFromSunlightInit?(
					chunk: Chunk,
					queue: Uint16Array,
					length: number,
				): void;
		  })
		| null = null;

	public deleteBlock(localX: number, localY: number, localZ: number): void {
		this.setBlock(localX, localY, localZ, 0);
	}

	// =========================================================================
	// Remesh scheduling
	// =========================================================================

	public scheduleRemesh(priority = false, includeNeighbors = false): void {
		if (!this.isLoaded) {
			return;
		}

		this.isDirty = true;

		if (includeNeighbors) {
			const refs = this.neighborRefs;

			refs[0]?.scheduleRemesh(priority);
			refs[1]?.scheduleRemesh(priority);
			refs[2]?.scheduleRemesh(priority);
			refs[3]?.scheduleRemesh(priority);
			refs[4]?.scheduleRemesh(priority);
			refs[5]?.scheduleRemesh(priority);
		}

		if (this.remeshQueued) {
			return;
		}

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

		let nbr = getChunkFast(this.chunkX + 1, this.chunkY, this.chunkZ);
		if (nbr) {
			refs[0] = nbr;
			nbr.neighborRefs[1] = this;
		}
		nbr = getChunkFast(this.chunkX - 1, this.chunkY, this.chunkZ);
		if (nbr) {
			refs[1] = nbr;
			nbr.neighborRefs[0] = this;
		}
		nbr = getChunkFast(this.chunkX, this.chunkY + 1, this.chunkZ);
		if (nbr) {
			refs[2] = nbr;
			nbr.neighborRefs[3] = this;
		}
		nbr = getChunkFast(this.chunkX, this.chunkY - 1, this.chunkZ);
		if (nbr) {
			refs[3] = nbr;
			nbr.neighborRefs[2] = this;
		}
		nbr = getChunkFast(this.chunkX, this.chunkY, this.chunkZ + 1);
		if (nbr) {
			refs[4] = nbr;
			nbr.neighborRefs[5] = this;
		}
		nbr = getChunkFast(this.chunkX, this.chunkY, this.chunkZ - 1);
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
			// Water is transparent: BFS must flood through open water exactly
			// like air. (Mixed water already traverses via the flood-fill
			// below; this just removes the uniform-vs-mixed inconsistency
			// that collapsed reachability — and hid the ocean floor — as soon
			// as the camera sat inside a uniform-water chunk while diving.)
			const mask =
				this._isUniform &&
				(this._uniformBlockId === 0 || this._uniformBlockId === WATER_BLOCK_ID)
					? connectFacesMask(0x3f)
					: 0;

			this.faceConnectivity = mask;
			this.connectivityDirty = false;
			return mask;
		}

		const connectivity = computeStoredFaceConnectivity(
			this._block_array!,
			this._paletteOpacity,
		);
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
		const light = this.light_array;
		const wordLength = light.length >>> 2;
		if (wordLength === 0 || (light.byteOffset & 3) !== 0) {
			this._la32 = null;
			return;
		}

		const current = this._la32;
		if (
			current !== null &&
			current.buffer === light.buffer &&
			current.byteOffset === light.byteOffset &&
			current.length === wordLength
		) {
			return;
		}

		this._la32 = new Uint32Array(light.buffer, light.byteOffset, wordLength);
	}

	// =========================================================================
	// Dispose
	// =========================================================================

	public dispose(): void {
		discardChunkEditState(this);
		invalidateFastChunkCache(this);

		const refs = this.neighborRefs;

		for (let direction = 0; direction < 6; direction++) {
			const neighbor = refs[direction];

			if (neighbor !== null) {
				neighbor.neighborRefs[direction ^ 1] = null;
				refs[direction] = null;
			}
		}

		const wasMerged = this.mergedGroupKey !== null;

		if (wasMerged) {
			removeChunkFromGroup(this);
		} else {
			deferChunkMeshes(
				Map1.mainScene,
				this.mesh,
				this.waterMesh,
				this.cutoutMesh,
			);
		}

		this.mesh = null;
		this.waterMesh = null;
		this.cutoutMesh = null;

		this.opaqueMeshData = null;
		this.waterMeshData = null;
		this.cutoutMeshData = null;

		this._block_array = null;
		this._palette = null;
		this._paletteOpacity = null;

		this._isUniform = true;
		this._uniformBlockId = 0;
		this._hasVoxelData = false;

		this.light_array = Chunk.EMPTY_LIGHT_ARRAY;
		this._la32 = null;
		this._isDarkCached = false;

		this._cachedLODMeshes = null;

		this._storageSnapshot = null;

		this.isLoaded = false;

		const view = Chunk.lightHeaderView;
		const slot = this.lightHeaderSlot;

		if (slot !== 0xffff_ffff) {
			if (view !== null) clearHeaderRow(view, slot);
			Chunk._lightHeaderFreeSlots.push(slot);
		}

		Chunk.onLightChunkDisposed?.(this);
		if (slot !== 0xffff_ffff) {
			this.lightHeaderSlot = 0xffff_ffff;
		}

		Chunk.loadedChunks.delete(this);
		Chunk.loadedChunkIndex.unregister(this);
		unregisterChunk(this);

		this.isTerrainScheduled = false;
		this.remeshQueued = false;
		this.rerunRemeshAfterInflight = false;

		this.bfsQueryId = 0;
		this.bfsVisitedFaces = 0;
		this.bfsSteps0 = 0;
		this.bfsSteps1 = 0;
		this.bfsQueuedForConnectivity = false;

		runChunkDisposeHooks(this);
		releasePooledChunk(this);
	}
}

// Resolve a loaded/constructed chunk by chunk coordinates.  Delegates to
// getChunkFast's 8-slot MRU cache — avoids BigInt alloc on hot hits (AABB
// sweeps, raycasts). Single registry (chunkInstances) remains the source of
// truth; neighborRefs is the primary hot-path bypass.
export function getChunk(
	cx: number,
	cy: number,
	cz: number,
): Chunk | undefined {
	return getChunkFast(cx, cy, cz);
}
