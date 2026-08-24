/**
 * GPU face-decoding mesh layer (thin-instance variant).
 *
 * Every chunk face is drawn as one instance of a single shared quad
 * (4 verts / 6 indices). Packed face data lives in a global storage buffer
 * (faceData) and per-group chunk origins in a second global buffer
 * (chunkOffsets). The vertex shader selects the face via
 * `@builtin(instance_index)` combined with a per-mesh `faceBase` offset that is
 * carried in the compact per-instance record (instData.x).
 *
 * Each face is 3 u32 words (12 bytes — see QuadBuffer.ts for the bit layout);
 * the per-face local chunk index (0..63) is OR'd into word2 byte 3 during
 * merged-group assembly, and the group's chunkOffsets base rides in the
 * instance record (instData.z), so no 4th word is needed.
 *
 * Babylon Lite 1.11 has no instanced-draw support in the plain ShaderMaterial
 * path (drawIndexed is called with no instance count), but it DOES support
 * thin instances: a mesh with `mesh.thinInstances` set is drawn `ti.count`
 * times, each with a `@builtin(instance_index)`, and the instance data is
 * supplied as a vertex buffer. We exploit that — and, via a patch-package
 * patch to lite ("compact instance mode", ti.compact), each instance carries
 * only ONE vec4<f32> instead of a full 4x4 matrix:
 *   instData.x = faceBase · instData.y = arena index · instData.z = offsetBase
 * Each mesh gets `ti.count = faceCount` and the shader reads
 * `faceData[faceBase + instanceIndex]`.
 *
 * Because `setShaderStorageBuffer` is material-wide, all meshes share ONE arena;
 * each mesh only carries its integer `faceBase` offset via the instance record.
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
import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
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
		/** Compact instance mode (patch-package patch to lite): each instance
		 *  is a single vec4<f32> (16 B) instead of a full mat4 (64 B). */
		compact?: boolean;
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

// Compact per-instance record layout: one vec4<f32> (4 floats) per face,
// written by buildInstanceData and read by the shader as `instData`:
//   x = faceBase · y = arena index · z = chunkOffsets base · w = unused
const INSTANCE_FLOATS = 4;
const FACE_BASE_INSTANCE_INDEX = 0;
const ARENA_INSTANCE_INDEX = 1;
const OFFSET_BASE_INSTANCE_INDEX = 2;

// Upper bound (elements) for a per-mesh compact instance buffer: 32 MiB at
// 4 B/element, i.e. up to 2,097,152 faces per mesh — ~8x headroom above any
// realistic merged group. A group above this is pathological or corrupt —
// refusing beats allocating gigabytes and hard-crashing the tab.
const MAX_INSTANCE_DATA_ELEMENTS = 1 << 23;

// Buffers at or below this size (16 KiB) are never shrunk — the churn isn't
// worth it. Shrink hysteresis only applies to buffers that actually cost
// memory (see buildInstanceData).
const MIN_MATRIX_SHRINK_ELEMENTS = 4096;

interface PackedMeshState {
	faceArena: number;
	faceBase: number;
	faceCount: number;
	offsetBase: number;
	/** Retained compact instance buffer (INSTANCE_FLOATS floats per face);
	 *  reused across updates. Grows monotonically (power-of-two capacity),
	 *  so repeated face-count growth never reallocates, but a larger need
	 *  still reallocates. */
	instanceMatrices?: Float32Array;
	/** Number of instances whose lanes are currently valid in
	 *  `instanceMatrices` (monotonic: lanes are only ever appended). */
	instanceLanesValid?: number;
	/** Retained mesh-visible bounds; reused across updates (no realloc). */
	boundMin?: [number, number, number];
	boundMax?: [number, number, number];
	/** Cached u32 view over the caller's input.faceData — rebuilt only when
	 *  the underlying buffer identity or range changes. */
	faceWords?: Uint32Array;
	/** Scratch flag used by compactArena to mark meshes whose faceBase moved
	 *  (their instance-record faceBase lanes need rewriting). */
	_compactMoved?: boolean;
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
	// PERF: running sum of free[].count. Lets allocFaces skip an arena whose
	// holes cannot possibly satisfy a request with one comparison instead of
	// linear-scanning every hole first-fit (O(total holes) after fragmentation).
	// Maintained at every mutation site; merges don't change the sum.
	freeCount: number;
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
// buffer) rides in the per-instance record (instData.z) instead of a
// 4th word — that cut the arena stride from 16 to 12 bytes per face.
const FACE_BYTES = 12;
const FACE_WORDS = 3;
const FACE_WORD_BYTES = 12;

const OFFSET_WORDS = 4;
const OFFSET_ENTRY_BYTES = 16;

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
		freeCount: 0,
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
	let newCapacity = Math.min(arena.capacity * 4, maxFaces);
	if (newCapacity <= arena.capacity) return;

	// Aggregate budget: refuse/shrink growth that would push the SUM of all
	// arena capacities past the cap. Other arenas' capacity is reserved —
	// only this arena's current capacity is replaceable within the budget.
	const othersCapacity = totalFaceCapacity() - arena.capacity;
	const budgetFaces = arenaBudgetFaces();
	if (othersCapacity + newCapacity > budgetFaces) {
		const fitCapacity = budgetFaces - othersCapacity;
		if (fitCapacity <= arena.capacity) {
			if (!_arenaBudgetWarned) {
				_arenaBudgetWarned = true;
				console.warn(
					`[PackedChunkMesh] arena growth budget reached ` +
						`(${SETTING_PARAMS.ARENA_BUDGET_MB} MiB across ` +
						`${faceArenas.length} arenas) — further growth refused. ` +
						`Far meshes will skip updates until geometry unloads.`,
				);
			}
			return;
		}
		newCapacity = fitCapacity;
	}

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

// Aggregate cap on face storage across ALL arenas (CPU copy AND GPU mirror).
// Individually each arena may grow to its 128 MiB binding cap; with the usual
// 6 arenas that permits ~0.8 GB of face data — and heap snapshots showed
// exactly that: several full-capacity 134 MB arena buffers for what is
// typically tens of MB of live geometry. The budget gates GROWTH only: the
// initial 6 × 262k-face (~3 MiB) arenas always fit, and when growth is
// refused allocFaces returns arena:-1, which every caller already handles
// by skipping the mesh update with a warning.
const _arenaBudgetBytes = SETTING_PARAMS.ARENA_BUDGET_MB * 1024 * 1024;
let _arenaBudgetWarned = false;

function arenaBudgetFaces(): number {
	return Math.floor(_arenaBudgetBytes / FACE_BYTES);
}

function allocFaces(count: number): FaceAlloc {
	if (count <= 0) {
		return { arena: 0, base: 0 };
	}

	const maxFaces = maxFacesPerArena();

	// Pass 0 may trigger defragmentation when free faces exist but no
	// contiguous hole fits; pass 1 rescans the normalized free lists.
	for (let pass = 0; pass < 2; pass++) {
		// 1) Reuse a freed hole in any existing arena.
		// Important: when splitting an existing free interval, mutate the existing
		// pooled node in place instead of replacing it with a new pooled object.
		// The old version leaked the old interval object from the pool path.
		for (let ai = 0; ai < faceArenas.length; ai++) {
			const arena = faceArenas[ai];

			// No hole in this arena can hold `count` faces — skip the scan.
			if (arena.freeCount < count) continue;

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

					arena.freeCount -= count;
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

		if (pass === 0 && !tryCompactFor(count)) break;
	}

	reportArenaExhaustion(count);
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
		arena.freeCount -= delta;
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
	// Merges inside freeFaceInterval only move counts between nodes — the
	// sum grows by exactly `count`.
	faceArenas[arena].freeCount += count;
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

// ── Arena defragmentation ───────────────────────────────────────────────────
// Streaming churn leaves scattered free holes; once the arenas sit near the
// aggregate budget, a large request can fail even though total free faces
// exceed it. compactArena slides every live block in one arena down to be
// contiguous from 0, turning ALL free faces into a single tail hole.

let _compacting = false;

function largestHoleFaces(a: FaceArena): number {
	let max = 0;
	for (let i = 0; i < a.free.length; i++) {
		if (a.free[i].count > max) max = a.free[i].count;
	}
	return max;
}

function compactArena(index: number): boolean {
	const arena = faceArenas[index];
	if (!arena || _compacting) return false;
	if (arena.freeCount <= 0 || arena.free.length === 0) return false;

	_compacting = true;
	try {
		const entries: Array<{ mesh: Mesh; s: PackedMeshState }> = [];
		for (const [mesh, s] of meshState) {
			if (s.faceArena === index && s.faceCount > 0) entries.push({ mesh, s });
		}
		if (entries.length === 0) return false;
		entries.sort((a, b) => a.s.faceBase - b.s.faceBase);

		const cpu = arena.cpu;
		let write = 0;
		let runDst = -1;
		let runSrc = -1;
		let runLen = 0;
		let moved = 0;

		const flushRun = (): void => {
			if (runLen > 0) {
				cpu.copyWithin(
					runDst * FACE_WORDS,
					runSrc * FACE_WORDS,
					(runSrc + runLen) * FACE_WORDS,
				);
				runDst = -1;
				runSrc = -1;
				runLen = 0;
			}
		};

		for (let i = 0; i < entries.length; i++) {
			const s = entries[i].s;
			const src = s.faceBase;
			if (src === write) {
				write += s.faceCount;
				continue;
			}
			if (
				runLen > 0 &&
				(runDst + runLen !== write || runSrc + runLen !== src)
			) {
				flushRun();
			}
			if (runLen === 0) {
				runDst = write;
				runSrc = src;
			}
			runLen += s.faceCount;
			s.faceBase = write;
			s._compactMoved = true;
			moved++;
			write += s.faceCount;
		}
		flushRun();

		if (moved === 0) return false;

		// One contiguous upload covers the compacted prefix; any untouched
		// blocks inside it re-upload identical bytes (CPU mirror is truth).
		uploadFaceRange(index, 0, write);

		arena.used = write;
		arena.free.length = 0;
		arena.freeCount = 0;
		const tail = arena.capacity - write;
		if (tail > 0) {
			arena.free.push(acquireInterval(write, tail));
			arena.freeCount = tail;
		}

		for (let i = 0; i < entries.length; i++) {
			const { mesh, s } = entries[i];
			if (!s._compactMoved) continue;
			s._compactMoved = false;
			const data = s.instanceMatrices;
			if (!data) continue;
			const lanes = Math.min(
				s.instanceLanesValid ?? s.faceCount,
				(data.length / INSTANCE_FLOATS) | 0,
			);
			let idx = FACE_BASE_INSTANCE_INDEX;
			for (let f = 0; f < lanes; f++) {
				data[idx] = s.faceBase;
				idx += INSTANCE_FLOATS;
			}
			setThinInstancesRange(mesh, data, s.faceCount, 0, s.faceCount);
		}

		console.warn(
			`[PackedChunkMesh] defragmented face arena #${index}: relocated ` +
				`${moved} mesh(es), recovered ${arena.freeCount}-face contiguous tail.`,
		);
		return true;
	} finally {
		_compacting = false;
	}
}

// Compaction candidate: an arena with enough total free faces for `count`
// whose free space is actually fragmented (largest hole much smaller than the
// total). Returns false when compaction cannot plausibly help.
function tryCompactFor(count: number): boolean {
	if (_compacting) return false;
	let totalFree = 0;
	for (let i = 0; i < faceArenas.length; i++)
		totalFree += faceArenas[i].freeCount;
	if (totalFree < count) return false;

	let best = -1;
	let bestFragmented = 0;
	for (let ai = 0; ai < faceArenas.length; ai++) {
		const a = faceArenas[ai];
		if (a.freeCount < count) continue;
		const fragmented = a.freeCount - largestHoleFaces(a);
		if (fragmented > bestFragmented) {
			bestFragmented = fragmented;
			best = ai;
		}
	}
	if (best < 0) return false;
	return compactArena(best);
}

// Detailed exhaustion report: distinguishes genuine capacity exhaustion
// ("live" dominates) from fragmentation ("free" dominates, small largest
// hole). `used` alone is a high-water mark and misleads — freed interior
// holes still count toward it.
function reportArenaExhaustion(count: number): void {
	let liveTotal = 0;
	let freeTotal = 0;
	const parts: string[] = [];
	for (let ai = 0; ai < faceArenas.length; ai++) {
		const a = faceArenas[ai];
		const live = a.capacity - a.used - a.freeCount;
		liveTotal += live;
		freeTotal += a.freeCount;
		parts.push(
			`  #${ai}: cap ${a.capacity}, live ${live}, highWater ${a.used}, ` +
				`free ${a.freeCount} (largest hole ${largestHoleFaces(a)})`,
		);
	}
	console.error(
		`[PackedChunkMesh] face arenas exhausted (request ${count} faces): ` +
			`live ${liveTotal} + free ${freeTotal} of ${totalFaceCapacity()} ` +
			`capacity (${faceArenas.length} arenas, maxFaceArenas=` +
			`${maxFaceArenas}, budget ${SETTING_PARAMS.ARENA_BUDGET_MB} MiB).\n` +
			parts.join("\n") +
			`\nIf "live" dominates, loaded geometry exceeds the arena budget; ` +
			`if "free" dominates with small holes, churn fragmented the arenas.`,
	);
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
	// 	shader mesh added later — including our thin-instance packed chunks — is
	// 	then rebuilt through that plain path, which omits the `instData` vertex
	// 	attribute our shader reads, producing a "struct member instData not found"
	// 	WGSL error.
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
	/** Interleaved face records (12 bytes = 3 u32 words per face), already in
	 *  the arena's native layout — packing is a plain contiguous copy. */
	faceData: Uint8Array;
	chunkOffsets: Float32Array; // length 192, stride 3
	position: [number, number, number];
	boundsMin: [number, number, number];
	boundsMax: [number, number, number];
}

// `input` is the caller's (reused, module-level scratch) `PackedMeshInput`,
// so its typed array is only ever replaced when the merged-group buffers
// grow — the view below stays valid across calls and is rebuilt only when
// the buffer identity or range changes.
// Reinterpreting faceData (a byte array with a 12-multiple length and
// offset) as a Uint32Array over the SAME buffer is safe: WebGPU browsers
// are all little-endian, so each 4-byte lane reads back exactly the u32 the
// worker packed.
// Rebuild the cached u32 view over `input`'s face data.
function ensureFaceWordViews(
	state: PackedMeshState,
	input: PackedMeshInput,
): void {
	const words = input.faceData.length >>> 2;

	let faceWords = state.faceWords;
	if (
		!faceWords ||
		faceWords.buffer !== input.faceData.buffer ||
		faceWords.byteOffset !== input.faceData.byteOffset ||
		faceWords.length !== words
	) {
		faceWords = new Uint32Array(
			input.faceData.buffer,
			input.faceData.byteOffset,
			words,
		);
		state.faceWords = faceWords;
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
// PERF: the worker now emits faces already interleaved (3 consecutive words
// per record), so source and destination share one contiguous layout and
// each range packs as a single memcpy (TypedArray.set) instead of the old
// 4-way-unrolled three-stream gather.
function packFaceRanges(
	state: PackedMeshState,
	input: PackedMeshInput,
	ranges: readonly MergedFaceRange[],
): void {
	if (ranges.length === 0) return;

	ensureFaceWordViews(state, input);

	const faceCount = input.faceData.length / 12;

	if (faceCount <= 0) return;

	const arena = faceArenas[state.faceArena];
	if (!arena) return;

	const faceCpu = arena.cpu;
	const words = state.faceWords!;
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

		faceCpu.set(
			words.subarray(start * FACE_WORDS, (start + count) * FACE_WORDS),
			baseWord + start * FACE_WORDS,
		);
	}
}

// Full-mesh pack path (initial build / full realloc): one contiguous memcpy.
function packFaces(state: PackedMeshState, input: PackedMeshInput): void {
	ensureFaceWordViews(state, input);

	const arena = faceArenas[state.faceArena];
	if (!arena) return;

	const faceCount = input.faceData.length / 12;

	if (faceCount <= 0) return;

	faceArenas[state.faceArena]!.cpu.set(
		state.faceWords!.subarray(0, faceCount * FACE_WORDS),
		state.faceBase * FACE_WORDS,
	);
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

// Build / reuse the compact thin-instance buffer for a mesh: `count` records
// of 4 floats each (INSTANCE_FLOATS), where record i carries
//   [i*4 + FACE_BASE_INSTANCE_INDEX]    = faceBase
//   [i*4 + ARENA_INSTANCE_INDEX]        = arena
//   [i*4 + OFFSET_BASE_INSTANCE_INDEX]  = the group's chunkOffsets base
// and w stays zero. The shader reads them as `instData` (a patch-package
// patch to lite gives these meshes a stride-16 vec4 vertex attribute instead
// of a full 64-byte mat4).
//
// PERF: the buffer is RETAINED per-mesh on PackedMeshState and reused across
// updates — only the faceBase/arena/offsetBase lanes per instance are
// rewritten, and only when the instance count changes do we reallocate. This
// removes the previous per-remesh Float32Array allocation (a major GC source
// in the updatePackedChunkMesh hot path).
//
// Capacity GROWS monotonically, so a mesh whose face count fluctuates around
// a level reuses its buffer instead of zero-filling a fresh array on every
// rebuild; a hysteresis shrink releases memory after spikes. `start` is the
// first instance index whose lanes need (re)writing — callers pass
// `state.faceCount` (the old count) when only the appended instances are new,
// and 0 when the faceBase/arena/offsetBase lanes themselves changed.
//
// Returns null (and logs) when `count` is not a sane non-negative number,
// would need more than MAX_INSTANCE_DATA_ELEMENTS, or the allocation itself
// fails (OOM under the cap) — the caller then skips the mesh update instead
// of attempting a multi-gigabyte allocation (which hard-crashes the tab with
// "Array buffer allocation failed").
function buildInstanceData(
	prev: Float32Array | undefined,
	arena: number,
	faceBase: number,
	offsetBase: number,
	count: number,
	start: number,
): Float32Array | null {
	if (!Number.isFinite(count) || count < 0) {
		console.warn(
			`[PackedChunkMesh] refusing instance buffer: ` +
				`invalid face count ${count}.`,
		);
		return null;
	}

	const needLen = count * INSTANCE_FLOATS;

	if (needLen > MAX_INSTANCE_DATA_ELEMENTS) {
		console.warn(
			`[PackedChunkMesh] refusing instance buffer: ` +
				`${count} faces (${needLen} elements) exceeds the safe ` +
				`limit of ${MAX_INSTANCE_DATA_ELEMENTS / INSTANCE_FLOATS} faces ` +
				`per mesh. Mesh update skipped.`,
		);
		return null;
	}

	let data = prev;
	if (!data || data.length < needLen) {
		// Grow to a power of two above the need so repeated face-count
		// growth (the streaming-append case) doesn't reallocate each time.
		// Plain multiplication, NOT `<<=`: a left shift is 32-bit and wraps
		// negative above 2^30, which turns this loop into an infinite loop
		// and the allocation into an OOM crash.
		let capacity = 1024;
		while (capacity < needLen) capacity *= 2;
		try {
			data = new Float32Array(capacity);
		} catch {
			// Under the size cap but the renderer heap still refused (real
			// memory pressure). Returning null skips this mesh update —
			// callers warn + keep the previous mesh — instead of letting a
			// RangeError escape through flushDirtyMergedGroups and kill the
			// whole mesh-drain tick.
			console.warn(
				`[PackedChunkMesh] instance allocation failed ` +
					`(${capacity} elements, ${(capacity * 4) >> 20} MiB) — ` +
					`out of memory. Mesh update skipped.`,
			);
			return null;
		}
		start = 0;
	} else if (
		data.length >= MIN_MATRIX_SHRINK_ELEMENTS &&
		needLen * 4 <= data.length
	) {
		// Hysteresis shrink: retained buffers grow monotonically, so after a
		// spike (streaming burst, LOD swap) every mesh used to hold its peak
		// buffer forever. Release memory when the need falls to a quarter of
		// capacity. Identity changes → callers treat it as a realloc and
		// rewrite every lane, so reset `start` to cover [0, count).
		try {
			data = new Float32Array(Math.max(1024, needLen));
			start = 0;
		} catch {
			// Keep the oversized buffer rather than dropping the update.
		}
	}

	// Only faceBase/arena/offsetBase are ever written; lane w stays zero from
	// the initial fill. f32 holds integers up to 2^24 exactly — faceBase and
	// offsetBase stay far below that (see arena capacity / offsetUsedGroups).
	let idx = start * INSTANCE_FLOATS;
	for (let i = start; i < count; i++) {
		data[idx + FACE_BASE_INSTANCE_INDEX] = faceBase;
		data[idx + ARENA_INSTANCE_INDEX] = arena;
		data[idx + OFFSET_BASE_INSTANCE_INDEX] = offsetBase;
		idx += INSTANCE_FLOATS;
	}

	return data;
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
	const capacity = matrices.length / INSTANCE_FLOATS;

	if (count > capacity) {
		console.error(
			`[PackedChunkMesh] thin-instance count (${count}) exceeds ` +
				`instance buffer capacity (${capacity}) — caller bug.`,
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
			ti.compact = true; // stride-16 vec4 records, NOT mat4s
			ti._capacity = capacity;
			ti.count = count; // fix the draw count back down; buffer stays capacity-sized
			// setThinInstances() reset the dirty range to [0, capacity);
			// clamp it to what's actually valid so sync uploads only real data.
			ti._dirtyMin = 0;
			ti._dirtyMax = count;
		}
		return;
	} else if (ti && !ti.compact) {
		// Buffer created before compact mode (or by another path): mark and
		// force a full re-upload + pipeline rebuild via a fresh version.
		ti.compact = true;
		ti._gpuVersion = -1;
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

	const faceCount = input.faceData.length / 12;

	// Refuse before doing any work (arena/offset allocation, mesh creation):
	// a corrupt face count would otherwise reach buildInstanceMatrices and
	// attempt a multi-gigabyte allocation.
	if (faceCount * INSTANCE_FLOATS > MAX_INSTANCE_DATA_ELEMENTS) {
		console.warn(
			`[PackedChunkMesh] skipping mesh for "${input.name}": ` +
				`${faceCount} faces exceeds the safe per-mesh limit of ` +
				`${MAX_INSTANCE_DATA_ELEMENTS / INSTANCE_FLOATS}.`,
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

	const instanceMatrices = buildInstanceData(
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

	const faceCount = input.faceData.length / 12;

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
	// Refuse oversized counts up front, before either sub-path mutates
	// anything: the full-realloc path below re-allocs/packs faces BEFORE
	// building matrices, and a refusal there would leave thin-instance
	// lanes pointing at the old arena block (corrupted rendering).
	if (faceCount * INSTANCE_FLOATS > MAX_INSTANCE_DATA_ELEMENTS) {
		console.warn(
			`[PackedChunkMesh] skipping mesh update: ${faceCount} faces ` +
				`exceeds the safe per-mesh limit of ` +
				`${MAX_INSTANCE_DATA_ELEMENTS / INSTANCE_FLOATS}.`,
		);
		return mesh;
	}
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
		const instanceMatrices = buildInstanceData(
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
	const oldArenaIdx = state.faceArena;
	const oldBase = state.faceBase;
	const oldCount = state.faceCount;

	let alloc = allocFaces(faceCount);
	let oldFreed = false;

	if (alloc.arena < 0 && oldCount > 0) {
		// Near-full allocator wedge: requiring the NEW block to fit BEFORE
		// releasing the old one means every resize needs old+new headroom at
		// once — once the arenas reach the aggregate budget, resizes fail
		// forever and keep the arenas pinned at their high-water mark. Free
		// this mesh's block first and retry.
		//
		// The retry cannot strand the mesh: freeing produced a contiguous run
		// of >= oldCount faces (freeFaceInterval merges with neighbors), and
		// nothing else runs between the failed retry and the restore below,
		// so allocFaces(oldCount) always succeeds and the snapshot restores
		// the previous geometry verbatim wherever it lands.
		const oldCpu = faceArenas[oldArenaIdx]?.cpu;
		const snapshot = oldCpu
			? oldCpu.slice(oldBase * FACE_WORDS, (oldBase + oldCount) * FACE_WORDS)
			: null;
		freeFaces(oldArenaIdx, oldBase, oldCount);
		oldFreed = true;

		alloc = allocFaces(faceCount);

		if (alloc.arena < 0) {
			const restore =
				snapshot !== null ? allocFaces(oldCount) : { arena: -1, base: -1 };
			if (restore.arena >= 0 && snapshot) {
				faceArenas[restore.arena]!.cpu.set(snapshot, restore.base * FACE_WORDS);
				state.faceArena = restore.arena;
				state.faceBase = restore.base;
				uploadFaceRange(restore.arena, restore.base, oldCount);
				if (restore.arena !== oldArenaIdx || restore.base !== oldBase) {
					const data = buildInstanceData(
						state.instanceMatrices,
						restore.arena,
						restore.base,
						state.offsetBase,
						oldCount,
						0,
					);
					if (data) {
						state.instanceMatrices = data;
						state.instanceLanesValid = oldCount;
						setThinInstancesRange(mesh, data, oldCount, 0, oldCount);
					} else {
						(mesh as PackedMesh).isVisible = false;
					}
				}
				console.warn(
					`[PackedChunkMesh] arenas exhausted for remesh ` +
						`(${oldCount} -> ${faceCount} faces); kept previous geometry.`,
				);
				return mesh;
			}
			// Unreachable per the invariant above; fail safe anyway — stop
			// drawing rather than risk stale lanes rendering another mesh's
			// faces. applyMeshMeta revives visibility on a later success.
			(mesh as PackedMesh).isVisible = false;
			console.error(
				`[PackedChunkMesh] arena restore failed for ${faceCount}-face ` +
					`remesh — mesh hidden until its next successful update.`,
			);
			return mesh;
		}
	}

	if (alloc.arena < 0) {
		console.warn(
			`[PackedChunkMesh] skipping update for chunk mesh: ` +
				`face arenas full (${totalFacesUsed()}/${totalFaceCapacity()}).`,
		);
		return mesh;
	}

	if (!oldFreed) freeFaces(oldArenaIdx, oldBase, oldCount);

	state.faceArena = alloc.arena;
	state.faceBase = alloc.base;
	state.faceCount = faceCount;

	packFaces(state, input);
	packOffsets(state, input);

	uploadFaceRange(alloc.arena, alloc.base, faceCount);
	uploadOffsetRange(state.offsetBase);

	applyMeshMeta(mesh, state, input);

	const instanceMatrices = buildInstanceData(
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

// Diagnostics: packed-mesh memory footprint (bytes). Instance buffers count
// the COMPACT stride (16 B/face); arenas count CPU copy + GPU mirror.
export function getPackedMeshMemoryStats(): {
	meshes: number;
	instanceBytes: number;
	arenaCapacityFaces: number;
	arenaUsedFaces: number;
	arenaBytes: number;
	offsetBytes: number;
} {
	let meshes = 0;
	let instanceBytes = 0;
	for (const state of meshState.values()) {
		meshes++;
		const ti = (state as { instanceMatrices?: Float32Array }).instanceMatrices;
		if (ti) instanceBytes += ti.length * 4;
	}
	let arenaCapacityFaces = 0;
	let arenaUsedFaces = 0;
	for (const a of faceArenas) {
		arenaCapacityFaces += a.capacity;
		arenaUsedFaces += a.used;
	}
	return {
		meshes,
		instanceBytes,
		arenaCapacityFaces,
		arenaUsedFaces,
		arenaBytes: arenaCapacityFaces * FACE_BYTES,
		offsetBytes: offsetCpu.length * 4,
	};
}
