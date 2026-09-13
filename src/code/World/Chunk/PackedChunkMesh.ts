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

const MIN_INSTANCE_DATA_ELEMENTS = INSTANCE_FLOATS;

// Retain the existing safety limit.
const MAX_INSTANCE_DATA_ELEMENTS = 1 << 23;

const MAX_FREE_INTERVAL_POOL_SIZE = 4096;
const INSTANCE_SHRINK_RATIO = 4;

interface FreeInterval {
	base: number;
	count: number;
}

interface PackedMeshState {
	faceArena: number;
	faceBase: number;
	faceCount: number;
	offsetBase: number;

	instanceMatrices?: Float32Array;
	instanceLanesValid?: number;

	boundMin?: [number, number, number];
	boundMax?: [number, number, number];

	faceWords?: Uint32Array;
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

function instanceCapacityFor(needLen: number): number {
	if (needLen <= MIN_INSTANCE_DATA_ELEMENTS) {
		return MIN_INSTANCE_DATA_ELEMENTS;
	}

	/*
	 * Computing the exponent avoids repeatedly multiplying in a loop.
	 * MAX_INSTANCE_DATA_ELEMENTS is below the range where Math.log2 loses
	 * integer precision.
	 */
	return 2 ** Math.ceil(Math.log2(needLen));
}

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
const _freeIntervalPool: FreeInterval[] = [];

function acquireInterval(base: number, count: number): FreeInterval {
	const last = _freeIntervalPool.length - 1;

	if (last >= 0) {
		const node = _freeIntervalPool[last];
		_freeIntervalPool.length = last;
		node.base = base;
		node.count = count;
		return node;
	}

	return { base, count };
}

function releaseInterval(node: FreeInterval): void {
	if (_freeIntervalPool.length < MAX_FREE_INTERVAL_POOL_SIZE) {
		_freeIntervalPool.push(node);
	}
}
function removeIntervalAt(free: FreeInterval[], index: number): FreeInterval {
	const node = free[index];
	const newLength = free.length - 1;

	for (let i = index; i < newLength; i++) {
		free[i] = free[i + 1];
	}

	free.length = newLength;
	return node;
}
function insertIntervalAt(
	free: FreeInterval[],
	index: number,
	node: FreeInterval,
): void {
	const oldLength = free.length;
	free.length = oldLength + 1;

	for (let i = oldLength; i > index; i--) {
		free[i] = free[i - 1];
	}

	free[index] = node;
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
		offsetCpu = new Float32Array(
			offsetCapacityGroups * OFFSETS_PER_GROUP * OFFSET_WORDS,
		);
		offsetBuffer = createStorageBuffer(engineRef!, offsetCpu, "offset-set");

		for (let i = 0; i < registeredMaterials.length; i++) {
			const material = registeredMaterials[i];
			setShaderStorageBuffer(material, "chunkOffsets", offsetBuffer);
			boundMaterials.add(material);
		}
	}

	const maxFaces = maxFacesPerArena();
	const primaryCapacity = Math.max(1, Math.min(262_144, maxFaces));

	if (faceArenas.length === 0) {
		createFaceArena(primaryCapacity);
	}

	// Every faceDataN binding must exist, but unused arenas do not need a
	// multi-megabyte initial CPU array and GPU buffer.
	while (faceArenas.length < maxFaceArenas) {
		createFaceArena(1);
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
	free: FreeInterval[],
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

	/*
	 * Merge directly with existing nodes where possible. The original
	 * implementation always acquired and inserted a node first, even when
	 * the interval was immediately merged away.
	 */
	const left = lo > 0 ? free[lo - 1] : undefined;
	const right = lo < free.length ? free[lo] : undefined;
	const joinsLeft = left !== undefined && left.base + left.count === base;
	const joinsRight = right !== undefined && base + count === right.base;

	if (joinsLeft) {
		left.count += count;

		if (joinsRight) {
			left.count += right.count;
			releaseInterval(removeIntervalAt(free, lo));
		}

		return;
	}

	if (joinsRight) {
		/*
		 * Reuse the right node rather than allocating a new interval.
		 */
		right.base = base;
		right.count += count;
		return;
	}

	insertIntervalAt(free, lo, acquireInterval(base, count));
}

function freeFaces(arenaIndex: number, base: number, count: number): void {
	if (count <= 0 || arenaIndex < 0 || arenaIndex >= faceArenas.length) {
		return;
	}

	const arena = faceArenas[arenaIndex];
	freeFaceInterval(arena.free, base, count);
	arena.freeCount += count;
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
interface CompactEntry {
	mesh: Mesh;
	state: PackedMeshState;
}

const _compactEntries: CompactEntry[] = [];
function compactEntryCompare(a: CompactEntry, b: CompactEntry): number {
	return a.state.faceBase - b.state.faceBase;
}
function compactArena(index: number): boolean {
	const arena = faceArenas[index];

	if (
		!arena ||
		_compacting ||
		arena.freeCount <= 0 ||
		arena.free.length === 0
	) {
		return false;
	}

	_compacting = true;

	try {
		const entries = _compactEntries;
		let entryCount = 0;

		for (const [mesh, state] of meshState) {
			if (state.faceArena !== index || state.faceCount <= 0) {
				continue;
			}

			let entry = entries[entryCount];

			if (entry) {
				entry.mesh = mesh;
				entry.state = state;
			} else {
				entry = { mesh, state };
				entries[entryCount] = entry;
			}

			entryCount++;
		}

		if (entryCount === 0) {
			entries.length = 0;
			return false;
		}

		entries.length = entryCount;
		entries.sort(compactEntryCompare);

		const cpu = arena.cpu;
		let writeFace = 0;
		let runDestination = 0;
		let runSource = 0;
		let runLength = 0;
		let movedCount = 0;

		for (let i = 0; i < entryCount; i++) {
			const state = entries[i].state;
			const sourceFace = state.faceBase;

			if (sourceFace === writeFace) {
				writeFace += state.faceCount;
				continue;
			}

			if (
				runLength > 0 &&
				(runDestination + runLength !== writeFace ||
					runSource + runLength !== sourceFace)
			) {
				cpu.copyWithin(
					runDestination * FACE_WORDS,
					runSource * FACE_WORDS,
					(runSource + runLength) * FACE_WORDS,
				);
				runLength = 0;
			}

			if (runLength === 0) {
				runDestination = writeFace;
				runSource = sourceFace;
			}

			runLength += state.faceCount;
			state.faceBase = writeFace;
			state._compactMoved = true;
			movedCount++;
			writeFace += state.faceCount;
		}

		if (runLength > 0) {
			cpu.copyWithin(
				runDestination * FACE_WORDS,
				runSource * FACE_WORDS,
				(runSource + runLength) * FACE_WORDS,
			);
		}

		if (movedCount === 0) {
			return false;
		}

		uploadFaceRange(index, 0, writeFace);

		arena.used = writeFace;

		for (let i = 0; i < arena.free.length; i++) {
			releaseInterval(arena.free[i]);
		}

		arena.free.length = 0;
		arena.freeCount = 0;

		const recoveredTail = arena.capacity - writeFace;

		for (let i = 0; i < entryCount; i++) {
			const entry = entries[i];
			const state = entry.state;

			if (!state._compactMoved) {
				continue;
			}

			state._compactMoved = false;

			const data = state.instanceMatrices;
			if (!data) continue;

			const capacity = Math.floor(data.length / INSTANCE_FLOATS);
			const lanes = Math.min(
				state.instanceLanesValid ?? state.faceCount,
				capacity,
			);

			for (
				let face = 0, lane = FACE_BASE_INSTANCE_INDEX;
				face < lanes;
				face++, lane += INSTANCE_FLOATS
			) {
				data[lane] = state.faceBase;
			}

			setThinInstancesRange(
				entry.mesh,
				data,
				state.faceCount,
				0,
				state.faceCount,
			);
		}

		console.warn(
			`[PackedChunkMesh] defragmented face arena #${index}: relocated ` +
				`${movedCount} mesh(es), recovered ${recoveredTail}-face ` +
				`contiguous tail.`,
		);

		return true;
	} finally {
		/*
		 * Retain entry objects for reuse, but clear mesh and state references
		 * so disposed meshes are not accidentally kept alive by scratch data.
		 */
		for (let i = 0; i < _compactEntries.length; i++) {
			const entry = _compactEntries[i];
			entry.mesh = null as unknown as Mesh;
			entry.state = null as unknown as PackedMeshState;
		}

		_compacting = false;
	}
}

// Compaction candidate: an arena with enough total free faces for `count`
// whose free space is actually fragmented (largest hole much smaller than the
// total). Returns false when compaction cannot plausibly help.
function tryCompactFor(count: number): boolean {
	if (_compacting) return false;
	let totalFree = 0;
	for (let i = 0; i < faceArenas.length; i++) {
		const a = faceArenas[i];
		totalFree += a.freeCount + (a.capacity - a.used);
	}
	if (totalFree < count) return false;

	let best = -1;
	let bestFragmented = 0;
	for (let ai = 0; ai < faceArenas.length; ai++) {
		const a = faceArenas[ai];
		const tail = a.capacity - a.used;
		const total = a.freeCount + tail;
		if (total < count) continue;
		const largest = Math.max(largestHoleFaces(a), tail);
		const fragmented = total - largest;
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
		const live = a.used - a.freeCount;
		const tail = a.capacity - a.used;
		liveTotal += live;
		freeTotal += a.freeCount + tail;
		const largest = Math.max(largestHoleFaces(a), tail);
		parts.push(
			`  #${ai}: cap ${a.capacity}, live ${live}, highWater ${a.used}, ` +
				`free ${a.freeCount} + tail ${tail} (largest hole ${largest})`,
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

function ensureFaceWordViews(
	state: PackedMeshState,
	input: PackedMeshInput,
): Uint32Array {
	const bytes = input.faceData;
	const wordLength = bytes.byteLength >>> 2;
	const cached = state.faceWords;

	if (
		cached &&
		cached.buffer === bytes.buffer &&
		cached.byteOffset === bytes.byteOffset &&
		cached.length === wordLength
	) {
		return cached;
	}

	const words = new Uint32Array(bytes.buffer, bytes.byteOffset, wordLength);

	state.faceWords = words;
	return words;
}

function packFaceRanges(
	state: PackedMeshState,
	input: PackedMeshInput,
	ranges: readonly MergedFaceRange[],
): void {
	if (ranges.length === 0) return;

	const arena = faceArenas[state.faceArena];
	if (!arena) return;

	const faceCount = input.faceData.byteLength / FACE_BYTES;
	if (faceCount <= 0) return;

	const words = ensureFaceWordViews(state, input);
	const destination = arena.cpu;
	const destinationBase = state.faceBase * FACE_WORDS;

	for (let i = 0; i < ranges.length; i++) {
		const range = ranges[i];
		let start = range.start;
		let count = range.count;

		if (start < 0) {
			count += start;
			start = 0;
		}

		if (count <= 0 || start >= faceCount) {
			continue;
		}

		const end = start + count > faceCount ? faceCount : start + count;

		const sourceWordStart = start * FACE_WORDS;
		const sourceWordEnd = end * FACE_WORDS;

		/*
		 * TypedArray.set requires an array-like source. This subarray view is
		 * a small JavaScript object, not a copy of the underlying face bytes.
		 * No large temporary face buffer is created.
		 */
		destination.set(
			words.subarray(sourceWordStart, sourceWordEnd),
			destinationBase + sourceWordStart,
		);
	}
}

function packFaces(state: PackedMeshState, input: PackedMeshInput): void {
	const arena = faceArenas[state.faceArena];
	if (!arena) return;

	const faceCount = input.faceData.byteLength / FACE_BYTES;
	if (faceCount <= 0) return;

	const words = ensureFaceWordViews(state, input);
	const requiredWords = faceCount * FACE_WORDS;

	if (words.length < requiredWords) {
		console.warn(
			`[PackedChunkMesh] face-data view is shorter than expected: ` +
				`${words.length} words for ${faceCount} faces.`,
		);
		return;
	}

	arena.cpu.set(words, state.faceBase * FACE_WORDS);
}

/**
 * Offset packing with fixed source and destination indexing.
 *
 * This avoids maintaining two incrementing cursors and lets JavaScript
 * engines optimize the fixed-stride loop more consistently.
 */
function packOffsets(state: PackedMeshState, input: PackedMeshInput): void {
	const source = input.chunkOffsets;
	const destinationBase = state.offsetBase * OFFSET_WORDS;

	for (let local = 0; local < MAX_LOCAL; local++) {
		const src = local * 3;
		const dst = destinationBase + local * OFFSET_WORDS;

		offsetCpu[dst] = source[src];
		offsetCpu[dst + 1] = source[src + 1];
		offsetCpu[dst + 2] = source[src + 2];
		offsetCpu[dst + 3] = 0;
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
	previous: Float32Array | undefined,
	arena: number,
	faceBase: number,
	offsetBase: number,
	count: number,
	start: number,
): Float32Array | null {
	if (!Number.isInteger(count) || count < 0) {
		console.warn(
			`[PackedChunkMesh] refusing instance buffer: invalid face count ` +
				`${count}.`,
		);
		return null;
	}

	const requiredLength = count * INSTANCE_FLOATS;

	if (requiredLength > MAX_INSTANCE_DATA_ELEMENTS) {
		console.warn(
			`[PackedChunkMesh] refusing instance buffer: ${count} faces ` +
				`(${requiredLength} elements) exceeds the safe limit of ` +
				`${MAX_INSTANCE_DATA_ELEMENTS / INSTANCE_FLOATS} faces per mesh. ` +
				`Mesh update skipped.`,
		);
		return null;
	}

	let data = previous;
	let mustInitializeAll = false;

	const needsGrowth = !data || data.length < requiredLength;
	const shouldShrink =
		data !== undefined &&
		data.length > MIN_INSTANCE_DATA_ELEMENTS &&
		requiredLength * INSTANCE_SHRINK_RATIO <= data.length;

	if (needsGrowth || shouldShrink) {
		const capacity = instanceCapacityFor(requiredLength);

		try {
			data = new Float32Array(capacity);
		} catch {
			console.warn(
				`[PackedChunkMesh] instance allocation failed ` +
					`(${capacity} elements, ${Math.ceil(capacity / 262144)} MiB). ` +
					`Mesh update skipped.`,
			);
			return null;
		}

		mustInitializeAll = true;
	}

	if (!data) {
		return null;
	}

	if (mustInitializeAll) {
		start = 0;
	} else if (start < 0) {
		start = 0;
	} else if (start > count) {
		start = count;
	}

	/*
	 * All three values are constant across the instances belonging to this
	 * mesh. The fourth lane remains zero.
	 */
	for (
		let instance = start, index = start * INSTANCE_FLOATS;
		instance < count;
		instance++, index += INSTANCE_FLOATS
	) {
		data[index + FACE_BASE_INSTANCE_INDEX] = faceBase;
		data[index + ARENA_INSTANCE_INDEX] = arena;
		data[index + OFFSET_BASE_INSTANCE_INDEX] = offsetBase;
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

export function createPackedChunkMesh(input: PackedMeshInput): Mesh | null {
	const engine = engineRef;
	const scene = sceneRef;

	if (!engine || !scene) {
		console.warn(
			"[PackedChunkMesh] cannot create mesh before arena initialization.",
		);
		return null;
	}

	const faceCount = input.faceData.byteLength / FACE_BYTES;

	if (
		!Number.isInteger(faceCount) ||
		faceCount * INSTANCE_FLOATS > MAX_INSTANCE_DATA_ELEMENTS
	) {
		console.warn(
			`[PackedChunkMesh] skipping mesh for "${input.name}": ` +
				`invalid or oversized face count ${faceCount}.`,
		);
		return null;
	}

	/*
	 * Allocate instance memory before consuming arena space. This matters
	 * under memory pressure because a failed instance allocation otherwise
	 * briefly reserves face and offset blocks that must be rolled back.
	 */
	const instanceMatrices = buildInstanceData(undefined, 0, 0, 0, faceCount, 0);

	if (!instanceMatrices) {
		return null;
	}

	const allocation = allocFaces(faceCount);

	if (allocation.arena < 0) {
		console.warn(
			`[PackedChunkMesh] skipping mesh for "${input.name}": face arenas ` +
				`full (${totalFacesUsed()}/${totalFaceCapacity()}).`,
		);
		return null;
	}

	const offsetBase = allocOffsetBlock();

	/*
	 * The provisional instance data used zeros because arena allocation had
	 * not happened yet. Rewrite its active records with the actual constants.
	 * No second typed array is allocated.
	 */
	for (
		let face = 0, index = 0;
		face < faceCount;
		face++, index += INSTANCE_FLOATS
	) {
		instanceMatrices[index + FACE_BASE_INSTANCE_INDEX] = allocation.base;
		instanceMatrices[index + ARENA_INSTANCE_INDEX] = allocation.arena;
		instanceMatrices[index + OFFSET_BASE_INSTANCE_INDEX] = offsetBase;
	}

	const state: PackedMeshState = {
		faceArena: allocation.arena,
		faceBase: allocation.base,
		faceCount,
		offsetBase,
		instanceMatrices,
		instanceLanesValid: faceCount,
	};

	packFaces(state, input);
	packOffsets(state, input);

	uploadFaceRange(allocation.arena, allocation.base, faceCount);
	uploadOffsetRange(offsetBase);

	let mesh: Mesh;

	try {
		mesh = createMeshFromData(
			engine,
			input.name,
			SHARED_QUAD_POSITIONS,
			SHARED_QUAD_NORMALS,
			SHARED_QUAD_INDICES,
		);
	} catch (error) {
		freeFaces(allocation.arena, allocation.base, faceCount);
		freeOffsetBlock(offsetBase);
		throw error;
	}

	mesh.material = input.material;
	mesh.pickable = false;

	applyMeshMeta(mesh, state, input);
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

	const faceCount = input.faceData.byteLength / FACE_BYTES;

	if (!Number.isInteger(faceCount)) {
		console.warn(
			`[PackedChunkMesh] skipping update: face data length ` +
				`${input.faceData.byteLength} is not divisible by ${FACE_BYTES}.`,
		);
		return mesh;
	}

	if (faceCount === state.faceCount) {
		applyMeshMeta(mesh, state, input);

		if (dirtyRanges?.length === 0) {
			return mesh;
		}

		if (dirtyRanges && dirtyRanges.length > 0) {
			packFaceRanges(state, input, dirtyRanges);
			uploadFaceRanges(state.faceArena, state.faceBase, faceCount, dirtyRanges);
		} else {
			packFaces(state, input);
			uploadFaceRange(state.faceArena, state.faceBase, faceCount);
		}

		/*
		 * Offsets are intentionally not uploaded here. This preserves the
		 * original behavior, which treats same-count updates as face-only
		 * changes plus metadata changes.
		 */
		return mesh;
	}

	if (faceCount * INSTANCE_FLOATS > MAX_INSTANCE_DATA_ELEMENTS) {
		console.warn(
			`[PackedChunkMesh] skipping mesh update: ${faceCount} faces ` +
				`exceeds the safe per-mesh limit of ` +
				`${MAX_INSTANCE_DATA_ELEMENTS / INSTANCE_FLOATS}.`,
		);
		return mesh;
	}

	const oldArenaIndex = state.faceArena;
	const oldBase = state.faceBase;
	const oldCount = state.faceCount;
	const oldMatrices = state.instanceMatrices;
	const oldValid = state.instanceLanesValid ?? oldCount;

	/*
	 * Fast path for tail growth or growth into an adjacent free interval.
	 */
	if (faceCount > oldCount) {
		const candidateMatrices = buildInstanceData(
			oldMatrices,
			oldArenaIndex,
			oldBase,
			state.offsetBase,
			faceCount,
			oldValid,
		);

		if (!candidateMatrices) {
			return mesh;
		}

		const arena = faceArenas[oldArenaIndex];

		if (
			arena &&
			tryExtendFaces(arena, oldArenaIndex, oldBase, oldCount, faceCount)
		) {
			state.faceCount = faceCount;

			if (dirtyRanges && dirtyRanges.length > 0) {
				packFaceRanges(state, input, dirtyRanges);
				uploadFaceRanges(oldArenaIndex, oldBase, faceCount, dirtyRanges);
			} else {
				packFaces(state, input);
				uploadFaceRange(oldArenaIndex, oldBase, faceCount);
			}

			const bufferChanged = candidateMatrices !== oldMatrices;

			state.instanceMatrices = candidateMatrices;
			state.instanceLanesValid = faceCount;

			setThinInstancesRange(
				mesh,
				candidateMatrices,
				faceCount,
				bufferChanged ? 0 : oldValid,
				faceCount,
			);

			applyMeshMeta(mesh, state, input);
			return mesh;
		}
	}

	/*
	 * Build or resize instance memory before freeing the current face block.
	 * This makes an allocation failure leave the old mesh fully intact.
	 *
	 * The arena constants are patched after the new face allocation succeeds.
	 */
	const candidateMatrices = buildInstanceData(
		oldMatrices,
		oldArenaIndex,
		oldBase,
		state.offsetBase,
		faceCount,
		0,
	);

	if (!candidateMatrices) {
		console.warn(
			`[PackedChunkMesh] skipping update for ${faceCount}-face mesh: ` +
				`instance allocation failed.`,
		);
		return mesh;
	}

	let allocation = allocFaces(faceCount);
	let oldBlockFreed = false;
	let snapshot: Uint32Array | null = null;

	if (allocation.arena < 0 && oldCount > 0) {
		const oldArena = faceArenas[oldArenaIndex];

		/*
		 * This is the sole unavoidable large temporary allocation in the
		 * recovery path. It is needed because allocFaces may compact arenas
		 * while retrying, so merely remembering the old coordinates is not
		 * enough to restore the original geometry safely.
		 */
		if (oldArena) {
			snapshot = oldArena.cpu.slice(
				oldBase * FACE_WORDS,
				(oldBase + oldCount) * FACE_WORDS,
			);
		}

		freeFaces(oldArenaIndex, oldBase, oldCount);
		oldBlockFreed = true;
		allocation = allocFaces(faceCount);

		if (allocation.arena < 0) {
			const restore =
				snapshot === null ? { arena: -1, base: -1 } : allocFaces(oldCount);

			if (restore.arena >= 0 && snapshot !== null) {
				const restoreArena = faceArenas[restore.arena];
				restoreArena.cpu.set(snapshot, restore.base * FACE_WORDS);

				state.faceArena = restore.arena;
				state.faceBase = restore.base;
				state.faceCount = oldCount;

				uploadFaceRange(restore.arena, restore.base, oldCount);

				if (restore.arena !== oldArenaIndex || restore.base !== oldBase) {
					const restoredMatrices = buildInstanceData(
						oldMatrices,
						restore.arena,
						restore.base,
						state.offsetBase,
						oldCount,
						0,
					);

					if (restoredMatrices) {
						state.instanceMatrices = restoredMatrices;
						state.instanceLanesValid = oldCount;
						setThinInstancesRange(
							mesh,
							restoredMatrices,
							oldCount,
							0,
							oldCount,
						);
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

			(mesh as PackedMesh).isVisible = false;

			console.error(
				`[PackedChunkMesh] arena restore failed for ${faceCount}-face ` +
					`remesh; mesh hidden until its next successful update.`,
			);

			return mesh;
		}
	}

	if (allocation.arena < 0) {
		console.warn(
			`[PackedChunkMesh] skipping update for chunk mesh: face arenas ` +
				`full (${totalFacesUsed()}/${totalFaceCapacity()}).`,
		);
		return mesh;
	}

	/*
	 * Patch the retained instance buffer before committing state. This loop
	 * performs no allocations.
	 */
	for (
		let face = 0, index = 0;
		face < faceCount;
		face++, index += INSTANCE_FLOATS
	) {
		candidateMatrices[index + FACE_BASE_INSTANCE_INDEX] = allocation.base;
		candidateMatrices[index + ARENA_INSTANCE_INDEX] = allocation.arena;
		candidateMatrices[index + OFFSET_BASE_INSTANCE_INDEX] = state.offsetBase;
	}

	if (!oldBlockFreed) {
		freeFaces(oldArenaIndex, oldBase, oldCount);
	}

	state.faceArena = allocation.arena;
	state.faceBase = allocation.base;
	state.faceCount = faceCount;
	state.instanceMatrices = candidateMatrices;
	state.instanceLanesValid = faceCount;

	packFaces(state, input);

	/*
	 * offsetBase does not change during remeshing, but chunkOffsets may.
	 */
	packOffsets(state, input);

	uploadFaceRange(allocation.arena, allocation.base, faceCount);
	uploadOffsetRange(state.offsetBase);

	setThinInstancesRange(mesh, candidateMatrices, faceCount, 0, faceCount);

	applyMeshMeta(mesh, state, input);
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

	let boundMin = state.boundMin;
	if (boundMin) {
		boundMin[0] = input.boundsMin[0];
		boundMin[1] = input.boundsMin[1];
		boundMin[2] = input.boundsMin[2];
	} else {
		boundMin = [input.boundsMin[0], input.boundsMin[1], input.boundsMin[2]];
		state.boundMin = boundMin;
	}

	let boundMax = state.boundMax;
	if (boundMax) {
		boundMax[0] = input.boundsMax[0];
		boundMax[1] = input.boundsMax[1];
		boundMax[2] = input.boundsMax[2];
	} else {
		boundMax = [input.boundsMax[0], input.boundsMax[1], input.boundsMax[2]];
		state.boundMax = boundMax;
	}

	anyMesh.boundMin = boundMin;
	anyMesh.boundMax = boundMax;
	anyMesh.isVisible = true;

	if (mesh.material !== input.material) {
		mesh.material = input.material;
	}

	const position = mesh.position;
	const x = input.position[0];
	const y = input.position[1];
	const z = input.position[2];

	if (position.x !== x || position.y !== y || position.z !== z) {
		position.set(x, y, z);
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
	for (const mesh of meshState.keys()) {
		if (sceneRef) {
			removeFromScene(sceneRef, mesh);
		}

		scheduleDeferredDisposal(mesh);
	}

	meshState.clear();

	const engine = engineRef;
	const arenas = faceArenas;
	const offsets = offsetBuffer;

	if (engine) {
		void onGpuWorkDone(engine).then(() => {
			for (let i = 0; i < arenas.length; i++) {
				disposeStorageBuffer(arenas[i].buffer);
			}

			if (offsets) {
				disposeStorageBuffer(offsets);
			}
		});
	} else {
		for (let i = 0; i < arenas.length; i++) {
			disposeStorageBuffer(arenas[i].buffer);
		}

		if (offsets) {
			disposeStorageBuffer(offsets);
		}
	}

	faceArenas = [];
	offsetBuffer = null;
	offsetCpu = new Float32Array(0);
	offsetCapacityGroups = 0;
	offsetUsedGroups = 0;

	offsetFree.length = 0;
	_freeIntervalPool.length = 0;
	_compactEntries.length = 0;

	registeredMaterials.length = 0;
	boundMaterials.clear();
	forcedBuilds.clear();

	/*
	 * Do not clear _pendingDisposal here. Those meshes are still awaiting
	 * safe GPU disposal and must remain referenced until the submitted work
	 * completes.
	 */
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

		if (state.instanceMatrices) {
			instanceBytes += state.instanceMatrices.byteLength;
		}
	}

	let arenaCapacityFaces = 0;
	let arenaUsedFaces = 0;

	for (let i = 0; i < faceArenas.length; i++) {
		const arena = faceArenas[i];
		arenaCapacityFaces += arena.capacity;
		arenaUsedFaces += arena.used;
	}

	return {
		meshes,
		instanceBytes,
		arenaCapacityFaces,
		arenaUsedFaces,
		// CPU mirror plus GPU storage buffer.
		arenaBytes: arenaCapacityFaces * FACE_BYTES * 2,
		// CPU mirror plus GPU storage buffer.
		offsetBytes: offsetCpu.byteLength * 2,
	};
}
