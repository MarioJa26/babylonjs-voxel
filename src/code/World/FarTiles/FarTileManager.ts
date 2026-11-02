import {
	addToScene,
	createMeshFromData,
	createStorageBuffer,
	disposeMeshGpu,
	disposeStorageBuffer,
	type EngineContext,
	getCameraPosition,
	getViewProjectionMatrix,
	type Mat4,
	type Mesh,
	onBeforeRender,
	onSceneDispose,
	removeFromScene,
	type SceneContext,
	type ShaderMaterial,
	type StorageBuffer,
	setShaderStorageBuffer,
	setShaderTexture,
	setShaderUniform,
	setThinInstances,
	updateStorageBuffer,
} from "@babylonjs/lite";
import MapFog from "@/code/Maps/MapFog";
import { getEyeLiquid } from "@/code/Maps/UnderWaterEffect";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import {
	type LiquidDefinition,
	WATER_LIQUID,
} from "@/code/World/Liquid/LiquidRegistry";
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
import { farTilePushDirtyRange } from "./FarTileDirtyRanges";
import { FAR_TILE_MAX_ORIGIN_SLOTS } from "./FarTileFaceFormat";
import type { FarTileLevelDef } from "./FarTileLadder";
import {
	BASE_CHUNK_SIZE,
	getFarTileLadderSignature,
	getFarTileLevels,
	isFarTilesEnabled,
} from "./FarTileLadder";
import {
	estimateFarTileFaceCapacity,
	farTileLoadWindow,
	farTileRetentionWindow,
	farTileRingTileCount,
	packTileKey,
	tileChebyshevDistanceChunks,
} from "./FarTileRingMath";

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

/**
 * Detaches a far-tile mesh from the scene and destroys its GPU state once
 * outstanding frames using it have completed. Far-tile meshes are throwaway
 * per-ladder objects: rebuilds always create fresh ones, so a retired mesh
 * is never expected to be re-added (lite retires disposed meshes anyway).
 */
function disposeWindingMesh(scene: SceneContext, wm: WindingMesh): void {
	const mesh = wm.mesh;

	if (!mesh) return;

	wm.mesh = null;

	removeFromScene(scene, mesh);

	if (engineRef) {
		void onGpuWorkDone(engineRef).then(() => disposeMeshGpu(mesh));
	}
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
		if (faceCount <= this.capacityFaces && this.buffer !== null) {
			return;
		}

		const maxFaces = maxFarFacesPerArena();

		let capacity: number;

		if (this.buffer === null) {
			// The GPU buffer was retired (ladder rebuild) without shrinking
			// the arena: re-create it at the current size and satisfy the
			// caller's face demand, instead of spuriously doubling. The CPU
			// side is fresh either way, since appendedFaces is 0 after a
			// rebuild's reset — nothing live gets copied, and the GPU buffer
			// seeds from zero-filled words.
			capacity = Math.min(
				Math.max(this.capacityFaces, faceCount, 256),
				maxFaces,
			);
		} else {
			// 2× growth (was 4×): halves unused CPU memory and avoids oversized
			// storage-buffer recreations during streaming bursts.
			const grownCapacity =
				this.capacityFaces > 0 ? this.capacityFaces * 2 : this.initialCapacity;
			capacity = Math.min(Math.max(faceCount, grownCapacity, 256), maxFaces);
		}

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

		// Best-fit hole reuse: pick the smallest hole that fits, reducing
		// long-term fragmentation vs first-fit (which strands large holes
		// behind small allocations).
		let bestIndex = -1;
		let bestCount = Number.POSITIVE_INFINITY;

		for (let i = 0; i < holes.length; i++) {
			const hole = holes[i];
			const holeCount = hole.count;

			if (holeCount < count || holeCount >= bestCount) {
				continue;
			}

			bestIndex = i;
			bestCount = holeCount;

			if (holeCount === count) {
				break;
			}
		}

		if (bestIndex >= 0) {
			const hole = holes[bestIndex];
			const base = hole.base;
			const remaining = hole.count - count;

			if (remaining === 0) {
				holes.splice(bestIndex, 1);
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

		// Trailing-hole reclamation: when the arena tail is freed, shrink
		// appendedFaces so future appends reuse the tail without growing, and
		// so appendedFaces (reported as live faces) can decrease on eviction.
		// Holes stay sorted by base, so only the suffix can touch the tail.
		const holes = this.holes;

		while (holes.length > 0) {
			const last = holes[holes.length - 1];

			if (last.base + last.count !== this.appendedFaces) {
				break;
			}

			this.appendedFaces = last.base;
			holes.pop();
		}
	}

	/**
	 * Empties the arena for a fresh streaming generation: no face is live,
	 * every hole and dirty range is dropped. The CPU storage and its GPU
	 * buffer are deliberately kept — they are recycled by the next tiles at
	 * zero cost — while a full retirement of the buffer is the caller's job
	 * (see rebuild/dispose) via disposeBufferAfterGpuWork.
	 */
	reset(): void {
		this.appendedFaces = 0;
		this.holes.length = 0;
		this.dirtyStarts.length = 0;
		this.dirtyCounts.length = 0;
		this.bufferRebound = false;
	}

	pushDirty(start: number, count: number): void {
		if (count <= 0) return;

		// Shared interval-tracker: binary-search insertion + copyWithin tail
		// shift (O(log n) typical). The old in-place "restart the scan from
		// 0 after every merge" implementation was O(n^2) once streaming
		// bursts + hole reuse fragmented the range list.
		farTilePushDirtyRange(this.dirtyStarts, this.dirtyCounts, start, count);
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
	/**
	 * Tile-origin slot in the shared origins buffer, or null for tiles that
	 * produced zero faces (they consume no slot and no origin allocation).
	 */
	originSlot: number | null;
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
	// PERF: pre-seedable via the constructor (default 1024 faces, 16 KiB —
	// starting empty caused a doubling cascade with a full GPU re-upload on
	// every growth step during the initial streaming burst). The manager
	// passes the ladder-derived steady-state estimate so attaching a mesh
	// sizes its instance buffer once instead of cascading.
	records = new Float32Array(4096);
	count = 0;
	capacityFaces = 1024;

	/*
	 * Changed instance-lane ranges since the last sync, as a canonical
	 * interval list (see farTilePushDirtyRange). Replaces the previous
	 * scalar [dirtyMin, dirtyMax] band: arena hole reuse makes worker
	 * arrivals land at scattered bases, so a single bounding band covered
	 * (nearly) the whole buffer and re-uploaded megabytes of unchanged
	 * lanes per burst frame. The band must stay PUBLIC —
	 * syncThinInstanceCount drains it directly to the GPU queue.
	 */
	dirtyStarts: number[] = [];
	dirtyCounts: number[] = [];

	private recordsSortedByFaceIndex = true;

	/**
	 * Count changes must trigger synchronization even when no surviving
	 * records moved. This occurs when removal only trims records from the end.
	 */
	private countDirty = false;

	readonly straight: boolean;

	constructor(straight: boolean, capacityFaces = 1024) {
		this.straight = straight;

		const lanes = Math.max(1024, Math.floor(capacityFaces)) * FT_FACE_WORDS;

		this.records = new Float32Array(lanes);
		this.capacityFaces = lanes >>> 2;
	}

	hasPendingSync(): boolean {
		return this.countDirty || this.dirtyStarts.length > 0;
	}

	appendContiguousFaces(faceBase: number, faceCount: number): void {
		if (faceCount <= 0) {
			return;
		}

		const oldCount = this.count;
		const newCount = oldCount + faceCount;

		this.ensureRecordCapacity(newCount);

		const records = this.records;
		let outputOffset = oldCount * FT_FACE_WORDS;

		if (
			this.recordsSortedByFaceIndex &&
			oldCount > 0 &&
			faceBase < records[(oldCount - 1) * FT_FACE_WORDS]
		) {
			this.recordsSortedByFaceIndex = false;
		}

		for (let face = 0; face < faceCount; face++) {
			records[outputOffset] = faceBase + face;
			records[outputOffset + 1] = 0;
			records[outputOffset + 2] = 0;
			records[outputOffset + 3] = 0;
			outputOffset += FT_FACE_WORDS;
		}

		this.count = newCount;
		this.countDirty = true;
		this.markDirty(oldCount, newCount);
	}

	appendFacesByWinding(
		faceBase: number,
		faces: Uint32Array,
		requiredBackFace: 0 | 1,
	): void {
		const faceCount = faces.length >>> 2;

		if (faceCount === 0) {
			return;
		}

		// Count matching faces first so capacity grows at most once.
		let addedCount = 0;

		for (
			let face = 0, word = 1;
			face < faceCount;
			face++, word += FT_FACE_WORDS
		) {
			if (((faces[word] >>> 20) & 1) === requiredBackFace) {
				addedCount++;
			}
		}

		if (addedCount === 0) {
			return;
		}

		const oldCount = this.count;
		const newCount = oldCount + addedCount;

		this.ensureRecordCapacity(newCount);

		const records = this.records;
		let write = oldCount;
		let lastFaceIndex =
			oldCount > 0
				? records[(oldCount - 1) * FT_FACE_WORDS]
				: Number.NEGATIVE_INFINITY;
		let remainsSorted = this.recordsSortedByFaceIndex;

		for (
			let localFaceIndex = 0, word = 1;
			localFaceIndex < faceCount;
			localFaceIndex++, word += FT_FACE_WORDS
		) {
			if (((faces[word] >>> 20) & 1) !== requiredBackFace) {
				continue;
			}

			const absoluteFaceIndex = faceBase + localFaceIndex;

			if (remainsSorted && absoluteFaceIndex < lastFaceIndex) {
				remainsSorted = false;
			}

			lastFaceIndex = absoluteFaceIndex;

			const offset = write * FT_FACE_WORDS;
			records[offset] = absoluteFaceIndex;
			records[offset + 1] = 0;
			records[offset + 2] = 0;
			records[offset + 3] = 0;
			write++;
		}

		this.count = newCount;
		this.countDirty = true;
		this.recordsSortedByFaceIndex = remainsSorted;
		this.markDirty(oldCount, newCount);
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
	 * modified (the same object can appear in both the straight and reversed
	 * eviction lists, so merging builds local start/end arrays instead).
	 * Overlapping/adjacent slots are merged first, so the sorted-records path
	 * is a single linear cursor pass and the unordered (hole-reuse) path
	 * binary-searches far fewer intervals.
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

		// Merge overlapping/adjacent slots into disjoint [start, end) ranges.
		// Local arrays only; eviction is chunk-move frequent, not per-frame
		// hot, so O(m) allocation here pays for an O(n+m) record scan.
		const mergedStarts: number[] = [];
		const mergedEnds: number[] = [];

		for (let i = 0; i < slotCount; i++) {
			const slot = slots[i];
			const slotCountFaces = slot.count;

			if (slotCountFaces <= 0) {
				continue;
			}

			const slotStart = slot.base;
			const slotEnd = slotStart + slotCountFaces;
			const mergedLength = mergedEnds.length;

			if (mergedLength > 0 && slotStart <= mergedEnds[mergedLength - 1]) {
				if (slotEnd > mergedEnds[mergedLength - 1]) {
					mergedEnds[mergedLength - 1] = slotEnd;
				}
			} else {
				mergedStarts.push(slotStart);
				mergedEnds.push(slotEnd);
			}
		}

		const mergedCount = mergedStarts.length;

		if (mergedCount === 0) {
			return;
		}

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
				// Linear cursor: both records and merged intervals ascend, so
				// each advances at most once over the whole pass.
				while (
					intervalIndex < mergedCount &&
					faceIndex >= mergedEnds[intervalIndex]
				) {
					intervalIndex++;
				}

				if (
					intervalIndex < mergedCount &&
					faceIndex >= mergedStarts[intervalIndex]
				) {
					remove = true;
				}
			} else {
				// Records can become unordered when an arena hole is reused.
				// Find the first merged interval whose end exceeds faceIndex.
				let low = 0;
				let high = mergedCount;

				while (low < high) {
					const middle = (low + high) >>> 1;

					if (mergedEnds[middle] <= faceIndex) {
						low = middle + 1;
					} else {
						high = middle;
					}
				}

				if (
					low < mergedCount &&
					faceIndex >= mergedStarts[low] &&
					faceIndex < mergedEnds[low]
				) {
					remove = true;
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
		this.dirtyStarts.length = 0;
		this.dirtyCounts.length = 0;
		this.countDirty = false;
	}

	/**
	 * Empties the winding list for a fresh streaming generation: no record,
	 * sorted invariant restored, sync state cleared. The records array is
	 * kept (repopulation just writes it again); the attached mesh is NOT
	 * touched here — level rebuilds retire meshes explicitly through
	 * disposeWindingMesh, reset() intentionally keeps them for reuse.
	 */
	reset(): void {
		this.count = 0;
		this.recordsSortedByFaceIndex = true;
		this.clearSyncState();
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

		farTilePushDirtyRange(
			this.dirtyStarts,
			this.dirtyCounts,
			start,
			end - start,
		);
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
	// PERF: pre-seeded 16k here is only the FALLBACK before init() runs;
	// init() re-seeds this shared arena (and its winding list) from the
	// ladder's summed water-cell estimate, sized so all-ocean horizons do
	// not trip a mid-stream growth cascade (full re-create + full upload).
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

	/**
	 * Streaming-generation token. Incremented by reset()/dispose()/rebuild so
	 * worker results generated against a discarded world or ladder can be
	 * rejected even when their request id somehow survives the scheduler's
	 * own cleanup (request ids are monotonic and never reused, so this is
	 * belt-and-braces on top of the id-based staleness checks).
	 */
	private generation = 0;

	/**
	 * Signature of the ladder the current per-level resources were built for.
	 * Compared against getFarTileLadderSignature() at the top of update(); a
	 * mismatch purges tiles and rebuilds. Cached each update call instead of
	 * recomputing per frame.
	 */
	private ladderSignature = "";

	/** Set by dispose()/scene disposal; every public entry point no-ops. */
	private disposed = false;

	/**
	 * Debug-only live-slot bitmap for the origin allocator: catches a slot
	 * being freed twice or re-allocated while live. Allocated lazily in
	 * init() only in dev builds; null in production.
	 */
	private originAllocated: Uint8Array | null = null;

	/*
	 * Per-level retention windows cache (computed once per player-chunk
	 * move in update(), consumed by the eviction scan).
	 */
	private _retentionInner: number[] = [];
	private _retentionOuter: number[] = [];

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
		// init() revives a previously disposed instance (e.g. scene swap).
		this.disposed = false;

		if (import.meta.env?.DEV !== false && this.originAllocated === null) {
			// Debug-only live-slot bitmap for the origin allocator (64 KiB).
			this.originAllocated = new Uint8Array(FAR_TILE_MAX_ORIGIN_SLOTS);
		}

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

			// PERF: pre-seed each level's arena AND its two winding lists
			// from the ladder's ring geometry (estimateLevelFaceCapacity).
			// Fixed 8k/32k starts forced growth cascades — each one a full
			// GPU buffer re-create + rebind + full re-upload — during every
			// initial streaming burst; the estimate covers the typical
			// steady-state population so bursts stream straight in.
			const faceSeed = estimateLevelFaceCapacity(levels[i]);

			this.terrainArenas.push(new FaceWordArena(faceSeed));
			this.terrainStraight.push(new WindingMesh(true, faceSeed));
			this.terrainReversed.push(new WindingMesh(false, faceSeed));

			// Allocate per-level scratch arrays once.
			this._evictStraightByLevel.push([]);
			this._evictReversedByLevel.push([]);
		}

		this.waterMaterial = createFarTileWaterMaterial();

		// PERF: the shared water arena/winding are seeded from the level
		// sum (all-ocean horizons need far more than the class-field's
		// historical 16k fallback, which was itself a cascade source).
		const waterSeed = estimateWaterFaceCapacity(levels);

		if (waterSeed > this.waterArena.initialCapacity) {
			this.waterArena = new FaceWordArena(waterSeed);
			this.waterReversed = new WindingMesh(false, waterSeed);
		}
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

		// Record the generation the current ladder was built with so the
		// first update() does not trigger a redundant purge + rebuild.
		this.ladderSignature = getFarTileLadderSignature();

		// Lite provides no per-hook unregister for onBeforeRender, so the
		// frame pump is instead gated by `this.disposed` (see frame()) and
		// the scene-dispose hook below owns full teardown.
		onBeforeRender(scene, () => this.frame());

		onSceneDispose(scene, () => {
			// The scene is going away: removeFromScene is neither needed nor
			// legal mid-teardown; retire only the manager-owned GPU state.
			if (!this.disposed) {
				this.teardown(true);
			}
		});
	}

	public isReady(): boolean {
		return this.engine != null;
	}

	public reset(): void {
		if (this.disposed) return;

		// Invalidate every in-flight result from before this point: worker
		// completions carrying the old generation are dropped wholesale by
		// handleResult, and the scheduler queue below drops queued tasks.
		this.generation++;

		const straightByLevel = this._evictStraightByLevel;
		const reversedByLevel = this._evictReversedByLevel;
		const waterSlots = this._evictWaterSlots;

		waterSlots.length = 0;

		for (let i = 0; i < straightByLevel.length; i++) {
			straightByLevel[i].length = 0;
			reversedByLevel[i].length = 0;
		}

		for (const entry of this.tiles.values()) {
			const levelIndex = entry.levelIndex;
			const opaque = entry.opaque;
			const water = entry.water;

			if (opaque) {
				const arena = this.terrainArenas[levelIndex];

				if (arena) {
					arena.free(opaque);

					if (levelIndex < straightByLevel.length) {
						straightByLevel[levelIndex].push(opaque);
						reversedByLevel[levelIndex].push(opaque);
					} else {
						// Ladder grew past the pre-sized scratch arrays (or reset
						// before init): fall back to a per-tile removal so no
						// tile leaks its winding records.
						this.terrainStraight[levelIndex]?.removeSlot(opaque);
						this.terrainReversed[levelIndex]?.removeSlot(opaque);
					}
				}
			}

			if (water) {
				this.waterArena.free(water);
				waterSlots.push(water);
			}

			if (entry.originSlot !== null) {
				this.releaseOrigin(entry.originSlot);
			}
		}

		/*
		 * Compact each instance collection once. The previous implementation
		 * scanned each complete instance array once per tile.
		 */
		for (
			let levelIndex = 0;
			levelIndex < straightByLevel.length;
			levelIndex++
		) {
			const straightSlots = straightByLevel[levelIndex];

			if (straightSlots.length > 0) {
				this.terrainStraight[levelIndex]?.removeSlots(straightSlots);
			}

			const reversedSlots = reversedByLevel[levelIndex];

			if (reversedSlots.length > 0) {
				this.terrainReversed[levelIndex]?.removeSlots(reversedSlots);
			}
		}

		if (waterSlots.length > 0) {
			this.waterReversed.removeSlots(waterSlots);
		}

		this.tiles.clear();
		this.pendingByKey.clear();
		this.keyByRequestId.clear();

		// Arena + winding state drops everything live at once (no per-tile
		// compaction bookkeeping beyond the batched watermark updates above).
		for (const arena of this.terrainArenas) {
			arena.reset();
		}
		this.waterArena.reset();

		for (const wm of this.terrainStraight) {
			wm.reset();
		}
		for (const wm of this.terrainReversed) {
			wm.reset();
		}
		this.waterReversed.reset();

		this.resetOriginAllocator();

		this.lastPlayerChunkX = Number.NaN;
		this.lastPlayerChunkZ = Number.NaN;

		ChunkWorkerPool.getInstance().resetFarTileRequests();
	}

	// ------------------------------------------------------------------
	// Ladder rebuild + teardown
	// ------------------------------------------------------------------

	/**
	 * Rebuilds the per-level GPU resources after a ladder change: retires the
	 * previous ladder's terrain meshes + face buffers, re-sizes the per-level
	 * collections and re-binds shared state on the materials.
	 *
	 * Materials are deliberately NOT recreated across rebuilds: lite exposes
	 * no ShaderMaterial disposal, so recreating one per rebuild would leak a
	 * pipeline per settings change. Instead existing materials are re-bound —
	 * texture, atlas uniform and storage buffers all follow the current
	 * shared state — and only NEW levels beyond the previous count create a
	 * fresh material. Surplus materials from a smaller ladder stay reachable
	 * in this.terrainMaterials for a later larger ladder to reuse.
	 *
	 * Caller contract: reset() has already purged every tile entry (and
	 * bumped the generation), so no arena slot is live when this runs.
	 */
	private rebuildLevelResources(levels: FarTileLevelDef[]): void {
		const engine = this.engine;
		const scene = this.scene;

		if (!engine || !scene) return;

		// Retire the previous ladder's meshes (fresh ones are created lazily
		// by ensureLevelMesh on first arrival) and recycle each arena.
		for (let i = 0; i < this.terrainStraight.length; i++) {
			disposeWindingMesh(scene, this.terrainStraight[i]);
			disposeWindingMesh(scene, this.terrainReversed[i]);

			const arena = this.terrainArenas[i];

			if (arena?.buffer) {
				disposeBufferAfterGpuWork(arena.buffer);
				arena.buffer = null;
			}

			arena?.reset();
		}

		while (this.terrainMaterials.length < levels.length) {
			const material = createFarTileTerrainMaterial({
				engine,
				scene,
				diffuseTexture: getDiffuseTexture2D(),
				atlasTileSize,
				textureScale: 32,
				nameSuffix: String(this.terrainMaterials.length),
			});
			this.terrainMaterials.push(material);
		}

		// Re-size per-level collections (meshes/arena buffers beyond the new
		// ladder were retired above; objects inside bounds are reused).
		this.terrainStraight.length = levels.length;
		this.terrainReversed.length = levels.length;
		this.terrainArenas.length = levels.length;
		this._evictStraightByLevel.length = levels.length;
		this._evictReversedByLevel.length = levels.length;

		for (let i = 0; i < levels.length; i++) {
			// PERF: seed sizing mirrors init(): a ladder ring that grew
			// needs an arena/winding pre-seed covering its NEW steady state,
			// else the next initial burst re-learns growth cascades. Larger
			//-than-needed pairs are kept (memory shrinks never bother us
			// between settings changes). Windings hold no live records here
			// (the caller's reset purged tiles), so they replace cleanly;
			// their meshes were retired above and re-attach lazily.
			const faceSeed = estimateLevelFaceCapacity(levels[i]);
			const arena = this.terrainArenas[i];

			if (!arena || arena.initialCapacity < faceSeed) {
				this.terrainArenas[i] = new FaceWordArena(faceSeed);
			}

			if (
				!this.terrainStraight[i] ||
				this.terrainStraight[i].capacityFaces < faceSeed
			) {
				this.terrainStraight[i] = new WindingMesh(true, faceSeed);
			}

			if (
				!this.terrainReversed[i] ||
				this.terrainReversed[i].capacityFaces < faceSeed
			) {
				this.terrainReversed[i] = new WindingMesh(false, faceSeed);
			}

			if (!this._evictStraightByLevel[i]) {
				this._evictStraightByLevel[i] = [];
			}
			if (!this._evictReversedByLevel[i]) {
				this._evictReversedByLevel[i] = [];
			}
		}

		// The shared water pair: re-seed only when the (possibly larger)
		// ladder outruns the previous estimate. Replacing the winding
		// requires retiring its mesh — unlike level windings, it is not
		// disposed in the per-level loop above.
		const waterSeed = estimateWaterFaceCapacity(levels);

		if (this.waterArena.initialCapacity < waterSeed) {
			const oldWaterBuffer = this.waterArena.buffer;

			if (oldWaterBuffer) {
				disposeBufferAfterGpuWork(oldWaterBuffer);
			}

			this.waterArena = new FaceWordArena(waterSeed);
		}

		if (this.waterReversed.capacityFaces < waterSeed) {
			disposeWindingMesh(scene, this.waterReversed);
			this.waterReversed = new WindingMesh(false, waterSeed);
		}

		// Re-bind shared state on every (reused or fresh) material so none of
		// them keep stale ladder-gen bindings: current texture, atlas scale,
		// frustum planes and origins. createFarTileTerrainMaterial set the
		// same values for fresh materials already; re-issuing is harmless.
		const diffuse = getDiffuseTexture2D();

		for (const m of this.terrainMaterials) {
			setShaderTexture(m, "diffuseTexture", diffuse);
			setShaderUniform(m, "atlasTileSize", atlasTileSize);
			setShaderUniform(m, "textureScale", 32);
			setShaderStorageBuffer(m, "frustumPlanes", this.frustumPlanesBuffer);
			setShaderStorageBuffer(m, "tileOrigins", this.originsBuffer);
		}
	}

	/**
	 * Full teardown, releasing every GPU resource the manager owns and
	 * detaching its streaming state. Unlike reset() (which keeps the meshes
	 * alive for immediate repopulation), this disables the instance: update,
	 * handleResult, frame and reset all become no-ops until a fresh init().
	 *
	 * Material note: lite has no ShaderMaterial disposal, so the far-tile
	 * materials are DOCUMENTED as not disposed here — their references are
	 * dropped and the (engine-scoped) resources die with the scene teardown
	 * that triggers or follows dispose().
	 */
	private teardown(fromSceneDispose: boolean): void {
		this.disposed = true;
		this.generation++;

		const scene = this.scene;

		if (!fromSceneDispose && scene !== null) {
			for (const wm of this.terrainStraight) {
				disposeWindingMesh(scene, wm);
			}
			for (const wm of this.terrainReversed) {
				disposeWindingMesh(scene, wm);
			}
			disposeWindingMesh(scene, this.waterReversed);
		} else {
			// The scene is (being) destroyed and owns mesh lifetime; drop the
			// references only.
			for (const wm of this.terrainStraight) {
				wm.mesh = null;
			}
			for (const wm of this.terrainReversed) {
				wm.mesh = null;
			}
			this.waterReversed.mesh = null;
		}

		// Face/origin/frustum storage buffers outlive the scene's meshes.
		for (const arena of this.terrainArenas) {
			if (arena.buffer) {
				disposeBufferAfterGpuWork(arena.buffer);
				arena.buffer = null;
			}
			arena.reset();
		}
		this.waterArena.reset();
		if (this.waterArena.buffer) {
			disposeBufferAfterGpuWork(this.waterArena.buffer);
			this.waterArena.buffer = null;
		}

		if (this.originsBuffer) {
			disposeBufferAfterGpuWork(this.originsBuffer);
			this.originsBuffer = null;
		}
		if (this.frustumPlanesBuffer) {
			disposeBufferAfterGpuWork(this.frustumPlanesBuffer);
			this.frustumPlanesBuffer = null;
		}

		// Origins CPU storage + capacity return to the just-initialized shape
		// so a later init() grows it again from scratch.
		this.origins = new Float32Array(0);
		this.originCapacitySlots = 0;
		this.resetOriginAllocator();

		// Streaming bookkeeping.
		const pool = ChunkWorkerPool.getInstance();
		pool.onFarTileGenerated = null;
		this.tiles.clear();
		this.pendingByKey.clear();
		this.keyByRequestId.clear();

		// Materials cannot be disposed in lite (see doc above); their
		// references are dropped so init() recreates them cleanly.
		this.terrainMaterials = [];
		this.waterMaterial = null;

		// Per-level collections must be empty when init() runs again, or the
		// init body would append duplicate levels onto stale entries.
		this.terrainArenas = [];
		this.terrainStraight = [];
		this.terrainReversed = [];
		this._evictStraightByLevel = [];
		this._evictReversedByLevel = [];

		this.engine = null;
		this.scene = null;
	}

	/** Full teardown of the manager (idempotent). */
	public dispose(): void {
		if (this.disposed) return;
		this.teardown(false);
	}

	// ------------------------------------------------------------------
	// Streaming
	// ------------------------------------------------------------------

	public update(playerWorldX: number, playerWorldZ: number): void {
		if (!this.engine || this.disposed) return;

		frameProfiler.begin("farTiles.update");

		try {
			/*
			 * Ladder synchronization must come BEFORE the position early-out:
			 * a settings change while the player stands still would otherwise
			 * never be picked up, leaving the manager attached to per-level
			 * resources built for a ladder whose ring radii no longer match
			 * the reported levels. On a mismatch the old tiles are all stale
			 * (rings, tile sizes and steps changed), so purge + rebuild.
			 *
			 * Runtime disable (FAR_TILE_DISTANCE <= 0) also flows through
			 * here: the ladder simply becomes empty.
			 */
			const levels = getFarTileLevels();
			const signature = getFarTileLadderSignature();

			if (signature !== this.ladderSignature) {
				this.reset();
				this.rebuildLevelResources(levels);
				this.ladderSignature = signature;
			}

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
								Math.ceil(MAX_TILE_REQUESTS_PER_UPDATE * pressureFactor),
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

					/*
					 * Scheduling is EXACTLY the official ring: the unload
					 * margin widens only eviction/retention below (hysteresis
					 * must never widen what gets BUILT — with margin-widened
					 * loads, a ring starting at N kept loading out to N + 16).
					 */
					const loadWindow = farTileLoadWindow(
						level.ringInnerChunks,
						level.ringOuterChunks,
					);

					const loadInner = loadWindow.inner;
					const loadOuter = loadWindow.outer;

					const txMin = Math.floor((pcx - loadOuter) / span);
					const txMax = Math.floor((pcx + loadOuter) / span);
					const tzMin = Math.floor((pcz - loadOuter) / span);
					const tzMax = Math.floor((pcz + loadOuter) / span);

					for (let tx = txMin; tx <= txMax; tx++) {
						/*
						 * Column skip via the shared area-distance helper:
						 * passing tz = pcz forces the z component to zero,
						 * so the helper returns exactly the x-axis component
						 * for this whole column — the minimum tile distance
						 * any tz inside it can reach. Chebyshev distance can
						 * never become smaller than distanceX regardless of
						 * tz, so skip the column when it cannot intersect
						 * the level's loading window.
						 */
						const distanceX = tileChebyshevDistanceChunks(
							pcx,
							pcz,
							tx,
							pcz,
							span,
						);

						if (distanceX >= loadOuter) {
							continue;
						}

						for (let tz = tzMin; tz <= tzMax; tz++) {
							const distance = tileChebyshevDistanceChunks(
								pcx,
								pcz,
								tx,
								tz,
								span,
							);

							if (distance < loadInner || distance >= loadOuter) {
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
							if (wantedCount >= requestBudget && distance >= worstDistance) {
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
					this.generation,
				);

				this.pendingByKey.add(key);
				this.keyByRequestId.set(requestId, key);
			}

			/*
			 * Per-level retention windows, computed once per player-chunk move:
			 * the official ring widened by the unload margin on BOTH edges.
			 * Without the inner margin, movement TOWARD a tile would evict it
			 * the moment its area crossed the inner boundary — churn instead
			 * of hysteresis.
			 */
			const retentionInner = this._retentionInner;
			const retentionOuter = this._retentionOuter;

			retentionInner.length = levels.length;
			retentionOuter.length = levels.length;

			for (let i = 0; i < levels.length; i++) {
				const retention = farTileRetentionWindow(
					levels[i].ringInnerChunks,
					levels[i].ringOuterChunks,
				);

				retentionInner[i] = retention.inner;
				retentionOuter[i] = retention.outer;
			}

			/*
			 * Find loaded tiles that have left their level's RETENTION window
			 * (ring + margin on both edges). This Map scan is necessary because
			 * loaded tiles can come from any previous player position.
			 */
			const evictKeys = this._evictKeys;
			const evictEntries = this._evictEntries;

			evictKeys.length = 0;
			evictEntries.length = 0;

			for (const [key, entry] of this.tiles) {
				const level = levels[entry.levelIndex];
				if (!level) continue;

				const distance = tileChebyshevDistanceChunks(
					pcx,
					pcz,
					entry.tx,
					entry.tz,
					level.tileSizeChunks,
				);

				if (
					distance < retentionInner[entry.levelIndex] ||
					distance >= retentionOuter[entry.levelIndex]
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

				if (entry.originSlot !== null) {
					this.releaseOrigin(entry.originSlot);
				}
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
			frameProfiler.end("farTiles.update");
		}
	}

	public handleResult(data: FarTileGeneratedMessage): void {
		/*
		 * Generation check first, BEFORE any map cleanup: a result generated
		 * against an earlier ladder/world generation can never be meshed (its
		 * faces reference arena layouts that reset()/rebuild tore down). The
		 * reset() call that bumped the generation also cleared the request-id
		 * mapping, so the ids cannot linger after a purge.
		 */
		if (this.disposed || data.generation !== this.generation) {
			return;
		}

		const requestId = data.requestId;
		const key = this.keyByRequestId.get(requestId);

		this.keyByRequestId.delete(requestId);

		if (key === undefined) {
			return;
		}

		this.pendingByKey.delete(key);

		/*
		 * Result-key validation: the worker echoes the coordinates it was
		 * handed. A mismatch means a cross-wired result — drop it loudly
		 * rather than meshing faces under the wrong tile key.
		 */
		const receivedKey = packTileKey(data.levelIndex, data.tileX, data.tileZ);

		if (receivedKey !== key) {
			console.warn(
				`[FarTileManager] mismatched worker result ` +
					`(scheduled ${key}, received ${receivedKey}) — dropping.`,
			);
			return;
		}

		if (
			!this.engine ||
			!this.pendingIsStillWanted(data.levelIndex, data.tileX, data.tileZ)
		) {
			return;
		}

		const levelIndex = data.levelIndex;
		const levels = getFarTileLevels();
		const level = levels[levelIndex];
		const opaqueArena = this.terrainArenas[levelIndex];

		if (!level || !opaqueArena) {
			return;
		}

		const opaqueFaces = data.opaqueFaces;
		const waterFaces = data.waterFaces;
		const opaqueCount = opaqueFaces.length >>> 2;
		const waterCount = waterFaces.length >>> 2;

		const opaqueSlot =
			opaqueCount !== 0 ? opaqueArena.alloc(opaqueCount) : null;
		const waterSlot =
			waterCount !== 0 ? this.waterArena.alloc(waterCount) : null;

		if (
			(opaqueCount !== 0 && opaqueSlot === null) ||
			(waterCount !== 0 && waterSlot === null)
		) {
			// Roll back whichever allocation succeeded.
			if (opaqueSlot) {
				opaqueArena.free(opaqueSlot);
			}

			if (waterSlot) {
				this.waterArena.free(waterSlot);
			}

			console.warn(
				`[FarTileManager] arena full, dropping tile ${key} ` +
					`(opaque ${opaqueCount}, water ${waterCount}).`,
			);
			return;
		}

		const tileWorldScale = level.tileSizeChunks * 32;

		/*
		 * Origin slots are only consumed by tiles that actually produce
		 * faces: an all-air/empty tile has nothing to render, so its entry
		 * records originSlot = null and the allocation is skipped entirely.
		 * allocOrigin() signals exhaustion with -1.
		 */
		const hasFaces = opaqueCount !== 0 || waterCount !== 0;

		let originSlot = -1;

		if (hasFaces) {
			originSlot = this.allocOrigin(
				data.tileX * tileWorldScale,
				data.tileZ * tileWorldScale,
			);

			if (originSlot === -1) {
				// Origin pool exhausted (every slot live). Roll back whichever
				// arena allocation succeeded so retrying stays consistent.
				if (opaqueSlot) {
					opaqueArena.free(opaqueSlot);
				}

				if (waterSlot) {
					this.waterArena.free(waterSlot);
				}

				console.warn(
					`[FarTileManager] origin slots exhausted (max ` +
						`${FAR_TILE_MAX_ORIGIN_SLOTS}), dropping tile ${key}.`,
				);
				return;
			}
		}

		if (opaqueSlot) {
			const opaqueBase = opaqueSlot.base;

			opaqueArena.cpu.set(opaqueFaces, opaqueBase * FT_FACE_WORDS);

			stampOriginSlot(opaqueArena.cpu, opaqueSlot, originSlot);

			opaqueArena.pushDirty(opaqueBase, opaqueCount);

			const straight = this.terrainStraight[levelIndex];
			const reversed = this.terrainReversed[levelIndex];

			/*
			 * Batch insertion performs:
			 * - one capacity growth per winding side at most
			 * - one count update per side
			 * - one dirty-range update per side
			 *
			 * The previous loop called appendFace() once per opaque face.
			 */
			straight.appendFacesByWinding(opaqueBase, opaqueFaces, 1);

			reversed.appendFacesByWinding(opaqueBase, opaqueFaces, 0);
		}

		if (waterSlot) {
			const waterBase = waterSlot.base;
			const waterArena = this.waterArena;

			waterArena.cpu.set(waterFaces, waterBase * FT_FACE_WORDS);

			stampOriginSlot(waterArena.cpu, waterSlot, originSlot);

			waterArena.pushDirty(waterBase, waterCount);

			/*
			 * Far-tile water always uses reversed winding, so it can be appended
			 * as one contiguous range without inspecting individual face flags.
			 */
			this.waterReversed.appendContiguousFaces(waterBase, waterCount);
		}

		this.tiles.set(key, {
			levelIndex,
			tx: data.tileX,
			tz: data.tileZ,
			opaque: opaqueSlot,
			water: waterSlot,
			// -1 only survives here for empty tiles (the exhausted path
			// already returned), which is exactly the null-origin case.
			originSlot: originSlot === -1 ? null : originSlot,
		});
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

		/*
		 * Acceptance window for in-flight results: the RETENTION window
		 * (official ring + margin on BOTH edges), evaluated with the shared
		 * area-to-point distance. A tile the eviction scan would keep is
		 * exactly a tile worth still meshing; anything already outside the
		 * retention window gets dropped here instead of arriving-then-evicting.
		 */
		const retention = farTileRetentionWindow(
			lv.ringInnerChunks,
			lv.ringOuterChunks,
		);

		const distance = tileChebyshevDistanceChunks(
			this.lastPlayerChunkX,
			this.lastPlayerChunkZ,
			tx,
			tz,
			lv.tileSizeChunks,
		);

		return distance >= retention.inner && distance < retention.outer;
	}

	// ------------------------------------------------------------------
	// Frame pump + GPU sync
	// ------------------------------------------------------------------

	private frame(): void {
		if (!this.engine || this.disposed) return;

		frameProfiler.begin("farTiles.frame");

		try {
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
			if (!this.farTilesVisible) return;

			// PERF: idle early-out — sync/flush/ensure loops run even when no
			// tile arrived, no arena dirtied, and no mesh pending. Uniforms
			// above are self-guarded (quantized), so skipping the rest when
			// clean saves ~10 function calls + profiler noise per frame.
			if (!this.hasPendingFarWork()) return;

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
		} finally {
			frameProfiler.end("farTiles.frame");
		}
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
		// Hard cap: the face record's origin field is 16 bits wide, so
		// capacity beyond FAR_TILE_MAX_ORIGIN_SLOTS would be addressable by
		// nothing (tile arrivals fail with a rollback in handleResult).
		const cap = Math.min(
			FAR_TILE_MAX_ORIGIN_SLOTS,
			Math.max(slots, this.originCapacitySlots * 2 || 1024),
		);

		if (cap <= this.originCapacitySlots) return;

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
		const slot = popped !== undefined ? popped : this.nextOriginSlot;

		if (slot >= FAR_TILE_MAX_ORIGIN_SLOTS) {
			// Every slot in the 16-bit origin space is live (or the free list
			// is exhausted): the caller rolls its arena allocations back.
			if (popped !== undefined) {
				// Return the slot to the free list so a later eviction can
				// still make progress.
				this.originFreeSlots.push(slot);
			}
			return -1;
		}

		if (popped === undefined) {
			this.nextOriginSlot = slot + 1;
		}

		if (slot + 1 > this.originCapacitySlots) this.ensureOrigins(slot + 1);

		if (this.originAllocated !== null) {
			if (this.originAllocated[slot] !== 0) {
				// Debug invariant: a live slot must never be handed out again.
				// (Free-list corruption would manifest as two tiles sharing
				// one origin row — a bogus world offset at distance.)
				console.warn(
					`[FarTileManager] origin slot ${slot} re-allocated while live`,
				);
			}
			this.originAllocated[slot] = 1;
		}

		this.origins[slot * 2] = worldX;
		this.origins[slot * 2 + 1] = worldZ;
		// PERF: ranged dirty tracking — flushOrigins used to re-upload the
		// ENTIRE origins buffer on every tile arrival.
		if (slot < this.originsDirtyMin) this.originsDirtyMin = slot;
		if (slot + 1 > this.originsDirtyMax) this.originsDirtyMax = slot + 1;
		return slot;
	}

	private releaseOrigin(slot: number): void {
		if (this.originAllocated !== null) {
			if (this.originAllocated[slot] === 0) {
				// Debug invariant: releasing an already-free slot would push a
				// duplicate into the free list, eventually handing one origin
				// row to two tiles. Keep the slot free-list-clean instead.
				console.warn(`[FarTileManager] double release of origin slot ${slot}`);
				return;
			}
			this.originAllocated[slot] = 0;
		}

		this.originFreeSlots.push(slot);
	}

	/**
	 * Drops the streaming-generation origin state: every slot is unallocated
	 * again. Stale GPU contents are harmless — no face references an origin
	 * slot until one is (re)allocated and stamped.
	 */
	private resetOriginAllocator(): void {
		this.nextOriginSlot = 0;
		this.originFreeSlots.length = 0;
		this.originsDirtyMin = Number.POSITIVE_INFINITY;
		this.originsDirtyMax = 0;

		this.originAllocated?.fill(0);
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

		const liquid = cameraPosition
			? getEyeLiquid(cameraPosition.x, cameraPosition.y, cameraPosition.z)
			: null;
		const underWater = liquid !== null;

		if (underWater !== this.farTilesUnderwater) {
			this.farTilesUnderwater = underWater;
			this.applyFarTilesVisibility();
		}

		// Water keeps the MapFog values (including dev overrides); lava and oil
		// use their registry fog so far tiles match the dense overlay.
		const liquidFog: LiquidDefinition | null =
			liquid !== null && liquid !== WATER_LIQUID ? liquid : null;
		const fogStart = liquidFog
			? liquidFog.fogStart
			: MapFog.getFogStart(underWater);
		const fogEnd = liquidFog ? liquidFog.fogEnd : MapFog.getFogEnd(underWater);
		const fogColor = liquidFog
			? liquidFog.fogColor
			: MapFog.getFogColor(underWater);
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

	if (wm.dirtyStarts.length > 0) {
		const gpuBuffer = thinInstances._gpuBuffer;
		const device = engineRef
			? (engineRef as EngineWithDevice)._device
			: undefined;
		const gpuIsCurrent = thinInstances._version === thinInstances._gpuVersion;

		if (gpuBuffer && device) {
			/*
			 * PERF: direct per-band writes. With the GPU fully current, each
			 * dirty interval becomes its own narrow queue.writeBuffer — the
			 * removed scalar band used to union scattered arrival bases into
			 * (almost) the whole buffer and re-upload every lane in between.
			 * Keeping `_gpuVersion` current afterwards makes Lite's own
			 * scalar-band pass skip this mesh, so lanes never write twice.
			 */
			for (let i = 0; i < wm.dirtyStarts.length; i++) {
				const low = Math.max(0, wm.dirtyStarts[i]);
				const high = Math.min(count, wm.dirtyStarts[i] + wm.dirtyCounts[i]);

				if (high <= low) {
					continue;
				}

				writeThinInstanceRecords(device, gpuBuffer, low, high, wm.records);

				_farInstanceBytesThisFrame += (high - low) * FAR_INSTANCE_STRIDE;
				_farInstanceRangedUploads++;
				_farInstanceCalls++;
			}

			// Lane state is on the GPU; keep the engine's version marker
			// current so Lite's own scalar-band pass skips this mesh.
			thinInstances._gpuVersion = thinInstances._version;
			wm.clearSyncState();

			return;
		}

		/*
		 * Fallback — the engine still owes a publish (mesh creation/growth
		 * or the compact restore bumped its version) or there is no direct
		 * device access: union every interval into the scalar band that
		 * Lite's own sync publishes once per draw.
		 */
		let bandLow = Number.POSITIVE_INFINITY;
		let bandHigh = 0;

		for (let i = 0; i < wm.dirtyStarts.length; i++) {
			const laneLow = Math.max(0, wm.dirtyStarts[i]);
			const laneHigh = Math.min(count, wm.dirtyStarts[i] + wm.dirtyCounts[i]);

			if (laneHigh <= laneLow) {
				continue;
			}

			if (laneLow < bandLow) {
				bandLow = laneLow;
			}

			if (laneHigh > bandHigh) {
				bandHigh = laneHigh;
			}
		}

		if (bandHigh > bandLow) {
			thinInstances._dirtyMin = gpuIsCurrent
				? bandLow
				: Math.min(thinInstances._dirtyMin, bandLow);

			thinInstances._dirtyMax = gpuIsCurrent
				? bandHigh
				: Math.max(thinInstances._dirtyMax, bandHigh);

			thinInstances._version++;

			// A union with a still-pending range can widen this well beyond
			// [bandLow, bandHigh); report what Lite will actually upload.
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

// ---------------------------------------------------------------------------
// Ladder-derived pre-seed sizing (no growth cascades)
// ---------------------------------------------------------------------------

/**
 * Cells-per-axis for a validated ladder level: tileSizeChunks * 32 block
 * edge / voxelStep. FarTileLadder validation guarantees integrality, so the
 * floor below is a pure defensive bound.
 */
function computeCellsPerAxis(level: FarTileLevelDef): number {
	return Math.floor((level.tileSizeChunks * BASE_CHUNK_SIZE) / level.voxelStep);
}

// Terrain emits one top face per land cell plus side faces for cells that
// neighbor lower ground or water: 2 faces/cell measured out as the typical
// full-ring mix. Water tiles contribute at most one flat top face per
// submerged cell into the one shared arena.
const ESTIMATED_TERRAIN_FACES_PER_CELL = 2;
const ESTIMATED_FACES_PER_WATER_CELL = 1;

function estimateLevelFaceCapacity(level: FarTileLevelDef): number {
	return estimateFarTileFaceCapacity(
		level.ringInnerChunks,
		level.ringOuterChunks,
		level.tileSizeChunks,
		computeCellsPerAxis(level),
		ESTIMATED_TERRAIN_FACES_PER_CELL,
	);
}

/**
 * Pre-seed for the SHARED water arena: every level's water-eligible cells
 * sum into one arena. Floor is the historical 16k seed; cap matches the
 * per-level estimator (2^21 faces) so even an all-ocean horizon at extreme
 * settings stops pre-reserving and relies on growth.
 */
function estimateWaterFaceCapacity(levels: readonly FarTileLevelDef[]): number {
	let waterCells = 0;

	for (const level of levels) {
		waterCells +=
			farTileRingTileCount(
				level.ringInnerChunks,
				level.ringOuterChunks,
				level.tileSizeChunks,
			) *
			computeCellsPerAxis(level) ** 2;
	}

	const CAP = 1 << 21;

	let seeded = 16384;

	while (seeded < waterCells && seeded < CAP) {
		seeded <<= 1;
	}

	return seeded;
}

// ---------------------------------------------------------------------------
// Direct per-band instance-record writes
// ---------------------------------------------------------------------------

// Cap individual queue.writeBuffer submissions at 256 KiB for the same
// reason as the matching cap in the patched Lite thin-instance sync: Dawn
// reserves the staging allocation at submit time and can block the render
// thread beyond it. The caller's per-band shape is preserved — this only
// bounds each submission.
const MAX_RECORD_INSTANCES_PER_WRITE = (256 * 1024) / FAR_INSTANCE_STRIDE;

/**
 * Writes records[low, high) — one compact vec4 per instance — straight to
 * the engine's thin-instance GPU buffer, chunked at 256 KiB.
 */
function writeThinInstanceRecords(
	device: GPUDevice,
	gpuBuffer: GPUBuffer,
	low: number,
	high: number,
	records: Float32Array,
): void {
	let dstByteOffset = low * FAR_INSTANCE_STRIDE;
	let srcFloat = low * FT_FACE_WORDS;
	let remaining = high - low;

	while (remaining > 0) {
		const lanes = Math.min(remaining, MAX_RECORD_INSTANCES_PER_WRITE);

		device.queue.writeBuffer(
			gpuBuffer,
			dstByteOffset,
			records.buffer,
			records.byteOffset + srcFloat * 4,
			lanes * FAR_INSTANCE_STRIDE,
		);

		dstByteOffset += lanes * FAR_INSTANCE_STRIDE;
		srcFloat += lanes;
		remaining -= lanes;
	}
}

interface EngineWithDevice extends EngineContext {
	_device?: GPUDevice;
}

export const FarTileManager = {
	init(engine: EngineContext, scene: SceneContext): void {
		FarTileManagerImpl.getInstance().init(engine, scene);
	},

	update(playerWorldX: number, playerWorldZ: number): void {
		// No isFarTilesEnabled() gate here: when the setting turns far tiles
		// off at runtime, update() is the only place that observes the now
		// empty ladder (signature mismatch) and retires the old resources.
		FarTileManagerImpl.getInstance().update(playerWorldX, playerWorldZ);
	},

	handleResult(data: FarTileGeneratedMessage): void {
		FarTileManagerImpl.getInstance().handleResult(data);
	},

	reset(): void {
		FarTileManagerImpl.peekInstance()?.reset();
	},

	/** Full teardown of the far-tile subsystem (idempotent). */
	dispose(): void {
		FarTileManagerImpl.peekInstance()?.dispose();
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
