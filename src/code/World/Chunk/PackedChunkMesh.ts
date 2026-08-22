/**
 * GPU face-decoding mesh layer (thin-instance variant).
 *
 * Every chunk face is drawn as one instance of a single shared quad
 * (4 verts / 6 indices). Packed face data lives in a global storage buffer
 * (faceData) and per-group chunk origins in a second global buffer
 * (chunkOffsets). The vertex shader selects the face via
 * `@builtin(instance_index)` combined with a per-mesh `faceBase` offset that is
 * carried in the thin-instance matrix (world3.w).
 *
 * Each face is 3 u32 words (12 bytes — see QuadBuffer.ts for the bit layout);
 * the per-face local chunk index (0..63) is OR'd into word2 byte 3 during
 * merged-group assembly, and the group's chunkOffsets base rides in the
 * instance matrix (world1.x), so no 4th word is needed.
 *
 * Babylon Lite 1.11 has no instanced-draw support in the plain ShaderMaterial
 * path (drawIndexed is called with no instance count), but it DOES support
 * thin instances: a mesh with `mesh.thinInstances` set is drawn `ti.count`
 * times, each with a `@builtin(instance_index)`, and the instance matrices are
 * supplied as a vertex buffer. We exploit that: each mesh gets
 * `ti.count = faceCount` and an instance matrix whose world3.w carries
 * `faceBase`, so the shader reads `faceData[faceBase + instanceIndex]`.
 *
 * Because `setShaderStorageBuffer` is material-wide, all meshes share ONE arena;
 * each mesh only carries its integer `faceBase` offset via the instance matrix.
 * No thin-instance colors, no identity-matrix arrays, no per-mesh storage
 * buffers.
 */
import {
	addToScene,
	createMeshFromData,
	createStorageBuffer,
	disposeMeshGpu,
	disposeStorageBuffer,
	type EngineContext,
	type Mesh,
	removeFromScene,
	type SceneContext,
	type ShaderMaterial,
	type StorageBuffer,
	setShaderStorageBuffer,
	setThinInstances,
	updateStorageBuffer,
} from "@babylonjs/lite";
import { onGpuWorkDone } from "../Light/liteGpuBuffer.js";
import type { MergedFaceRange } from "./MergedMeshManager.js";

// Babylon Lite's public type surface omits the thinInstances field and a few
// runtime-only fields this module relies on. These local extension interfaces
// describe the real shape so we can use a single, direct cast.
interface EngineWithDevice extends EngineContext {
	_device: GPUDevice;
}
interface PackedMesh extends Mesh {
	isVisible: boolean;
	thinInstances?: {
		matrices: Float32Array;
		count: number;
		_capacity: number;
		_version: number;
		_gpuBuffer: GPUBuffer | null;
		_gpuBufferStorage: boolean;
		_gpuVersion: number;
		_dirtyMin: number;
		_dirtyMax: number;
		_colorVersion?: number;
		_colorDirtyMin?: number;
		_colorDirtyMax?: number;
		_colorGpuBuffer?: GPUBuffer | null;
		_colorGpuBufferStorage?: boolean;
		_colorGpuVersion?: number;
		_gpuCullingEnabled?: boolean;
	};
}

export const USE_GPU_FACE_DECODING = true;

const MAX_LOCAL = 64; // subchunks per group (GROUP_SIZE^3)
const OFFSETS_PER_GROUP = MAX_LOCAL; // vec4 entries per group block
// log2(OFFSETS_PER_GROUP) — OFFSETS_PER_GROUP (== MAX_LOCAL) must stay a
// power of two for allocOffsetBlock/freeOffsetBlock's shifts below to stay
// equivalent to `* OFFSETS_PER_GROUP` / `/ OFFSETS_PER_GROUP`.
const OFFSETS_PER_GROUP_SHIFT = 6;

const SHARED_QUAD_POSITIONS = new Float32Array([
	0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1,
]);
const SHARED_QUAD_NORMALS = new Float32Array(12);
const SHARED_QUAD_INDICES = new Uint32Array([0, 2, 1, 0, 3, 2]);

// Float index inside the per-instance 4x4 matrix where we stash `faceBase`.
// world3 is the 4th column; .w is element 15. The shader reads it as world3.w.
const FACE_BASE_MATRIX_INDEX = 15;

// Upper bound (elements) for a per-mesh thin-instance matrix buffer: 256 MiB
// at 4 B/element, i.e. up to 4,194,304 faces per mesh. A merged group above
// this is pathological or corrupt — refusing beats allocating gigabytes and
// hard-crashing the tab.
const MAX_INSTANCE_MATRIX_ELEMENTS = 1 << 26;

interface PackedMeshState {
	faceArena: number;
	faceBase: number;
	faceCount: number;
	offsetBase: number;
	/** Retained instance-matrix buffer; reused across updates. Grows
	 *  monotonically (power-of-two capacity), so repeated face-count
	 *  growth never reallocates, but a larger need still reallocates. */
	instanceMatrices?: Float32Array;
	/** Number of instances whose matrix lanes are currently valid in
	 *  `instanceMatrices` (monotonic: lanes are only ever appended). */
	instanceLanesValid?: number;
	/** Retained mesh-visible bounds; reused across updates (no realloc). */
	boundMin?: [number, number, number];
	boundMax?: [number, number, number];
	/** Cached u32 views over the caller's input.faceDataA/B/C — rebuilt only
	 *  when the underlying buffer identity or range changes. */
	faceWordsA?: Uint32Array;
	faceWordsB?: Uint32Array;
	faceWordsC?: Uint32Array;
}

const meshState = new Map<Mesh, PackedMeshState>();

// ── Arena state ──────────────────────────────────────────────────────────────
let engineRef: EngineContext | null = null;
let sceneRef: SceneContext | null = null;

// PERF/BUGFIX: Deferred GPU resource disposal queue. disposeMeshGpu() destroys
// GPU buffers immediately, but the GPU may still be rendering with them from
// a previously-submitted command buffer. This causes "buffer used in submit
// while destroyed" WebGPU validation errors. We queue meshes for disposal and
// only dispose them after onGpuWorkDone() resolves.
const _pendingDisposal: Mesh[] = [];
let _disposalScheduled = false;

function scheduleDeferredDisposal(mesh: Mesh): void {
	_pendingDisposal.push(mesh);
	if (_disposalScheduled) return;
	_disposalScheduled = true;
	const engine = engineRef;
	if (!engine) {
		// Engine gone — dispose immediately (no GPU to wait for).
		for (const m of _pendingDisposal) disposeMeshGpu(m);
		_pendingDisposal.length = 0;
		_disposalScheduled = false;
		return;
	}
	void onGpuWorkDone(engine).then(() => {
		_disposalScheduled = false;
		for (const m of _pendingDisposal) disposeMeshGpu(m);
		_pendingDisposal.length = 0;
	});
}

// The face data is split across several storage buffers ("arenas"). A single
// GPU storage-buffer BINDING is capped at `maxStorageBufferBindingSize`
// (default 128 MiB ≈ 8.4M faces). To hold more loaded faces than that, we
// allocate additional arenas, each under the cap, and the shader selects the
// right one via a per-instance `arenaIndex`. `faceData0..faceData{N-1}` are
// bound to every packed material.
interface FaceArena {
	cpu: Uint32Array; // faceCount * 3 u32 (vec3<u32> per face)
	buffer: StorageBuffer;
	capacity: number; // in faces
	used: number; // in faces
	free: Array<{ base: number; count: number }>;
	/** False until the arena's buffer has been bound to all materials. */
	bound: boolean;
}

let faceArenas: FaceArena[] = [];
let maxFaceArenas = 1;

let offsetBuffer: StorageBuffer | null = null;

// Recycles {base,count} nodes discarded by merges instead of allocating a
// fresh literal on every freeFaces() call. Under steady-state churn (roughly
// as many merges as frees) the pool stays warm and converges to near-zero
// allocation for unload bursts.
const _freeIntervalPool: Array<{ base: number; count: number }> = [];

function acquireInterval(
	base: number,
	count: number,
): {
	base: number;
	count: number;
} {
	const node = _freeIntervalPool.pop();
	if (node) {
		node.base = base;
		node.count = count;
		return node;
	}
	return { base, count };
}

function releaseInterval(node: { base: number; count: number }): void {
	_freeIntervalPool.push(node);
}

let offsetCpu = new Float32Array(0);
let offsetCapacityGroups = 0;
let offsetUsedGroups = 0;
const offsetFree: number[] = []; // free block indices

// WebGPU writeBuffer size cap (bytes). Cached from the device at init; falls
// back to a conservative value if the device isn't reachable yet.
let maxWriteBytes = 64 * 1024 * 1024;

// Maximum size (bytes) a single storage-buffer BINDING may have. WebGPU's
// default `maxStorageBufferBindingSize` is 128 MiB, and a storage buffer
// larger than this fails validation *silently* when the bind group is built —
// every dependent mesh then draws nothing and the screen goes black with no
// thrown error. We cap each arena at this limit and add more arenas as needed.
let maxStorageBindingBytes = 128 * 1024 * 1024;

// Bytes per face in the arena (vec3<u32>: 3 words × 4 bytes).
// Layout (little-endian, see QuadBuffer.ts):
//   w0 = sx | sy<<8 | sz<<16 | axisFace(3)<<24 | tint(3)<<27
//   w1 = sw | sh<<8 | tileX<<16 | tileY<<24
//   w2 = ao | light<<8 | meta<<16 | chunkIndex(6)<<24
// The per-face chunk index (0..63) is OR'd in at merge time; the group's
// offsetBase (where its 64 chunk offsets live in the global chunkOffsets
// buffer) rides in the per-mesh instance matrix (world1.x) instead of a
// 4th word — that cut the arena stride from 16 to 12 bytes per face.
const FACE_BYTES = 12;
const FACE_WORDS = 3;
const FACE_WORD_BYTES = 12;

const OFFSET_WORDS = 4;
const OFFSET_ENTRY_BYTES = 16;

// Element index inside the per-instance 4x4 matrix where we stash the group's
// chunkOffsets base (world1.x = matrix element 4). The vertex shader computes
// the per-face offset as `chunkOffsets[offsetBase + ci]`. f32 holds integers
// up to 2^24 exactly; offsetBase is far below that (offsetUsedGroups * 64).
const OFFSET_BASE_MATRIX_INDEX = 4;

// Element index inside the per-instance 4x4 matrix where we stash `arenaIndex`.
// world0.w is column 0, row 3 (matrix element 3). The vertex shader reads it
// as world0.w; nothing else uses world0, so it's safe to repurpose.
const ARENA_MATRIX_INDEX = 3;

const registeredMaterials: ShaderMaterial[] = [];
// Materials already bound to the shared arena buffers. We bind each material's
// storage-buffer slots exactly once: re-binding bumps the material's visibility
// epoch, which makes Lite rebuild individual meshes through the plain
// (non-instanced) builder that omits the thin-instance matrix attributes our
// vertex shader reads. See registerPackedMaterial.
const boundMaterials = new Set<ShaderMaterial>();

// Materials for which we've forced an instanced group build. `buildScene` only
// runs the deferred group builders once (at registration), but packed chunk
// meshes are added later, so they would otherwise be rebuilt via
// `processMaterialSwaps` using a `_rebuildSingle` that was never set (the
// per-material group builder only sets it when it runs as a group). We force a
// single instanced group build per material to populate `_rebuildSingle`, after
// which `processMaterialSwaps` can build each mesh correctly.
const forcedBuilds = new Set<ShaderMaterial>();
function ensureInstancedBuild(material: ShaderMaterial, mesh: Mesh): void {
	if (forcedBuilds.has(material) || !sceneRef) return;
	forcedBuilds.add(material);
	const bg = (
		material as unknown as {
			_buildGroup?: (sc: unknown, meshes: Array<unknown>) => Promise<unknown>;
		}
	)._buildGroup;
	if (typeof bg === "function") {
		// Runs buildShaderGroup with a thin-instance mesh present, which makes the
		// builder capture an instanced-aware `_rebuildSingle`. The renderables it
		// returns are discarded here (not pushed); `processMaterialSwaps` pushes
		// the real ones once `_rebuildSingle` is populated.
		void bg(sceneRef, [mesh]).catch(() => {});
	}
}

export function initPackedChunkArenas(
	engine: EngineContext,
	scene: SceneContext,
): void {
	engineRef = engine;
	sceneRef = scene;
	const device = (engine as EngineWithDevice)._device;
	if (typeof device.limits.maxBufferSize === "number") {
		maxWriteBytes = device.limits.maxBufferSize;
	}
	if (typeof device.limits.maxStorageBufferBindingSize === "number") {
		maxStorageBindingBytes = device.limits.maxStorageBufferBindingSize;
	}
	// Faces are stored in `faceData0..N-1` (one storage buffer per arena) plus
	// the shared `chunkOffsets` buffer and (for LOD2/LOD3) a `tintLUT` buffer.
	// Reserve slots for those fixed bindings so we don't exceed the device's
	// per-shader-stage storage-buffer limit. Default limit is 8 → 6 face
	// arenas (~50M faces). Capped at 16 as a safety rail.
	const perStage = device.limits.maxStorageBuffersPerShaderStage;
	const limit = typeof perStage === "number" ? perStage : 8;
	maxFaceArenas = Math.max(1, Math.min(limit - 2, 16));
	ensureArenas();
}

/** Number of face-data storage-buffer arenas bound to each material. */
export function getFaceArenaCount(): number {
	return Math.max(1, maxFaceArenas);
}

function ensureArenas(): void {
	if (!offsetBuffer) {
		offsetCapacityGroups = 1024;
		offsetCpu = new Float32Array(offsetCapacityGroups * OFFSETS_PER_GROUP * 4);
		offsetBuffer = createStorageBuffer(engineRef!, offsetCpu, "offset-set");
		for (const m of registeredMaterials) {
			setShaderStorageBuffer(m, "chunkOffsets", offsetBuffer);
			boundMaterials.add(m);
		}
	}
	// Pre-size each arena to a generous initial capacity so growth at runtime
	// is rare. `maxStorageBindingBytes / FACE_BYTES` is the binding cap; we
	// start each arena at 262144 faces (3 MiB at 12 B/face) which covers
	// ~1.5M faces across 6 arenas before any grow is needed — well past a
	// typical render distance. The capacity doubles on demand up to the
	// binding cap if needed.
	const maxFaces = maxFacesPerArena();
	const initialCapacity = Math.min(262_144, maxFaces);
	while (faceArenas.length < maxFaceArenas) {
		createFaceArena(initialCapacity);
	}
}

// Allocate one fresh face arena sized just under the binding limit. Never
// exceeds maxStorageBindingBytes — an oversized buffer silently fails to bind
// and blackscreens the world.
function createFaceArena(initialCapacity: number): FaceArena {
	const maxFaces = Math.floor(maxStorageBindingBytes / FACE_BYTES);
	let capacity = initialCapacity;
	if (capacity < 1) capacity = 1;
	if (capacity > maxFaces) capacity = maxFaces;
	const cpu = new Uint32Array(capacity * 3);
	const buffer = createStorageBuffer(engineRef!, cpu);
	const arena: FaceArena = {
		cpu,
		buffer,
		capacity,
		used: 0,
		free: [],
		bound: false,
	};
	faceArenas.push(arena);
	bindArenaToMaterials(arena, faceArenas.length - 1);
	return arena;
}

// Bind a face arena's buffer to every registered material under its
// `faceDataN` slot. Called when the arena is created (materials may not all
// exist yet — registerPackedMaterial re-binds every arena to late materials).
function bindArenaToMaterials(arena: FaceArena, index: number): void {
	const name = `faceData${index}`;
	for (const m of registeredMaterials) {
		setShaderStorageBuffer(m, name, arena.buffer);
		boundMaterials.add(m);
	}
	arena.bound = true;
}

// Total faces currently allocated across all arenas (for diagnostics).
function totalFacesUsed(): number {
	let total = 0;
	for (const a of faceArenas) total += a.used;
	return total;
}
function totalFaceCapacity(): number {
	let total = 0;
	for (const a of faceArenas) total += a.capacity;
	return total;
}

// Result of a face allocation: which arena plus the base within that arena.
// arena < 0 means allocation failed (all arenas full and no new arena could
// be created — e.g. maxFaceArenas reached).
interface FaceAlloc {
	arena: number;
	base: number;
}

// Grow an existing arena in place up to the binding cap: reallocate its CPU
// array + GPU buffer (preserving existing faces) and rebind every material.
// The buffer identity changes, so materials re-bind; the group-build path
// keeps the instanced pipeline, so this is safe.
function growArena(arena: FaceArena, index: number): void {
	const maxFaces = Math.floor(maxStorageBindingBytes / FACE_BYTES);
	// 4x steps: each grow is expensive (full CPU copy + new GPU storage
	// buffer + material rebinds), so halve the number of events during
	// wide-ring streaming even at the cost of extra VRAM slack.
	const newCapacity = Math.min(arena.capacity * 4, maxFaces);
	if (newCapacity <= arena.capacity) return;
	const newCpu = new Uint32Array(newCapacity * 3);
	newCpu.set(arena.cpu.subarray(0, arena.used * 3));
	arena.cpu = newCpu;
	arena.capacity = newCapacity;
	const old = arena.buffer;
	arena.buffer = createStorageBuffer(engineRef!, arena.cpu);
	bindArenaToMaterials(arena, index);
	if (engineRef && old) {
		const e = engineRef;
		void onGpuWorkDone(e).then(() => disposeStorageBuffer(old));
	}
}

// Total faces one arena may hold (the binding-size cap). All arenas are
// created up front (see ensureArenas) and grow toward this independently.
// Exported so MergedMeshManager can clamp merged-group capacity to what a
// single arena block can actually hold.
export function maxFacesPerArena(): number {
	return Math.floor(maxStorageBindingBytes / FACE_BYTES);
}

function allocFaces(count: number): FaceAlloc {
	if (count <= 0) {
		return { arena: 0, base: 0 };
	}

	const maxFaces = maxFacesPerArena();

	// 1) Reuse a freed hole in any existing arena.
	// Important: when splitting an existing free interval, mutate the existing
	// pooled node in place instead of replacing it with a new pooled object.
	// The old version leaked the old interval object from the pool path.
	for (let ai = 0; ai < faceArenas.length; ai++) {
		const arena = faceArenas[ai];
		const free = arena.free;

		for (let i = 0, len = free.length; i < len; i++) {
			const node = free[i];

			if (node.count >= count) {
				const base = node.base;
				const leftover = node.count - count;

				if (leftover > 0) {
					node.base = base + count;
					node.count = leftover;
				} else {
					free.splice(i, 1);
					releaseInterval(node);
				}

				return { arena: ai, base };
			}
		}
	}

	// 2) Append to an arena tail, growing that arena first if possible.
	for (let ai = 0; ai < faceArenas.length; ai++) {
		const arena = faceArenas[ai];

		if (arena.used + count <= arena.capacity) {
			const base = arena.used;
			arena.used += count;
			return { arena: ai, base };
		}

		if (arena.capacity < maxFaces) {
			growArena(arena, ai);

			if (arena.used + count <= arena.capacity) {
				const base = arena.used;
				arena.used += count;
				return { arena: ai, base };
			}
		}
	}

	console.error(
		`[PackedChunkMesh] face arenas exhausted (${totalFacesUsed()} faces, ` +
			`${faceArenas.length} arenas = ${totalFaceCapacity()} faces). ` +
			`Loaded geometry exceeds the GPU storage-buffer arena limit ` +
			`(maxFaceArenas=${maxFaceArenas}).`,
	);

	return { arena: -1, base: -1 };
}

// Grow an existing face block in place from `oldCount` to `newCount` faces,
// avoiding the allocFaces/freeFaces shuffle. Succeeds when the block ends at
// the arena tail (the streaming-append case) or when a free interval starts
// exactly where the block ends and is at least as large as the delta (the
// block was previously adjacent to a freed hole). On success the arena's
// used/free state is updated; the caller then packs + uploads only the dirty
// ranges. Returns false when the block can't grow in place (caller falls
// back to the full realloc path).
function tryExtendFaces(
	arena: FaceArena,
	arenaIndex: number,
	base: number,
	oldCount: number,
	newCount: number,
): boolean {
	if (newCount <= oldCount) return false;
	const delta = newCount - oldCount;
	const end = base + oldCount;

	if (end === arena.used) {
		if (base + newCount > arena.capacity) {
			growArena(arena, arenaIndex);
			if (base + newCount > arena.capacity) return false;
		}
		arena.used = base + newCount;
		return true;
	}

	// Block is not at the tail: look for a free interval starting at `end`.
	// `free` is sorted by base (freeFaceInterval keeps it ordered), so a
	// binary search finds the candidate in O(log n) instead of a scan.
	let lo = 0;
	let hi = arena.free.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (arena.free[mid].base < end) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}

	const node = arena.free[lo];
	if (node && node.base === end && node.count >= delta) {
		const leftover = node.count - delta;
		if (leftover > 0) {
			node.base = end + delta;
			node.count = leftover;
		} else {
			arena.free.splice(lo, 1);
			releaseInterval(node);
		}
		return true;
	}

	return false;
}

function freeFaceInterval(
	free: Array<{ base: number; count: number }>,
	base: number,
	count: number,
): void {
	if (count <= 0) return;

	let lo = 0;
	let hi = free.length;

	while (lo < hi) {
		const mid = (lo + hi) >>> 1;

		if (free[mid].base < base) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}

	let i = lo;
	const node = acquireInterval(base, count);

	// Manual insert avoids Array.splice allocation/slow path overhead.
	const oldLen = free.length;
	free.length = oldLen + 1;

	for (let j = oldLen; j > i; j--) {
		free[j] = free[j - 1];
	}

	free[i] = node;

	// Merge left.
	if (i > 0) {
		const prev = free[i - 1];
		const curr = free[i];

		if (prev.base + prev.count === curr.base) {
			prev.count += curr.count;

			for (let j = i; j < free.length - 1; j++) {
				free[j] = free[j + 1];
			}

			free.length--;
			releaseInterval(curr);
			i--;
		}
	}

	// Merge right.
	if (i < free.length - 1) {
		const curr = free[i];
		const next = free[i + 1];

		if (curr.base + curr.count === next.base) {
			curr.count += next.count;

			for (let j = i + 1; j < free.length - 1; j++) {
				free[j] = free[j + 1];
			}

			free.length--;
			releaseInterval(next);
		}
	}
}

function freeFaces(arena: number, base: number, count: number): void {
	if (arena < 0 || arena >= faceArenas.length) return;
	freeFaceInterval(faceArenas[arena].free, base, count);
}

function freeOffsetBlock(base: number): void {
	// OFFSETS_PER_GROUP is a power of two (64): an unsigned right shift is
	// exact for non-negative `base` and skips the float division + `|0`
	// truncation the previous `(base / OFFSETS_PER_GROUP) | 0` did — same
	// idea as the "faster than Math.floor" comment already on this line.
	const blockIndex = base >>> OFFSETS_PER_GROUP_SHIFT;
	offsetFree.push(blockIndex);
}

function allocOffsetBlock(): number {
	if (offsetFree.length > 0) {
		const blockIndex = offsetFree.pop()!;
		return blockIndex << OFFSETS_PER_GROUP_SHIFT;
	}
	if (offsetUsedGroups + 1 > offsetCapacityGroups) growOffset();
	const blockIndex = offsetUsedGroups;
	offsetUsedGroups += 1;
	return blockIndex << OFFSETS_PER_GROUP_SHIFT;
}

function growOffset(): void {
	const newCapacity = offsetCapacityGroups * 2;
	const newCpu = new Float32Array(newCapacity * OFFSETS_PER_GROUP * 4);
	newCpu.set(offsetCpu.subarray(0, offsetUsedGroups * OFFSETS_PER_GROUP * 4));
	offsetCpu = newCpu;
	offsetCapacityGroups = newCapacity;
	const old = offsetBuffer;
	offsetBuffer = createStorageBuffer(engineRef!, offsetCpu, "offset-set");
	for (const m of registeredMaterials) {
		setShaderStorageBuffer(m, "chunkOffsets", offsetBuffer);
		boundMaterials.add(m);
	}
	if (engineRef && old) {
		const e = engineRef;
		void onGpuWorkDone(e).then(() => disposeStorageBuffer(old));
	}
}
function uploadFaceRange(arena: number, base: number, count: number): void {
	const a = faceArenas[arena];
	if (!a || count <= 0) return;

	writeBufferChunked(
		a.buffer,
		a.cpu,
		base * FACE_WORD_BYTES,
		base * FACE_WORDS,
		count * FACE_WORDS,
	);
}

// Upload only the given arena face ranges (arena-face coordinates). `ranges`
// are already coalesced by the caller, so each range is one writeBuffer.
// Ranges are clamped to `faceCount` so a stale/mismatched list can never
// overwrite another mesh's arena block.
function uploadFaceRanges(
	arena: number,
	faceBase: number,
	faceCount: number,
	ranges: readonly MergedFaceRange[],
): void {
	if (faceCount <= 0 || ranges.length === 0) return;

	for (let r = 0, len = ranges.length; r < len; r++) {
		const range = ranges[r];

		let start = range.start;
		let count = range.count;

		if (start < 0) {
			count += start;
			start = 0;
		}

		if (count <= 0 || start >= faceCount) {
			continue;
		}

		if (start + count > faceCount) {
			count = faceCount - start;
		}

		uploadFaceRange(arena, faceBase + start, count);
	}
}

function uploadOffsetRange(base: number): void {
	if (!offsetBuffer) return;

	writeBufferChunked(
		offsetBuffer,
		offsetCpu,
		base * OFFSET_ENTRY_BYTES,
		base * OFFSET_WORDS,
		OFFSETS_PER_GROUP * OFFSET_WORDS,
	);
}

// Splits a large upload into chunks no larger than the device's maxWriteBufferSize,
// which a single writeBuffer call would reject.
function writeBufferChunked(
	buffer: StorageBuffer,
	data: Uint32Array | Float32Array,
	dstByteOffset: number,
	srcElementOffset: number,
	elementCount: number,
): void {
	if (!engineRef || elementCount <= 0) return;

	const bytesPerElement = 4;
	const maxElements = Math.max(1, (maxWriteBytes / bytesPerElement) | 0);

	if (elementCount <= maxElements) {
		updateStorageBuffer(
			engineRef,
			buffer,
			data.subarray(srcElementOffset, srcElementOffset + elementCount),
			dstByteOffset,
		);
		return;
	}

	let remaining = elementCount;
	let dst = dstByteOffset;
	let src = srcElementOffset;

	while (remaining > 0) {
		const n = remaining > maxElements ? maxElements : remaining;

		updateStorageBuffer(engineRef, buffer, data.subarray(src, src + n), dst);

		dst += n * bytesPerElement;
		src += n;
		remaining -= n;
	}
}

/** Bind a material to the shared arenas (idempotent). */
export function registerPackedMaterial(material: ShaderMaterial): void {
	if (registeredMaterials.includes(material)) return;
	ensureArenas();
	registeredMaterials.push(material);

	// Babylon Lite's shader group builder is a SINGLETON (`getShaderGroupBuilder`).
	// Its `_rebuildSingle` is set by the *first* `buildShaderGroup` call for that
	// builder. In this app the first shader-material group built is the set of
	// non-instanced meshes (sky, cracks, highlights, ...), so the singleton's
	// `_rebuildSingle` becomes the PLAIN (non-thin-instance) rebuild. Every
	// shader mesh added later — including our thin-instance packed chunks — is
	// then rebuilt through that plain path, which omits the `world0..3` vertex
	// attributes our shader reads, producing the "struct member world3 not found"
	// WGSL error.
	//
	// Fix: give every packed material its OWN independent `_buildGroup` (delegating
	// to the shared Lite builder but capturing its own `_rebuildSingle`). Each
	// packed material therefore builds its meshes through a dedicated group: when
	// that group is built it sees `thinInstances` and produces an instanced-aware
	// `_rebuildSingle`, which can no longer be clobbered by the plain singleton.
	type BuildGroupFn = ((
		sc: unknown,
		meshes: Array<unknown>,
	) => Promise<{
		renderables: unknown[];
		rebuildSingle?: (...a: unknown[]) => unknown;
	}>) & {
		_rebuildSingle?: (...a: unknown[]) => unknown;
		_materialFamily?: string;
	};
	const matAny = material as unknown as { _buildGroup?: BuildGroupFn };
	const shared = matAny._buildGroup;
	if (shared) {
		const own = (async (
			sc: unknown,
			meshes: Array<unknown>,
		): Promise<{
			renderables: unknown[];
			rebuildSingle?: (...a: unknown[]) => unknown;
		}> => {
			const result = await shared(sc, meshes);
			// Capture this group's instanced-aware rebuild as our own, separate
			// from the shared singleton's (which may be plain).
			own._rebuildSingle = result.rebuildSingle ?? shared._rebuildSingle;
			own._materialFamily = "shader";
			return result;
		}) as BuildGroupFn;
		own._materialFamily = "shader";
		own._rebuildSingle = shared._rebuildSingle;
		matAny._buildGroup = own;
	}

	// Bind the storage buffers exactly once per material. setShaderStorageBuffer
	// bumps the material's visibility epoch, which makes Lite rebuild individual
	// meshes; with the dedicated group above those rebuilds stay instanced.
	if (!boundMaterials.has(material)) {
		for (let i = 0; i < faceArenas.length; i++) {
			setShaderStorageBuffer(material, `faceData${i}`, faceArenas[i]?.buffer);
			faceArenas[i]!.bound = true;
		}
		if (offsetBuffer) {
			setShaderStorageBuffer(material, "chunkOffsets", offsetBuffer);
		}
		boundMaterials.add(material);
	}
}

export interface PackedMeshInput {
	name: string;
	material: ShaderMaterial;
	faceDataA: Uint8Array;
	faceDataB: Uint8Array;
	faceDataC: Uint8Array;
	chunkOffsets: Float32Array; // length 192, stride 3
	position: [number, number, number];
	boundsMin: [number, number, number];
	boundsMax: [number, number, number];
}

// `input` is the caller's (reused, module-level scratch) `PackedMeshInput`,
// so its typed arrays are only ever replaced when the merged-group buffers
// grow — the views below stay valid across calls and are rebuilt only when
// the buffer identity or range changes.
// Reinterpreting faceDataA/B/C (each a byte array with a 4-multiple length
// and offset) as a Uint32Array over the SAME buffer is safe: the
// little-endian byte layout `a[i*4]` (LSB) .. `a[i*4+3]` (MSB) is
// bit-for-bit identical to reading those four bytes as one u32 on every
// realistic deployment target (WebGPU browsers are all little-endian).
// This turns 12 shifts+ORs per face into 3 direct word reads, and replaces
// four independent `i * 4` index computations per array with one running
// accumulator.
// Rebuild the cached u32 views over `input`'s face data.
function ensureFaceWordViews(
	state: PackedMeshState,
	input: PackedMeshInput,
): void {
	const faceCount = input.faceDataA.length >>> 2;

	let aWords = state.faceWordsA;
	if (
		!aWords ||
		aWords.buffer !== input.faceDataA.buffer ||
		aWords.byteOffset !== input.faceDataA.byteOffset ||
		aWords.length !== faceCount
	) {
		aWords = new Uint32Array(
			input.faceDataA.buffer,
			input.faceDataA.byteOffset,
			faceCount,
		);
		state.faceWordsA = aWords;
	}
	let bWords = state.faceWordsB;
	if (
		!bWords ||
		bWords.buffer !== input.faceDataB.buffer ||
		bWords.byteOffset !== input.faceDataB.byteOffset ||
		bWords.length !== faceCount
	) {
		bWords = new Uint32Array(
			input.faceDataB.buffer,
			input.faceDataB.byteOffset,
			faceCount,
		);
		state.faceWordsB = bWords;
	}
	let cWords = state.faceWordsC;
	if (
		!cWords ||
		cWords.buffer !== input.faceDataC.buffer ||
		cWords.byteOffset !== input.faceDataC.byteOffset ||
		cWords.length !== faceCount
	) {
		cWords = new Uint32Array(
			input.faceDataC.buffer,
			input.faceDataC.byteOffset,
			faceCount,
		);
		state.faceWordsC = cWords;
	}
}

// Pack only the given merged-face ranges into the arena. `ranges` are in
// merged-face coordinates (the concatenated group layout); the arena layout
// is identical, shifted by state.faceBase. Ranges are clamped to the mesh's
// face count so a stale/mismatched list can never corrupt the arena.
// Each face is 3 u32 words; the per-face chunk index (ci) is already stamped
// into word2 byte 3 by the merged-group assembly, so the words are copied
// verbatim.
//
// PERF: the inner copy is 4-way unrolled. This is the hottest per-element
// kernel in the file (runs over every dirty face on every remesh) — with the
// plain 1-at-a-time loop, the increment/compare/branch of the loop itself is
// a significant fraction of the 6 memory ops (3 loads + 3 stores) each
// iteration does. Unrolling amortizes that control overhead across 4 faces
// and gives the CPU more independent load/store pairs to overlap. As with
// any hand-unroll, verify the win against a trace rather than assuming it —
// gains here are JIT/engine dependent.
function packFaceRanges(
	state: PackedMeshState,
	input: PackedMeshInput,
	ranges: readonly MergedFaceRange[],
): void {
	if (ranges.length === 0) return;

	ensureFaceWordViews(state, input);

	const faceCount = input.faceDataA.length >>> 2;

	if (faceCount <= 0) return;

	const arena = faceArenas[state.faceArena];
	if (!arena) return;

	const faceCpu = arena.cpu;
	const aWords = state.faceWordsA!;
	const bWords = state.faceWordsB!;
	const cWords = state.faceWordsC!;
	const baseWord = state.faceBase * FACE_WORDS;

	for (let r = 0, len = ranges.length; r < len; r++) {
		const range = ranges[r];

		let start = range.start;
		let count = range.count;

		if (start < 0) {
			count += start;
			start = 0;
		}

		if (count <= 0 || start >= faceCount) {
			continue;
		}

		if (start + count > faceCount) {
			count = faceCount - start;
		}

		const end = start + count;
		const unrolledEnd = start + (count - (count % 4));

		let dst = baseWord + start * FACE_WORDS;
		let i = start;

		for (; i < unrolledEnd; i += 4) {
			faceCpu[dst] = aWords[i];
			faceCpu[dst + 1] = bWords[i];
			faceCpu[dst + 2] = cWords[i];

			faceCpu[dst + 3] = aWords[i + 1];
			faceCpu[dst + 4] = bWords[i + 1];
			faceCpu[dst + 5] = cWords[i + 1];

			faceCpu[dst + 6] = aWords[i + 2];
			faceCpu[dst + 7] = bWords[i + 2];
			faceCpu[dst + 8] = cWords[i + 2];

			faceCpu[dst + 9] = aWords[i + 3];
			faceCpu[dst + 10] = bWords[i + 3];
			faceCpu[dst + 11] = cWords[i + 3];

			dst += 12;
		}

		for (; i < end; i++) {
			faceCpu[dst] = aWords[i];
			faceCpu[dst + 1] = bWords[i];
			faceCpu[dst + 2] = cWords[i];
			dst += FACE_WORDS;
		}
	}
}

// Same 4-way unroll as packFaceRanges above, for the full-mesh pack path
// (initial build / full realloc). See that function's PERF comment.
function packFaces(state: PackedMeshState, input: PackedMeshInput): void {
	ensureFaceWordViews(state, input);

	const arena = faceArenas[state.faceArena];
	if (!arena) return;

	const faceCpu = arena.cpu;
	const aWords = state.faceWordsA!;
	const bWords = state.faceWordsB!;
	const cWords = state.faceWordsC!;
	const faceCount = aWords.length;

	const unrolledEnd = faceCount - (faceCount % 4);

	let o = state.faceBase * FACE_WORDS;
	let i = 0;

	for (; i < unrolledEnd; i += 4) {
		faceCpu[o] = aWords[i];
		faceCpu[o + 1] = bWords[i];
		faceCpu[o + 2] = cWords[i];

		faceCpu[o + 3] = aWords[i + 1];
		faceCpu[o + 4] = bWords[i + 1];
		faceCpu[o + 5] = cWords[i + 1];

		faceCpu[o + 6] = aWords[i + 2];
		faceCpu[o + 7] = bWords[i + 2];
		faceCpu[o + 8] = cWords[i + 2];

		faceCpu[o + 9] = aWords[i + 3];
		faceCpu[o + 10] = bWords[i + 3];
		faceCpu[o + 11] = cWords[i + 3];

		o += 12;
	}

	for (; i < faceCount; i++) {
		faceCpu[o] = aWords[i];
		faceCpu[o + 1] = bWords[i];
		faceCpu[o + 2] = cWords[i];
		o += 3;
	}
}

function packOffsets(state: PackedMeshState, input: PackedMeshInput): void {
	const co = input.chunkOffsets;

	let src = 0;
	let dst = state.offsetBase * OFFSET_WORDS;

	for (let idx = 0; idx < MAX_LOCAL; idx++) {
		offsetCpu[dst++] = co[src++];
		offsetCpu[dst++] = co[src++];
		offsetCpu[dst++] = co[src++];
		offsetCpu[dst++] = 0;
	}
}

// Build / reuse the thin-instance matrix buffer for a mesh: `count` matrices
// whose world3.w (matrices[i*16 + FACE_BASE_MATRIX_INDEX]) carries `faceBase`
// and world1.x (OFFSET_BASE_MATRIX_INDEX) carries the group's chunkOffsets
// base. The shader reads those and ignores the rest (it computes the vertex
// position from faceData), so the rest of every matrix stays zero.
//
// PERF: the buffer is RETAINED per-mesh on PackedMeshState and reused across
// updates — only the faceBase/arena/offsetBase lanes per instance are
// rewritten, and only when the instance count changes do we reallocate. This
// removes the previous `count*16` Float32Array allocation on every chunk
// remesh (a major GC source in the updatePackedChunkMesh hot path).
//
// Capacity GROWS monotonically (never shrinks), so a mesh whose face count
// fluctuates around a level reuses its buffer instead of zero-filling a
// fresh `count*16` array on every rebuild. `start` is the first instance
// index whose lanes need (re)writing — callers pass `state.faceCount` (the
// old count) when only the appended instances are new, and 0 when the
// faceBase/arena/offsetBase lanes themselves changed.
//
// Returns null (and logs) when `count` is not a sane non-negative number or
// would need more than MAX_INSTANCE_MATRIX_ELEMENTS — the caller then skips
// the mesh update instead of attempting a multi-gigabyte allocation (which
// hard-crashes the tab with "Array buffer allocation failed").
//
// PERF: the write loop is 4-way unrolled. It only ever writes 3 scalar lanes
// per instance (faceBase/arena/offsetBase are constant across the whole
// call), so the loop-control-to-work ratio here is even worse than
// packFaces' — unrolling has more relative overhead to amortize. Verify
// against a trace, same caveat as packFaceRanges.
function buildInstanceMatrices(
	prev: Float32Array | undefined,
	arena: number,
	faceBase: number,
	offsetBase: number,
	count: number,
	start: number,
): Float32Array | null {
	if (!Number.isFinite(count) || count < 0) {
		console.warn(
			`[PackedChunkMesh] refusing instance-matrix buffer: ` +
				`invalid face count ${count}.`,
		);
		return null;
	}

	const needLen = count * 16;

	if (needLen > MAX_INSTANCE_MATRIX_ELEMENTS) {
		console.warn(
			`[PackedChunkMesh] refusing instance-matrix buffer: ` +
				`${count} faces (${needLen} matrix elements) exceeds the safe ` +
				`limit of ${MAX_INSTANCE_MATRIX_ELEMENTS >> 4} faces per mesh. ` +
				`Mesh update skipped.`,
		);
		return null;
	}

	let matrices = prev;
	if (!matrices || matrices.length < needLen) {
		// Grow to a power of two above the need so repeated face-count
		// growth (the streaming-append case) doesn't reallocate each time.
		// Plain multiplication, NOT `<<=`: a left shift is 32-bit and wraps
		// negative above 2^30, which turns this loop into an infinite loop
		// and the allocation into an OOM crash.
		let capacity = 1024;
		while (capacity < needLen) capacity *= 2;
		matrices = new Float32Array(capacity);
		start = 0;
	}

	// The matrices are otherwise all-zero and never change, so only the
	// faceBase (world3.w), arena (world0.w) and offsetBase (world1.x) lanes
	// are ever rewritten.
	const span = count - start;
	const unrolledEnd = start + (span - (span % 4));

	let i = start;
	let faceIdx = FACE_BASE_MATRIX_INDEX + start * 16;
	let arenaIdx = ARENA_MATRIX_INDEX + start * 16;
	let offsetIdx = OFFSET_BASE_MATRIX_INDEX + start * 16;

	for (; i < unrolledEnd; i += 4) {
		matrices[faceIdx] = faceBase;
		matrices[arenaIdx] = arena;
		matrices[offsetIdx] = offsetBase;

		matrices[faceIdx + 16] = faceBase;
		matrices[arenaIdx + 16] = arena;
		matrices[offsetIdx + 16] = offsetBase;

		matrices[faceIdx + 32] = faceBase;
		matrices[arenaIdx + 32] = arena;
		matrices[offsetIdx + 32] = offsetBase;

		matrices[faceIdx + 48] = faceBase;
		matrices[arenaIdx + 48] = arena;
		matrices[offsetIdx + 48] = offsetBase;

		faceIdx += 64;
		arenaIdx += 64;
		offsetIdx += 64;
	}

	for (; i < count; i++) {
		matrices[faceIdx] = faceBase;
		matrices[arenaIdx] = arena;
		matrices[offsetIdx] = offsetBase;
		faceIdx += 16;
		arenaIdx += 16;
		offsetIdx += 16;
	}

	return matrices;
}
// ── Thin-instance range updates ─────────────────────────────────────────────
// Low-level replacement for the public setThinInstances() that avoids paying
// for a full buffer recreation + full re-upload on every face-count change.
//
// Two paths:
//  1. GROWTH (rare): capacity actually increased, or there's no GPU buffer
//     yet. We delegate to the real setThinInstances(), but size it to the
//     mesh's full retained capacity rather than the current logical count —
//     this is what lets subsequent count increases, up to that capacity,
//     avoid path 1 entirely. Full dirty range here is fine; it only happens
//     on mesh creation and on the (power-of-two) doublings.
//  2. IN-PLACE (common): same GPU buffer, only `count` and a sub-range of
//     lanes changed. We mutate `matrices`/`count` directly and widen the
//     dirty range instead of resetting it to [0, count), so Lite's sync step
//     uploads only the changed lanes on the next frame.
function setThinInstancesRange(
	mesh: Mesh,
	matrices: Float32Array,
	count: number,
	dirtyStart: number,
	dirtyEnd: number,
): void {
	const anyMesh = mesh as PackedMesh;
	const capacity = matrices.length / 16;

	if (count > capacity) {
		console.error(
			`[PackedChunkMesh] thin-instance count (${count}) exceeds ` +
				`matrices capacity (${capacity}) — caller bug.`,
		);
		return;
	}

	let ti = anyMesh.thinInstances;
	const needsGrowth = !ti?._gpuBuffer || capacity > (ti._capacity ?? 0);

	if (needsGrowth) {
		// Size the underlying buffer to the full capacity, not just `count`,
		// so future in-place updates (path 2) have headroom to grow into
		// without ever hitting this branch again.
		setThinInstances(mesh, matrices, capacity);
		ti = anyMesh.thinInstances;
		if (ti) {
			ti._capacity = capacity;
			ti.count = count; // fix the draw count back down; buffer stays capacity-sized
		}
		return;
	}

	// Fast path — same GPU buffer, just update what changed.
	ti!.matrices = matrices;
	ti!.count = count;

	const lo = Math.max(0, Math.min(dirtyStart, dirtyEnd));
	const hi = Math.min(capacity, Math.max(dirtyStart, dirtyEnd));
	if (hi <= lo) return;

	// If the previous dirty range was already consumed (version caught up),
	// it's safe to overwrite with just this update's range. If not, a prior
	// update is still pending an upload — union with it instead of clobbering it.
	const inSync = ti!._version === ti!._gpuVersion;
	ti!._dirtyMin = inSync ? lo : Math.min(ti!._dirtyMin, lo);
	ti!._dirtyMax = inSync ? hi : Math.max(ti!._dirtyMax, hi);
	ti!._version++;
}
function reuseOrCloneVec3(
	prev: [number, number, number] | undefined,
	src: readonly [number, number, number],
): [number, number, number] {
	if (prev) {
		prev[0] = src[0];
		prev[1] = src[1];
		prev[2] = src[2];
		return prev;
	}
	return [src[0], src[1], src[2]];
}

export function createPackedChunkMesh(input: PackedMeshInput): Mesh | null {
	const engine = engineRef!;
	const scene = sceneRef!;

	const faceCount = input.faceDataA.length >>> 2;

	// Refuse before doing any work (arena/offset allocation, mesh creation):
	// a corrupt face count would otherwise reach buildInstanceMatrices and
	// attempt a multi-gigabyte allocation.
	if (faceCount * 16 > MAX_INSTANCE_MATRIX_ELEMENTS) {
		console.warn(
			`[PackedChunkMesh] skipping mesh for "${input.name}": ` +
				`${faceCount} faces exceeds the safe per-mesh limit of ` +
				`${MAX_INSTANCE_MATRIX_ELEMENTS >> 4}.`,
		);
		return null;
	}

	const alloc = allocFaces(faceCount);

	if (alloc.arena < 0) {
		console.warn(
			`[PackedChunkMesh] skipping mesh for "${input.name}": ` +
				`face arenas full (${totalFacesUsed()}/${totalFaceCapacity()}).`,
		);
		return null;
	}

	// Allocate offset block only after face allocation succeeds.
	// The previous order leaked offset blocks when allocFaces failed.
	const offsetBase = allocOffsetBlock();

	const state: PackedMeshState = {
		faceArena: alloc.arena,
		faceBase: alloc.base,
		faceCount,
		offsetBase,
	};

	packFaces(state, input);
	packOffsets(state, input);

	uploadFaceRange(alloc.arena, alloc.base, faceCount);
	uploadOffsetRange(offsetBase);

	const mesh = createMeshFromData(
		engine,
		input.name,
		SHARED_QUAD_POSITIONS,
		SHARED_QUAD_NORMALS,
		SHARED_QUAD_INDICES,
	);

	mesh.material = input.material;
	mesh.position.set(input.position[0], input.position[1], input.position[2]);
	mesh.pickable = false;

	const anyMesh = mesh as PackedMesh;

	const boundMin = reuseOrCloneVec3(state.boundMin, input.boundsMin);
	const boundMax = reuseOrCloneVec3(state.boundMax, input.boundsMax);

	state.boundMin = boundMin;
	state.boundMax = boundMax;

	anyMesh.boundMin = boundMin;
	anyMesh.boundMax = boundMax;
	anyMesh.isVisible = true;

	const instanceMatrices = buildInstanceMatrices(
		undefined,
		alloc.arena,
		alloc.base,
		offsetBase,
		faceCount,
		0,
	);

	if (!instanceMatrices) {
		// Unreachable after the count validation above; keep the guard so a
		// future regression cannot leak the arena block, offset block and
		// mesh. The mesh was never added to the scene, so disposing its GPU
		// resources immediately is safe.
		freeFaces(alloc.arena, alloc.base, faceCount);
		freeOffsetBlock(offsetBase);
		disposeMeshGpu(mesh);
		return null;
	}

	state.instanceMatrices = instanceMatrices;
	state.instanceLanesValid = faceCount;

	setThinInstancesRange(mesh, instanceMatrices, faceCount, 0, faceCount);

	addToScene(scene, mesh);
	meshState.set(mesh, state);

	ensureInstancedBuild(input.material, mesh);

	return mesh;
}

export function updatePackedChunkMesh(
	mesh: Mesh,
	input: PackedMeshInput,
	dirtyRanges?: readonly MergedFaceRange[] | null,
): Mesh {
	const state = meshState.get(mesh);

	if (!state) {
		return createPackedChunkMesh(input) ?? mesh;
	}

	const faceCount = input.faceDataA.length >>> 2;

	if (faceCount === state.faceCount) {
		applyMeshMeta(mesh, state, input);

		// Empty dirty range means no face data changed.
		if (dirtyRanges && dirtyRanges.length === 0) {
			return mesh;
		}

		if (dirtyRanges && dirtyRanges.length > 0) {
			packFaceRanges(state, input, dirtyRanges);
			uploadFaceRanges(state.faceArena, state.faceBase, faceCount, dirtyRanges);
		} else {
			packFaces(state, input);
			uploadFaceRange(state.faceArena, state.faceBase, faceCount);
		}

		return mesh;
	}

	// Slow path: face count changed.
	//
	// Fast sub-path: grow the existing arena block in place. Streaming
	// appends (the common case) extend a group mesh at the tail, so the
	// block's base and the instance-matrix constants (faceBase/arena/
	// offsetBase) are all unchanged — only the appended face range needs
	// packing/uploading and only the appended instances' matrix lanes need
	// writing.
	if (faceCount > state.faceCount) {
		const arena = faceArenas[state.faceArena];
		const oldValid = state.instanceLanesValid ?? 0;
		const prevMatrices = state.instanceMatrices;

		// Build the instance matrices BEFORE touching the arena: a corrupt
		// huge face count then bails here with the arena block intact.
		const instanceMatrices = buildInstanceMatrices(
			prevMatrices,
			state.faceArena,
			state.faceBase,
			state.offsetBase,
			faceCount,
			oldValid,
		);

		if (!instanceMatrices) {
			console.warn(
				`[PackedChunkMesh] skipping growth update for chunk mesh ` +
					`(${faceCount} faces) — instance-matrix limit hit.`,
			);
			return mesh;
		}

		if (
			arena &&
			tryExtendFaces(
				arena,
				state.faceArena,
				state.faceBase,
				state.faceCount,
				faceCount,
			)
		) {
			state.faceCount = faceCount;

			if (dirtyRanges && dirtyRanges.length > 0) {
				packFaceRanges(state, input, dirtyRanges);
				uploadFaceRanges(
					state.faceArena,
					state.faceBase,
					faceCount,
					dirtyRanges,
				);
			} else {
				// No ranges (boat-chunk path, or defensive fallback): the
				// block stayed put, so repack it fully in place — still
				// avoids the allocFaces/freeFaces shuffle and keeps the
				// instance-matrix constants intact.
				packFaces(state, input);
				uploadFaceRange(state.faceArena, state.faceBase, faceCount);
			}

			// buildInstanceMatrices only reallocates the retained buffer when the
			// new face count outgrows it (power-of-two growth). If it did, every
			// lane is freshly written, so the dirty range must be full; if not,
			// only the appended lanes [oldValid, faceCount) changed. (When it
			// reallocates, capacity grew, so setThinInstancesRange self-selects
			// the growth path and the `0` here is ignored anyway.)
			const reallocated = instanceMatrices !== prevMatrices;

			state.instanceMatrices = instanceMatrices;
			state.instanceLanesValid = faceCount;
			setThinInstancesRange(
				mesh,
				instanceMatrices,
				faceCount,
				reallocated ? 0 : oldValid,
				faceCount,
			);

			applyMeshMeta(mesh, state, input);
			return mesh;
		}
	}

	// Full realloc path: face count changed and the block could not grow in
	// place (shrinks, mid-arena blocks with no adjacent hole), so this mesh
	// needs a new arena interval.
	const alloc = allocFaces(faceCount);

	if (alloc.arena < 0) {
		console.warn(
			`[PackedChunkMesh] skipping update for chunk mesh: ` +
				`face arenas full (${totalFacesUsed()}/${totalFaceCapacity()}).`,
		);
		return mesh;
	}

	freeFaces(state.faceArena, state.faceBase, state.faceCount);

	state.faceArena = alloc.arena;
	state.faceBase = alloc.base;
	state.faceCount = faceCount;

	packFaces(state, input);
	packOffsets(state, input);

	uploadFaceRange(alloc.arena, alloc.base, faceCount);
	uploadOffsetRange(state.offsetBase);

	applyMeshMeta(mesh, state, input);

	const instanceMatrices = buildInstanceMatrices(
		state.instanceMatrices,
		alloc.arena,
		alloc.base,
		state.offsetBase,
		faceCount,
		0,
	);

	if (!instanceMatrices) {
		console.warn(
			`[PackedChunkMesh] skipping thin-instance update for chunk mesh ` +
				`(${faceCount} faces) — instance-matrix limit hit.`,
		);
		return mesh;
	}

	state.instanceMatrices = instanceMatrices;
	state.instanceLanesValid = faceCount;
	// Full realloc: arena/faceBase moved, so every lane's faceBase/arena/
	// offsetBase changed — keep the dirty range full.
	setThinInstancesRange(mesh, instanceMatrices, faceCount, 0, faceCount);

	return mesh;
}

// Refresh the per-mesh transform/bounds/visibility state from `input`
// without allocating (reuses the retained bound arrays).
function applyMeshMeta(
	mesh: Mesh,
	state: PackedMeshState,
	input: PackedMeshInput,
): void {
	const anyMesh = mesh as PackedMesh;

	const boundMin = reuseOrCloneVec3(state.boundMin, input.boundsMin);
	const boundMax = reuseOrCloneVec3(state.boundMax, input.boundsMax);

	state.boundMin = boundMin;
	state.boundMax = boundMax;

	anyMesh.boundMin = boundMin;
	anyMesh.boundMax = boundMax;

	if (!anyMesh.isVisible) {
		anyMesh.isVisible = true;
	}

	if (mesh.material !== input.material) {
		mesh.material = input.material;
	}

	const p = mesh.position;
	const x = input.position[0];
	const y = input.position[1];
	const z = input.position[2];

	if (p.x !== x || p.y !== y || p.z !== z) {
		p.set(x, y, z);
	}
}

export function disposePackedMesh(mesh: Mesh): void {
	const state = meshState.get(mesh);

	if (state) {
		meshState.delete(mesh);

		freeFaces(state.faceArena, state.faceBase, state.faceCount);
		freeOffsetBlock(state.offsetBase);
	}

	if (sceneRef && mesh) {
		removeFromScene(sceneRef, mesh);
	}

	scheduleDeferredDisposal(mesh);
}

export function destroyPackedArenas(): void {
	// Tear down every live packed mesh first so none lingers in the scene
	// referencing the arena buffers we are about to destroy.
	for (const mesh of meshState.keys()) {
		if (sceneRef && mesh) removeFromScene(sceneRef, mesh);
		scheduleDeferredDisposal(mesh);
	}
	meshState.clear();

	const engine = engineRef;
	const arenas = faceArenas;
	const o = offsetBuffer;
	if (engine) {
		const e = engine;
		void onGpuWorkDone(e).then(() => {
			for (const a of arenas) disposeStorageBuffer(a.buffer);
			if (o) disposeStorageBuffer(o);
		});
	} else {
		for (const a of arenas) disposeStorageBuffer(a.buffer);
		if (o) disposeStorageBuffer(o);
	}
	faceArenas = [];
	offsetBuffer = null;
	offsetCpu = new Float32Array(0);
	offsetUsedGroups = 0;
	offsetFree.length = 0;
	registeredMaterials.length = 0;
	boundMaterials.clear();
	engineRef = null;
	sceneRef = null;
}
