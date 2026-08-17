import type { Mesh } from "@babylonjs/lite";
import { CHUNK_SIZE } from "@/code/Lib/VoxelMath";
import type { Chunk } from "./Chunk";
import type { MeshData } from "./DataStructures/MeshData";
import { disposePackedMesh, maxFacesPerArena } from "./PackedChunkMesh.js";

// Lite `Mesh` has no `.dispose()` — free its packed-arena slices, unregister
// from the scene, then free GPU resources.
function disposeGroupMesh(mesh: Mesh): void {
	if (!mesh) return;
	disposePackedMesh(mesh);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

enum Meshkind {
	opaque,
	water,
	cutout,
}

export interface ChunkMemberData {
	chunkId: number;
	chunk: Chunk;
	opaqueData: MeshData | null;
	waterData: MeshData | null;
	cutoutData: MeshData | null;
	localIndex: number; // 0-63 within the group
	// `lastBuilt*` records the MeshData reference we last copied into the
	// merged buffer for this member. On a group rebuild we skip re-copying a
	// member whose data reference is unchanged — its bytes are already in the
	// merged buffer at the same deterministic offset, so re-copying all 64
	// members (incl. the 63 that didn't remesh) is pure waste. Relight-only
	// updates hand a *new* MeshData to just the changed chunk, so only that
	// one member's reference differs and gets re-copied (up to 63x cheaper).
	lastBuiltOpaque: MeshData | null;
	lastBuiltWater: MeshData | null;
	lastBuiltCutout: MeshData | null;
	// The writeByte offset each was copied at. A member is only safe to
	// skip when BOTH its data reference AND its target offset are unchanged
	// from last rebuild — an earlier member's face-count change shifts every
	// later member's offset even if that later member itself didn't remesh.
	lastBuiltOpaqueOffset: number;
	lastBuiltWaterOffset: number;
	lastBuiltCutoutOffset: number;
}

export interface MergedVertexData {
	faceDataA: Uint8Array;
	faceDataB: Uint8Array;
	faceDataC: Uint8Array;
	faceCount: number;
}

interface MergedBuffers {
	a: Uint8Array;
	b: Uint8Array;
	c: Uint8Array;
}

export interface MergedFaceRange {
	start: number; // first face index in merged-face coordinates
	count: number;
}

export interface MergedMeshGroup {
	groupKey: number;
	gridX: number;
	gridY: number;
	gridZ: number;
	/**
	 * Render encoding bucket.
	 * 0 = LOD0/LOD1 full AO path
	 * 2 = LOD2 path
	 * 3 = LOD3+ path
	 */
	lodBucket: number;
	minLodLevel: number;
	members: Map<number, ChunkMemberData>;
	membersArray: ChunkMemberData[];
	totalOpaqueFaces: number;
	totalWaterFaces: number;
	totalCutoutFaces: number;
	chunkOffsets: Float32Array; // 64 * 3 = 192 floats
	cachedOpaque: MergedVertexData | null;
	cachedWater: MergedVertexData | null;
	cachedCutout: MergedVertexData | null;

	opaqueCapacityFaces: number;
	waterCapacityFaces: number;
	cutoutCapacityFaces: number;

	opaqueA: Uint8Array | null;
	opaqueB: Uint8Array | null;
	opaqueC: Uint8Array | null;

	waterA: Uint8Array | null;
	waterB: Uint8Array | null;
	waterC: Uint8Array | null;

	cutoutA: Uint8Array | null;
	cutoutB: Uint8Array | null;
	cutoutC: Uint8Array | null;

	// Cached wrappers to avoid allocating `{ a, b, c }` every rebuild.
	opaqueBuffers: MergedBuffers | null;
	waterBuffers: MergedBuffers | null;
	cutoutBuffers: MergedBuffers | null;

	// Cached vertex data wrappers to avoid allocating new objects every rebuild.
	opaqueVertexData: MergedVertexData | null;
	waterVertexData: MergedVertexData | null;
	cutoutVertexData: MergedVertexData | null;

	dirty: boolean;

	// Face ranges (merged-face coordinates) that changed on the most recent
	// rebuildGroupData pass. Consumed by the packed-mesh updater so it can
	// re-pack + re-upload only the members that actually remeshed instead of
	// the whole merged group. Cleared/regenerated on every rebuild.
	dirtyOpaqueRanges: MergedFaceRange[] | null;
	dirtyWaterRanges: MergedFaceRange[] | null;
	dirtyCutoutRanges: MergedFaceRange[] | null;

	// Mesh references — set by ChunkMesher.ts after creating/updating.
	// These are NOT owned by MergedMeshManager; ownership stays with ChunkMesher.
	opaqueMeshRef: any | null;
	waterMeshRef: any | null;
	cutoutMeshRef: any | null;
}

// Metadata stored on merged meshes for onBind callbacks.
export class MergedMeshMeta {
	chunkOffsets: Float32Array | null = null;
	chunkOffsetsArray: number[] | null = null;
	isMerged = true;
	__lodLevel = 0;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GROUP_SIZE = 4;
const MAX_GROUP_MEMBERS = GROUP_SIZE * GROUP_SIZE * GROUP_SIZE;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const groups = new Map<number, MergedMeshGroup>();
const dirtyGroups = new Set<MergedMeshGroup>();

// Scratch face-count caches for rebuildGroupData.
// MAX_GROUP_MEMBERS is 64, so these avoid per-rebuild arrays.
const _opaqueFaceCounts = new Uint32Array(MAX_GROUP_MEMBERS);
const _waterFaceCounts = new Uint32Array(MAX_GROUP_MEMBERS);
const _cutoutFaceCounts = new Uint32Array(MAX_GROUP_MEMBERS);

// Invalidate the per-member "already built" cache. Must be called whenever
// the merged-buffer layout can change independent of member data references:
// member add/remove (membersArray order/offset shifts) or merged-buffer
// reallocation. Pure reassigns of an existing member (the relight path) do
// NOT call this, so unchanged members keep their skip-eligibility.
function invalidateGroupBuildCache(group: MergedMeshGroup): void {
	for (const m of group.membersArray) {
		m.lastBuiltOpaque = null;
		m.lastBuiltWater = null;
		m.lastBuiltCutout = null;
	}
}

// Pool of MergedFaceRange objects to avoid allocating a fresh {start,count}
// object on every dirty-range push (up to ~64 per full 64-member rebuild).
// Objects are returned to the pool at the start of each rebuildGroupData pass
// (the previous pass's ranges were already consumed synchronously by the
// packed-mesh updater callback), then reused for the current pass.
const _rangePool: MergedFaceRange[] = [];

function acquireRange(start: number, count: number): MergedFaceRange {
	const r = _rangePool.pop();
	if (r) {
		r.start = start;
		r.count = count;
		return r;
	}
	return { start, count };
}

// Records a re-copied member's face range into `ranges` (merged-face
// coordinates), coalescing with the previous range when adjacent so the
// packed-mesh updater issues as few writeBuffer calls as possible. Members
// are iterated in merged order and never overlap, so adjacency is the only
// merge case.
function pushDirtyRange(
	ranges: MergedFaceRange[],
	start: number,
	count: number,
): void {
	if (count <= 0) return;
	const prev = ranges[ranges.length - 1];
	if (prev && prev.start + prev.count === start) {
		prev.count += count;
	} else {
		ranges.push(acquireRange(start, count));
	}
}

function markGroupDirty(group: MergedMeshGroup): void {
	group.dirty = true;
	dirtyGroups.add(group);
	// A group can become dirty without a fresh worker mesh-result arriving
	// (OPFS cache load, chunk unload, LOD change). The mesh rebuild only runs
	// inside processMeshQueueLoop, which self-reschedules solely while the
	// mesh-result queue is non-empty — so without this nudge a dirty group
	// wouldn't be rebuilt (and would keep showing stale/missing geometry)
	// until some unrelated chunk finished remeshing. Ask the pool to pump.
	_requestFlush?.();
}

// Set by ChunkWorkerPool so markGroupDirty can schedule a flush pump.
let _requestFlush: (() => void) | null = null;

export function setRequestFlush(cb: () => void): void {
	_requestFlush = cb;
}

/**
 * Copy `byteCount` bytes from `src` into `dst` at `writeByte`.
 *
 * `src.subarray(0, byteCount)` allocates a new TypedArray view object on
 * every call. In the overwhelmingly common case the mesher already hands
 * us a tightly-packed buffer (`src.length === byteCount`), so we can pass
 * `src` straight to `.set()` and skip the view allocation entirely. This
 * is called 3x per member per rebuild (a/b/c), so for a full 64-member
 * group that's up to 192 avoided allocations per buffer type per rebuild.
 */
function copyFaceBytes(
	dst: Uint8Array,
	src: Uint8Array,
	byteCount: number,
	writeByte: number,
): void {
	if (src.length === byteCount) {
		dst.set(src, writeByte);
	} else {
		dst.set(src.subarray(0, byteCount), writeByte);
	}
}

// Pre-computed chunk offsets for localIndex 0-63.
const _precomputedOffsets = (() => {
	const offsets = new Float32Array(MAX_GROUP_MEMBERS * 3);

	for (let i = 0; i < MAX_GROUP_MEMBERS; i++) {
		const lx = i % GROUP_SIZE;
		const ly = Math.floor(i / GROUP_SIZE) % GROUP_SIZE;
		const lz = Math.floor(i / (GROUP_SIZE * GROUP_SIZE));
		const base = i * 3;

		offsets[base] = lx * CHUNK_SIZE;
		offsets[base + 1] = ly * CHUNK_SIZE;
		offsets[base + 2] = lz * CHUNK_SIZE;
	}

	return offsets;
})();

// Reusable array for getAllGroups to avoid per-frame allocation.
const _allGroupsReuse: MergedMeshGroup[] = [];

// Cached chunkOffsets array for non-merged meshes.
// Prevents per-frame Array.from.
export const PRECOMPUTED_CHUNK_OFFSETS_ARRAY = Array.from(_precomputedOffsets);

// ---------------------------------------------------------------------------
// Callback: notify ChunkMesher when a group's mesh needs vertex buffer update
// ---------------------------------------------------------------------------

export type GroupMeshRebuildCallback = (group: MergedMeshGroup) => void;

let _onGroupMeshNeedsRebuild: GroupMeshRebuildCallback | null = null;

export function setOnGroupMeshNeedsRebuild(cb: GroupMeshRebuildCallback): void {
	_onGroupMeshNeedsRebuild = cb;
}

function getLodRenderBucket(lod: number): number {
	if (lod <= 1) return 0;
	if (lod === 2) return 2;
	return 3;
}

/**
 * Pack (group grid coords, lod bucket) into a single number key. 10 bits per
 * axis with a +512 bias (group coords in [-512, 511] → chunk coords in
 * [-2048, 2047], the same ±512 domain the worker registries assume) plus 2
 * bits for the lod bucket. The result fits int32 exactly, so it stays a
 * small integer in V8 — much cheaper Map lookups than the old string key.
 */
function makeGroupKey(
	gx: number,
	gy: number,
	gz: number,
	lodBucket: number,
): number {
	return (gx + 512) * 1048576 + (gy + 512) * 4096 + (gz + 512) * 4 + lodBucket;
}

function getLocalIndex(chunkX: number, chunkY: number, chunkZ: number): number {
	const lx = chunkX & (GROUP_SIZE - 1);
	const ly = chunkY & (GROUP_SIZE - 1);
	const lz = chunkZ & (GROUP_SIZE - 1);

	return lx + (ly << 2) + (lz << 4);
}

// ---------------------------------------------------------------------------
// Public: group lookup
// ---------------------------------------------------------------------------

export function getGroupKeyForChunk(chunk: Chunk): number {
	return makeGroupKey(
		Math.floor(chunk.chunkX / GROUP_SIZE),
		Math.floor(chunk.chunkY / GROUP_SIZE),
		Math.floor(chunk.chunkZ / GROUP_SIZE),
		getLodRenderBucket(chunk.lodLevel ?? 0),
	);
}

export function getGroup(groupKey: number): MergedMeshGroup | undefined {
	return groups.get(groupKey);
}

export function getAllGroups(): MergedMeshGroup[] {
	_allGroupsReuse.length = 0;

	for (const group of groups.values()) {
		_allGroupsReuse.push(group);
	}

	return _allGroupsReuse;
}

// ---------------------------------------------------------------------------
// Public: data management
// ---------------------------------------------------------------------------

/**
 * Assign a chunk's mesh data to its merged group.
 * Returns the group, creating it if needed.
 * The group's cached vertex data is rebuilt from all members only when data
 * actually changes.
 */
export function assignChunkToGroup(
	chunk: Chunk,
	opaqueData: MeshData | null,
	waterData: MeshData | null,
	cutoutData: MeshData | null,
): MergedMeshGroup {
	const gx = Math.floor(chunk.chunkX / GROUP_SIZE);
	const gy = Math.floor(chunk.chunkY / GROUP_SIZE);
	const gz = Math.floor(chunk.chunkZ / GROUP_SIZE);

	const chunkLod = chunk.lodLevel ?? 0;
	const lodBucket = getLodRenderBucket(chunkLod);
	const groupKey = makeGroupKey(gx, gy, gz, lodBucket);

	if (chunk.mergedGroupKey !== null && chunk.mergedGroupKey !== groupKey) {
		removeChunkFromGroup(chunk);
	}

	let group = groups.get(groupKey);

	if (!group) {
		group = {
			groupKey,
			gridX: gx,
			gridY: gy,
			gridZ: gz,
			lodBucket,
			minLodLevel: chunkLod,
			members: new Map(),
			membersArray: [],
			totalOpaqueFaces: 0,
			totalWaterFaces: 0,
			totalCutoutFaces: 0,
			chunkOffsets: _precomputedOffsets,
			cachedOpaque: null,
			cachedWater: null,
			cachedCutout: null,

			opaqueCapacityFaces: 0,
			waterCapacityFaces: 0,
			cutoutCapacityFaces: 0,

			opaqueA: null,
			opaqueB: null,
			opaqueC: null,

			waterA: null,
			waterB: null,
			waterC: null,

			cutoutA: null,
			cutoutB: null,
			cutoutC: null,

			opaqueBuffers: null,
			waterBuffers: null,
			cutoutBuffers: null,

			opaqueVertexData: null,
			waterVertexData: null,
			cutoutVertexData: null,

			dirty: true,

			dirtyOpaqueRanges: null,
			dirtyWaterRanges: null,
			dirtyCutoutRanges: null,

			opaqueMeshRef: null,
			waterMeshRef: null,
			cutoutMeshRef: null,
		};

		groups.set(groupKey, group);
	}

	const existing = group.members.get(chunk.numericId);

	if (existing) {
		if (
			existing.opaqueData === opaqueData &&
			existing.waterData === waterData &&
			existing.cutoutData === cutoutData &&
			chunk.mergedGroupKey === groupKey
		) {
			return group;
		}

		existing.opaqueData = opaqueData;
		existing.waterData = waterData;
		existing.cutoutData = cutoutData;
	} else {
		const memberData: ChunkMemberData = {
			chunkId: chunk.numericId,
			chunk,
			opaqueData,
			waterData,
			cutoutData,
			localIndex: getLocalIndex(chunk.chunkX, chunk.chunkY, chunk.chunkZ),
			lastBuiltOpaque: null,
			lastBuiltWater: null,
			lastBuiltCutout: null,
			lastBuiltOpaqueOffset: -1,
			lastBuiltWaterOffset: -1,
			lastBuiltCutoutOffset: -1,
		};

		group.members.set(chunk.numericId, memberData);
		group.membersArray.push(memberData);
	}

	if (chunkLod < group.minLodLevel) {
		group.minLodLevel = chunkLod;
	}

	chunk.mergedGroupKey = groupKey;

	markGroupDirty(group);

	return group;
}

/**
 * Remove a chunk from its merged group.
 * Disposes the group if empty.
 */
export function removeChunkFromGroup(chunk: Chunk): void {
	const groupKey = chunk.mergedGroupKey;

	if (groupKey === null) return;

	const group = groups.get(groupKey);

	chunk.mergedGroupKey = null;

	if (!group) return;

	group.members.delete(chunk.numericId);

	if (group.members.size === 0) {
		if (group.opaqueMeshRef) {
			disposeGroupMesh(group.opaqueMeshRef);
			group.opaqueMeshRef = null;
		}

		if (group.waterMeshRef) {
			disposeGroupMesh(group.waterMeshRef);
			group.waterMeshRef = null;
		}

		if (group.cutoutMeshRef) {
			disposeGroupMesh(group.cutoutMeshRef);
			group.cutoutMeshRef = null;
		}

		groups.delete(groupKey);
		dirtyGroups.delete(group);

		return;
	}

	const arr = group.membersArray;
	let write = 0;
	let minLod = Infinity;
	const removedId = chunk.numericId;

	for (let i = 0, len = arr.length; i < len; i++) {
		const m = arr[i];

		if (m.chunkId === removedId) {
			continue;
		}

		arr[write++] = m;

		const lod = m.chunk.lodLevel ?? 0;
		if (lod < minLod) {
			minLod = lod;
		}
	}

	arr.length = write;
	group.minLodLevel = minLod;

	invalidateGroupBuildCache(group);
	markGroupDirty(group);
}

/**
 * Flush all pending group rebuilds.
 * Call once per frame/batch after assignChunkToGroup calls to avoid redundant
 * per-chunk rebuilds.
 */
// ─── Mesh-assembly timing (main-thread merged-group rebuild) ───────────────
// This is the dominant main-thread cost when chunks stream in: rebuildGroupData
// allocates/concatenates typed arrays and _onGroupMeshNeedsRebuild uploads them
// to GPU buffers. Exposed so the debug HUD can show it and so a future worker
// offload of mesh assembly can be measured against a baseline.
let _lastMergedFlushMs = 0;
let _mergedFlushTotalMs = 0;
let _mergedFlushCount = 0;

export function getMergedMeshFlushStats(): {
	lastMs: number;
	avgMs: number;
} {
	return {
		lastMs: _lastMergedFlushMs,
		avgMs: _mergedFlushCount > 0 ? _mergedFlushTotalMs / _mergedFlushCount : 0,
	};
}

let _mergedFlushRafScheduled = false;
const _flushSnapshot: MergedMeshGroup[] = [];

export function flushDirtyMergedGroups(): void {
	if (dirtyGroups.size === 0) return;

	const start = performance.now();
	const snapshot = _flushSnapshot;

	snapshot.length = 0;

	for (const group of dirtyGroups) {
		snapshot.push(group);
	}

	dirtyGroups.clear();

	let i = 0;
	let budgetExhausted = false;

	for (; i < snapshot.length; i++) {
		if (i !== 0 && performance.now() - start > 5) {
			budgetExhausted = true;
			break;
		}

		const group = snapshot[i];

		if (!group.dirty || groups.get(group.groupKey) !== group) {
			continue;
		}

		rebuildGroupData(group);
		_onGroupMeshNeedsRebuild?.(group);
	}

	if (budgetExhausted) {
		for (; i < snapshot.length; i++) {
			const group = snapshot[i];

			if (group.dirty && groups.get(group.groupKey) === group) {
				dirtyGroups.add(group);
			}
		}

		if (_requestFlush) {
			// Reuse the pool's centralized scheduler instead of creating another
			// zero-delay timer for the remaining dirty groups.
			_requestFlush();
		} else if (!_mergedFlushRafScheduled) {
			_mergedFlushRafScheduled = true;

			setTimeout(() => {
				_mergedFlushRafScheduled = false;
				flushDirtyMergedGroups();
			}, 0);
		}
	}

	const elapsed = performance.now() - start;

	_lastMergedFlushMs = elapsed;
	_mergedFlushTotalMs += elapsed;
	_mergedFlushCount++;
}

/**
 * Dispose all group data.
 * Call on world unload.
 */
export function disposeAll(): void {
	for (const group of groups.values()) {
		if (group.opaqueMeshRef) {
			disposeGroupMesh(group.opaqueMeshRef);
			group.opaqueMeshRef = null;
		}

		if (group.waterMeshRef) {
			disposeGroupMesh(group.waterMeshRef);
			group.waterMeshRef = null;
		}

		if (group.cutoutMeshRef) {
			disposeGroupMesh(group.cutoutMeshRef);
			group.cutoutMeshRef = null;
		}

		group.cachedOpaque = null;
		group.cachedWater = null;
		group.cachedCutout = null;

		group.opaqueA = null;
		group.opaqueB = null;
		group.opaqueC = null;
		group.opaqueBuffers = null;
		group.opaqueCapacityFaces = 0;

		group.waterA = null;
		group.waterB = null;
		group.waterC = null;
		group.waterBuffers = null;
		group.waterCapacityFaces = 0;

		group.cutoutA = null;
		group.cutoutB = null;
		group.cutoutC = null;
		group.cutoutBuffers = null;
		group.cutoutCapacityFaces = 0;

		group.members.clear();
		group.membersArray.length = 0;
	}

	groups.clear();
	dirtyGroups.clear();
}

// ---------------------------------------------------------------------------
// Internal: rebuild combined vertex data
// ---------------------------------------------------------------------------

function ensureOpaqueMergedCapacity(
	group: MergedMeshGroup,
	faceCount: number,
): MergedBuffers {
	let capacity = group.opaqueCapacityFaces;

	if (capacity < faceCount) {
		// Plain multiplication, NOT `<<`: a left shift is 32-bit and wraps
		// negative above 2^30, which would produce a bogus (possibly huge or
		// negative) byte length. Also clamp to the face-arena per-block
		// limit: a merged group above it can never be uploaded to the GPU
		// anyway, and this stops a corrupt faceCount from allocating
		// gigabytes of merged buffers.
		const maxFaces = maxFacesPerArena();
		capacity = Math.min(Math.max(faceCount, capacity * 2, 256), maxFaces);
		group.opaqueCapacityFaces = capacity;

		const byte4 = capacity * 4;

		const a = new Uint8Array(byte4);
		const b = new Uint8Array(byte4);
		const c = new Uint8Array(byte4);

		group.opaqueA = a;
		group.opaqueB = b;
		group.opaqueC = c;

		if (group.opaqueBuffers) {
			group.opaqueBuffers.a = a;
			group.opaqueBuffers.b = b;
			group.opaqueBuffers.c = c;
		} else {
			group.opaqueBuffers = { a, b, c };
		}
	}

	return group.opaqueBuffers!;
}

function ensureWaterMergedCapacity(
	group: MergedMeshGroup,
	faceCount: number,
): MergedBuffers {
	let capacity = group.waterCapacityFaces;

	if (capacity < faceCount) {
		// See ensureOpaqueMergedCapacity — same wrap/clamp rationale.
		const maxFaces = maxFacesPerArena();
		capacity = Math.min(Math.max(faceCount, capacity * 2, 256), maxFaces);
		group.waterCapacityFaces = capacity;

		const byte4 = capacity * 4;

		const a = new Uint8Array(byte4);
		const b = new Uint8Array(byte4);
		const c = new Uint8Array(byte4);

		group.waterA = a;
		group.waterB = b;
		group.waterC = c;

		if (group.waterBuffers) {
			group.waterBuffers.a = a;
			group.waterBuffers.b = b;
			group.waterBuffers.c = c;
		} else {
			group.waterBuffers = { a, b, c };
		}
	}

	return group.waterBuffers!;
}

function ensureCutoutMergedCapacity(
	group: MergedMeshGroup,
	faceCount: number,
): MergedBuffers {
	let capacity = group.cutoutCapacityFaces;

	if (capacity < faceCount) {
		// See ensureOpaqueMergedCapacity — same wrap/clamp rationale.
		const maxFaces = maxFacesPerArena();
		capacity = Math.min(Math.max(faceCount, capacity * 2, 256), maxFaces);
		group.cutoutCapacityFaces = capacity;

		const byte4 = capacity * 4;

		const a = new Uint8Array(byte4);
		const b = new Uint8Array(byte4);
		const c = new Uint8Array(byte4);

		group.cutoutA = a;
		group.cutoutB = b;
		group.cutoutC = c;

		if (group.cutoutBuffers) {
			group.cutoutBuffers.a = a;
			group.cutoutBuffers.b = b;
			group.cutoutBuffers.c = c;
		} else {
			group.cutoutBuffers = { a, b, c };
		}
	}

	return group.cutoutBuffers!;
}

// Returns the member's face count for `kind`, clamped to what its payload
// buffers actually hold. A stale/desynced MeshData (e.g. from the OPFS cache)
// can declare a faceCount wildly larger than its buffers — which would
// balloon the merged group and, downstream, OOM the packed-mesh
// instance-matrix buffer ("Array buffer allocation failed"). The buffer
// length is the ground truth: the packed mesh derives its face count from it
// too (faceDataA.length >>> 2).
function memberFaceCount(m: ChunkMemberData, kind: Meshkind): number {
	const data =
		kind === Meshkind.opaque
			? m.opaqueData
			: kind === Meshkind.water
				? m.waterData
				: m.cutoutData;
	if (!data) return 0;

	const raw = data.faceCount;
	const aLen = data.faceDataA.length;
	const bLen = data.faceDataB.length;
	const cLen = data.faceDataC.length;

	if (raw >= 0 && raw * 4 === aLen && aLen === bLen && aLen === cLen) {
		return raw;
	}

	const derived = Math.min(aLen, bLen, cLen) >>> 2;

	console.warn(
		`[MergedMeshManager] chunk #${m.chunkId} (lod ${m.chunk.lodLevel ?? 0}) ` +
			`${Meshkind[kind]} faceCount (${raw}) inconsistent with buffer lengths ` +
			`(${aLen}/${bLen}/${cLen} bytes) — using ${derived} instead.`,
	);

	return derived;
}

function rebuildGroupData(group: MergedMeshGroup): void {
	const members = group.membersArray;
	const memberCount = members.length;

	const prevOpaqueRanges = group.dirtyOpaqueRanges;
	if (prevOpaqueRanges) {
		for (let i = 0, len = prevOpaqueRanges.length; i < len; i++) {
			_rangePool.push(prevOpaqueRanges[i]);
		}
	}

	const prevWaterRanges = group.dirtyWaterRanges;
	if (prevWaterRanges) {
		for (let i = 0, len = prevWaterRanges.length; i < len; i++) {
			_rangePool.push(prevWaterRanges[i]);
		}
	}

	const prevCutoutRanges = group.dirtyCutoutRanges;
	if (prevCutoutRanges) {
		for (let i = 0, len = prevCutoutRanges.length; i < len; i++) {
			_rangePool.push(prevCutoutRanges[i]);
		}
	}

	group.dirtyOpaqueRanges ??= [];
	const opaqueRanges = group.dirtyOpaqueRanges;
	opaqueRanges.length = 0;

	group.dirtyWaterRanges ??= [];
	const waterRanges = group.dirtyWaterRanges;
	waterRanges.length = 0;

	group.dirtyCutoutRanges ??= [];
	const cutoutRanges = group.dirtyCutoutRanges;
	cutoutRanges.length = 0;

	let totalOpaque = 0;
	let totalWater = 0;
	let totalCutout = 0;

	// Count once, cache per-member counts, and reuse those counts in the copy
	// pass. This avoids repeated validation/logging and repeated buffer-length
	// reads for every dirty rebuild.
	for (let i = 0; i < memberCount; i++) {
		const m = members[i];

		const opaqueCount = m.opaqueData ? memberFaceCount(m, Meshkind.opaque) : 0;
		const waterCount = m.waterData ? memberFaceCount(m, Meshkind.water) : 0;
		const cutoutCount = m.cutoutData ? memberFaceCount(m, Meshkind.cutout) : 0;

		_opaqueFaceCounts[i] = opaqueCount;
		_waterFaceCounts[i] = waterCount;
		_cutoutFaceCounts[i] = cutoutCount;

		totalOpaque += opaqueCount;
		totalWater += waterCount;
		totalCutout += cutoutCount;
	}

	group.totalOpaqueFaces = totalOpaque;
	group.totalWaterFaces = totalWater;
	group.totalCutoutFaces = totalCutout;

	// A merged group must fit a single face-arena block per mesh to be
	// uploaded; above that allocFaces can never succeed. Refuse before
	// allocating gigabytes of merged buffers.
	const maxGroupFaces = maxFacesPerArena();
	if (
		totalOpaque > maxGroupFaces ||
		totalWater > maxGroupFaces ||
		totalCutout > maxGroupFaces
	) {
		console.warn(
			`[MergedMeshManager] group (${group.gridX}, ${group.gridY}, ` +
				`${group.gridZ}) lod bucket ${group.lodBucket} exceeds the ` +
				`per-mesh arena limit (opaque ${totalOpaque}, water ` +
				`${totalWater}, cutout ${totalCutout}, max ${maxGroupFaces} ` +
				`faces) — mesh rebuild skipped.`,
		);

		group.dirty = false;
		return;
	}

	const opaqueGrew = totalOpaque > group.opaqueCapacityFaces;
	const waterGrew = totalWater > group.waterCapacityFaces;
	const cutoutGrew = totalCutout > group.cutoutCapacityFaces;

	let opaqueA: Uint8Array | null = null;
	let opaqueB: Uint8Array | null = null;
	let opaqueC: Uint8Array | null = null;

	let waterA: Uint8Array | null = null;
	let waterB: Uint8Array | null = null;
	let waterC: Uint8Array | null = null;

	let cutoutA: Uint8Array | null = null;
	let cutoutB: Uint8Array | null = null;
	let cutoutC: Uint8Array | null = null;

	if (totalOpaque > 0) {
		const buffers = ensureOpaqueMergedCapacity(group, totalOpaque);
		opaqueA = buffers.a;
		opaqueB = buffers.b;
		opaqueC = buffers.c;

		if (opaqueGrew) {
			for (let i = 0; i < memberCount; i++) {
				const m = members[i];
				m.lastBuiltOpaque = null;
				m.lastBuiltOpaqueOffset = -1;
			}
		}
	} else {
		group.cachedOpaque = null;
	}

	if (totalWater > 0) {
		const buffers = ensureWaterMergedCapacity(group, totalWater);
		waterA = buffers.a;
		waterB = buffers.b;
		waterC = buffers.c;

		if (waterGrew) {
			for (let i = 0; i < memberCount; i++) {
				const m = members[i];
				m.lastBuiltWater = null;
				m.lastBuiltWaterOffset = -1;
			}
		}
	} else {
		group.cachedWater = null;
	}

	if (totalCutout > 0) {
		const buffers = ensureCutoutMergedCapacity(group, totalCutout);
		cutoutA = buffers.a;
		cutoutB = buffers.b;
		cutoutC = buffers.c;

		if (cutoutGrew) {
			for (let i = 0; i < memberCount; i++) {
				const m = members[i];
				m.lastBuiltCutout = null;
				m.lastBuiltCutoutOffset = -1;
			}
		}
	} else {
		group.cachedCutout = null;
	}

	let opaqueWriteByte = 0;
	let opaqueWriteFace = 0;

	let waterWriteByte = 0;
	let waterWriteFace = 0;

	let cutoutWriteByte = 0;
	let cutoutWriteFace = 0;

	for (let i = 0; i < memberCount; i++) {
		const m = members[i];

		const opaque = m.opaqueData;
		const opaqueFaceCount = _opaqueFaceCounts[i];

		if (opaque && opaqueFaceCount > 0) {
			const byteCount = opaqueFaceCount * 4;

			if (
				m.lastBuiltOpaque !== opaque ||
				m.lastBuiltOpaqueOffset !== opaqueWriteByte
			) {
				copyFaceBytes(opaqueA!, opaque.faceDataA, byteCount, opaqueWriteByte);
				copyFaceBytes(opaqueB!, opaque.faceDataB, byteCount, opaqueWriteByte);
				copyFaceBytes(opaqueC!, opaque.faceDataC, byteCount, opaqueWriteByte);

				const ci = m.localIndex;

				if (ci !== 0) {
					for (
						let k = opaqueWriteByte + 3, end = opaqueWriteByte + byteCount;
						k < end;
						k += 4
					) {
						opaqueC![k] |= ci;
					}
				}

				m.lastBuiltOpaque = opaque;
				m.lastBuiltOpaqueOffset = opaqueWriteByte;

				pushDirtyRange(opaqueRanges, opaqueWriteFace, opaqueFaceCount);
			}

			opaqueWriteByte += byteCount;
			opaqueWriteFace += opaqueFaceCount;
		}

		const water = m.waterData;
		const waterFaceCount = _waterFaceCounts[i];

		if (water && waterFaceCount > 0) {
			const byteCount = waterFaceCount * 4;

			if (
				m.lastBuiltWater !== water ||
				m.lastBuiltWaterOffset !== waterWriteByte
			) {
				copyFaceBytes(waterA!, water.faceDataA, byteCount, waterWriteByte);
				copyFaceBytes(waterB!, water.faceDataB, byteCount, waterWriteByte);
				copyFaceBytes(waterC!, water.faceDataC, byteCount, waterWriteByte);

				const ci = m.localIndex;

				if (ci !== 0) {
					for (
						let k = waterWriteByte + 3, end = waterWriteByte + byteCount;
						k < end;
						k += 4
					) {
						waterC![k] |= ci;
					}
				}

				m.lastBuiltWater = water;
				m.lastBuiltWaterOffset = waterWriteByte;

				pushDirtyRange(waterRanges, waterWriteFace, waterFaceCount);
			}

			waterWriteByte += byteCount;
			waterWriteFace += waterFaceCount;
		}

		const cutout = m.cutoutData;
		const cutoutFaceCount = _cutoutFaceCounts[i];

		if (cutout && cutoutFaceCount > 0) {
			const byteCount = cutoutFaceCount * 4;

			if (
				m.lastBuiltCutout !== cutout ||
				m.lastBuiltCutoutOffset !== cutoutWriteByte
			) {
				copyFaceBytes(cutoutA!, cutout.faceDataA, byteCount, cutoutWriteByte);
				copyFaceBytes(cutoutB!, cutout.faceDataB, byteCount, cutoutWriteByte);
				copyFaceBytes(cutoutC!, cutout.faceDataC, byteCount, cutoutWriteByte);

				const ci = m.localIndex;

				if (ci !== 0) {
					for (
						let k = cutoutWriteByte + 3, end = cutoutWriteByte + byteCount;
						k < end;
						k += 4
					) {
						cutoutC![k] |= ci;
					}
				}

				m.lastBuiltCutout = cutout;
				m.lastBuiltCutoutOffset = cutoutWriteByte;

				pushDirtyRange(cutoutRanges, cutoutWriteFace, cutoutFaceCount);
			}

			cutoutWriteByte += byteCount;
			cutoutWriteFace += cutoutFaceCount;
		}
	}

	if (totalOpaque > 0) {
		const totalBytes = totalOpaque * 4;

		if (!group.opaqueVertexData) {
			group.opaqueVertexData = {
				faceDataA: new Uint8Array(0),
				faceDataB: new Uint8Array(0),
				faceDataC: new Uint8Array(0),
				faceCount: 0,
			};
		}

		const vd = group.opaqueVertexData;

		vd.faceDataA =
			opaqueA!.length === totalBytes
				? opaqueA!
				: opaqueA!.subarray(0, totalBytes);
		vd.faceDataB =
			opaqueB!.length === totalBytes
				? opaqueB!
				: opaqueB!.subarray(0, totalBytes);
		vd.faceDataC =
			opaqueC!.length === totalBytes
				? opaqueC!
				: opaqueC!.subarray(0, totalBytes);
		vd.faceCount = totalOpaque;

		group.cachedOpaque = vd;
	}

	if (totalWater > 0) {
		const totalBytes = totalWater * 4;

		if (!group.waterVertexData) {
			group.waterVertexData = {
				faceDataA: new Uint8Array(0),
				faceDataB: new Uint8Array(0),
				faceDataC: new Uint8Array(0),
				faceCount: 0,
			};
		}

		const vd = group.waterVertexData;

		vd.faceDataA =
			waterA!.length === totalBytes ? waterA! : waterA!.subarray(0, totalBytes);
		vd.faceDataB =
			waterB!.length === totalBytes ? waterB! : waterB!.subarray(0, totalBytes);
		vd.faceDataC =
			waterC!.length === totalBytes ? waterC! : waterC!.subarray(0, totalBytes);
		vd.faceCount = totalWater;

		group.cachedWater = vd;
	}

	if (totalCutout > 0) {
		const totalBytes = totalCutout * 4;

		if (!group.cutoutVertexData) {
			group.cutoutVertexData = {
				faceDataA: new Uint8Array(0),
				faceDataB: new Uint8Array(0),
				faceDataC: new Uint8Array(0),
				faceCount: 0,
			};
		}

		const vd = group.cutoutVertexData;

		vd.faceDataA =
			cutoutA!.length === totalBytes
				? cutoutA!
				: cutoutA!.subarray(0, totalBytes);
		vd.faceDataB =
			cutoutB!.length === totalBytes
				? cutoutB!
				: cutoutB!.subarray(0, totalBytes);
		vd.faceDataC =
			cutoutC!.length === totalBytes
				? cutoutC!
				: cutoutC!.subarray(0, totalBytes);
		vd.faceCount = totalCutout;

		group.cachedCutout = vd;
	}

	group.dirty = false;
}
