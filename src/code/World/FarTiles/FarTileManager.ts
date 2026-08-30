import {
	addToScene,
	createMeshFromData,
	createStorageBuffer,
	disposeStorageBuffer,
	type EngineContext,
	getCameraPosition,
	type Mesh,
	onBeforeRender,
	type SceneContext,
	type ShaderMaterial,
	type StorageBuffer,
	setShaderStorageBuffer,
	setShaderUniform,
	setThinInstances,
	updateStorageBuffer,
} from "@babylonjs/lite";
import MapFog from "@/code/Maps/MapFog";
import { isEyeUnderwater } from "@/code/Maps/UnderWaterEffect";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import { frameProfiler } from "../../Lib/FrameProfiler";
import { ChunkWorkerPool } from "../Chunk/ChunkWorkerPool";
import type { FarTileGeneratedMessage } from "../Chunk/DataStructures/WorkerMessageType";
import {
	bindFarTileBuffers,
	createFarTileTerrainMaterial,
	createFarTileWaterMaterial,
} from "../Light/FarTileShaderLite";
import { onGpuWorkDone } from "../Light/liteGpuBuffer.js";
import {
	atlasTileSize,
	getDiffuseTexture2D,
} from "../Texture/TextureAtlasFactory";
import { getFarTileLevels, isFarTilesEnabled } from "./FarTileLadder";

/**
 * Main-thread far-tile streaming manager — GPU face-decoding variant.
 *
 * Worker faces (4×u32 words, see FarTileFaceFormat.ts) are copied VERBATIM
 * into a per-level face-word storage buffer; each level renders through TWO
 * shared-quad thin-instance meshes — straight-indexed for backFace=1 faces,
 * reversed-indexed for backFace=0 — so per-face winding (and therefore
 * backface culling) matches the old CPU-expanded path exactly. Without the
 * split, coplanar opposite-facing boundary skirts at tile/ring edges would
 * z-fight. The previous CPU expand-to-vertex-buffers pipeline
 * (expandTileFaces + full-level recopy + destroy/recreate uploads on every
 * tile arrival) is gone entirely:
 *
 *   - tile arrival   = memcpy words into an arena slot, partition face
 *                      indices into the two winding lists, ranged GPU write
 *   - tile eviction  = zero-fill the slot + remove indices + ranged write
 *   - VRAM           = 16 B/face words + 16 B/instance record (+ shared
 *                      quads), vs ~216 B/quad of expanded vertex data before
 *
 * Each tile also owns one entry in a workspace-wide `tileOrigins` buffer
 * (vec2 world X/Z); faces reference their tile's origin slot via bits 8-23
 * of word3, stamped main-thread-side at arrival (worker output untouched).
 */

const MAX_TILE_REQUESTS_PER_UPDATE = 24;
const UNLOAD_MARGIN_CHUNKS = 4;

// Collision-free tile-key packing using 26 bits per axis (same as
// packColumnKey) plus 6 bits for level — uses BigInt to stay unique for the
// full ±33M tile range without overflow.
const TILE_KEY_AXIS_BITS = 26;
const TILE_KEY_AXIS_MASK = 0x3ffffff;
const TILE_KEY_LEVEL_SHIFT = BigInt(TILE_KEY_AXIS_BITS * 2);

function packTileKey(levelIndex: number, tx: number, tz: number): bigint {
	return (
		(BigInt(levelIndex) << TILE_KEY_LEVEL_SHIFT) |
		(BigInt(tx & TILE_KEY_AXIS_MASK) << BigInt(TILE_KEY_AXIS_BITS)) |
		BigInt(tz & TILE_KEY_AXIS_MASK)
	);
}

// Bytes per face word record (4 u32).
const FT_FACE_BYTES = 16;
const FT_FACE_WORDS = 4;

// Shared unit quad — same constants PackedChunkMesh uses. Vertex shader
// derives real positions from the face words; this buffer only feeds the
// mandatory position attribute.
const QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]);
const QUAD_NORMALS = new Float32Array(12);

// GPU upload bytes flushed during the current frame (reset in frame()).
let _farUploadBytesThisFrame = 0;

interface FarSlot {
	base: number; // first face index in the arena
	count: number; // face count
}

interface FarMeshLike extends Mesh {
	isVisible?: boolean;
	thinInstances?: {
		matrices: Float32Array;
		count: number;
		compact?: boolean;
		_capacity: number;
		_version: number;
		_gpuBuffer: GPUBuffer | null;
		_gpuBufferStorage: boolean;
		_gpuVersion: number;
		_dirtyMin: number;
		_dirtyMax: number;
	};
}

// ---------------------------------------------------------------------------
// Allocation-reduced helpers
// ---------------------------------------------------------------------------

const QUANTIZE_SCALE = 256;

function quantize256(value: number): number {
	return Math.round(value * QUANTIZE_SCALE) / QUANTIZE_SCALE;
}

// ---------------------------------------------------------------------------
// Face-word arena: verbatim worker words + stable per-tile slots.
// ---------------------------------------------------------------------------

let engineRef: EngineContext | null = null;

function disposeBufferAfterGpuWork(buffer: StorageBuffer): void {
	if (!engineRef) return;
	void onGpuWorkDone(engineRef).then(() => disposeStorageBuffer(buffer));
}

class FaceWordArena {
	cpu: Uint32Array = new Uint32Array(0);
	buffer: StorageBuffer | null = null;
	capacityFaces = 0;
	appendedFaces = 0;
	holes: FarSlot[] = [];

	// Parallel numeric arrays avoid allocating one DirtyRange object per write.
	private dirtyStarts: number[] = [];
	private dirtyCounts: number[] = [];

	readonly initialCapacity: number;
	bufferRebound = false;

	constructor(initialCapacity: number) {
		this.initialCapacity = initialCapacity;
	}

	private ensureCpu(faceCount: number): void {
		if (faceCount <= this.capacityFaces) return;

		const maxFaces = maxFarFacesPerArena();
		const grownCapacity =
			this.capacityFaces > 0 ? this.capacityFaces * 4 : this.initialCapacity;
		const capacity = Math.min(
			Math.max(faceCount, grownCapacity, 256),
			maxFaces,
		);

		const next = new Uint32Array(capacity * FT_FACE_WORDS);
		next.set(this.cpu.subarray(0, this.appendedFaces * FT_FACE_WORDS));

		this.cpu = next;
		this.capacityFaces = capacity;

		const oldBuffer = this.buffer;
		this.buffer = createStorageBuffer(engineRef!, this.cpu, "farTileFaces");

		if (oldBuffer) {
			disposeBufferAfterGpuWork(oldBuffer);
		}

		this.bufferRebound = true;
	}

	alloc(count: number): FarSlot | null {
		if (count === 0) {
			return { base: 0, count: 0 };
		}

		if (count > maxFarFacesPerArena()) {
			return null;
		}

		const holes = this.holes;

		for (let i = 0; i < holes.length; i++) {
			const hole = holes[i];

			if (hole.count < count) {
				continue;
			}

			const base = hole.base;
			const remaining = hole.count - count;

			if (remaining === 0) {
				holes.splice(i, 1);
			} else {
				// Reuse the existing hole object rather than removing it and
				// allocating a replacement remainder object.
				hole.base += count;
				hole.count = remaining;
			}

			return { base, count };
		}

		const required = this.appendedFaces + count;

		if (required > this.capacityFaces) {
			this.ensureCpu(required);

			if (required > this.capacityFaces) {
				return null;
			}
		}

		const slot = {
			base: this.appendedFaces,
			count,
		};

		this.appendedFaces = required;
		return slot;
	}

	insertHole(base: number, count: number): void {
		if (count <= 0) return;

		const holes = this.holes;
		let index = 0;

		while (index < holes.length && holes[index].base < base) {
			index++;
		}

		// Merge with the previous and/or next hole. This lowers hole-object
		// count and improves the chance that future allocations reuse space.
		const previous = index > 0 ? holes[index - 1] : null;
		const next = index < holes.length ? holes[index] : null;

		if (previous && previous.base + previous.count >= base) {
			const end = Math.max(previous.base + previous.count, base + count);
			previous.count = end - previous.base;

			if (next && previous.base + previous.count >= next.base) {
				const mergedEnd = Math.max(
					previous.base + previous.count,
					next.base + next.count,
				);
				previous.count = mergedEnd - previous.base;
				holes.splice(index, 1);
			}

			return;
		}

		if (next && base + count >= next.base) {
			const end = Math.max(base + count, next.base + next.count);
			next.base = base;
			next.count = end - base;
			return;
		}

		holes.splice(index, 0, { base, count });
	}

	free(slot: FarSlot): void {
		if (slot.count === 0) return;

		const wordStart = slot.base * FT_FACE_WORDS;
		const wordEnd = wordStart + slot.count * FT_FACE_WORDS;

		this.cpu.fill(0, wordStart, wordEnd);
		this.insertHole(slot.base, slot.count);
	}

	pushDirty(start: number, count: number): void {
		if (count <= 0) return;

		const starts = this.dirtyStarts;
		const counts = this.dirtyCounts;
		const length = starts.length;

		if (length > 0) {
			const lastIndex = length - 1;
			const lastStart = starts[lastIndex];
			const lastEnd = lastStart + counts[lastIndex];
			const newEnd = start + count;

			// Merge adjacent or overlapping ranges.
			if (start <= lastEnd && newEnd >= lastStart) {
				const mergedStart = Math.min(lastStart, start);
				const mergedEnd = Math.max(lastEnd, newEnd);
				starts[lastIndex] = mergedStart;
				counts[lastIndex] = mergedEnd - mergedStart;
				return;
			}
		}

		starts.push(start);
		counts.push(count);
	}

	flushDirty(): void {
		const starts = this.dirtyStarts;
		const counts = this.dirtyCounts;
		const engine = engineRef;
		const buffer = this.buffer;

		if (!engine || !buffer) {
			starts.length = 0;
			counts.length = 0;
			return;
		}

		for (let i = 0; i < starts.length; i++) {
			const start = starts[i];
			const count = counts[i];
			const wordStart = start * FT_FACE_WORDS;
			const wordEnd = wordStart + count * FT_FACE_WORDS;

			updateStorageBuffer(
				engine,
				buffer,
				this.cpu.subarray(wordStart, wordEnd),
				start * FT_FACE_BYTES,
			);

			_farUploadBytesThisFrame += count * FT_FACE_BYTES;
		}

		starts.length = 0;
		counts.length = 0;
	}
}

interface TileEntry {
	levelIndex: number;
	tx: number;
	tz: number;
	opaque: FarSlot | null;
	water: FarSlot | null;
	originSlot: number;
}

// ---------------------------------------------------------------------------
// Winding meshes
//
// Each level renders its shared face arena through TWO thin-instanced quads:
// the straight-indexed mesh draws backFace=1 faces, the reversed-indexed mesh
// draws backFace=0 faces — restoring the CPU expander's exact per-face
// winding so backface culling works (and coplanar opposite-facing boundary
// skirts culled from behind instead of z-fighting). The per-instance record
// carries the face's absolute index in the arena (instData.x).
// ---------------------------------------------------------------------------

const STRAIGHT_INDICES = new Uint32Array([0, 1, 2, 0, 2, 3]);
const REVERSED_INDICES = new Uint32Array([0, 2, 1, 0, 3, 2]);

class WindingMesh {
	mesh: FarMeshLike | null = null;
	records = new Float32Array(0);
	count = 0;
	capacityFaces = 0;
	dirtyMin = Number.POSITIVE_INFINITY;
	dirtyMax = 0;
	// Arena slots are normally appended in ascending order. Hole reuse can
	// append a lower face index after a higher one, so retain the invariant
	// explicitly instead of making batched removal assume it forever.
	private recordsSortedByFaceIndex = true;

	readonly straight: boolean;

	constructor(straight: boolean) {
		this.straight = straight;
	}

	appendFace(faceIndex: number): void {
		this.ensureRecordCapacity(this.count + 1);

		if (
			this.recordsSortedByFaceIndex &&
			this.count > 0 &&
			faceIndex < this.records[(this.count - 1) * 4]
		) {
			this.recordsSortedByFaceIndex = false;
		}

		const recordOffset = this.count * 4;
		this.records[recordOffset] = faceIndex;

		// The remaining lanes are already zero for newly allocated typed-array
		// storage. Explicitly clear them because this slot may be reused after
		// compaction.
		this.records[recordOffset + 1] = 0;
		this.records[recordOffset + 2] = 0;
		this.records[recordOffset + 3] = 0;

		const changedIndex = this.count++;
		this.markDirty(changedIndex, changedIndex + 1);
	}

	/**
	 * Allocation-free single-slot removal.
	 *
	 * This avoids removeSlots([slot]), which allocates a temporary array and
	 * previously also cloned the slot.
	 */
	removeSlot(slot: FarSlot): void {
		const oldCount = this.count;

		if (oldCount === 0 || slot.count === 0) {
			return;
		}

		const removeStart = slot.base;
		const removeEnd = removeStart + slot.count;

		let write = 0;
		let firstChanged = Number.POSITIVE_INFINITY;
		const records = this.records;

		for (let read = 0; read < oldCount; read++) {
			const sourceOffset = read * 4;
			const faceIndex = records[sourceOffset];

			if (faceIndex >= removeStart && faceIndex < removeEnd) {
				if (firstChanged === Number.POSITIVE_INFINITY) {
					firstChanged = write;
				}
				continue;
			}

			if (write !== read) {
				const targetOffset = write * 4;
				records[targetOffset] = records[sourceOffset];
				records[targetOffset + 1] = records[sourceOffset + 1];
				records[targetOffset + 2] = records[sourceOffset + 2];
				records[targetOffset + 3] = records[sourceOffset + 3];
			}

			write++;
		}

		this.count = write;

		if (firstChanged !== Number.POSITIVE_INFINITY && write > firstChanged) {
			this.markDirty(firstChanged, write);
		}
	}

	/**
	 * Batched order-preserving removal.
	 *
	 * The supplied array is sorted in place, but the FarSlot objects are not
	 * mutated. In this manager all callers pass reusable scratch arrays, so
	 * sorting the array has no observable effect.
	 *
	 * Records are sorted while the arena only grows. Once a freed arena hole is
	 * reused, however, the newly appended records can have lower face indices
	 * than records already in this list. Keep the O(n + m) scan for the common
	 * ordered case, and use allocation-free binary interval lookups otherwise.
	 */
	removeSlots(slots: FarSlot[]): void {
		const oldCount = this.count;
		const slotCount = slots.length;

		if (oldCount === 0 || slotCount === 0) {
			return;
		}

		if (slotCount === 1) {
			this.removeSlot(slots[0]);
			return;
		}

		slots.sort(compareSlotsByBase);

		const records = this.records;
		let write = 0;
		let intervalIndex = 0;
		let firstChanged = Number.POSITIVE_INFINITY;
		const recordsSorted = this.recordsSortedByFaceIndex;
		let previousKeptFaceIndex = Number.NEGATIVE_INFINITY;
		let keptRecordsRemainSorted = true;

		for (let read = 0; read < oldCount; read++) {
			const sourceOffset = read * 4;
			const faceIndex = records[sourceOffset];
			let remove = false;

			if (recordsSorted) {
				// Advance past intervals that end before this face. This is the
				// O(n + m) path used until arena-hole reuse changes record order.
				while (intervalIndex < slotCount) {
					const interval = slots[intervalIndex];

					if (interval.count <= 0) {
						intervalIndex++;
						continue;
					}

					if (faceIndex >= interval.base + interval.count) {
						intervalIndex++;
						continue;
					}

					break;
				}

				if (intervalIndex < slotCount) {
					// Handle overlapping or contiguous input slots without
					// allocating a merged interval list.
					let scanIndex = intervalIndex;

					while (scanIndex < slotCount) {
						const interval = slots[scanIndex];

						if (interval.count <= 0) {
							scanIndex++;
							continue;
						}

						if (interval.base > faceIndex) {
							break;
						}

						if (faceIndex < interval.base + interval.count) {
							remove = true;
							break;
						}

						scanIndex++;
					}
				}
			} else {
				// Reused holes append lower arena indices at the tail, so the
				// record order is arbitrary. Binary-search the sorted removal
				// intervals to keep this fallback allocation-free.
				let lo = 0;
				let hi = slotCount;

				while (lo < hi) {
					const middle = (lo + hi) >>> 1;
					const interval = slots[middle];

					if (interval.base + interval.count <= faceIndex) {
						lo = middle + 1;
					} else {
						hi = middle;
					}
				}

				if (lo < slotCount) {
					const interval = slots[lo];
					remove =
						interval.count > 0 &&
						faceIndex >= interval.base &&
						faceIndex < interval.base + interval.count;
				}
			}

			if (remove) {
				if (firstChanged === Number.POSITIVE_INFINITY) {
					firstChanged = write;
				}
				continue;
			}

			if (faceIndex < previousKeptFaceIndex) {
				keptRecordsRemainSorted = false;
			}
			previousKeptFaceIndex = faceIndex;

			if (write !== read) {
				const targetOffset = write * 4;
				records[targetOffset] = records[sourceOffset];
				records[targetOffset + 1] = records[sourceOffset + 1];
				records[targetOffset + 2] = records[sourceOffset + 2];
				records[targetOffset + 3] = records[sourceOffset + 3];
			}

			write++;
		}

		this.count = write;
		this.recordsSortedByFaceIndex = keptRecordsRemainSorted;

		if (firstChanged !== Number.POSITIVE_INFINITY && write > firstChanged) {
			this.markDirty(firstChanged, write);
		}
	}

	sync(): void {
		const requiredLanes = this.count * 4;
		const currentLanes = this.records.length;

		// Growth is already normally handled by appendFace(), but retain this
		// path for callers that may change count by another route.
		if (requiredLanes > currentLanes) {
			let capacity = currentLanes > 0 ? currentLanes : 1024;

			while (capacity < requiredLanes) {
				capacity *= 2;
			}

			const next = new Float32Array(capacity);
			next.set(this.records);
			this.records = next;
			this.markDirty(0, this.count);
		} else if (currentLanes >= 16384 && requiredLanes * 8 <= currentLanes) {
			// Round shrinking to a power-of-two capacity. Shrinking exactly to
			// requiredLanes causes an immediate allocation on the next append.
			let capacity = 1024;
			const target = Math.max(1024, requiredLanes * 2);

			while (capacity < target) {
				capacity *= 2;
			}

			const next = new Float32Array(capacity);
			next.set(this.records.subarray(0, requiredLanes));
			this.records = next;
			this.markDirty(0, this.count);
		}

		this.capacityFaces = this.records.length >>> 2;
	}

	clearDirty(): void {
		this.dirtyMin = Number.POSITIVE_INFINITY;
		this.dirtyMax = 0;
	}

	private ensureRecordCapacity(requiredFaces: number): void {
		const requiredLanes = requiredFaces * 4;

		if (requiredLanes <= this.records.length) {
			return;
		}

		let capacity = this.records.length > 0 ? this.records.length : 1024;

		while (capacity < requiredLanes) {
			capacity *= 2;
		}

		const next = new Float32Array(capacity);
		next.set(this.records.subarray(0, this.count * 4));
		this.records = next;
		this.capacityFaces = capacity >>> 2;

		if (this.count > 0) {
			this.markDirty(0, this.count);
		}
	}

	private markDirty(start: number, end: number): void {
		if (end <= start) return;

		if (start < this.dirtyMin) {
			this.dirtyMin = start;
		}

		if (end > this.dirtyMax) {
			this.dirtyMax = end;
		}
	}
}
function compareSlotsByBase(a: FarSlot, b: FarSlot): number {
	return a.base - b.base;
}

class FarTileManagerImpl {
	private static instance: FarTileManagerImpl | null = null;

	public static getInstance(): FarTileManagerImpl {
		if (!FarTileManagerImpl.instance) {
			FarTileManagerImpl.instance = new FarTileManagerImpl();
		}
		return FarTileManagerImpl.instance;
	}

	public static peekInstance(): FarTileManagerImpl | null {
		return FarTileManagerImpl.instance;
	}

	private engine: EngineContext | null = null;
	private scene: SceneContext | null = null;

	private terrainMaterials: ShaderMaterial[] = [];
	private waterMaterial: ShaderMaterial | null = null;
	private terrainArenas: FaceWordArena[] = [];
	private terrainStraight: WindingMesh[] = [];
	private terrainReversed: WindingMesh[] = [];
	private waterArena = new FaceWordArena(4096);
	private waterReversed = new WindingMesh(false);

	// Workspace-wide tile-origin table (shared by every material).
	private origins = new Float32Array(0);
	private originsBuffer: StorageBuffer | null = null;
	private originCapacitySlots = 0;
	private nextOriginSlot = 0;
	// BUGFIX: origin slots are REUSED via this free list. They used to be
	// monotonic-only, and the face-word origin index is only 16 bits wide —
	// after 65,536 tile arrivals the packed index wrapped onto stale origins
	// and tiles rendered at wrong world positions. Live tiles number in the
	// hundreds, so reuse keeps every handed-out id far below the wrap.
	private originFreeSlots: number[] = [];
	// Half-open dirty SLOT range for ranged GPU uploads (Infinity = clean).
	private originsDirtyMin = Number.POSITIVE_INFINITY;
	private originsDirtyMax = 0;

	private readonly tiles = new Map<bigint, TileEntry>();
	private readonly pendingByKey = new Set<bigint>();
	private readonly keyByRequestId = new Map<number, bigint>();

	private lastPlayerChunkX = Number.NaN;
	private lastPlayerChunkZ = Number.NaN;

	// Reused scratch arrays for update() — avoids per-frame allocations
	private _wantedKeys: bigint[] = [];
	private _wantedLevels: number[] = [];
	private _wantedTx: number[] = [];
	private _wantedTz: number[] = [];
	private _wantedDist: number[] = [];
	private _evictKeys: bigint[] = [];
	private _evictEntries: TileEntry[] = [];
	private _evictWaterSlots: FarSlot[] = [];
	private _evictStraightByLevel: FarSlot[][] = [];
	private _evictReversedByLevel: FarSlot[][] = [];

	// Uniform caches (mirrors DistantTerrain's steady-state skip).
	private fogInfosScratch = new Float32Array(4);
	private fogColorScratch = new Float32Array(3);
	private lightDirScratch = new Float32Array(3);
	private lastLx = Number.NaN;
	private lastLy = Number.NaN;
	private lastLz = Number.NaN;
	private lastSunIntensity = Number.NaN;
	private lastUnderWater: boolean | null = null;
	private lastFogStart = Number.NaN;
	private lastFogEnd = Number.NaN;
	private lastFogColorR = Number.NaN;
	private lastFogColorG = Number.NaN;
	private lastFogColorB = Number.NaN;
	private lastFogInvRange = Number.NaN;

	public init(engine: EngineContext, scene: SceneContext): void {
		if (!isFarTilesEnabled() || this.engine) {
			return;
		}

		this.engine = engine;
		this.scene = scene;
		engineRef = engine;

		const diffuse = getDiffuseTexture2D();
		const levels = getFarTileLevels();

		for (let i = 0; i < levels.length; i++) {
			const material = createFarTileTerrainMaterial({
				engine,
				scene,
				diffuseTexture: diffuse,
				atlasTileSize,
				textureScale: 32,
				nameSuffix: String(i),
			});

			this.terrainMaterials.push(material);
			this.terrainArenas.push(new FaceWordArena(8192));
			this.terrainStraight.push(new WindingMesh(true));
			this.terrainReversed.push(new WindingMesh(false));

			// Allocate per-level scratch arrays once.
			this._evictStraightByLevel.push([]);
			this._evictReversedByLevel.push([]);
		}

		this.waterMaterial = createFarTileWaterMaterial();
		this.ensureOrigins(1024);

		const pool = ChunkWorkerPool.getInstance();
		pool.onFarTileGenerated = (data) => this.handleResult(data);

		onBeforeRender(scene, () => this.frame());
	}

	public isReady(): boolean {
		return this.engine != null;
	}

	// ------------------------------------------------------------------
	// Streaming
	// ------------------------------------------------------------------

	public update(playerWorldX: number, playerWorldZ: number): void {
		if (!this.engine) return;

		frameProfiler.begin("farTiles");

		const levels = getFarTileLevels();
		const pcx = Math.floor(playerWorldX / 32);
		const pcz = Math.floor(playerWorldZ / 32);

		if (pcx === this.lastPlayerChunkX && pcz === this.lastPlayerChunkZ) {
			frameProfiler.end("farTiles");
			return;
		}
		this.lastPlayerChunkX = pcx;
		this.lastPlayerChunkZ = pcz;

		// Reuse scratch arrays — no per-frame object/string allocations
		const wantedKeys = this._wantedKeys;
		const wantedLevels = this._wantedLevels;
		const wantedTx = this._wantedTx;
		const wantedTz = this._wantedTz;
		const wantedDist = this._wantedDist;
		wantedKeys.length = 0;
		wantedLevels.length = 0;
		wantedTx.length = 0;
		wantedTz.length = 0;
		wantedDist.length = 0;

		for (let li = 0; li < levels.length; li++) {
			const lv = levels[li];
			const span = lv.tileSizeChunks;
			const half = span / 2;

			const txMin = Math.floor((pcx - lv.ringOuterChunks) / span);
			const txMax = Math.floor((pcx + lv.ringOuterChunks) / span);
			const tzMin = Math.floor((pcz - lv.ringOuterChunks) / span);
			const tzMax = Math.floor((pcz + lv.ringOuterChunks) / span);

			for (let tx = txMin; tx <= txMax; tx++) {
				for (let tz = tzMin; tz <= tzMax; tz++) {
					const centerX = tx * span + half;
					const centerZ = tz * span + half;
					const d = Math.max(Math.abs(centerX - pcx), Math.abs(centerZ - pcz));

					if (
						d < lv.ringInnerChunks ||
						d >= lv.ringOuterChunks + UNLOAD_MARGIN_CHUNKS
					) {
						continue;
					}

					const key = packTileKey(li, tx, tz);
					if (this.tiles.has(key) || this.pendingByKey.has(key)) continue;

					wantedKeys.push(key);
					wantedLevels.push(li);
					wantedTx.push(tx);
					wantedTz.push(tz);
					wantedDist.push(d);
				}
			}
		}

		// Select nearest MAX_TILE_REQUESTS_PER_UPDATE without full sort (allocation-free)
		const wantedCount = wantedKeys.length;
		const toRequest =
			wantedCount < MAX_TILE_REQUESTS_PER_UPDATE
				? wantedCount
				: MAX_TILE_REQUESTS_PER_UPDATE;
		for (let r = 0; r < toRequest; r++) {
			let bestIdx = r;
			let bestDist = wantedDist[r];
			for (let i = r + 1; i < wantedCount; i++) {
				const d = wantedDist[i];
				if (d < bestDist) {
					bestDist = d;
					bestIdx = i;
				}
			}
			if (bestIdx !== r) {
				const tmpKey = wantedKeys[r];
				wantedKeys[r] = wantedKeys[bestIdx];
				wantedKeys[bestIdx] = tmpKey;
				let tmp: number;
				tmp = wantedLevels[r];
				wantedLevels[r] = wantedLevels[bestIdx];
				wantedLevels[bestIdx] = tmp;
				tmp = wantedTx[r];
				wantedTx[r] = wantedTx[bestIdx];
				wantedTx[bestIdx] = tmp;
				tmp = wantedTz[r];
				wantedTz[r] = wantedTz[bestIdx];
				wantedTz[bestIdx] = tmp;
				tmp = wantedDist[r];
				wantedDist[r] = wantedDist[bestIdx];
				wantedDist[bestIdx] = tmp;
			}
		}

		const pool = ChunkWorkerPool.getInstance();
		for (let i = 0; i < toRequest; i++) {
			const key = wantedKeys[i];
			const requestId = pool.scheduleFarTile(
				wantedLevels[i],
				wantedTx[i],
				wantedTz[i],
			);
			this.pendingByKey.add(key);
			this.keyByRequestId.set(requestId, key);
		}

		// Unload tiles outside their window — batched single-pass compaction
		// to avoid O(m*n) repeated scans (previous per-tile removeSlot).
		const evictKeys = this._evictKeys;
		const evictEntries = this._evictEntries;
		evictKeys.length = 0;
		evictEntries.length = 0;
		for (const [key, entry] of this.tiles) {
			const lv = levels[entry.levelIndex];
			if (!lv) continue;

			const span = lv.tileSizeChunks;
			const centerX = entry.tx * span + span / 2;
			const centerZ = entry.tz * span + span / 2;
			const d = Math.max(Math.abs(centerX - pcx), Math.abs(centerZ - pcz));

			if (
				d >= lv.ringOuterChunks + UNLOAD_MARGIN_CHUNKS ||
				d < lv.ringInnerChunks
			) {
				evictKeys.push(key);
				evictEntries.push(entry);
			}
		}

		if (evictEntries.length > 0) {
			const straightByLevel = this._evictStraightByLevel;
			const reversedByLevel = this._evictReversedByLevel;
			const waterSlots = this._evictWaterSlots;

			waterSlots.length = 0;

			// Reuse all per-level arrays rather than Map.clear() followed by creation
			// of new arrays during every eviction update.
			for (
				let levelIndex = 0;
				levelIndex < straightByLevel.length;
				levelIndex++
			) {
				straightByLevel[levelIndex].length = 0;
				reversedByLevel[levelIndex].length = 0;
			}

			for (let i = 0; i < evictEntries.length; i++) {
				const entry = evictEntries[i];
				const levelIndex = entry.levelIndex;
				const arena = this.terrainArenas[levelIndex];
				const opaque = entry.opaque;
				const water = entry.water;

				if (arena && opaque) {
					arena.free(opaque);
					straightByLevel[levelIndex].push(opaque);
					reversedByLevel[levelIndex].push(opaque);
				}

				if (water) {
					this.waterArena.free(water);
					waterSlots.push(water);
				}

				this.releaseOrigin(entry.originSlot);
			}

			for (
				let levelIndex = 0;
				levelIndex < straightByLevel.length;
				levelIndex++
			) {
				const straightSlots = straightByLevel[levelIndex];

				if (straightSlots.length > 0) {
					this.terrainStraight[levelIndex].removeSlots(straightSlots);
				}

				const reversedSlots = reversedByLevel[levelIndex];

				if (reversedSlots.length > 0) {
					this.terrainReversed[levelIndex].removeSlots(reversedSlots);
				}
			}

			if (waterSlots.length > 0) {
				this.waterReversed.removeSlots(waterSlots);
			}

			for (let i = 0; i < evictKeys.length; i++) {
				this.tiles.delete(evictKeys[i]);
			}
		}

		frameProfiler.end("farTiles");
	}

	public handleResult(data: FarTileGeneratedMessage): void {
		const key = this.keyByRequestId.get(data.requestId);
		this.keyByRequestId.delete(data.requestId);

		if (key === undefined) return;
		this.pendingByKey.delete(key);

		// Stale result for an unloaded tile — drop it.
		if (!this.engine) return;
		if (!this.pendingIsStillWanted(data.levelIndex, data.tileX, data.tileZ)) {
			return;
		}

		const levels = getFarTileLevels();
		const lv = levels[data.levelIndex];
		if (!lv) return;

		const arena = this.terrainArenas[data.levelIndex];
		if (!arena) return;

		const opaqueCount = data.opaqueFaces.length >>> 2;
		const waterCount = data.waterFaces.length >>> 2;

		const opaqueSlot = opaqueCount > 0 ? arena.alloc(opaqueCount) : null;
		const waterSlot = waterCount > 0 ? this.waterArena.alloc(waterCount) : null;
		if ((opaqueCount > 0 && !opaqueSlot) || (waterCount > 0 && !waterSlot)) {
			// Arena full (binding-size cap) — drop the tile rather than
			// partially populating it. BUGFIX: roll back the side that DID
			// allocate, otherwise its faces leak (hole never recovered).
			if (opaqueSlot) arena.free(opaqueSlot);
			if (waterSlot) this.waterArena.free(waterSlot);
			console.warn(
				`[FarTileManager] arena full, dropping tile ${key} ` +
					`(opaque ${opaqueCount}, water ${waterCount}).`,
			);
			return;
		}

		const originSlot = this.allocOrigin(
			data.tileX * lv.tileSizeChunks * 32,
			data.tileZ * lv.tileSizeChunks * 32,
		);

		if (opaqueSlot && opaqueSlot.count > 0) {
			arena.cpu.set(data.opaqueFaces, opaqueSlot.base * FT_FACE_WORDS);
			stampOriginSlot(arena.cpu, opaqueSlot, originSlot);
			arena.pushDirty(opaqueSlot.base, opaqueSlot.count);

			// Partition faces into the straight/reversed winding meshes so
			// backface culling sees the intended orientation per face.
			const straight = this.terrainStraight[data.levelIndex];
			const reversed = this.terrainReversed[data.levelIndex];
			const base = opaqueSlot.base;
			for (let j = 0; j < opaqueCount; j++) {
				const backFace = (data.opaqueFaces[j * 4 + 1] >>> 20) & 1;
				if (backFace) straight.appendFace(base + j);
				else reversed.appendFace(base + j);
			}
		}
		if (waterSlot && waterSlot.count > 0) {
			this.waterArena.cpu.set(data.waterFaces, waterSlot.base * FT_FACE_WORDS);
			stampOriginSlot(this.waterArena.cpu, waterSlot, originSlot);
			this.waterArena.pushDirty(waterSlot.base, waterSlot.count);

			const waterBase = waterSlot.base;
			for (let j = 0; j < waterCount; j++) {
				this.waterReversed.appendFace(waterBase + j);
			}
		}

		const entry: TileEntry = {
			levelIndex: data.levelIndex,
			tx: data.tileX,
			tz: data.tileZ,
			opaque: opaqueSlot,
			water: waterSlot,
			originSlot,
		};
		this.tiles.set(key, entry);
	}

	/** Debug/profiling snapshot (HUD "Far" lines). */
	public getDebugStats(): {
		tiles: number;
		pending: number;
		uploadBytes: number;
		levels: {
			faces: number;
			capacity: number;
			straight: number;
			reversed: number;
		}[];
		water: { faces: number; capacity: number; instances: number };
		origins: { used: number; capacity: number; free: number };
	} {
		const levels = this.terrainArenas.map((arena, i) => ({
			faces: arena.appendedFaces,
			capacity: arena.capacityFaces,
			straight: this.terrainStraight[i]?.count ?? 0,
			reversed: this.terrainReversed[i]?.count ?? 0,
		}));
		return {
			tiles: this.tiles.size,
			pending: this.pendingByKey.size,
			uploadBytes: _farUploadBytesThisFrame,
			levels,
			water: {
				faces: this.waterArena.appendedFaces,
				capacity: this.waterArena.capacityFaces,
				instances: this.waterReversed.count,
			},
			origins: {
				used: this.nextOriginSlot - this.originFreeSlots.length,
				capacity: this.originCapacitySlots,
				free: this.originFreeSlots.length,
			},
		};
	}

	public setFarTilesVisible(visible: boolean): void {
		for (const wm of this.terrainStraight) {
			if (wm.mesh) (wm.mesh as FarMeshLike).isVisible = visible;
		}
		for (const wm of this.terrainReversed) {
			if (wm.mesh) (wm.mesh as FarMeshLike).isVisible = visible;
		}
		if (this.waterReversed.mesh) {
			(this.waterReversed.mesh as FarMeshLike).isVisible = visible;
		}
	}

	public isFarTilesVisible(): boolean {
		for (let i = 0; i < this.terrainReversed.length; i++) {
			const mesh = this.terrainReversed[i].mesh;

			if (mesh) {
				return mesh.isVisible !== false;
			}
		}

		return true;
	}

	private pendingIsStillWanted(
		levelIndex: number,
		tx: number,
		tz: number,
	): boolean {
		if (Number.isNaN(this.lastPlayerChunkX)) return false;

		const levels = getFarTileLevels();
		const lv = levels[levelIndex];
		if (!lv) return false;

		const span = lv.tileSizeChunks;
		const half = span / 2;
		const centerX = tx * span + half;
		const centerZ = tz * span + half;
		const d = Math.max(
			Math.abs(centerX - this.lastPlayerChunkX),
			Math.abs(centerZ - this.lastPlayerChunkZ),
		);

		return (
			d >= lv.ringInnerChunks && d < lv.ringOuterChunks + UNLOAD_MARGIN_CHUNKS
		);
	}

	// ------------------------------------------------------------------
	// Frame pump + GPU sync
	// ------------------------------------------------------------------

	private frame(): void {
		if (!this.engine) return;

		frameProfiler.begin("farTiles");
		_farUploadBytesThisFrame = 0;

		this.updateUniforms();

		for (const arena of this.terrainArenas) {
			arena.flushDirty();
		}
		this.waterArena.flushDirty();
		for (const wm of this.terrainStraight) wm.sync();
		for (const wm of this.terrainReversed) wm.sync();
		this.waterReversed.sync();
		this.flushOrigins();

		for (let i = 0; i < this.terrainArenas.length; i++) {
			this.ensureLevelMesh(i);
		}
		this.ensureWaterMesh();

		frameProfiler.end("farTiles");
	}

	private ensureLevelMesh(levelIndex: number): void {
		if (!this.engine || !this.scene) return;
		const arena = this.terrainArenas[levelIndex];
		const material = this.terrainMaterials[levelIndex];
		const straight = this.terrainStraight[levelIndex];
		const reversed = this.terrainReversed[levelIndex];
		// Mesh creation binds the arena's storage buffer, so wait until the
		// first tile arrival actually materialized one.
		if (!arena || !material || !arena.buffer || !this.originsBuffer) return;

		if (!straight.mesh) {
			const mesh = createQuadInstanceMesh(
				this.engine,
				`farTilesLod${6 + levelIndex}s`,
				STRAIGHT_INDICES,
			);
			mesh.material = material;
			mesh.pickable = false;
			// Explicit placement AFTER chunk opaque/cutout groups (order 0) —
			// equal-depth coplanar cases resolve toward the real chunks.
			mesh.renderOrder = 90;
			bindFarTileBuffers(material, arena.buffer, this.originsBuffer);
			addToScene(this.scene, mesh);
			straight.mesh = mesh;
		}
		if (!reversed.mesh) {
			const mesh = createQuadInstanceMesh(
				this.engine,
				`farTilesLod${6 + levelIndex}r`,
				REVERSED_INDICES,
			);
			mesh.material = material;
			mesh.pickable = false;
			mesh.renderOrder = 90;
			bindFarTileBuffers(material, arena.buffer, this.originsBuffer);
			addToScene(this.scene, mesh);
			reversed.mesh = mesh;
		}
		if (arena.bufferRebound) {
			bindFarTileBuffers(material, arena.buffer, this.originsBuffer);
		}
		syncThinInstanceCount(straight.mesh, straight);
		syncThinInstanceCount(reversed.mesh, reversed);
		arena.bufferRebound = false;
	}

	private ensureWaterMesh(): void {
		if (!this.engine || !this.scene || !this.waterMaterial) return;
		const arena = this.waterArena;
		if (!arena.buffer || !this.originsBuffer) return;

		if (!this.waterReversed.mesh) {
			const mesh = createQuadInstanceMesh(
				this.engine,
				"farTilesWater",
				REVERSED_INDICES,
			);
			mesh.material = this.waterMaterial;
			mesh.pickable = false;
			// After far terrain (90); chunk water is a transparent-pass mesh
			// (order 1) that always draws after the whole opaque bucket.
			mesh.renderOrder = 95;
			bindFarTileBuffers(this.waterMaterial, arena.buffer, this.originsBuffer);
			addToScene(this.scene, mesh);
			this.waterReversed.mesh = mesh;
		} else if (arena.bufferRebound) {
			bindFarTileBuffers(this.waterMaterial, arena.buffer, this.originsBuffer);
		}
		syncThinInstanceCount(this.waterReversed.mesh, this.waterReversed);
		arena.bufferRebound = false;
	}

	// ------------------------------------------------------------------
	// Tile-origin table
	// ------------------------------------------------------------------

	private ensureOrigins(slots: number): void {
		if (slots <= this.originCapacitySlots) return;
		const cap = Math.max(slots, this.originCapacitySlots * 2 || 1024);
		const next = new Float32Array(cap * 2);
		next.set(this.origins);
		this.origins = next;
		this.originCapacitySlots = cap;

		if (this.originsBuffer) {
			disposeBufferAfterGpuWork(this.originsBuffer);
		}
		this.originsBuffer = createStorageBuffer(
			this.engine!,
			this.origins,
			"farTileOrigins",
		);
		// Rebind everywhere; materials may not have meshes yet (harmless).
		for (const m of this.terrainMaterials) {
			setShaderStorageBuffer(m, "tileOrigins", this.originsBuffer);
		}
		if (this.waterMaterial) {
			setShaderStorageBuffer(
				this.waterMaterial,
				"tileOrigins",
				this.originsBuffer,
			);
		}
		// createStorageBuffer seeded the new GPU buffer with the full CPU
		// contents — no re-upload needed.
		this.originsDirtyMin = Number.POSITIVE_INFINITY;
		this.originsDirtyMax = 0;
	}

	private allocOrigin(worldX: number, worldZ: number): number {
		const popped = this.originFreeSlots.pop();
		const slot = popped !== undefined ? popped : this.nextOriginSlot++;
		if (slot + 1 > this.originCapacitySlots) this.ensureOrigins(slot + 1);
		this.origins[slot * 2] = worldX;
		this.origins[slot * 2 + 1] = worldZ;
		// PERF: ranged dirty tracking — flushOrigins used to re-upload the
		// ENTIRE origins buffer on every tile arrival.
		if (slot < this.originsDirtyMin) this.originsDirtyMin = slot;
		if (slot + 1 > this.originsDirtyMax) this.originsDirtyMax = slot + 1;
		return slot;
	}

	private releaseOrigin(slot: number): void {
		this.originFreeSlots.push(slot);
	}

	private flushOrigins(): void {
		if (
			!engineRef ||
			!this.originsBuffer ||
			!Number.isFinite(this.originsDirtyMin)
		) {
			return;
		}
		const lo = this.originsDirtyMin * 2;
		const hi = this.originsDirtyMax * 2;
		this.originsDirtyMin = Number.POSITIVE_INFINITY;
		this.originsDirtyMax = 0;
		updateStorageBuffer(
			engineRef,
			this.originsBuffer,
			this.origins.subarray(lo, hi),
			lo * 4,
		);
		_farUploadBytesThisFrame += (hi - lo) * 4;
	}

	// ------------------------------------------------------------------
	// Uniforms
	// ------------------------------------------------------------------

	private updateUniforms(): void {
		const waterMaterial = this.waterMaterial;
		const terrainMaterials = this.terrainMaterials;
		const terrainMaterialCount = terrainMaterials.length;

		if (terrainMaterialCount === 0 || !waterMaterial) {
			return;
		}

		const lightDir = GLOBAL_VALUES.skyLightDirection;
		const shaderDirY = -lightDir.y;

		const interpolation = (shaderDirY + 0.2) / 0.4;
		const clampedInterpolation =
			interpolation < 0 ? 0 : interpolation > 1 ? 1 : interpolation;

		const rawBlend = 1 - clampedInterpolation;
		const blend = rawBlend * rawBlend * (3 - 2 * rawBlend);
		const inverseBlend = 1 - blend;

		const lightX = -lightDir.x * inverseBlend;
		const lightY = -lightDir.y * inverseBlend + blend;
		const lightZ = -lightDir.z * inverseBlend;

		const rawIntensity = (-lightDir.y + 0.1) * 4;
		const intensity =
			rawIntensity < 0 ? 0 : rawIntensity > 1 ? 1 : rawIntensity;

		// A module-level helper avoids allocating a closure every frame.
		const lightXQuantized = quantize256(lightX);
		const lightYQuantized = quantize256(lightY);
		const lightZQuantized = quantize256(lightZ);
		const intensityQuantized = quantize256(intensity);

		const camera = this.scene?.camera;
		const cameraPosition = camera ? getCameraPosition(camera) : null;

		const underWater = cameraPosition
			? isEyeUnderwater(cameraPosition.x, cameraPosition.y, cameraPosition.z)
			: false;

		const fogStart = MapFog.getFogStart(underWater);
		const fogEnd = MapFog.getFogEnd(underWater);
		const fogColor = MapFog.getFogColor(underWater);
		const fogInverseRange = 1 / Math.max(fogEnd - fogStart, 1e-4);

		const lightingChanged =
			lightXQuantized !== this.lastLx ||
			lightYQuantized !== this.lastLy ||
			lightZQuantized !== this.lastLz ||
			intensityQuantized !== this.lastSunIntensity;

		const fogChanged =
			underWater !== this.lastUnderWater ||
			fogStart !== this.lastFogStart ||
			fogEnd !== this.lastFogEnd ||
			fogColor[0] !== this.lastFogColorR ||
			fogColor[1] !== this.lastFogColorG ||
			fogColor[2] !== this.lastFogColorB ||
			fogInverseRange !== this.lastFogInvRange;

		if (!lightingChanged && !fogChanged) {
			return;
		}

		if (lightingChanged) {
			const scratch = this.lightDirScratch;
			scratch[0] = lightXQuantized;
			scratch[1] = lightYQuantized;
			scratch[2] = lightZQuantized;

			this.lastLx = lightXQuantized;
			this.lastLy = lightYQuantized;
			this.lastLz = lightZQuantized;
			this.lastSunIntensity = intensityQuantized;

			// Avoid [...terrainMaterials, waterMaterial], which allocated a new
			// array whenever either group of uniforms changed.
			for (let i = 0; i < terrainMaterialCount; i++) {
				const material = terrainMaterials[i];
				setShaderUniform(material, "lightDirection", scratch);
				setShaderUniform(material, "sunLightIntensity", intensityQuantized);
			}

			setShaderUniform(waterMaterial, "lightDirection", scratch);
			setShaderUniform(waterMaterial, "sunLightIntensity", intensityQuantized);
		}

		if (fogChanged) {
			const fogInfos = this.fogInfosScratch;
			fogInfos[0] = 0;
			fogInfos[1] = fogStart;
			fogInfos[2] = fogEnd;
			fogInfos[3] = 0;

			const fogColorScratch = this.fogColorScratch;
			fogColorScratch[0] = fogColor[0];
			fogColorScratch[1] = fogColor[1];
			fogColorScratch[2] = fogColor[2];

			this.lastUnderWater = underWater;
			this.lastFogStart = fogStart;
			this.lastFogEnd = fogEnd;
			this.lastFogColorR = fogColor[0];
			this.lastFogColorG = fogColor[1];
			this.lastFogColorB = fogColor[2];
			this.lastFogInvRange = fogInverseRange;

			for (let i = 0; i < terrainMaterialCount; i++) {
				const material = terrainMaterials[i];
				setShaderUniform(material, "fogInfos", fogInfos);
				setShaderUniform(material, "fogColor", fogColorScratch);
				setShaderUniform(material, "fogInvRange", fogInverseRange);
			}

			setShaderUniform(waterMaterial, "fogInfos", fogInfos);
			setShaderUniform(waterMaterial, "fogColor", fogColorScratch);
			setShaderUniform(waterMaterial, "fogInvRange", fogInverseRange);
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stamp the tile-origin slot into word3 bits 8-23 of every face in a slot. */
function stampOriginSlot(
	cpu: Uint32Array,
	slot: FarSlot,
	originSlot: number,
): void {
	const mask = (originSlot & 0xffff) << 8;
	let w = slot.base * FT_FACE_WORDS + 3;
	for (let j = 0; j < slot.count; j++) {
		cpu[w] = (cpu[w] & 0xff) | mask;
		w += FT_FACE_WORDS;
	}
}

function createQuadInstanceMesh(
	engine: EngineContext,
	name: string,
	indices: Uint32Array,
): FarMeshLike {
	const mesh = createMeshFromData(
		engine,
		name,
		QUAD_POSITIONS,
		QUAD_NORMALS,
		indices,
	) as FarMeshLike;

	// Seed compact thin instances at count 0 so an empty level draws nothing
	// (without thinInstances the base quad itself would render).
	setThinInstances(mesh, new Float32Array(4), 1);
	const ti = (mesh as FarMeshLike).thinInstances;
	if (ti) {
		ti.compact = true;
		ti._capacity = 1;
		ti.count = 0;
		ti._dirtyMin = 0;
		ti._dirtyMax = 0;
	}
	return mesh;
}

/**
 * Compact thin-instance sync — same two-path strategy as PackedChunkMesh's
 * setThinInstancesRange: full setThinInstances only when the GPU buffer must
 * (re)grow, otherwise mutate count/dirty-range in place so lite uploads just
 * the changed lanes. Records carry absolute face indices (written by
 * WindingMesh.appendFace/removeSlot, which track the dirty lane range with
 * an Infinity sentinel).
 */
function syncThinInstanceCount(mesh: FarMeshLike, wm: WindingMesh): void {
	const count = wm.count;
	const capacity = wm.capacityFaces;
	if (capacity === 0 && count === 0) {
		wm.clearDirty();
		return;
	}

	const anyMesh = mesh as FarMeshLike;
	let ti = anyMesh.thinInstances;
	const needsGrowth = !ti?._gpuBuffer || capacity > (ti._capacity ?? 0);

	if (needsGrowth && capacity > 0) {
		setThinInstances(mesh, wm.records, capacity);
		ti = anyMesh.thinInstances;
		if (ti) {
			ti.compact = true;
			ti._capacity = capacity;
			ti.count = count;
			ti._dirtyMin = 0;
			ti._dirtyMax = count;
		}
		wm.clearDirty();
		return;
	}

	if (!ti) {
		wm.clearDirty();
		return;
	}
	ti.matrices = wm.records;
	ti.count = count;

	if (wm.dirtyMax > wm.dirtyMin && Number.isFinite(wm.dirtyMin)) {
		const lo = Math.max(0, wm.dirtyMin);
		const hi = Math.min(count, wm.dirtyMax);
		if (hi > lo) {
			ti._dirtyMin = Math.min(ti._dirtyMin, lo);
			ti._dirtyMax = Math.max(ti._dirtyMax, hi);
		}
	}
	wm.clearDirty();
}

function maxFarFacesPerArena(): number {
	const engine = engineRef;
	if (!engine) return 1 << 20;
	const device = (engine as EngineWithDevice)._device;
	const limit =
		typeof device?.limits?.maxStorageBufferBindingSize === "number"
			? device.limits.maxStorageBufferBindingSize
			: 128 * 1024 * 1024;
	return Math.max(1, Math.floor(limit / FT_FACE_BYTES));
}

interface EngineWithDevice extends EngineContext {
	_device?: GPUDevice;
}

export const FarTileManager = {
	init(engine: EngineContext, scene: SceneContext): void {
		FarTileManagerImpl.getInstance().init(engine, scene);
	},

	update(playerWorldX: number, playerWorldZ: number): void {
		if (!isFarTilesEnabled()) return;
		FarTileManagerImpl.getInstance().update(playerWorldX, playerWorldZ);
	},

	handleResult(data: FarTileGeneratedMessage): void {
		if (!isFarTilesEnabled()) return;
		FarTileManagerImpl.getInstance().handleResult(data);
	},

	isInitialized(): boolean {
		return FarTileManagerImpl.peekInstance()?.isReady() === true;
	},

	/** Debug/profiling snapshot (HUD "Far" lines). */
	getDebugStats(): {
		tiles: number;
		pending: number;
		uploadBytes: number;
		levels: {
			faces: number;
			capacity: number;
			straight: number;
			reversed: number;
		}[];
		water: { faces: number; capacity: number; instances: number };
		origins: { used: number; capacity: number; free: number };
	} | null {
		const impl = FarTileManagerImpl.peekInstance();
		if (!impl) return null;
		return impl.getDebugStats();
	},

	/** A/B toggle for GPU-side profiling (F6). */
	setFarTilesVisible(visible: boolean): void {
		FarTileManagerImpl.peekInstance()?.setFarTilesVisible(visible);
	},

	isFarTilesVisible(): boolean {
		return FarTileManagerImpl.peekInstance()?.isFarTilesVisible() ?? true;
	},
};
