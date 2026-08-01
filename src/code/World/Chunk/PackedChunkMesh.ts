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

const SHARED_QUAD_POSITIONS = new Float32Array([
	0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1,
]);
const SHARED_QUAD_NORMALS = new Float32Array(12);
const SHARED_QUAD_INDICES = new Uint32Array([0, 2, 1, 0, 3, 2]);

// Float index inside the per-instance 4x4 matrix where we stash `faceBase`.
// world3 is the 4th column; .w is element 15. The shader reads it as world3.w.
const FACE_BASE_MATRIX_INDEX = 15;

interface PackedMeshState {
	faceArena: number;
	faceBase: number;
	faceCount: number;
	offsetBase: number;
	/** Persistent copy of the mesh's input, retained for per-frame rebuilds. */
	input: PackedMeshInput;
	/** Retained instance-matrix buffer; reused across updates (no realloc). */
	instanceMatrices?: Float32Array;
	/** Retained mesh-visible bounds; reused across updates (no realloc),
	 *  kept independent from state.input's own copies. */
	boundMin?: [number, number, number];
	boundMax?: [number, number, number];
	/** Cached u32 views over input.faceDataA/B/C — rebuilt only when the
	 *  underlying buffer identity changes (i.e. reuseOrCloneU8 had to
	 *  .slice() a new one instead of reusing via .set()). */
	faceWordsA?: Uint32Array;
	faceWordsB?: Uint32Array;
	faceWordsC?: Uint32Array;
}

const meshState = new Map<Mesh, PackedMeshState>();

// ── Arena state ──────────────────────────────────────────────────────────────
let engineRef: EngineContext | null = null;
let sceneRef: SceneContext | null = null;

// The face data is split across several storage buffers ("arenas"). A single
// GPU storage-buffer BINDING is capped at `maxStorageBufferBindingSize`
// (default 128 MiB ≈ 8.4M faces). To hold more loaded faces than that, we
// allocate additional arenas, each under the cap, and the shader selects the
// right one via a per-instance `arenaIndex`. `faceData0..faceData{N-1}` are
// bound to every packed material.
interface FaceArena {
	cpu: Uint32Array; // faceCount * 4 u32 (vec4<u32> per face)
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

// Bytes per face in the arena (vec4<u32>).
const FACE_BYTES = 16;

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
	// start each arena at 262144 faces (4 MiB) which covers ~1.5M faces across
	// 6 arenas before any grow is needed — well past a typical render distance.
	// The capacity doubles on demand up to the binding cap if needed.
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
	const cpu = new Uint32Array(capacity * 4);
	const buffer = createStorageBuffer(engineRef!, cpu, "face-set");
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
	const newCapacity = Math.min(arena.capacity * 2, maxFaces);
	if (newCapacity <= arena.capacity) return;
	const newCpu = new Uint32Array(newCapacity * 4);
	newCpu.set(arena.cpu.subarray(0, arena.used * 4));
	arena.cpu = newCpu;
	arena.capacity = newCapacity;
	const old = arena.buffer;
	arena.buffer = createStorageBuffer(engineRef!, arena.cpu, "face-set");
	bindArenaToMaterials(arena, index);
	if (engineRef && old) {
		const e = engineRef;
		void onGpuWorkDone(e).then(() => disposeStorageBuffer(old));
	}
}

// Total faces one arena may hold (the binding-size cap). All arenas are
// created up front (see ensureArenas) and grow toward this independently.
function maxFacesPerArena(): number {
	return Math.floor(maxStorageBindingBytes / FACE_BYTES);
}

function allocFaces(count: number): FaceAlloc {
	const maxFaces = maxFacesPerArena();

	// 1) Reuse a freed hole in any existing arena (keeps memory compact and
	//    lets unloaded chunks' faces be recycled without growing).
	for (let ai = 0; ai < faceArenas.length; ai++) {
		const arena = faceArenas[ai];
		const free = arena.free;
		for (let i = 0; i < free.length; i++) {
			if (free[i].count >= count) {
				const base = free[i].base;
				const leftover = free[i].count - count;
				if (leftover > 0) {
					free[i] = acquireInterval(base + count, leftover);
				} else {
					free.splice(i, 1);
				}
				return { arena: ai, base };
			}
		}
	}

	// 2) Append to an arena's tail, growing that arena up to the cap first if
	//    it still has headroom. Walk arenas in order so we fill arena 0 before
	//    spilling into arena 1, etc.
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

	// 3) Every arena is full at the binding cap — the GPU face budget is
	//    exhausted. Callers skip drawing rather than writing OOB.
	console.error(
		`[PackedChunkMesh] face arenas exhausted (${totalFacesUsed()} faces, ` +
			`${faceArenas.length} arenas = ${totalFaceCapacity()} faces). ` +
			`Loaded geometry exceeds the GPU storage-buffer arena limit ` +
			`(maxFaceArenas=${maxFaceArenas}).`,
	);
	return { arena: -1, base: -1 };
}

function freeFaceInterval(
	free: Array<{ base: number; count: number }>,
	base: number,
	count: number,
): void {
	// Binary search for the sorted insertion point. The splice() shift below
	// is still O(n) (array-based free list), but this keeps the *search* at
	// O(log n) instead of O(n) — matters for large unload bursts.
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

	free.splice(i, 0, acquireInterval(base, count));

	// merge left
	if (i > 0) {
		const prev = free[i - 1];
		const curr = free[i];
		if (prev.base + prev.count === curr.base) {
			prev.count += curr.count;
			free.splice(i, 1);
			releaseInterval(curr);
			i--;
		}
	}

	// merge right
	if (i < free.length - 1) {
		const curr = free[i];
		const next = free[i + 1];
		if (curr.base + curr.count === next.base) {
			curr.count += next.count;
			free.splice(i + 1, 1);
			releaseInterval(next);
		}
	}
}

function freeFaces(arena: number, base: number, count: number): void {
	if (arena < 0 || arena >= faceArenas.length) return;
	freeFaceInterval(faceArenas[arena].free, base, count);
}

function freeOffsetBlock(base: number): void {
	const blockIndex = (base / OFFSETS_PER_GROUP) | 0; // faster than Math.floor
	offsetFree.push(blockIndex);
}

function allocOffsetBlock(): number {
	if (offsetFree.length > 0) {
		const blockIndex = offsetFree.pop()!;
		return blockIndex * OFFSETS_PER_GROUP;
	}
	if (offsetUsedGroups + 1 > offsetCapacityGroups) growOffset();
	const blockIndex = offsetUsedGroups;
	offsetUsedGroups += 1;
	return blockIndex * OFFSETS_PER_GROUP;
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
	if (!a) return;

	const elementsPerFace = 4; // vec4<u32>

	const dstByteOffset = base * elementsPerFace * 4;
	const srcElementOffset = base * elementsPerFace;
	const elementCount = count * elementsPerFace;

	writeBufferChunked(
		a.buffer,
		a.cpu,
		dstByteOffset,
		srcElementOffset,
		elementCount,
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
	for (let r = 0; r < ranges.length; r++) {
		const { start, count } = ranges[r];
		const clampedStart = start < 0 ? 0 : start;
		const clampedEnd = clampedStart + count;
		if (clampedStart >= faceCount) continue;
		const n = clampedEnd > faceCount ? faceCount - clampedStart : count;
		if (n <= 0) continue;
		uploadFaceRange(arena, faceBase + clampedStart, n);
	}
}

function uploadOffsetRange(base: number): void {
	if (!offsetBuffer) return;

	const elementsPerEntry = 4; // vec4<f32>
	const count = OFFSETS_PER_GROUP;

	const dstByteOffset = base * elementsPerEntry * 4;
	const srcElementOffset = base * elementsPerEntry;
	const elementCount = count * elementsPerEntry;

	writeBufferChunked(
		offsetBuffer,
		offsetCpu,
		dstByteOffset,
		srcElementOffset,
		elementCount,
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
	if (!engineRef) return;
	const bytesPerElement = 4;
	const maxElements = Math.max(1, Math.floor(maxWriteBytes / bytesPerElement));
	let remaining = elementCount;
	let dst = dstByteOffset;
	let src = srcElementOffset;
	while (remaining > 0) {
		const n = remaining > maxElements ? maxElements : remaining;
		// updateStorageBuffer writes `data` verbatim starting at `byteOffset`,
		// so slice the source to just the [src, src+n) element window.
		const slice = data.subarray(src, src + n);
		updateStorageBuffer(engineRef, buffer, slice, dst);
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
	chunkIndex: Uint8Array; // per-face local chunk index (0..63)
	chunkOffsets: Float32Array; // length 192, stride 3
	position: [number, number, number];
	boundsMin: [number, number, number];
	boundsMax: [number, number, number];
}

// `state.input` is only ever produced by `cloneInput` (below), whose typed
// arrays are always either a fresh `.slice()` or a same-length in-place
// `.set()` into a buffer that itself originated from `.slice()`. Either way
// `faceDataA/B/C.byteOffset` is always 0 and `byteLength` is always a
// multiple of 4, so reinterpreting each as a Uint32Array over the SAME
// buffer is safe: the little-endian byte layout `a[i*4]` (LSB) .. `a[i*4+3]`
// (MSB) is bit-for-bit identical to reading those four bytes as one u32 on
// every realistic deployment target (WebGPU browsers are all little-endian).
// This turns 12 shifts+ORs per face into 3 direct word reads, and replaces
// four independent `i * 4` index computations per array with one running
// accumulator.
// Rebuild the cached u32 views over state.input's face data. The views are
// only invalid when the underlying buffer identity changes (reuseOrCloneU8
// had to .slice() a fresh copy instead of reusing via .set()).
function ensureFaceWordViews(state: PackedMeshState): void {
	const input = state.input;
	const faceCount = input.faceDataA.length >>> 2;

	let aWords = state.faceWordsA;
	if (
		!aWords ||
		aWords.buffer !== input.faceDataA.buffer ||
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
function packFaceRanges(
	state: PackedMeshState,
	ranges: readonly MergedFaceRange[],
): void {
	if (ranges.length === 0) return;
	ensureFaceWordViews(state);
	const input = state.input;
	const ci = input.chunkIndex;
	const offsetBase = state.offsetBase;
	const faceCount = input.faceDataA.length >>> 2;

	const arena = faceArenas[state.faceArena];
	if (!arena) return;
	const faceCpu = arena.cpu;

	const aWords = state.faceWordsA!;
	const bWords = state.faceWordsB!;
	const cWords = state.faceWordsC!;

	const baseWord = state.faceBase * 4;
	for (let r = 0; r < ranges.length; r++) {
		const { start, count } = ranges[r];
		const clampedStart = start < 0 ? 0 : start;
		const clampedEnd = clampedStart + count;
		if (clampedStart >= faceCount) continue;
		const n = clampedEnd > faceCount ? faceCount - clampedStart : count;
		if (n <= 0) continue;
		let o = baseWord + clampedStart * 4;
		const end = clampedStart + n;
		for (let i = clampedStart; i < end; i++) {
			faceCpu[o] = aWords[i];
			faceCpu[o + 1] = bWords[i];
			faceCpu[o + 2] = cWords[i];
			faceCpu[o + 3] = offsetBase + ci[i];
			o += 4;
		}
	}
}

function packFaces(state: PackedMeshState): void {
	const faceCount = state.input.faceDataA.length >>> 2;
	packFaceRanges(state, [{ start: 0, count: faceCount }]);
}

function packOffsets(state: PackedMeshState): void {
	const input = state.input;
	const offsetBase = state.offsetBase;
	const co = input.chunkOffsets;
	for (let idx = 0; idx < MAX_LOCAL; idx++) {
		const o = (offsetBase + idx) * 4;
		offsetCpu[o] = co[idx * 3] ?? 0;
		offsetCpu[o + 1] = co[idx * 3 + 1] ?? 0;
		offsetCpu[o + 2] = co[idx * 3 + 2] ?? 0;
		offsetCpu[o + 3] = 0;
	}
}

// Build / reuse the thin-instance matrix buffer for a mesh: `count` matrices
// whose world3.w (matrices[i*16 + FACE_BASE_MATRIX_INDEX]) carries `faceBase`.
// The shader reads world3.w as faceBase and ignores the rest (it computes the
// vertex position from faceData), so the rest of every matrix stays zero.
//
// PERF: the buffer is RETAINED per-mesh on PackedMeshState and reused across
// updates — only the single faceBase lane per instance is rewritten, and only
// when the instance count changes do we reallocate. This removes the previous
// `count*16` Float32Array allocation on every chunk remesh (a major GC source
// in the updatePackedChunkMesh hot path). The old single-shared-scratch concern
// does not apply because each mesh owns its OWN retained buffer here.
function buildInstanceMatrices(
	prev: Float32Array | undefined,
	arena: number,
	faceBase: number,
	count: number,
): Float32Array {
	const needLen = count * 16;
	let matrices = prev;
	if (!matrices || matrices.length !== needLen) {
		matrices = new Float32Array(needLen);
	}
	// The matrices are otherwise all-zero and never change, so only the
	// faceBase (world3.w) and arenaIndex (world0.w) lanes are ever rewritten.
	// A running accumulator replaces `count` multiplications (i*16) with
	// `count` additions.
	let faceIdx = FACE_BASE_MATRIX_INDEX;
	let arenaIdx = ARENA_MATRIX_INDEX;
	for (let i = 0; i < count; i++) {
		matrices[faceIdx] = faceBase;
		matrices[arenaIdx] = arena;
		faceIdx += 16;
		arenaIdx += 16;
	}
	return matrices;
}

// `prev`'s arrays (if any) are always ones we ourselves allocated in an
// earlier cloneInput call, so reusing them never aliases the caller's buffer
// and never changes byteOffset-0 alignment (see packFaces).
function reuseOrCloneU8(
	prev: Uint8Array | undefined,
	src: Uint8Array,
): Uint8Array {
	if (prev && prev.length === src.length) {
		prev.set(src);
		return prev;
	}
	return src.slice();
}

function reuseOrCloneF32(
	prev: Float32Array | undefined,
	src: Float32Array,
): Float32Array {
	if (prev && prev.length === src.length) {
		prev.set(src);
		return prev;
	}
	return src.slice();
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

// Deep-copies the typed-array payload so the retained input is independent of
// the caller's (often reused, module-level) scratch `PackedMeshInput`. When a
// previous clone (`prev`) is passed — the update path, where a chunk's
// face/offset layout is frequently unchanged in size across relight/rebuild
// passes — matching-length buffers are overwritten in place via `.set()`
// instead of allocating fresh typed arrays, cutting GC churn on every mesh
// rebuild. `chunkOffsets` is fixed at length 192 (MAX_LOCAL * 3), so it
// always hits the reuse path once a mesh has been built once.
function cloneInput(
	input: PackedMeshInput,
	prev?: PackedMeshInput,
): PackedMeshInput {
	return {
		name: input.name,
		material: input.material,
		faceDataA: reuseOrCloneU8(prev?.faceDataA, input.faceDataA),
		faceDataB: reuseOrCloneU8(prev?.faceDataB, input.faceDataB),
		faceDataC: reuseOrCloneU8(prev?.faceDataC, input.faceDataC),
		chunkIndex: reuseOrCloneU8(prev?.chunkIndex, input.chunkIndex),
		chunkOffsets: reuseOrCloneF32(prev?.chunkOffsets, input.chunkOffsets),
		position: reuseOrCloneVec3(prev?.position, input.position),
		boundsMin: reuseOrCloneVec3(prev?.boundsMin, input.boundsMin),
		boundsMax: reuseOrCloneVec3(prev?.boundsMax, input.boundsMax),
	};
}

export function createPackedChunkMesh(input: PackedMeshInput): Mesh | null {
	const engine = engineRef!;
	const scene = sceneRef!;

	const alloc = allocFaces(input.faceDataA.length / 4);
	const offsetBase = allocOffsetBlock();
	const faceCount = input.faceDataA.length / 4;

	// Arena exhausted (GPU storage-buffer arena limit reached). Skip this
	// chunk's mesh entirely rather than writing past the buffer end, which
	// would throw and blackscreen the world. The chunk still exists in data;
	// it simply isn't drawn until faces are freed elsewhere.
	if (alloc.arena < 0) {
		console.warn(
			`[PackedChunkMesh] skipping mesh for "${input.name}": ` +
				`face arenas full (${totalFacesUsed()}/${totalFaceCapacity()}).`,
		);
		return null;
	}

	const state: PackedMeshState = {
		faceArena: alloc.arena,
		faceBase: alloc.base,
		faceCount,
		offsetBase,
		input: cloneInput(input),
	};
	packFaces(state);
	packOffsets(state);
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

	// Thin instances: draw `faceCount` copies of the shared quad, each addressed
	// by instance_index; faceBase rides in world3.w and the arena index in
	// world0.w.
	const instanceMatrices = buildInstanceMatrices(
		state.instanceMatrices,
		alloc.arena,
		alloc.base,
		faceCount,
	);
	state.instanceMatrices = instanceMatrices;
	setThinInstances(mesh, instanceMatrices, faceCount);

	addToScene(scene, mesh);
	ensureInstancedBuild(input.material, mesh);
	meshState.set(mesh, state);
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

	const faceCount = input.faceDataA.length / 4;

	if (faceCount === state.faceCount) {
		const anyMesh = mesh as PackedMesh;
		const boundMin = reuseOrCloneVec3(state.boundMin, input.boundsMin);
		const boundMax = reuseOrCloneVec3(state.boundMax, input.boundsMax);
		state.boundMin = boundMin;
		state.boundMax = boundMax;
		anyMesh.boundMin = boundMin;
		anyMesh.boundMax = boundMax;
		anyMesh.isVisible = true;
		mesh.material = input.material;
		mesh.position.set(input.position[0], input.position[1], input.position[2]);

		// Incremental path: `dirtyRanges` (merged-face coordinates) tells us
		// exactly which members remeshed this pass. Empty means the merged
		// buffer is byte-identical to what we last packed — skip the clone,
		// the CPU re-pack and the GPU re-upload entirely (the retained
		// `state.input` copy is still accurate).
		if (dirtyRanges && dirtyRanges.length === 0) {
			return mesh;
		}

		state.input = cloneInput(input, state.input);
		if (dirtyRanges && dirtyRanges.length > 0) {
			packFaceRanges(state, dirtyRanges);
			uploadFaceRanges(state.faceArena, state.faceBase, faceCount, dirtyRanges);
		} else {
			packFaces(state);
			uploadFaceRange(state.faceArena, state.faceBase, faceCount);
		}

		return mesh;
	}

	// Slow path
	const alloc = allocFaces(faceCount);

	// Arena exhausted. Keep the mesh's previously-allocated faces and its
	// existing GPU geometry so it keeps rendering instead of writing past
	// the buffer (which throws + blackscreens). We leave `state` as-is.
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
	state.input = cloneInput(input, state.input);
	packFaces(state);
	packOffsets(state);
	uploadFaceRange(alloc.arena, alloc.base, faceCount);
	uploadOffsetRange(state.offsetBase);

	const anyMesh = mesh as PackedMesh;
	const boundMin = reuseOrCloneVec3(state.boundMin, input.boundsMin);
	const boundMax = reuseOrCloneVec3(state.boundMax, input.boundsMax);
	state.boundMin = boundMin;
	state.boundMax = boundMax;
	anyMesh.boundMin = boundMin;
	anyMesh.boundMax = boundMax;
	anyMesh.isVisible = true;
	mesh.material = input.material;
	mesh.position.set(input.position[0], input.position[1], input.position[2]);

	const instanceMatrices = buildInstanceMatrices(
		state.instanceMatrices,
		alloc.arena,
		alloc.base,
		faceCount,
	);
	state.instanceMatrices = instanceMatrices;
	setThinInstances(mesh, instanceMatrices, faceCount);

	return mesh;
}

export function disposePackedMesh(mesh: Mesh): void {
	const state = meshState.get(mesh);
	if (state) {
		freeFaces(state.faceArena, state.faceBase, state.faceCount);
		freeOffsetBlock(state.offsetBase);
		meshState.delete(mesh);
	}
	if (sceneRef && mesh) removeFromScene(sceneRef, mesh);
	disposeMeshGpu(mesh);
}

export function destroyPackedArenas(): void {
	// Tear down every live packed mesh first so none lingers in the scene
	// referencing the arena buffers we are about to destroy.
	for (const mesh of meshState.keys()) {
		if (sceneRef && mesh) removeFromScene(sceneRef, mesh);
		disposeMeshGpu(mesh);
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
