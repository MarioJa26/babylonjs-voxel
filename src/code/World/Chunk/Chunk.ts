import { disposeMeshGpu, type Mesh, removeFromScene } from "@babylonjs/lite";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { getFinalTerrainHeight } from "@/code/Generation/TerrainHeightMap";
import { LIGHT_NIBBLE_MASK, SKY_LIGHT_SHIFT } from "@/code/Lib/VoxelMath";
import { Map1 } from "@/code/Maps/Map1";
import {
	FACE_ALL,
	FACE_NX,
	FACE_NY,
	FACE_NZ,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
	FALLBACK_CUBE,
	getCubeShapeIndex,
	getShapeByBlockId,
	getShapeDefinitions,
} from "../Shape/BlockShapes";
import { getSliceAxis, transformBox } from "../Shape/BlockShapeTransforms";
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
	transparent: MeshData | null;
};
type SerializedLODMeshCache = Record<
	number,
	{ opaque?: MeshData | null; transparent?: MeshData | null }
>;

// ---------------------------------------------------------------------------
// Face-rect scratch buffers (used by getClosedFaceMaskForPacked).
// ---------------------------------------------------------------------------
const MAX_RECTS = 64;
const RECT_STRIDE = 4;
const _rectBufs = Array.from(
	{ length: 6 },
	() => new Float32Array(MAX_RECTS * RECT_STRIDE),
);
const _rectCounts = new Int32Array(6);
const _edgeScratch = new Float64Array((MAX_RECTS * 2 + 4) * 2);
const _twoEntryPalette = new Uint16Array(2);

const _sliceMin: [number, number, number] = [0, 0, 0];
const _sliceMax: [number, number, number] = [0, 0, 0];
const _sliceResult = { min: _sliceMin, max: _sliceMax };

const _ccVisited = new Uint8Array(GenerationParams.CHUNK_SIZE ** 3);
const _ccStack = new Int32Array(GenerationParams.CHUNK_SIZE ** 3);
const _ccOpaque = new Uint8Array(GenerationParams.CHUNK_SIZE ** 3);
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
	// PERF: neighbor ids are computed lazily (and cached) on first access
	// rather than eagerly in the constructor — the 6 BigInt packCoords calls
	// were a major cost on the chunk-creation hot path (the 1ms streaming
	// spike) even though neighbors aren't needed until culling/meshing.
	private _neighborIds: bigint[] | null = null;

	public lodLevel = 0;

	public static readonly SIZE = GenerationParams.CHUNK_SIZE;
	public static readonly SIZE2 = Chunk.SIZE * Chunk.SIZE;
	public static readonly SIZE3 = Chunk.SIZE * Chunk.SIZE * Chunk.SIZE;
	public static readonly chunkInstances = new Map<bigint, Chunk>();
	// PERF: coordinate-indexed lookup that avoids the BigInt packCoords()
	// allocation on the hot getChunk path. The public `chunkInstances`
	// (BigInt-keyed) map is retained for id-based external lookups; this nested
	// Number-keyed map mirrors it for coordinate-based lookups (chunk
	// coordinates are <= 2^21, exact as Number keys). Kept in sync at set/delete.
	// Internal (not `private` so the module-level getChunk/helpers can access it).
	static _chunkByCoords = new Map<number, Map<number, Map<number, Chunk>>>();
	public static readonly loadedChunks = new Set<Chunk>();
	public static readonly loadedChunkIndex = new LoadedChunkIndex();

	public isModified = false;
	public isBoatChunk = false;
	public isDirty = false;
	public isLoaded = false;
	public isTerrainScheduled = false;
	public isLightDirty = false;
	public remeshQueued = false;
	/** Monotonically increases whenever a new mesh is requested for this chunk. */
	public meshRevision = 0;

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
	private _paletteIndexMap: Map<number, number> | null = null;
	private _hasVoxelData = false;

	public chunkY: number;
	public chunkX: number;
	public chunkZ: number;

	public mesh: Mesh | null = null;
	public transparentMesh: Mesh | null = null;
	public opaqueMeshData: MeshData | null = null;
	public transparentMeshData: MeshData | null = null;

	// Merged mesh group key (e.g., "gx_gy_gz_lod"). null if not merged.
	public mergedGroupKey: string | null = null;

	// --- Face connectivity for occlusion BFS ---
	public faceConnectivity = 0;
	public connectivityDirty = true;

	// PERF: Cached "is chunk dark" flag.
	_isDarkCached: boolean | undefined = undefined;

	// PERF: Pre-allocated per-face BFS step counts — avoids new Uint8Array(6) in hot BFS loop.
	public _fSteps: Uint8Array = new Uint8Array(6);

	light_array: Uint8Array;

	/**
	 * Snapshot of the worker-visible block/palette storage.  Used by
	 * ChunkWorkerPool to broadcast new SharedArrayBuffer handles after a
	 * storage layout transition (uniform->palette, palette->u16, ...).
	 * Centralised here so the pool never touches private fields directly.
	 */
	public getLightStorageSnapshot(): {
		lightSAB: SharedArrayBuffer | null;
		blockSAB: SharedArrayBuffer | null;
		paletteSAB: SharedArrayBuffer | null;
		blockStorageBytesPerElement: 1 | 2;
	} {
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
		return {
			lightSAB: lightBuffer instanceof SharedArrayBuffer ? lightBuffer : null,
			blockSAB: blockBuffer instanceof SharedArrayBuffer ? blockBuffer : null,
			paletteSAB:
				paletteBuffer instanceof SharedArrayBuffer ? paletteBuffer : null,
			blockStorageBytesPerElement:
				this._block_array instanceof Uint16Array ? 2 : 1,
		};
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
	 * Populated lazily by the OcclusionCuller on first BFS traversal and
	 * nulled eagerly in dispose() so there are no dangling references.
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
	private static readonly GLASS_01_BLOCK_ID = 60;
	private static readonly GLASS_02_BLOCK_ID = 61;
	private static readonly EPS = 1e-6;

	// Single closed-face-mask cache.  Masks are ≤ FACE_ALL (63) so a byte
	// array suffices; 255 is the uncomputed sentinel.  This same LUT is also
	// shipped to the light worker (precomputeClosedFaceMasks), eliminating the
	// previous duplicate Int16Array + separate Uint8Array computation paths.
	private static readonly CLOSED_FACE_MASK_CACHE = (() => {
		const cache = new Uint8Array(1 << 16);
		cache.fill(255);
		return cache;
	})();

	private static readonly EMPTY_LIGHT_ARRAY =
		typeof SharedArrayBuffer !== "undefined"
			? new Uint8Array(new SharedArrayBuffer(0))
			: new Uint8Array(0);

	public cachedLODMeshes = new Map<number, CachedLODMesh>();

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
		this.lightHeaderSlot = Chunk.allocLightHeaderSlot();
		this._isDarkCached = false;
		Chunk.chunkInstances.set(this.id, this);
		_setByCoords(this);
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
			this._paletteIndexMap = null;
		} else if (palette && blocks instanceof Uint8Array) {
			this._isUniform = false;
			this._uniformBlockId = 0;
			this._palette = palette;
			this._paletteIndexMap = null;
			this._block_array = blocks;
		} else if (blocks) {
			this._isUniform = false;
			this._uniformBlockId = 0;
			this._palette = null;
			this._paletteIndexMap = null;
			this._block_array = blocks;
		} else {
			this._isUniform = true;
			this._uniformBlockId = 0;
			this._block_array = null;
			this._palette = null;
			this._paletteIndexMap = null;
		}

		if (light_array) {
			this.light_array = light_array;
		} else {
			this.initializeSunlight();
		}
		this.recomputeDarkCache();

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
			new Uint8Array(sab).set(
				new Uint8Array(block.buffer, block.byteOffset, len),
			);
			this._block_array =
				block instanceof Uint16Array
					? new Uint16Array(sab)
					: new Uint8Array(sab);
		}

		const palette = this._palette;
		if (palette && !(palette.buffer instanceof SharedArrayBuffer)) {
			const byteLen = palette.byteLength;
			const sab = new SharedArrayBuffer(byteLen);
			new Uint8Array(sab).set(
				new Uint8Array(palette.buffer, palette.byteOffset, byteLen),
			);
			this._palette = new Uint16Array(sab, 0, palette.length);
		}
	}

	public loadLodOnlyFromStorage(scheduleRemesh = false): void {
		this._hasVoxelData = false;
		this._isUniform = true;
		this._uniformBlockId = 0;
		this._block_array = null;
		this._palette = null;
		this._paletteIndexMap = null;
		this.light_array = Chunk.EMPTY_LIGHT_ARRAY;
		this._isDarkCached = false;
		this.isLoaded = true;
		Chunk.loadedChunks.add(this);
		Chunk.loadedChunkIndex.register(this);
		this.isTerrainScheduled = false;
		if (scheduleRemesh) this.scheduleRemesh();
	}

	// =========================================================================
	// LOD mesh cache
	// =========================================================================

	public getCachedLODMesh(lod: number): CachedLODMesh | null {
		return this.cachedLODMeshes.get(lod) ?? null;
	}
	public hasCachedLODMesh(lod: number): boolean {
		const c = this.cachedLODMeshes.get(lod);
		return !!c && (!!c.opaque || !!c.transparent);
	}
	public setCachedLODMesh(lod: number, mesh: CachedLODMesh): void {
		this.cachedLODMeshes.set(lod, {
			opaque: mesh.opaque ?? null,
			transparent: mesh.transparent ?? null,
		});
	}
	public clearCachedLODMeshes(): void {
		this.cachedLODMeshes.clear();
	}
	public getSerializableLODMeshCache(): SerializedLODMeshCache | undefined {
		if (this.cachedLODMeshes.size === 0) return undefined;
		const out: SerializedLODMeshCache = {};
		let count = 0;
		for (const [lod, mesh] of this.cachedLODMeshes.entries()) {
			if (!mesh.opaque && !mesh.transparent) continue;
			out[lod] = {
				opaque: mesh.opaque ?? null,
				transparent: mesh.transparent ?? null,
			};
			count++;
		}
		return count === 0 ? undefined : out;
	}
	public restoreLODMeshCache(cache?: SerializedLODMeshCache): void {
		this.cachedLODMeshes.clear();
		if (!cache) return;
		for (const key in cache) {
			const lod = Number(key);
			if (!Number.isFinite(lod)) continue;
			const entry = cache[lod];
			if (!entry?.opaque && !entry?.transparent) continue;
			this.cachedLODMeshes.set(lod, {
				opaque: entry?.opaque ?? null,
				transparent: entry?.transparent ?? null,
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

		const la = this.light_array;
		for (let i = 0; i < Chunk.SIZE3; i++) la[i] &= blockMask;

		const chunkBaseX = this.chunkX * size;
		const chunkBaseZ = this.chunkZ * size;
		const hasLoadedAbove = !!aboveChunk?.isLoaded;

		// Reuse the module-level scratch seed queue.  The function is
		// synchronous and never re-enters, so sharing is safe.  At the
		// hand-off we .slice() to give the pool an array it can safely
		// own/transfer — passing the raw scratch would detach it if
		// postMessage uses a transfer list, and would be overwritten if
		// a second chunk loads before the deferred-light pump fires.
		const seedCapacity = _sunlightSeedQueue.length;
		const seedQueue = _sunlightSeedQueue;
		let seedLength = 0;

		for (let x = 0; x < size; x++) {
			const worldX = chunkBaseX + x;
			for (let z = 0; z < size; z++) {
				const worldZ = chunkBaseZ + z;
				let incomingSkyLight = 0;
				let sourceFiltersFullSun = false;

				if (hasLoadedAbove) {
					const aboveBlockPacked = aboveChunk.getBlockPacked(x, 0, z);
					if (aboveChunk.isTransparent(aboveBlockPacked, 1, -1)) {
						incomingSkyLight = aboveChunk.getSkyLight(x, 0, z);
						sourceFiltersFullSun = filtersFullSunlight(
							unpackBlockId(aboveBlockPacked),
						);
					}
				} else {
					const terrainHeight = getFinalTerrainHeight(worldX, worldZ);
					if (
						topWorldY >= Chunk.SKYLIGHT_GENERATION_MIN_WORLD_Y &&
						topWorldY >= terrainHeight - 48
					) {
						incomingSkyLight = 15;
					}
				}

				for (let y = size - 1; y >= 0; y--) {
					const worldY = this.chunkY * size + y;
					if (
						!hasLoadedAbove &&
						worldY < Chunk.SKYLIGHT_GENERATION_MIN_WORLD_Y
					) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = false;
						continue;
					}

					const blockPacked = this.getBlockPacked(x, y, z);
					if (!this.isTransparent(blockPacked, 1, 1)) {
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
					const cellSkyLight = preservesFullSun
						? 15
						: Math.max(incomingSkyLight - 1, 0);

					if (cellSkyLight === 0) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = thisFiltersFullSun;
						continue;
					}

					const idx = x + y * size + z * size2;
					la[idx] = (la[idx] & blockMask) | (cellSkyLight << skyShift);

					if (!thisFiltersFullSun && seedLength < seedCapacity) {
						seedQueue[seedLength++] = (x << 10) | (y << 5) | z;
					}

					if (!this.isTransparent(blockPacked, 1, -1)) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = thisFiltersFullSun;
						continue;
					}
					incomingSkyLight = cellSkyLight;
					sourceFiltersFullSun = thisFiltersFullSun;
				}
			}
		}

		// Hand the seed queue off to the worker pool's deferred-light pump
		// which forwards it to a worker thread for the BFS pass.
		if (seedLength > 0) {
			const pool = Chunk._lightPool;
			if (pool) {
				pool.enqueueDeferredLightFromSunlightInit?.(
					this,
					seedQueue.slice(0, seedLength),
					seedLength,
				);
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
			this._isDarkCached = undefined;
		}
	}

	public recomputeDarkCache(): void {
		const la = this.light_array;
		if (!la || la.length === 0) {
			this._isDarkCached = false;
			return;
		}
		for (let i = 0; i < la.length; i++) {
			if ((la[i]! & 0xf0) !== 0) {
				this._isDarkCached = false;
				return;
			}
		}
		this._isDarkCached = true;
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
		if (this._palette) {
			const blockArr = this._block_array as Uint8Array;
			const byte = blockArr[i >>> 1];
			const nibble = (i & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;
			const packed = this._palette[nibble];
			return packed !== 0 && BLOCK_TYPE[unpackBlockId(packed)] === 0 ? 1 : 0;
		}
		if (this._block_array) {
			const packed = this._block_array[i];
			return packed !== 0 && BLOCK_TYPE[unpackBlockId(packed)] === 0 ? 1 : 0;
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
			this._palette = new Uint16Array([this._uniformBlockId]);
			this._paletteIndexMap = null;
			let newIndex = 0;
			if (this._palette[0] !== packedBlock) {
				_twoEntryPalette[0] = this._palette[0];
				_twoEntryPalette[1] = packedBlock;
				this._palette = new Uint16Array(_twoEntryPalette);
				this._paletteIndexMap = null;
				newIndex = 1;
			}
			this._block_array = new Uint8Array(
				new SharedArrayBuffer(Chunk.SIZE3 / 2),
			);
			this._block_array.fill(0);
			this.setNibble(index, newIndex);
			storageLayoutChanged = true;
			paletteChanged = true;
		} else if (this._palette) {
			const paletteIndex = this.getNibble(index);
			oldPacked = this._palette[paletteIndex];
			if (oldPacked === packedBlock) return;

			let pm = this._paletteIndexMap;
			if (!pm) {
				pm = new Map();
				for (let i = 0; i < this._palette.length; i++) {
					pm.set(this._palette[i], i);
				}
				this._paletteIndexMap = pm;
			}
			let npi = pm.get(packedBlock);
			if (npi === undefined) {
				if (this._palette.length < 16) {
					npi = this._palette.length;
					const ep = new Uint16Array(npi + 1);
					ep.set(this._palette);
					ep[npi] = packedBlock;
					this._palette = ep;
					pm.set(packedBlock, npi);
					this.setNibble(index, npi);
					paletteChanged = true;
				} else {
					const na = new Uint16Array(new SharedArrayBuffer(Chunk.SIZE3 * 2));
					for (let i = 0; i < Chunk.SIZE3; i++)
						na[i] = this._palette[this.getNibble(i)];
					na[index] = packedBlock;
					this._block_array = na;
					this._palette = null;
					this._paletteIndexMap = null;
					storageLayoutChanged = true;
				}
			} else {
				this.setNibble(index, npi);
			}
		} else {
			if (packedBlock > 255 && this._block_array instanceof Uint8Array) {
				const na = new Uint16Array(new SharedArrayBuffer(Chunk.SIZE3 * 2));
				na.set(this._block_array);
				this._block_array = na;
				storageLayoutChanged = true;
			}
			oldPacked = this._block_array![index];
			if (oldPacked === packedBlock) return;
			this._block_array![index] = packedBlock;
		}

		// Ensure any newly created palette is backed by SharedArrayBuffer so
		// the light worker can read block IDs through its view.
		if (paletteChanged && this._palette) {
			const buf = this._palette.buffer;
			if (!(buf instanceof SharedArrayBuffer)) {
				const sab = new SharedArrayBuffer(this._palette.byteLength);
				new Uint8Array(sab).set(
					new Uint8Array(
						buf,
						this._palette.byteOffset,
						this._palette.byteLength,
					),
				);
				this._palette = new Uint16Array(sab, 0, this._palette.length);
			}
		}

		// Block storage layout changed — refresh the worker-visible header
		// row BEFORE the light BFS dispatches, so any in-flight BFS picks
		// up the new layout on its next cell access.
		if (storageLayoutChanged) {
			this.writeLightHeaderRow();
		}
		// Broadcast updated buffer references to the light worker whenever
		// the palette changed (even without a layout change), so the worker
		// can resolve nibble indices to block IDs.
		if (storageLayoutChanged || paletteChanged) {
			Chunk.onLightChunkLayoutChanged?.(this);
		}

		this.dispatchLightMutate(localX, localY, localZ, oldPacked, packedBlock);

		this.isModified = true;
		this.connectivityDirty = true;
		this.clearCachedLODMeshes();
		this.scheduleRemesh(true);
		Chunk.onBlockModified?.(this);

		const S = Chunk.SIZE;
		if (localX === 0) this.getNeighbor(-1, 0, 0)?.scheduleRemesh(true);
		else if (localX === S - 1) this.getNeighbor(1, 0, 0)?.scheduleRemesh(true);
		if (localY === 0) this.getNeighbor(0, -1, 0)?.scheduleRemesh(true);
		else if (localY === S - 1) this.getNeighbor(0, 1, 0)?.scheduleRemesh(true);
		if (localZ === 0) this.getNeighbor(0, 0, -1)?.scheduleRemesh(true);
		else if (localZ === S - 1) this.getNeighbor(0, 0, 1)?.scheduleRemesh(true);
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
		this.meshRevision++;
		this.isDirty = true;
		if (this.remeshQueued) {
			return;
		}
		this.remeshQueued = true;

		if (includeNeighbors) {
			this.getNeighbor(-1, 0, 0)?.scheduleRemesh(priority);
			this.getNeighbor(1, 0, 0)?.scheduleRemesh(priority);
			this.getNeighbor(0, -1, 0)?.scheduleRemesh(priority);
			this.getNeighbor(0, 1, 0)?.scheduleRemesh(priority);
			this.getNeighbor(0, 0, -1)?.scheduleRemesh(priority);
			this.getNeighbor(0, 0, 1)?.scheduleRemesh(priority);
		}

		Chunk.onRequestRemesh?.(this, priority);
	}

	// =========================================================================
	// Neighbour / coordinate helpers
	// =========================================================================

	public getNeighbor(dx: number, dy: number, dz: number): Chunk | undefined {
		return getChunk(this.chunkX + dx, this.chunkY + dy, this.chunkZ + dz);
	}

	// PERF: lazily build + cache the neighbor id list. Neighbor ids are derived
	// from this.id via BigInt bit-ops (no Number->BigInt conversions or bias
	// recompute), and only on first access — keeping the constructor free of
	// the 6 packCoords calls that used to fire on every new chunk.
	public get neighborIds(): readonly bigint[] {
		if (this._neighborIds) return this._neighborIds;
		const AXIS_BITS = 21n;
		const MASK = (1n << AXIS_BITS) - 1n;
		const derive = (axis: 0 | 1 | 2, sign: 1n | -1n): bigint => {
			const shift = BigInt(axis) * AXIS_BITS;
			const comp = (this.id >> shift) & MASK;
			const nb = (comp + sign + (1n << AXIS_BITS)) & MASK;
			return (this.id & ~(MASK << shift)) | (nb << shift);
		};
		this._neighborIds = [
			derive(0, 1n),
			derive(0, -1n),
			derive(1, 1n),
			derive(1, -1n),
			derive(2, 1n),
			derive(2, -1n),
		];
		return this._neighborIds;
	}

	public markLightChanged(): void {
		this.isLightDirty = true;
	}
	public needsPersistence(): boolean {
		return this.isModified || this.isLightDirty;
	}

	// =========================================================================
	// Face-mask geometry
	// =========================================================================

	private static getClosedFaceMaskForPacked(blockPacked: number): number {
		const cacheIndex = blockPacked & 0xffff;
		const cached = Chunk.CLOSED_FACE_MASK_CACHE[cacheIndex];
		if (cached !== 255) return cached;

		const blockId = unpackBlockId(blockPacked);
		if (
			blockId === 0 ||
			blockId === WATER_BLOCK_ID ||
			blockId === Chunk.GLASS_01_BLOCK_ID ||
			blockId === Chunk.GLASS_02_BLOCK_ID
		) {
			Chunk.CLOSED_FACE_MASK_CACHE[cacheIndex] = 0;
			return 0;
		}

		const state = unpackBlockState(blockPacked);
		const shapeMap = getShapeByBlockId();
		const shapeDefs = getShapeDefinitions();
		const cubeIndex = getCubeShapeIndex();
		const shapeIndex = shapeMap[blockId] ?? cubeIndex;
		const shape =
			shapeDefs[shapeIndex] ?? shapeDefs[cubeIndex] ?? FALLBACK_CUBE;
		if (!shape) {
			Chunk.CLOSED_FACE_MASK_CACHE[cacheIndex] = FACE_ALL;
			return FACE_ALL;
		}

		const rotation = shape.rotateY ? state & 3 : 0;
		const flipY = Boolean(shape.allowFlipY && (state & 4) !== 0);

		_rectCounts.fill(0);

		for (const box of shape.boxes) {
			const transformed = transformBox(box.min, box.max, rotation, flipY);
			const sliced = shape.usesSliceState
				? Chunk.applySliceStateToBoxForLight(
						transformed.min,
						transformed.max,
						state,
					)
				: transformed;

			const min = sliced.min;
			const max = sliced.max;
			const faceMask = box.faceMask ?? FACE_ALL;
			const EPS = Chunk.EPS;

			if (
				max[0] - min[0] <= EPS ||
				max[1] - min[1] <= EPS ||
				max[2] - min[2] <= EPS
			)
				continue;

			if (faceMask & FACE_PX && max[0] >= 1 - EPS)
				Chunk.pushRectFlat(0, min[1], max[1], min[2], max[2]);
			if (faceMask & FACE_NX && min[0] <= EPS)
				Chunk.pushRectFlat(1, min[1], max[1], min[2], max[2]);
			if (faceMask & FACE_PY && max[1] >= 1 - EPS)
				Chunk.pushRectFlat(2, min[0], max[0], min[2], max[2]);
			if (faceMask & FACE_NY && min[1] <= EPS)
				Chunk.pushRectFlat(3, min[0], max[0], min[2], max[2]);
			if (faceMask & FACE_PZ && max[2] >= 1 - EPS)
				Chunk.pushRectFlat(4, min[0], max[0], min[1], max[1]);
			if (faceMask & FACE_NZ && min[2] <= EPS)
				Chunk.pushRectFlat(5, min[0], max[0], min[1], max[1]);
		}

		let closedMask = 0;
		if (Chunk.doesFlatRectsCoverUnitSquare(0)) closedMask |= FACE_PX;
		if (Chunk.doesFlatRectsCoverUnitSquare(1)) closedMask |= FACE_NX;
		if (Chunk.doesFlatRectsCoverUnitSquare(2)) closedMask |= FACE_PY;
		if (Chunk.doesFlatRectsCoverUnitSquare(3)) closedMask |= FACE_NY;
		if (Chunk.doesFlatRectsCoverUnitSquare(4)) closedMask |= FACE_PZ;
		if (Chunk.doesFlatRectsCoverUnitSquare(5)) closedMask |= FACE_NZ;

		Chunk.CLOSED_FACE_MASK_CACHE[cacheIndex] = closedMask;
		return closedMask;
	}

	/**
	 * Precompute the closed-face mask for every possible packed block value
	 * (blockId << BLOCK_STATE_SHIFT | state) and return the shared Uint8Array
	 * LUT.  Called once at startup after shapes are loaded and sent to the
	 * light worker so it can do per-face transparency checks without
	 * importing shape definitions.  The returned array is the same static
	 * cache `getClosedFaceMaskForPacked` reads from.
	 */
	public static precomputeClosedFaceMasks(): Uint8Array {
		const lut = Chunk.CLOSED_FACE_MASK_CACHE;
		for (let i = 0; i < 1 << 16; i++) {
			// getClosedFaceMaskForPacked populates `lut` as a side effect;
			// calling it here just forces the lazy computation for all entries.
			Chunk.getClosedFaceMaskForPacked(i);
		}
		return lut;
	}

	private static pushRectFlat(
		f: number,
		u0: number,
		u1: number,
		v0: number,
		v1: number,
	): void {
		const EPS = Chunk.EPS;
		const cu0 = Math.min(1, Math.max(0, Math.min(u0, u1)));
		const cu1 = Math.min(1, Math.max(0, Math.max(u0, u1)));
		const cv0 = Math.min(1, Math.max(0, Math.min(v0, v1)));
		const cv1 = Math.min(1, Math.max(0, Math.max(v0, v1)));
		if (cu1 - cu0 <= EPS || cv1 - cv0 <= EPS) return;
		const cnt = _rectCounts[f];
		if (cnt >= MAX_RECTS) return;
		const base = cnt * RECT_STRIDE;
		const buf = _rectBufs[f];
		buf[base] = cu0;
		buf[base + 1] = cu1;
		buf[base + 2] = cv0;
		buf[base + 3] = cv1;
		_rectCounts[f] = cnt + 1;
	}

	private static doesFlatRectsCoverUnitSquare(f: number): boolean {
		const count = _rectCounts[f];
		if (count === 0) return false;

		const buf = _rectBufs[f];
		const EPS = Chunk.EPS;
		const HALF = MAX_RECTS * 2 + 2;

		let uLen = 0;
		let vLen = 0;
		for (let i = 0; i < count; i++) {
			const b = i * RECT_STRIDE;
			_edgeScratch[uLen++] = buf[b];
			_edgeScratch[uLen++] = buf[b + 1];
			_edgeScratch[HALF + vLen++] = buf[b + 2];
			_edgeScratch[HALF + vLen++] = buf[b + 3];
		}

		Chunk.insertionSortEdges(0, uLen);
		Chunk.insertionSortEdges(HALF, vLen);

		uLen = Chunk.dedupeEdges(0, uLen);
		vLen = Chunk.dedupeEdges(HALF, vLen);

		for (let ui = 0; ui < uLen - 1; ui++) {
			const u0e = _edgeScratch[ui];
			const u1e = _edgeScratch[ui + 1];
			if (u1e - u0e <= EPS) continue;
			for (let vi = 0; vi < vLen - 1; vi++) {
				const v0e = _edgeScratch[HALF + vi];
				const v1e = _edgeScratch[HALF + vi + 1];
				if (v1e - v0e <= EPS) continue;
				let covered = false;
				for (let r = 0; r < count; r++) {
					const rb = r * RECT_STRIDE;
					if (
						buf[rb] <= u0e + EPS &&
						buf[rb + 1] >= u1e - EPS &&
						buf[rb + 2] <= v0e + EPS &&
						buf[rb + 3] >= v1e - EPS
					) {
						covered = true;
						break;
					}
				}
				if (!covered) return false;
			}
		}
		return true;
	}

	private static insertionSortEdges(start: number, len: number): void {
		_edgeScratch.subarray(start, start + len).sort();
	}

	private static dedupeEdges(start: number, len: number): number {
		const EPS = Chunk.EPS;
		if (len === 0 || _edgeScratch[start] > EPS) {
			for (let i = len; i > 0; i--)
				_edgeScratch[start + i] = _edgeScratch[start + i - 1];
			_edgeScratch[start] = 0;
			len++;
		}
		if (_edgeScratch[start + len - 1] < 1 - EPS) {
			_edgeScratch[start + len] = 1;
			len++;
		}
		let write = 1;
		for (let read = 1; read < len; read++) {
			if (
				Math.abs(_edgeScratch[start + read] - _edgeScratch[start + write - 1]) >
				EPS
			) {
				_edgeScratch[start + write++] = _edgeScratch[start + read];
			}
		}
		return write;
	}

	private static readonly _faceBitLUT = new Uint8Array([
		FACE_PX,
		FACE_NX,
		FACE_PY,
		FACE_NY,
		FACE_PZ,
		FACE_NZ,
	]);

	private static getFaceBit(axis: number, dir: number): number {
		return Chunk._faceBitLUT[axis * 2 + (dir >= 0 ? 0 : 1)];
	}

	private isTransparent(
		blockPacked: number,
		axis?: number,
		dir?: number,
	): boolean {
		const closedMask = Chunk.getClosedFaceMaskForPacked(blockPacked);
		if (axis === undefined) return closedMask !== FACE_ALL;
		if (dir === undefined) {
			return (
				(closedMask & Chunk.getFaceBit(axis, 1)) === 0 ||
				(closedMask & Chunk.getFaceBit(axis, -1)) === 0
			);
		}
		return (closedMask & Chunk.getFaceBit(axis, dir)) === 0;
	}

	private static applySliceStateToBoxForLight(
		min: [number, number, number],
		max: [number, number, number],
		state: number,
	): { min: [number, number, number]; max: [number, number, number] } {
		const slice = (state >>> 3) & 7;
		if (slice === 0) {
			_sliceResult.min = min;
			_sliceResult.max = max;
			return _sliceResult;
		}

		const rotation = state & 7;
		const sliceAxis = getSliceAxis(rotation);
		const flip = (rotation & 4) !== 0;
		const heightScale = slice / 8;
		_sliceMin[0] = min[0];
		_sliceMin[1] = min[1];
		_sliceMin[2] = min[2];
		_sliceMax[0] = max[0];
		_sliceMax[1] = max[1];
		_sliceMax[2] = max[2];

		if (flip) {
			_sliceMin[sliceAxis] = 1 - (1 - min[sliceAxis]) * heightScale;
			_sliceMax[sliceAxis] = 1 - (1 - max[sliceAxis]) * heightScale;
		} else {
			_sliceMin[sliceAxis] = min[sliceAxis] * heightScale;
			_sliceMax[sliceAxis] = max[sliceAxis] * heightScale;
		}
		if (_sliceMin[sliceAxis] > _sliceMax[sliceAxis]) {
			const tmp = _sliceMin[sliceAxis];
			_sliceMin[sliceAxis] = _sliceMax[sliceAxis];
			_sliceMax[sliceAxis] = tmp;
		}
		_sliceResult.min = _sliceMin;
		_sliceResult.max = _sliceMax;
		return _sliceResult;
	}

	// =========================================================================
	// Face connectivity for occlusion BFS
	// =========================================================================

	public static facePairIndex(i: number, j: number): number {
		return 4 * i - ((i * (i - 1)) >> 1) + j - 1;
	}

	private static readonly _faceScratch: number[] = [];

	private static connectFacesMask(faceMask: number): number {
		let result = 0;
		const faces = Chunk._faceScratch;
		faces.length = 0;
		for (let f = 0; f < 6; f++) {
			if (faceMask & (1 << f)) faces.push(f);
		}
		for (let a = 0; a < faces.length; a++) {
			for (let b = a + 1; b < faces.length; b++) {
				const i = faces[a];
				const j = faces[b];
				result |= 1 << Chunk.facePairIndex(i, j);
			}
		}
		return result;
	}

	// Minimum air voxels on a chunk face for that face to count as connected.
	// A 32×32 face has 1024 voxels; threshold of S/2 = 16 filters out
	// single-block cracks and thin slivers while allowing real passages.
	private static readonly FACE_CONNECT_THRESHOLD =
		GenerationParams.CHUNK_SIZE / 2;

	public computeFaceConnectivity(): number {
		if (!this._hasVoxelData || this._isUniform) {
			const mask =
				this._isUniform && this._uniformBlockId === 0
					? Chunk.connectFacesMask(0x3f)
					: 0;
			this.faceConnectivity = mask;
			this.connectivityDirty = false;
			return mask;
		}

		const S = Chunk.SIZE;
		const S2 = S * S;
		const S3 = Chunk.SIZE3;

		_ccVisited.fill(0, 0, S3);
		const visited = _ccVisited;
		const stack = _ccStack;
		const opaque = _ccOpaque;
		for (let i = 0; i < S3; i++) {
			opaque[i] = this.isOpaqueAtIndex(i);
		}
		let connectivity = 0;

		for (let z = 0; z < S; z++) {
			for (let y = 0; y < S; y++) {
				for (let x = 0; x < S; x++) {
					const idx = x + y * S + z * S2;
					if (visited[idx]) continue;

					if (opaque[idx]) {
						visited[idx] = 1;
						continue;
					}

					let stackTop = 0;
					stack[stackTop++] = idx;
					visited[idx] = 1;
					const fc = _ccFaceCounts;
					fc[0] = 0;
					fc[1] = 0;
					fc[2] = 0;
					fc[3] = 0;
					fc[4] = 0;
					fc[5] = 0;

					while (stackTop > 0) {
						const cur = stack[--stackTop];
						const cx = cur % S;
						const cy = ((cur / S) | 0) % S;
						const cz = (cur / S2) | 0;

						if (cx === 0) fc[1]++;
						if (cx === S - 1) fc[0]++;
						if (cy === 0) fc[3]++;
						if (cy === S - 1) fc[2]++;
						if (cz === 0) fc[5]++;
						if (cz === S - 1) fc[4]++;

						if (cx > 0) {
							const n = cur - 1;
							if (!visited[n] && !opaque[n]) {
								visited[n] = 1;
								stack[stackTop++] = n;
							}
						}
						if (cx < S - 1) {
							const n = cur + 1;
							if (!visited[n] && !opaque[n]) {
								visited[n] = 1;
								stack[stackTop++] = n;
							}
						}
						if (cy > 0) {
							const n = cur - S;
							if (!visited[n] && !opaque[n]) {
								visited[n] = 1;
								stack[stackTop++] = n;
							}
						}
						if (cy < S - 1) {
							const n = cur + S;
							if (!visited[n] && !opaque[n]) {
								visited[n] = 1;
								stack[stackTop++] = n;
							}
						}
						if (cz > 0) {
							const n = cur - S2;
							if (!visited[n] && !opaque[n]) {
								visited[n] = 1;
								stack[stackTop++] = n;
							}
						}
						if (cz < S - 1) {
							const n = cur + S2;
							if (!visited[n] && !opaque[n]) {
								visited[n] = 1;
								stack[stackTop++] = n;
							}
						}
					}

					// Only count faces with enough air voxels as connected.
					let openFaces = 0;
					const thresh = Chunk.FACE_CONNECT_THRESHOLD;
					if (fc[0] >= thresh) openFaces |= 1 << 0;
					if (fc[1] >= thresh) openFaces |= 1 << 1;
					if (fc[2] >= thresh) openFaces |= 1 << 2;
					if (fc[3] >= thresh) openFaces |= 1 << 3;
					if (fc[4] >= thresh) openFaces |= 1 << 4;
					if (fc[5] >= thresh) openFaces |= 1 << 5;
					connectivity |= Chunk.connectFacesMask(openFaces);
				}
			}
		}

		this.faceConnectivity = connectivity;
		this.connectivityDirty = false;
		return connectivity;
	}

	// =========================================================================
	// Dispose
	// =========================================================================

	public dispose(): void {
		// Null our slot in each live neighbour's neighborRefs before removing
		// ourselves from chunkInstances, so no chunk holds a dangling ref to us.
		// d ^ 1 gives the opposite direction (the face pointing back toward us).
		const ids = this.neighborIds;
		for (let d = 0; d < 6; d++) {
			const nbr = Chunk.chunkInstances.get(ids[d]);
			if (nbr) nbr.neighborRefs[d ^ 1] = null;
		}
		this.neighborRefs.fill(null);

		// Remove from merged mesh group — the group manager handles mesh disposal.
		if (this.mergedGroupKey) {
			removeChunkFromGroup(this);
		}

		if (!this.mergedGroupKey) {
			if (this.mesh) {
				removeFromScene(Map1.mainScene, this.mesh);
				disposeMeshGpu(this.mesh);
			}
			if (this.transparentMesh) {
				removeFromScene(Map1.mainScene, this.transparentMesh);
				disposeMeshGpu(this.transparentMesh);
			}
		}
		this.clearCachedLODMeshes();
		this.mesh = null;
		this.transparentMesh = null;
		this.opaqueMeshData = null;
		this.transparentMeshData = null;
		this._block_array = null;
		this._isUniform = true;
		this._uniformBlockId = 0;
		this._palette = null;
		this._paletteIndexMap = null;
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
		Chunk.chunkInstances.delete(this.id);
		_deleteByCoords(this);
		this.bfsQueryId = 0;
		this.bfsVisitedFaces = 0;
		this.bfsQueuedForConnectivity = false;

		runChunkDisposeHooks(this);
	}
}

export function getChunk(
	cx: number,
	cy: number,
	cz: number,
): Chunk | undefined {
	return Chunk._chunkByCoords.get(cx)?.get(cy)?.get(cz);
}

// ── _chunkByCoords mirror maintenance ────────────────────────────────────────
function _setByCoords(c: Chunk): void {
	let my = Chunk._chunkByCoords.get(c.chunkX);
	if (my === undefined) {
		my = new Map();
		Chunk._chunkByCoords.set(c.chunkX, my);
	}
	let mz = my.get(c.chunkY);
	if (mz === undefined) {
		mz = new Map();
		my.set(c.chunkY, mz);
	}
	mz.set(c.chunkZ, c);
}

function _deleteByCoords(c: Chunk): void {
	const my = Chunk._chunkByCoords.get(c.chunkX);
	if (my === undefined) return;
	const mz = my.get(c.chunkY);
	if (mz === undefined) return;
	mz.delete(c.chunkZ);
	if (mz.size === 0) {
		my.delete(c.chunkY);
		if (my.size === 0) Chunk._chunkByCoords.delete(c.chunkX);
	}
}
