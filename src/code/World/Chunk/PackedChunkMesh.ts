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
	disposeMeshGpu,
	type EngineContext,
	type Mesh,
	removeFromScene,
	type SceneContext,
	type ShaderMaterial,
	type StorageBuffer,
	setShaderStorageBuffer,
	setThinInstances,
} from "@babylonjs/lite";
import {
	createLiteStorageBuffer,
	disposeLiteStorageBuffer,
	onGpuWorkDone,
	updateLiteStorageBuffer,
} from "../Light/liteGpuBuffer.js";

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
	faceBase: number;
	faceCount: number;
	offsetBase: number;
	/** Persistent copy of the mesh's input, retained for per-frame rebuilds. */
	input: PackedMeshInput;
}

const meshState = new Map<Mesh, PackedMeshState>();

// ── Arena state ──────────────────────────────────────────────────────────────
let engineRef: EngineContext | null = null;
let sceneRef: SceneContext | null = null;

// A single pair of global GPU storage buffers shared by every packed mesh.
// All meshes index into the same arena via their per-mesh faceBase, so the
// material's storage-buffer binding is set exactly once.
let faceBuffer: StorageBuffer | null = null;
let offsetBuffer: StorageBuffer | null = null;

let faceCpu = new Uint32Array(0);
let faceCapacity = 0; // in faces
let faceUsed = 0;
const faceFree: Array<{ base: number; count: number }> = [];

let offsetCpu = new Float32Array(0);
let offsetCapacityGroups = 0;
let offsetUsedGroups = 0;
const offsetFree: number[] = []; // free block indices

// WebGPU writeBuffer size cap (bytes). Cached from the device at init; falls
// back to a conservative value if the device isn't reachable yet.
let maxWriteBytes = 64 * 1024 * 1024;

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
	ensureArenas();
}

function ensureArenas(): void {
	if (!faceBuffer) {
		faceCapacity = 8192;
		faceCpu = new Uint32Array(faceCapacity * 4);
		offsetCapacityGroups = 1024;
		offsetCpu = new Float32Array(offsetCapacityGroups * OFFSETS_PER_GROUP * 4);
		faceBuffer = createLiteStorageBuffer(engineRef!, faceCpu, "face-set");
		offsetBuffer = createLiteStorageBuffer(engineRef!, offsetCpu, "offset-set");
		for (const m of registeredMaterials) {
			setShaderStorageBuffer(m, "faceData", faceBuffer);
			setShaderStorageBuffer(m, "chunkOffsets", offsetBuffer);
			boundMaterials.add(m);
		}
	}
}

function growFace(): void {
	const newCapacity = faceCapacity * 2;
	const newCpu = new Uint32Array(newCapacity * 4);
	newCpu.set(faceCpu.subarray(0, faceUsed * 4));
	faceCpu = newCpu;
	faceCapacity = newCapacity;
	const old = faceBuffer;
	faceBuffer = createLiteStorageBuffer(engineRef!, faceCpu, "face-set");
	// The buffer identity changed, so materials must re-bind. The epoch bump
	// triggers a rebuild of individual meshes; the group build keeps the
	// instanced pipeline, so this is safe as long as no plain single-mesh
	// rebuild is forced for an instanced mesh.
	for (const m of registeredMaterials) {
		setShaderStorageBuffer(m, "faceData", faceBuffer);
		boundMaterials.add(m);
	}
	if (engineRef && old) {
		const e = engineRef;
		void onGpuWorkDone(e).then(() => disposeLiteStorageBuffer(old));
	}
}

function growOffset(): void {
	const newCapacity = offsetCapacityGroups * 2;
	const newCpu = new Float32Array(newCapacity * OFFSETS_PER_GROUP * 4);
	newCpu.set(offsetCpu.subarray(0, offsetUsedGroups * OFFSETS_PER_GROUP * 4));
	offsetCpu = newCpu;
	offsetCapacityGroups = newCapacity;
	const old = offsetBuffer;
	offsetBuffer = createLiteStorageBuffer(engineRef!, offsetCpu, "offset-set");
	for (const m of registeredMaterials) {
		setShaderStorageBuffer(m, "chunkOffsets", offsetBuffer);
		boundMaterials.add(m);
	}
	if (engineRef && old) {
		const e = engineRef;
		void onGpuWorkDone(e).then(() => disposeLiteStorageBuffer(old));
	}
}

function allocFaces(count: number): number {
	for (let i = 0; i < faceFree.length; i++) {
		if (faceFree[i].count >= count) {
			const base = faceFree[i].base;
			const leftover = faceFree[i].count - count;
			if (leftover > 0) {
				faceFree[i] = { base: base + count, count: leftover };
			} else {
				faceFree.splice(i, 1);
			}
			return base;
		}
	}
	if (faceUsed + count > faceCapacity) {
		while (faceUsed + count > faceCapacity) growFace();
	}
	const base = faceUsed;
	faceUsed += count;
	return base;
}
function freeFaces(base: number, count: number): void {
	// Binary search for the sorted insertion point instead of scanning
	// backward from the end. The splice() shift below is still O(n) (array-
	// based free list), but this keeps the *search* at O(log n) instead of
	// O(n) — matters when a low-index block is freed after many higher-index
	// ones have piled up, e.g. large-radius chunk unload bursts.
	let lo = 0;
	let hi = faceFree.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (faceFree[mid].base < base) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	let i = lo;

	faceFree.splice(i, 0, { base, count });

	// merge left
	if (i > 0) {
		const prev = faceFree[i - 1];
		const curr = faceFree[i];
		if (prev.base + prev.count === curr.base) {
			prev.count += curr.count;
			faceFree.splice(i, 1);
			i--;
		}
	}

	// merge right
	if (i < faceFree.length - 1) {
		const curr = faceFree[i];
		const next = faceFree[i + 1];
		if (curr.base + curr.count === next.base) {
			curr.count += next.count;
			faceFree.splice(i + 1, 1);
		}
	}
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

function uploadFaceRange(base: number, count: number): void {
	if (!faceBuffer) return;

	const elementsPerFace = 4; // vec4<u32>

	const dstByteOffset = base * elementsPerFace * 4;
	const srcElementOffset = base * elementsPerFace;
	const elementCount = count * elementsPerFace;

	writeBufferChunked(
		faceBuffer,
		faceCpu,
		dstByteOffset,
		srcElementOffset,
		elementCount,
	);
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
// which a single writeBuffer call would reject. Uses the managed storage-buffer
// update API (updateLiteStorageBuffer -> updateStorageBuffer), which replaces a
// byte range in place without changing the buffer's bind identity.
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
		updateLiteStorageBuffer(engineRef, buffer, slice, dst);
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
	if (faceBuffer && !boundMaterials.has(material)) {
		setShaderStorageBuffer(material, "faceData", faceBuffer);
		setShaderStorageBuffer(material, "chunkOffsets", offsetBuffer!);
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
function packFaces(state: PackedMeshState): void {
	const input = state.input;
	const faceCount = input.faceDataA.length >>> 2;
	const aWords = new Uint32Array(
		input.faceDataA.buffer,
		input.faceDataA.byteOffset,
		faceCount,
	);
	const bWords = new Uint32Array(
		input.faceDataB.buffer,
		input.faceDataB.byteOffset,
		faceCount,
	);
	const cWords = new Uint32Array(
		input.faceDataC.buffer,
		input.faceDataC.byteOffset,
		faceCount,
	);
	const ci = input.chunkIndex;
	const offsetBase = state.offsetBase;

	let o = state.faceBase * 4;
	for (let i = 0; i < faceCount; i++) {
		faceCpu[o] = aWords[i];
		faceCpu[o + 1] = bWords[i];
		faceCpu[o + 2] = cWords[i];
		faceCpu[o + 3] = offsetBase + ci[i];
		o += 4;
	}
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

// Build the thin-instance matrix buffer for a mesh: `count` identity-ish matrices
// whose world3.w carries `faceBase`. The shader reads world3.w as faceBase and
// ignores the rest (it computes vertex position from faceData).
function buildInstanceMatrices(faceBase: number, count: number): Float32Array {
	// Float32Array is zero-initialized on allocation, so only the single
	// faceBase slot per instance needs writing. A running accumulator
	// replaces `count` multiplications (`i * 16`) with `count` additions.
	//
	// NOTE: deliberately NOT pooled across calls. `mesh.thinInstances.matrices`
	// (see PackedMesh above) is retained by Lite and lazily flushed to the GPU
	// via `_dirtyMin/_dirtyMax/_gpuVersion`, not copied synchronously — so
	// every mesh must own a distinct array. Sharing one scratch buffer across
	// meshes would alias their instance data and corrupt whichever mesh's
	// upload hadn't flushed yet.
	const matrices = new Float32Array(count * 16);
	let idx = FACE_BASE_MATRIX_INDEX;
	for (let i = 0; i < count; i++) {
		matrices[idx] = faceBase;
		idx += 16;
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
		position: [input.position[0], input.position[1], input.position[2]],
		boundsMin: [input.boundsMin[0], input.boundsMin[1], input.boundsMin[2]],
		boundsMax: [input.boundsMax[0], input.boundsMax[1], input.boundsMax[2]],
	};
}

export function createPackedChunkMesh(input: PackedMeshInput): Mesh {
	const engine = engineRef!;
	const scene = sceneRef!;

	const faceBase = allocFaces(input.faceDataA.length / 4);
	const offsetBase = allocOffsetBlock();
	const faceCount = input.faceDataA.length / 4;

	const state: PackedMeshState = {
		faceBase,
		faceCount,
		offsetBase,
		input: cloneInput(input),
	};
	packFaces(state);
	packOffsets(state);
	uploadFaceRange(faceBase, faceCount);
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
	const boundMin = [
		input.boundsMin[0],
		input.boundsMin[1],
		input.boundsMin[2],
	] as [number, number, number];
	const boundMax = [
		input.boundsMax[0],
		input.boundsMax[1],
		input.boundsMax[2],
	] as [number, number, number];
	anyMesh.boundMin = boundMin;
	anyMesh.boundMax = boundMax;
	anyMesh.isVisible = true;

	// Thin instances: draw `faceCount` copies of the shared quad, each addressed
	// by instance_index; faceBase rides in the instance matrix (world3.w).
	setThinInstances(mesh, buildInstanceMatrices(faceBase, faceCount), faceCount);

	addToScene(scene, mesh);
	ensureInstancedBuild(input.material, mesh);
	meshState.set(mesh, state);
	return mesh;
}

export function updatePackedChunkMesh(
	mesh: Mesh,
	input: PackedMeshInput,
): Mesh {
	const state = meshState.get(mesh);
	if (!state) {
		return createPackedChunkMesh(input);
	}
	freeFaces(state.faceBase, state.faceCount);
	freeOffsetBlock(state.offsetBase);

	const faceBase = allocFaces(input.faceDataA.length / 4);
	const offsetBase = allocOffsetBlock();
	const faceCount = input.faceDataA.length / 4;

	state.faceBase = faceBase;
	state.faceCount = faceCount;
	state.offsetBase = offsetBase;
	state.input = cloneInput(input, state.input);
	packFaces(state);
	packOffsets(state);
	uploadFaceRange(faceBase, faceCount);
	uploadOffsetRange(offsetBase);

	const anyMesh = mesh as PackedMesh;
	const boundMin = [
		input.boundsMin[0],
		input.boundsMin[1],
		input.boundsMin[2],
	] as [number, number, number];
	const boundMax = [
		input.boundsMax[0],
		input.boundsMax[1],
		input.boundsMax[2],
	] as [number, number, number];
	anyMesh.boundMin = boundMin;
	anyMesh.boundMax = boundMax;
	anyMesh.isVisible = true;
	mesh.material = input.material;
	mesh.position.set(input.position[0], input.position[1], input.position[2]);

	// Refresh the thin-instance count and carry the new faceBase.
	setThinInstances(mesh, buildInstanceMatrices(faceBase, faceCount), faceCount);

	return mesh;
}

export function disposePackedMesh(mesh: Mesh): void {
	const state = meshState.get(mesh);
	if (state) {
		freeFaces(state.faceBase, state.faceCount);
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
	const f = faceBuffer;
	const o = offsetBuffer;
	if (engine && f && o) {
		const e = engine;
		void onGpuWorkDone(e).then(() => {
			disposeLiteStorageBuffer(f);
			disposeLiteStorageBuffer(o);
		});
	} else {
		if (f) disposeLiteStorageBuffer(f);
		if (o) disposeLiteStorageBuffer(o);
	}
	faceBuffer = null;
	offsetBuffer = null;
	faceCpu = new Uint32Array(0);
	offsetCpu = new Float32Array(0);
	faceUsed = 0;
	offsetUsedGroups = 0;
	faceFree.length = 0;
	offsetFree.length = 0;
	registeredMaterials.length = 0;
	boundMaterials.clear();
	engineRef = null;
	sceneRef = null;
}
