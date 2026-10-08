import {
	addToScene,
	createMeshFromData,
	createStorageBuffer,
	disposeStorageBuffer,
	type EngineContext,
	getCameraPosition,
	getViewProjectionMatrix,
	type Mat4,
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
import { getGpuPressureFactor, onGpuWorkDone } from "../Light/liteGpuBuffer.js";
import { setMeshBaseVisible } from "../MeshVisibility";
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
// PERF: eviction hysteresis. WindingMesh.removeSlots marks its dirty range
// from the FIRST removed record to the end of the list (see removeSlots), and
// arena slots are handed out in arrival order, so evicted tiles are scattered
// throughout the instance arrays. That means one eviction dirties a range
// covering essentially every surviving record after it, and the range is
// re-uploaded as a 16 B/record writeBuffer. A 4-chunk margin re-evicts on the
// leading edge of every single chunk move, so most of that full re-upload
// cost was paid per 32 blocks travelled. 16 chunks absorbs leading-edge churn
// without meaningfully growing the resident set.
const UNLOAD_MARGIN_CHUNKS = 16;

/**
 * Collision-free key within JavaScript's safe-integer range:
 *
 * level: 1 bit at position 52
 * tx: 26 bits at positions 26-51
 * tz: 26 bits at positions 0-25
 *
 * This supports two levels safely. If more than two far-tile levels are used,
 * use bigint or string keys instead.
 */
const TILE_KEY_AXIS_BITS = 26;
const TILE_KEY_AXIS_SIZE = 2 ** TILE_KEY_AXIS_BITS;
const TILE_KEY_AXIS_MASK = TILE_KEY_AXIS_SIZE - 1;
const TILE_KEY_LEVEL_MULTIPLIER = 2 ** (TILE_KEY_AXIS_BITS * 2);
const TILE_KEY_X_MULTIPLIER = TILE_KEY_AXIS_SIZE;

function packTileKey(levelIndex: number, tx: number, tz: number): number {
	const packedX = tx & TILE_KEY_AXIS_MASK;
	const packedZ = tz & TILE_KEY_AXIS_MASK;

	return (
		levelIndex * TILE_KEY_LEVEL_MULTIPLIER +
		packedX * TILE_KEY_X_MULTIPLIER +
		packedZ
	);
}

// Bytes per face word record (4 u32).
const FT_FACE_BYTES = 16;
const FT_FACE_WORDS = 4;

// Reverse-Z-aware frustum-plane extraction for the far-tile vertex cull.
// Mirrors OcclusionCuller.cacheFrustumPlanes: column-major VP, WebGPU clip
// 0 <= z <= w, reverse-Z (depth 1 at near, 0 at far) so the far plane is
// col2 (z_clip >= 0) and the near plane is col3 - col2 (z_clip <= w).
// Planes are normalised so the shader sphere test stays in world units.
function writeFarFrustumPlane(
	out: Float32Array,
	off: number,
	nx: number,
	ny: number,
	nz: number,
	d: number,
): void {
	const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
	out[off] = nx / len;
	out[off + 1] = ny / len;
	out[off + 2] = nz / len;
	out[off + 3] = d / len;
}

function extractFarFrustumPlanes(vp: Mat4, out: Float32Array): void {
	const m = vp as unknown as ArrayLike<number>;
	writeFarFrustumPlane(
		out,
		0,
		m[3] + m[0],
		m[7] + m[4],
		m[11] + m[8],
		m[15] + m[12],
	);
	writeFarFrustumPlane(
		out,
		4,
		m[3] - m[0],
		m[7] - m[4],
		m[11] - m[8],
		m[15] - m[12],
	);
	writeFarFrustumPlane(
		out,
		8,
		m[3] + m[1],
		m[7] + m[5],
		m[11] + m[9],
		m[15] + m[13],
	);
	writeFarFrustumPlane(
		out,
		12,
		m[3] - m[1],
		m[7] - m[5],
		m[11] - m[9],
		m[15] - m[13],
	);
	writeFarFrustumPlane(out, 16, m[2], m[6], m[10], m[14]);
	writeFarFrustumPlane(
		out,
		20,
		m[3] - m[2],
		m[7] - m[6],
		m[11] - m[10],
		m[15] - m[14],
	);
}

// Compact thin-instance record: one vec4<f32> per winding entry (see the
// compact-instance patch in @babylonjs/lite). Mirrors lite's
// `thin-instance-gpu.js` stride so the byte counters below match what the
// driver actually receives.
const FAR_INSTANCE_STRIDE = 16;

// Shared unit quad — same constants PackedChunkMesh uses. Vertex shader
// derives real positions from the face words; this buffer only feeds the
// mandatory position attribute.
const QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]);
const QUAD_NORMALS = new Float32Array(12);

// GPU upload bytes flushed during the current frame (reset in frame()).
let _farUploadBytesThisFrame = 0;

// PERF DIAGNOSTIC: winding-record (thin-instance) upload accounting, tracked
// separately from the face-word bytes above. These two are uploaded by
// DIFFERENT code paths at different times — face words go through
// updateStorageBuffer in flushDirty/flushOrigins (visible in DevTools as
// `updateStorageBuffer`), while the compact 16 B/face instance records are
// drained later by Lite's thin-instance sync during _record() and surface only
// as the opaque native `writeBuffer`. Without this counter the HUD's
// "up:KiB/f" line cannot see the most likely large upload at all.
let _farInstanceBytesThisFrame = 0;
let _farInstanceFullUploads = 0;
let _farInstanceRangedUploads = 0;
let _farInstanceCalls = 0;

interface FarSlot {
	base: number; // first face index in the arena
	count: number; // face count
}

interface FarMeshLike extends Mesh {
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

	public hasDirty(): boolean {
		return this.dirtyStarts.length > 0;
	}

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
		this.buffer = createStorageBuffer(engineRef!, this.cpu, {
			label: "farTileFaces",
			cpuShadow: "source",
		});

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

/**
 * Effective base visibility for every far-tile mesh — the F6 diagnostic toggle
 * ANDed with the underwater gate. Kept at module scope so a mesh attached later
 * (level setup can run at any time, including while submerged) is born in the
 * right state instead of needing a follow-up sweep.
 */
let farTilesBaseVisible = true;

class WindingMesh {
	mesh: FarMeshLike | null = null;
	// PERF: pre-seeded for 1024 faces (16 KiB). Starting empty caused a
	// doubling cascade (256→512→1024 faces) with a full GPU re-upload on
	// every growth step during the initial streaming burst.
	records = new Float32Array(4096);
	count = 0;
	capacityFaces = 1024;

	dirtyMin = Number.POSITIVE_INFINITY;
	dirtyMax = 0;

	private recordsSortedByFaceIndex = true;

	/**
	 * Count changes must trigger synchronization even when no surviving
	 * records moved. This occurs when removal only trims records from the end.
	 */
	private countDirty = false;

	readonly straight: boolean;

	constructor(straight: boolean) {
		this.straight = straight;
	}

	hasPendingSync(): boolean {
		return this.countDirty || this.dirtyMax > this.dirtyMin;
	}

	appendFace(faceIndex: number): void {
		this.ensureRecordCapacity(this.count + 1);

		const oldCount = this.count;

		if (
			this.recordsSortedByFaceIndex &&
			oldCount > 0 &&
			faceIndex < this.records[(oldCount - 1) * 4]
		) {
			this.recordsSortedByFaceIndex = false;
		}

		const offset = oldCount * 4;
		const records = this.records;

		records[offset] = faceIndex;
		records[offset + 1] = 0;
		records[offset + 2] = 0;
		records[offset + 3] = 0;

		this.count = oldCount + 1;
		this.countDirty = true;
		this.markDirty(oldCount, oldCount + 1);
	}

	/**
	 * Allocation-free removal of every record whose face index belongs to
	 * the supplied arena slot.
	 */
	removeSlot(slot: FarSlot): void {
		const oldCount = this.count;

		if (oldCount === 0 || slot.count <= 0) {
			return;
		}

		const removeStart = slot.base;
		const removeEnd = removeStart + slot.count;
		const records = this.records;

		let write = 0;
		let firstChanged = Number.POSITIVE_INFINITY;

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

				records[targetOffset] = faceIndex;
				records[targetOffset + 1] = records[sourceOffset + 1];
				records[targetOffset + 2] = records[sourceOffset + 2];
				records[targetOffset + 3] = records[sourceOffset + 3];
			}

			write++;
		}

		if (write === oldCount) {
			return;
		}

		this.count = write;
		this.countDirty = true;

		// Only surviving records need uploading. If removal trimmed the tail,
		// this range can be empty, but countDirty still forces count sync.
		if (firstChanged < write) {
			this.markDirty(firstChanged, write);
		}
	}

	/**
	 * Batched, order-preserving removal.
	 *
	 * The slot array is sorted in place. Slot objects themselves are not
	 * modified.
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
		const recordsSorted = this.recordsSortedByFaceIndex;

		let write = 0;
		let intervalIndex = 0;
		let firstChanged = Number.POSITIVE_INFINITY;

		let previousKeptFaceIndex = Number.NEGATIVE_INFINITY;
		let keptRecordsRemainSorted = true;

		for (let read = 0; read < oldCount; read++) {
			const sourceOffset = read * 4;
			const faceIndex = records[sourceOffset];
			let remove = false;

			if (recordsSorted) {
				while (intervalIndex < slotCount) {
					const interval = slots[intervalIndex];

					if (
						interval.count <= 0 ||
						faceIndex >= interval.base + interval.count
					) {
						intervalIndex++;
						continue;
					}

					break;
				}

				if (intervalIndex < slotCount) {
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
				// Records can become unordered when an arena hole is reused.
				// Find the first interval whose end exceeds faceIndex.
				let low = 0;
				let high = slotCount;

				while (low < high) {
					const middle = (low + high) >>> 1;
					const interval = slots[middle];

					if (
						interval.count <= 0 ||
						interval.base + interval.count <= faceIndex
					) {
						low = middle + 1;
					} else {
						high = middle;
					}
				}

				if (low < slotCount) {
					const interval = slots[low];

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

				records[targetOffset] = faceIndex;
				records[targetOffset + 1] = records[sourceOffset + 1];
				records[targetOffset + 2] = records[sourceOffset + 2];
				records[targetOffset + 3] = records[sourceOffset + 3];
			}

			write++;
		}

		if (write === oldCount) {
			return;
		}

		this.count = write;
		this.countDirty = true;
		this.recordsSortedByFaceIndex = keptRecordsRemainSorted;

		if (firstChanged < write) {
			this.markDirty(firstChanged, write);
		}
	}

	sync(): void {
		const requiredLanes = this.count * 4;
		const currentLanes = this.records.length;

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
			let capacity = 1024;
			const target = Math.max(1024, requiredLanes * 2);

			while (capacity < target) {
				capacity *= 2;
			}

			const next = new Float32Array(capacity);

			if (requiredLanes > 0) {
				next.set(this.records.subarray(0, requiredLanes));
			}

			this.records = next;
			this.markDirty(0, this.count);
		}

		this.capacityFaces = this.records.length >>> 2;
	}

	clearSyncState(): void {
		this.dirtyMin = Number.POSITIVE_INFINITY;
		this.dirtyMax = 0;
		this.countDirty = false;
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

		if (this.count > 0) {
			next.set(this.records.subarray(0, this.count * 4));
		}

		this.records = next;
		this.capacityFaces = capacity >>> 2;

		if (this.count > 0) {
			this.markDirty(0, this.count);
		}
	}

	private markDirty(start: number, end: number): void {
		if (end <= start) {
			return;
		}

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
	// PERF: pre-seeded for 16k faces (256 KiB). The old 4k start forced a
	// ×4 growth cascade (full buffer re-create + rebind + full re-upload)
	// during every initial streaming burst in ocean regions.
	private waterArena = new FaceWordArena(16384);
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

	// F6 A/B state. Hiding far tiles must also STOP their uploads, otherwise
	// the toggle only removes draw work and cannot attribute a `writeBuffer`
	// spike to this subsystem. Gating frame() on this makes the toggle a real
	// A/B: dirty ranges are left intact and drain when visibility returns.
	private farTilesVisible = true;

	// Draw-only gate: far tiles reach hundreds of blocks out while underwater
	// fog is fully opaque at 100 (MapFog.fogEndUnderWater), so every fragment
	// they would shade is fog colour anyway. Streaming/uploads keep running so
	// the horizon is ready the instant the eye breaks the surface.
	private farTilesUnderwater = false;

	private readonly tiles = new Map<number, TileEntry>();
	private readonly pendingByKey = new Set<number>();
	private readonly keyByRequestId = new Map<number, number>();

	private lastPlayerChunkX = Number.NaN;
	private lastPlayerChunkZ = Number.NaN;

	// Reused scratch arrays for update() — avoids per-frame allocations
	private _wantedKeys: number[] = [];
	private _wantedLevels: number[] = [];
	private _wantedTx: number[] = [];
	private _wantedTz: number[] = [];
	private _wantedDist: number[] = [];
	private _evictKeys: number[] = [];
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

	// GPU frustum-cull planes fed to the far-tile vertex shaders (world-space
	// inward normals, packed 6×vec4). Same extraction as OcclusionCuller's
	// reverse-Z-aware cacheFrustumPlanes. Updated when the VP matrix changes;
	// all-zero until the first update means "never cull".
	private frustumPlanesScratch = new Float32Array(24);
	private frustumPlanesBuffer: StorageBuffer | null = null;
	private lastFrustumVP = new Float32Array(16);
	private frustumPlanesInit = false;

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
			// PERF: pre-seeded for 32k faces (512 KiB/level). The old 8k
			// start forced a ×4 growth cascade (full buffer re-create +
			// rebind + full re-upload) during every initial streaming burst.
			this.terrainArenas.push(new FaceWordArena(32768));
			this.terrainStraight.push(new WindingMesh(true));
			this.terrainReversed.push(new WindingMesh(false));

			// Allocate per-level scratch arrays once.
			this._evictStraightByLevel.push([]);
			this._evictReversedByLevel.push([]);
		}

		this.waterMaterial = createFarTileWaterMaterial();
		// PERF: 4k origin slots (32 KiB) up front — a few hundred live
		// tiles plus churn never trips a mid-stream re-create + full rebind.
		this.ensureOrigins(4096);

		// GPU frustum-cull plane buffer (6×vec4, 96 B, shared by every
		// far-tile material). Zeros = never cull until the first VP upload.
		this.frustumPlanesBuffer = createStorageBuffer(
			engine,
			this.frustumPlanesScratch,
			{
				label: "farTileFrustumPlanes",
				cpuShadow: "source",
			},
		);
		for (const m of this.terrainMaterials) {
			setShaderStorageBuffer(m, "frustumPlanes", this.frustumPlanesBuffer);
		}
		setShaderStorageBuffer(
			this.waterMaterial,
			"frustumPlanes",
			this.frustumPlanesBuffer,
		);

		const pool = ChunkWorkerPool.getInstance();
		pool.onFarTileGenerated = (data) => this.handleResult(data);

		onBeforeRender(scene, () => this.frame());
	}

	public isReady(): boolean {
		return this.engine != null;
	}

	public reset(): void {
		for (const entry of this.tiles.values()) {
			const levelIndex = entry.levelIndex;
			const arena = this.terrainArenas[levelIndex];
			if (arena && entry.opaque) {
				arena.free(entry.opaque);
			}
			if (entry.opaque) {
				this.terrainStraight[levelIndex].removeSlot(entry.opaque);
				this.terrainReversed[levelIndex].removeSlot(entry.opaque);
			}
			if (entry.water) {
				this.waterArena.free(entry.water);
				this.waterReversed.removeSlot(entry.water);
			}
			this.releaseOrigin(entry.originSlot);
		}

		this.tiles.clear();
		this.pendingByKey.clear();
		this.keyByRequestId.clear();
		this.lastPlayerChunkX = Number.NaN;
		this.lastPlayerChunkZ = Number.NaN;
		ChunkWorkerPool.getInstance().resetFarTileRequests();
	}

	// ------------------------------------------------------------------
	// Streaming
	// ------------------------------------------------------------------

	public update(playerWorldX: number, playerWorldZ: number): void {
		if (!this.engine) return;

		frameProfiler.begin("farTiles");

		try {
			const levels = getFarTileLevels();
			const pcx = Math.floor(playerWorldX / 32);
			const pcz = Math.floor(playerWorldZ / 32);

			if (pcx === this.lastPlayerChunkX && pcz === this.lastPlayerChunkZ) {
				return;
			}

			this.lastPlayerChunkX = pcx;
			this.lastPlayerChunkZ = pcz;

			/*
			 * Keep only the nearest MAX_TILE_REQUESTS_PER_UPDATE candidates.
			 * These existing arrays now remain bounded to 24 entries rather than
			 * growing to contain every tile in every level's search rectangle.
			 */
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

			// GPU back-pressure: when the device queue is far behind (see
			// liteGpuBuffer.publishGpuPressure), scheduling more tiles only
			// appends faces + uploads the GPU cannot retire — the ms climb in
			// the profiler. Scale the 24/update intake by the pressure factor
			// (1 = healthy, 0 = saturated) instead of changing distances.
			// Eviction below still runs so dead tiles free GPU while stalled.
			const pressureFactor = getGpuPressureFactor();
			const requestBudget =
				pressureFactor <= 0
					? 0
					: Math.min(
							MAX_TILE_REQUESTS_PER_UPDATE,
							Math.max(
								4,
								Math.ceil(
									MAX_TILE_REQUESTS_PER_UPDATE * pressureFactor,
								),
							),
						);

			let wantedCount = 0;
			let worstIndex = -1;
			let worstDistance = Number.NEGATIVE_INFINITY;

			/*
			 * Skip the loading-window scan completely when GPU pressure has
			 * reduced the intake budget to zero. Eviction still runs below.
			 */
			if (requestBudget > 0) {
				for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
					const level = levels[levelIndex];
					const span = level.tileSizeChunks;
					const halfSpan = span * 0.5;

					const outer = level.ringOuterChunks;
					const inner = level.ringInnerChunks;
					const unloadOuter = outer + UNLOAD_MARGIN_CHUNKS;

					const txMin = Math.floor((pcx - outer) / span);
					const txMax = Math.floor((pcx + outer) / span);
					const tzMin = Math.floor((pcz - outer) / span);
					const tzMax = Math.floor((pcz + outer) / span);

					for (let tx = txMin; tx <= txMax; tx++) {
						const distanceX = Math.abs(tx * span + halfSpan - pcx);

						/*
						 * Chebyshev distance can never become smaller than
						 * distanceX, regardless of tz. Skip the whole column
						 * when it cannot intersect the level's loading window.
						 */
						if (distanceX >= unloadOuter) {
							continue;
						}

						for (let tz = tzMin; tz <= tzMax; tz++) {
							const distanceZ = Math.abs(tz * span + halfSpan - pcz);
							const distance =
								distanceX > distanceZ ? distanceX : distanceZ;

							if (distance < inner || distance >= unloadOuter) {
								continue;
							}

							/*
							 * Once the bounded candidate list is full, candidates
							 * farther away than its current worst entry cannot
							 * enter the nearest-24 set. Avoid key creation and
							 * Map/Set lookups for those candidates.
							 *
							 * Use <= so equal-distance candidates retain the
							 * original first-encountered behavior.
							 */
							if (
								wantedCount >= requestBudget &&
								distance >= worstDistance
							) {
								continue;
							}

							const key = packTileKey(levelIndex, tx, tz);

							if (this.tiles.has(key) || this.pendingByKey.has(key)) {
								continue;
							}

							if (wantedCount < requestBudget) {
								const index = wantedCount++;

								wantedKeys[index] = key;
								wantedLevels[index] = levelIndex;
								wantedTx[index] = tx;
								wantedTz[index] = tz;
								wantedDist[index] = distance;

								if (distance > worstDistance) {
									worstDistance = distance;
									worstIndex = index;
								}

								continue;
							}

							/*
							 * Replace the farthest retained candidate. Finding the
							 * new farthest item scans at most 24 entries, so this
							 * is bounded constant work rather than a scan over
							 * every discovered candidate.
							 */
							wantedKeys[worstIndex] = key;
							wantedLevels[worstIndex] = levelIndex;
							wantedTx[worstIndex] = tx;
							wantedTz[worstIndex] = tz;
							wantedDist[worstIndex] = distance;

							worstIndex = 0;
							worstDistance = wantedDist[0];

							for (let i = 1; i < wantedCount; i++) {
								if (wantedDist[i] > worstDistance) {
									worstDistance = wantedDist[i];
									worstIndex = i;
								}
							}
						}
					}
				}
			}

			/*
			 * Sort the retained candidates nearest-first. Insertion sort is a
			 * good fit because the list contains at most 24 entries and avoids
			 * creating comparator closures or candidate objects.
			 */
			for (let i = 1; i < wantedCount; i++) {
				const key = wantedKeys[i];
				const levelIndex = wantedLevels[i];
				const tx = wantedTx[i];
				const tz = wantedTz[i];
				const distance = wantedDist[i];

				let insertAt = i;

				while (insertAt > 0 && wantedDist[insertAt - 1] > distance) {
					wantedKeys[insertAt] = wantedKeys[insertAt - 1];
					wantedLevels[insertAt] = wantedLevels[insertAt - 1];
					wantedTx[insertAt] = wantedTx[insertAt - 1];
					wantedTz[insertAt] = wantedTz[insertAt - 1];
					wantedDist[insertAt] = wantedDist[insertAt - 1];
					insertAt--;
				}

				wantedKeys[insertAt] = key;
				wantedLevels[insertAt] = levelIndex;
				wantedTx[insertAt] = tx;
				wantedTz[insertAt] = tz;
				wantedDist[insertAt] = distance;
			}

			const pool = ChunkWorkerPool.getInstance();

			for (let i = 0; i < wantedCount; i++) {
				const key = wantedKeys[i];
				const requestId = pool.scheduleFarTile(
					wantedLevels[i],
					wantedTx[i],
					wantedTz[i],
				);

				this.pendingByKey.add(key);
				this.keyByRequestId.set(requestId, key);
			}

			/*
			 * Find loaded tiles that have moved outside their level's active
			 * window. This Map scan is necessary because loaded tiles can come
			 * from any previous player position.
			 */
			const evictKeys = this._evictKeys;
			const evictEntries = this._evictEntries;

			evictKeys.length = 0;
			evictEntries.length = 0;

			for (const [key, entry] of this.tiles) {
				const level = levels[entry.levelIndex];
				if (!level) continue;

				const span = level.tileSizeChunks;
				const halfSpan = span * 0.5;
				const distanceX = Math.abs(entry.tx * span + halfSpan - pcx);
				const distanceZ = Math.abs(entry.tz * span + halfSpan - pcz);
				const distance = distanceX > distanceZ ? distanceX : distanceZ;

				if (
					distance >= level.ringOuterChunks + UNLOAD_MARGIN_CHUNKS ||
					distance < level.ringInnerChunks
				) {
					evictKeys.push(key);
					evictEntries.push(entry);
				}
			}

			if (evictEntries.length === 0) {
				return;
			}

			const straightByLevel = this._evictStraightByLevel;
			const reversedByLevel = this._evictReversedByLevel;
			const waterSlots = this._evictWaterSlots;

			waterSlots.length = 0;

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
				const opaque = entry.opaque;
				const water = entry.water;

				if (opaque) {
					const arena = this.terrainArenas[levelIndex];

					if (arena) {
						arena.free(opaque);
						straightByLevel[levelIndex].push(opaque);
						reversedByLevel[levelIndex].push(opaque);
					}
				}

				if (water) {
					this.waterArena.free(water);
					waterSlots.push(water);
				}

				this.releaseOrigin(entry.originSlot);
			}

			/*
			 * Compact each winding mesh once per level instead of once per tile.
			 * removeSlots() performs one record pass for all evicted slots.
			 */
			for (
				let levelIndex = 0;
				levelIndex < straightByLevel.length;
				levelIndex++
			) {
				const straightSlots = straightByLevel[levelIndex];

				if (straightSlots.length !== 0) {
					this.terrainStraight[levelIndex].removeSlots(straightSlots);
				}

				const reversedSlots = reversedByLevel[levelIndex];

				if (reversedSlots.length !== 0) {
					this.terrainReversed[levelIndex].removeSlots(reversedSlots);
				}
			}

			if (waterSlots.length !== 0) {
				this.waterReversed.removeSlots(waterSlots);
			}

			for (let i = 0; i < evictKeys.length; i++) {
				this.tiles.delete(evictKeys[i]);
			}
		} finally {
			/*
			 * Guarantees balanced profiler calls if scheduling or another
			 * dependency unexpectedly throws.
			 */
			frameProfiler.end("farTiles");
		}
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

			const straight = this.terrainStraight[data.levelIndex];
			const reversed = this.terrainReversed[data.levelIndex];
			const base = opaqueSlot.base;
			const faces = data.opaqueFaces;
			for (let j = 0; j < opaqueCount; j++) {
				const backFace = (faces[j * 4 + 1] >>> 20) & 1;
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
		instanceUploadBytes: number;
		instanceUploadFull: number;
		instanceUploadRanged: number;
		instanceUploadCalls: number;
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
			instanceUploadBytes: _farInstanceBytesThisFrame,
			instanceUploadFull: _farInstanceFullUploads,
			instanceUploadRanged: _farInstanceRangedUploads,
			instanceUploadCalls: _farInstanceCalls,
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

	private applyFarTilesVisibility(): void {
		const base = this.farTilesVisible && !this.farTilesUnderwater;
		if (base === farTilesBaseVisible) return;
		farTilesBaseVisible = base;

		for (const wm of this.terrainStraight) {
			if (wm.mesh) setMeshBaseVisible(wm.mesh, base);
		}
		for (const wm of this.terrainReversed) {
			if (wm.mesh) setMeshBaseVisible(wm.mesh, base);
		}
		if (this.waterReversed.mesh) {
			setMeshBaseVisible(this.waterReversed.mesh, base);
		}
	}

	public setFarTilesVisible(visible: boolean): void {
		this.farTilesVisible = visible;
		this.applyFarTilesVisibility();
	}

	public isFarTilesVisible(): boolean {
		return this.farTilesVisible;
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
		_farInstanceBytesThisFrame = 0;
		_farInstanceFullUploads = 0;
		_farInstanceRangedUploads = 0;
		_farInstanceCalls = 0;

		this.updateUniforms();

		// PERF: F6 A/B gate. When far tiles are hidden there is nothing to
		// draw, so skip their uploads too. Crucially this does NOT clear any
		// dirty state: the arena ranges, origin range, and winding dirty
		// ranges all survive, so re-enabling visibility drains the full
		// backlog in one frame. That is what makes the toggle a valid A/B for
		// "is the writeBuffer spike coming from far tiles?".
		if (!this.farTilesVisible) {
			frameProfiler.end("farTiles");
			return;
		}

		// PERF: idle early-out — sync/flush/ensure loops run even when no
		// tile arrived, no arena dirtied, and no mesh pending. Uniforms
		// above are self-guarded (quantized), so skipping the rest when
		// clean saves ~10 function calls + profiler noise per frame.
		if (!this.hasPendingFarWork()) {
			frameProfiler.end("farTiles");
			return;
		}

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

	private hasPendingFarWork(): boolean {
		for (let i = 0; i < this.terrainArenas.length; i++) {
			const arena = this.terrainArenas[i];

			if (arena.hasDirty()) {
				return true;
			}

			if (arena.bufferRebound) {
				return true;
			}

			if (
				arena.buffer &&
				arena.appendedFaces > 0 &&
				(!this.terrainStraight[i]?.mesh || !this.terrainReversed[i]?.mesh)
			) {
				return true;
			}

			if (this.terrainStraight[i].hasPendingSync()) {
				return true;
			}

			if (this.terrainReversed[i].hasPendingSync()) {
				return true;
			}
		}

		if (this.waterArena.hasDirty() || this.waterArena.bufferRebound) {
			return true;
		}

		if (Number.isFinite(this.originsDirtyMin)) {
			return true;
		}

		if (this.waterReversed.hasPendingSync()) {
			return true;
		}

		if (
			this.waterArena.buffer &&
			this.waterArena.appendedFaces > 0 &&
			!this.waterReversed.mesh
		) {
			return true;
		}

		return false;
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
			attachFarTileMesh(
				this.engine,
				this.scene,
				straight,
				`farTilesLod${6 + levelIndex}s`,
				STRAIGHT_INDICES,
				material,
				90,
				arena.buffer,
				this.originsBuffer,
				this.frustumPlanesBuffer,
			);
		}
		if (!reversed.mesh) {
			attachFarTileMesh(
				this.engine,
				this.scene,
				reversed,
				`farTilesLod${6 + levelIndex}r`,
				REVERSED_INDICES,
				material,
				90,
				arena.buffer,
				this.originsBuffer,
				this.frustumPlanesBuffer,
			);
		}
		if (arena.bufferRebound) {
			bindFarTileBuffers(
				material,
				arena.buffer,
				this.originsBuffer,
				this.frustumPlanesBuffer,
			);
		}
		// Engine perf: mesh is materialized above (early return when
		// arena/material missing); locals let TS narrow without assertions.
		const straightMesh = straight.mesh;
		const reversedMesh = reversed.mesh;
		if (straightMesh) syncThinInstanceCount(straightMesh, straight);
		if (reversedMesh) syncThinInstanceCount(reversedMesh, reversed);
		arena.bufferRebound = false;
	}

	private ensureWaterMesh(): void {
		if (!this.engine || !this.scene || !this.waterMaterial) return;
		const arena = this.waterArena;
		if (!arena.buffer || !this.originsBuffer) return;

		if (!this.waterReversed.mesh) {
			attachFarTileMesh(
				this.engine,
				this.scene,
				this.waterReversed,
				"farTilesWater",
				REVERSED_INDICES,
				this.waterMaterial,
				95,
				arena.buffer,
				this.originsBuffer,
				this.frustumPlanesBuffer,
			);
		} else if (arena.bufferRebound) {
			bindFarTileBuffers(
				this.waterMaterial,
				arena.buffer,
				this.originsBuffer,
				this.frustumPlanesBuffer,
			);
		}
		const waterMesh = this.waterReversed.mesh;
		if (waterMesh) syncThinInstanceCount(waterMesh, this.waterReversed);
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
		this.originsBuffer = createStorageBuffer(this.engine!, this.origins, {
			label: "farTileOrigins",
			cpuShadow: "source",
		});
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

		// GPU frustum-cull feed: recompute planes when the VP matrix changes
		// (translation OR rotation) and push to every far-tile material.
		// Runs independently of the lighting/fog early-out below — the camera
		// moves far more often than the sun/fog changes.
		if (camera && this.engine) {
			const canvas = this.engine.canvas;
			const aspect =
				canvas && canvas.height > 0 ? canvas.width / canvas.height : 1;
			const vp = getViewProjectionMatrix(camera, aspect);
			let vpChanged = !this.frustumPlanesInit;
			if (!vpChanged) {
				for (let i = 0; i < 16; i++) {
					if (
						Math.abs(
							(vp as unknown as ArrayLike<number>)[i] - this.lastFrustumVP[i],
						) > 1e-6
					) {
						vpChanged = true;
						break;
					}
				}
			}
			if (vpChanged) {
				extractFarFrustumPlanes(vp, this.frustumPlanesScratch);
				this.lastFrustumVP.set(vp as unknown as ArrayLike<number>);
				this.frustumPlanesInit = true;
				// One 96-byte ranged upload feeds every far-tile material
				// (shared buffer) — negligible vs the face/instance traffic.
				if (this.frustumPlanesBuffer) {
					updateStorageBuffer(
						this.engine,
						this.frustumPlanesBuffer,
						this.frustumPlanesScratch,
						0,
					);
				}
			}
		}

		const underWater = cameraPosition
			? isEyeUnderwater(cameraPosition.x, cameraPosition.y, cameraPosition.z)
			: false;

		if (underWater !== this.farTilesUnderwater) {
			this.farTilesUnderwater = underWater;
			this.applyFarTilesVisibility();
		}

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

// Engine perf: cold init path only (once per mesh). Dedupes the
// create→material→pickable→renderOrder→bind→addToScene sequence shared by
// terrain straight/reversed (order 90: after chunk opaque/cutout groups so
// equal-depth coplanar cases resolve toward real chunks) and water (order 95:
// after far terrain; chunk water is a transparent-pass mesh that always draws
// after the whole opaque bucket). Behavior identical.
function attachFarTileMesh(
	engine: EngineContext,
	scene: SceneContext,
	holder: WindingMesh,
	name: string,
	indices: Uint32Array,
	material: ShaderMaterial,
	renderOrder: number,
	arenaBuffer: StorageBuffer,
	originsBuffer: StorageBuffer,
	frustumPlanesBuffer?: StorageBuffer | null,
): void {
	const mesh = createQuadInstanceMesh(engine, name, indices);
	mesh.material = material;
	mesh.pickable = false;
	mesh.renderOrder = renderOrder;
	bindFarTileBuffers(
		material,
		arenaBuffer,
		originsBuffer,
		frustumPlanesBuffer ?? undefined,
	);
	addToScene(scene, mesh);
	holder.mesh = mesh;
	setMeshBaseVisible(mesh, farTilesBaseVisible);
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
	const existing = mesh.thinInstances;

	// PERF: records are pre-seeded (capacity 1024 at count 0), so the guard
	// is on count alone — an empty winding side draws nothing and must not
	// allocate a GPU instance buffer or log a phantom full upload.
	if (count === 0) {
		if (existing) {
			existing.count = 0;
		}

		wm.clearSyncState();
		return;
	}

	let thinInstances = existing;

	const needsGrowth =
		!thinInstances?._gpuBuffer || capacity > (thinInstances._capacity ?? 0);

	if (needsGrowth && capacity > 0) {
		setThinInstances(mesh, wm.records, capacity);
		thinInstances = mesh.thinInstances;

		if (thinInstances) {
			thinInstances.compact = true;
			thinInstances._capacity = capacity;
			thinInstances.count = count;
			thinInstances._dirtyMin = 0;
			thinInstances._dirtyMax = count;
		}

		// Growth reallocates the instance buffer, so the whole live range is
		// re-uploaded (16 B/face). Nine such meshes (4 levels x 2 winding
		// lists + water) can fire on one streaming burst.
		_farInstanceBytesThisFrame += count * FAR_INSTANCE_STRIDE;
		_farInstanceFullUploads++;
		_farInstanceCalls++;

		wm.clearSyncState();
		return;
	}

	if (!thinInstances) {
		wm.clearSyncState();
		return;
	}

	if (!thinInstances.compact) {
		thinInstances.compact = true;
		thinInstances._gpuVersion = -1;
	}

	thinInstances.matrices = wm.records;
	thinInstances.count = count;

	if (wm.dirtyMax > wm.dirtyMin && Number.isFinite(wm.dirtyMin)) {
		const low = Math.max(0, wm.dirtyMin);
		const high = Math.min(count, wm.dirtyMax);

		if (high > low) {
			const gpuIsCurrent = thinInstances._version === thinInstances._gpuVersion;

			thinInstances._dirtyMin = gpuIsCurrent
				? low
				: Math.min(thinInstances._dirtyMin, low);

			thinInstances._dirtyMax = gpuIsCurrent
				? high
				: Math.max(thinInstances._dirtyMax, high);

			thinInstances._version++;

			// A union with a still-pending range can widen this well beyond
			// [low, high); report what Lite will actually upload.
			const uploadLow = thinInstances._dirtyMin;
			const uploadHigh = Math.min(count, thinInstances._dirtyMax);
			const uploadCount = Math.max(0, uploadHigh - uploadLow);

			_farInstanceBytesThisFrame += uploadCount * FAR_INSTANCE_STRIDE;
			_farInstanceRangedUploads++;
			_farInstanceCalls++;
		}
	}

	wm.clearSyncState();
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

	reset(): void {
		FarTileManagerImpl.peekInstance()?.reset();
	},

	isInitialized(): boolean {
		return FarTileManagerImpl.peekInstance()?.isReady() === true;
	},

	/** Debug/profiling snapshot (HUD "Far" lines). */
	getDebugStats(): {
		tiles: number;
		pending: number;
		uploadBytes: number;
		instanceUploadBytes: number;
		instanceUploadFull: number;
		instanceUploadRanged: number;
		instanceUploadCalls: number;
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
