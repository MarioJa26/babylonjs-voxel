import type { Mesh } from "@babylonjs/lite";
import { CHUNK_SIZE } from "@/code/Lib/VoxelMath";
import type { Chunk } from "./Chunk";
import type { MeshData } from "./DataStructures/MeshData";
import { disposePackedMesh } from "./PackedChunkMesh.js";

// Lite `Mesh` has no `.dispose()` — free its packed-arena slices, unregister
// from the scene, then free GPU resources.
function disposeGroupMesh(mesh: Mesh): void {
	if (!mesh) return;
	disposePackedMesh(mesh);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChunkMemberData {
	chunkId: number;
	chunk: Chunk;
	opaqueData: MeshData | null;
	transparentData: MeshData | null;
	localIndex: number; // 0-63 within the group
	// `lastBuilt*` records the MeshData reference we last copied into the
	// merged buffer for this member. On a group rebuild we skip re-copying a
	// member whose data reference is unchanged — its bytes are already in the
	// merged buffer at the same deterministic offset, so re-copying all 64
	// members (incl. the 63 that didn't remesh) is pure waste. Relight-only
	// updates hand a *new* MeshData to just the changed chunk, so only that
	// one member's reference differs and gets re-copied (up to 63x cheaper).
	lastBuiltOpaque: MeshData | null;
	lastBuiltTransparent: MeshData | null;
	// The writeByte offset each was copied at. A member is only safe to
	// skip when BOTH its data reference AND its target offset are unchanged
	// from last rebuild — an earlier member's face-count change shifts every
	// later member's offset even if that later member itself didn't remesh.
	lastBuiltOpaqueOffset: number;
	lastBuiltTransparentOffset: number;
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
	totalTransparentFaces: number;
	chunkOffsets: Float32Array; // 64 * 3 = 192 floats
	cachedOpaque: MergedVertexData | null;
	cachedTransparent: MergedVertexData | null;

	opaqueCapacityFaces: number;
	transparentCapacityFaces: number;

	opaqueA: Uint8Array | null;
	opaqueB: Uint8Array | null;
	opaqueC: Uint8Array | null;

	transparentA: Uint8Array | null;
	transparentB: Uint8Array | null;
	transparentC: Uint8Array | null;

	// Cached wrappers to avoid allocating `{ a, b, c }` every rebuild.
	opaqueBuffers: MergedBuffers | null;
	transparentBuffers: MergedBuffers | null;

	// Cached vertex data wrappers to avoid allocating new objects every rebuild.
	opaqueVertexData: MergedVertexData | null;
	transparentVertexData: MergedVertexData | null;

	dirty: boolean;

	// Face ranges (merged-face coordinates) that changed on the most recent
	// rebuildGroupData pass. Consumed by the packed-mesh updater so it can
	// re-pack + re-upload only the members that actually remeshed instead of
	// the whole merged group. Cleared/regenerated on every rebuild.
	dirtyOpaqueRanges: MergedFaceRange[] | null;
	dirtyTransparentRanges: MergedFaceRange[] | null;

	// Mesh references — set by ChunkMesher.ts after creating/updating.
	// These are NOT owned by MergedMeshManager; ownership stays with ChunkMesher.
	opaqueMeshRef: any | null;
	transparentMeshRef: any | null;
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

// Invalidate the per-member "already built" cache. Must be called whenever
// the merged-buffer layout can change independent of member data references:
// member add/remove (membersArray order/offset shifts) or merged-buffer
// reallocation. Pure reassigns of an existing member (the relight path) do
// NOT call this, so unchanged members keep their skip-eligibility.
function invalidateGroupBuildCache(group: MergedMeshGroup): void {
	for (const m of group.membersArray) {
		m.lastBuiltOpaque = null;
		m.lastBuiltTransparent = null;
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
	transparentData: MeshData | null,
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
			totalTransparentFaces: 0,
			chunkOffsets: _precomputedOffsets,
			cachedOpaque: null,
			cachedTransparent: null,

			opaqueCapacityFaces: 0,
			transparentCapacityFaces: 0,

			opaqueA: null,
			opaqueB: null,
			opaqueC: null,

			transparentA: null,
			transparentB: null,
			transparentC: null,

			opaqueBuffers: null,
			transparentBuffers: null,

			opaqueVertexData: null,
			transparentVertexData: null,

			dirty: true,

			dirtyOpaqueRanges: null,
			dirtyTransparentRanges: null,

			opaqueMeshRef: null,
			transparentMeshRef: null,
		};

		groups.set(groupKey, group);
	}

	const existing = group.members.get(chunk.numericId);

	if (existing) {
		if (
			existing.opaqueData === opaqueData &&
			existing.transparentData === transparentData &&
			chunk.mergedGroupKey === groupKey
		) {
			return group;
		}

		existing.opaqueData = opaqueData;
		existing.transparentData = transparentData;
	} else {
		const memberData: ChunkMemberData = {
			chunkId: chunk.numericId,
			chunk,
			opaqueData,
			transparentData,
			localIndex: getLocalIndex(chunk.chunkX, chunk.chunkY, chunk.chunkZ),
			lastBuiltOpaque: null,
			lastBuiltTransparent: null,
			lastBuiltOpaqueOffset: -1,
			lastBuiltTransparentOffset: -1,
		};

		group.members.set(chunk.numericId, memberData);
		group.membersArray.push(memberData);

		invalidateGroupBuildCache(group);
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

	if (!groupKey) return;

	const group = groups.get(groupKey);

	chunk.mergedGroupKey = null;

	if (!group) return;

	group.members.delete(chunk.numericId);

	if (group.members.size === 0) {
		if (group.opaqueMeshRef) {
			disposeGroupMesh(group.opaqueMeshRef);
			group.opaqueMeshRef = null;
		}

		if (group.transparentMeshRef) {
			disposeGroupMesh(group.transparentMeshRef);
			group.transparentMeshRef = null;
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

		if (!_mergedFlushRafScheduled) {
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

		if (group.transparentMeshRef) {
			disposeGroupMesh(group.transparentMeshRef);
			group.transparentMeshRef = null;
		}

		group.cachedOpaque = null;
		group.cachedTransparent = null;

		group.opaqueA = null;
		group.opaqueB = null;
		group.opaqueC = null;
		group.opaqueBuffers = null;
		group.opaqueCapacityFaces = 0;

		group.transparentA = null;
		group.transparentB = null;
		group.transparentC = null;
		group.transparentBuffers = null;
		group.transparentCapacityFaces = 0;

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
		capacity = Math.max(faceCount, capacity << 1, 256);
		group.opaqueCapacityFaces = capacity;

		const byte4 = capacity << 2;

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

function ensureTransparentMergedCapacity(
	group: MergedMeshGroup,
	faceCount: number,
): MergedBuffers {
	let capacity = group.transparentCapacityFaces;

	if (capacity < faceCount) {
		capacity = Math.max(faceCount, capacity << 1, 256);
		group.transparentCapacityFaces = capacity;

		const byte4 = capacity << 2;

		const a = new Uint8Array(byte4);
		const b = new Uint8Array(byte4);
		const c = new Uint8Array(byte4);

		group.transparentA = a;
		group.transparentB = b;
		group.transparentC = c;

		if (group.transparentBuffers) {
			group.transparentBuffers.a = a;
			group.transparentBuffers.b = b;
			group.transparentBuffers.c = c;
		} else {
			group.transparentBuffers = { a, b, c };
		}
	}

	return group.transparentBuffers!;
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

	const prevTransparentRanges = group.dirtyTransparentRanges;
	if (prevTransparentRanges) {
		for (let i = 0, len = prevTransparentRanges.length; i < len; i++) {
			_rangePool.push(prevTransparentRanges[i]);
		}
	}

	group.dirtyOpaqueRanges ??= [];
	const opaqueRanges = group.dirtyOpaqueRanges;
	opaqueRanges.length = 0;

	group.dirtyTransparentRanges ??= [];
	const transparentRanges = group.dirtyTransparentRanges;
	transparentRanges.length = 0;

	let totalOpaque = 0;
	let totalTransparent = 0;

	for (let i = 0; i < memberCount; i++) {
		const m = members[i];
		const opaque = m.opaqueData;
		const transparent = m.transparentData;

		if (opaque) totalOpaque += opaque.faceCount;
		if (transparent) totalTransparent += transparent.faceCount;
	}

	group.totalOpaqueFaces = totalOpaque;
	group.totalTransparentFaces = totalTransparent;

	const opaqueGrew = totalOpaque > group.opaqueCapacityFaces;
	const transparentGrew = totalTransparent > group.transparentCapacityFaces;

	let opaqueA: Uint8Array | null = null;
	let opaqueB: Uint8Array | null = null;
	let opaqueC: Uint8Array | null = null;

	let transparentA: Uint8Array | null = null;
	let transparentB: Uint8Array | null = null;
	let transparentC: Uint8Array | null = null;

	if (totalOpaque > 0) {
		const buffers = ensureOpaqueMergedCapacity(group, totalOpaque);
		opaqueA = buffers.a;
		opaqueB = buffers.b;
		opaqueC = buffers.c;

		if (opaqueGrew) {
			for (let i = 0; i < memberCount; i++) {
				members[i].lastBuiltOpaque = null;
			}
		}
	} else {
		group.cachedOpaque = null;
	}

	if (totalTransparent > 0) {
		const buffers = ensureTransparentMergedCapacity(group, totalTransparent);
		transparentA = buffers.a;
		transparentB = buffers.b;
		transparentC = buffers.c;

		if (transparentGrew) {
			for (let i = 0; i < memberCount; i++) {
				members[i].lastBuiltTransparent = null;
			}
		}
	} else {
		group.cachedTransparent = null;
	}

	let opaqueWriteByte = 0;
	let opaqueWriteFace = 0;

	let transparentWriteByte = 0;
	let transparentWriteFace = 0;

	for (let i = 0; i < memberCount; i++) {
		const m = members[i];

		const opaque = m.opaqueData;
		if (opaque) {
			const fc = opaque.faceCount;

			if (fc > 0) {
				const byteCount = fc << 2;

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

					pushDirtyRange(opaqueRanges, opaqueWriteFace, fc);
				}

				opaqueWriteByte += byteCount;
				opaqueWriteFace += fc;
			}
		}

		const transparent = m.transparentData;
		if (transparent) {
			const fc = transparent.faceCount;

			if (fc > 0) {
				const byteCount = fc << 2;

				if (
					m.lastBuiltTransparent !== transparent ||
					m.lastBuiltTransparentOffset !== transparentWriteByte
				) {
					copyFaceBytes(
						transparentA!,
						transparent.faceDataA,
						byteCount,
						transparentWriteByte,
					);
					copyFaceBytes(
						transparentB!,
						transparent.faceDataB,
						byteCount,
						transparentWriteByte,
					);
					copyFaceBytes(
						transparentC!,
						transparent.faceDataC,
						byteCount,
						transparentWriteByte,
					);

					const ci = m.localIndex;

					if (ci !== 0) {
						for (
							let k = transparentWriteByte + 3,
								end = transparentWriteByte + byteCount;
							k < end;
							k += 4
						) {
							transparentC![k] |= ci;
						}
					}

					m.lastBuiltTransparent = transparent;
					m.lastBuiltTransparentOffset = transparentWriteByte;

					pushDirtyRange(transparentRanges, transparentWriteFace, fc);
				}

				transparentWriteByte += byteCount;
				transparentWriteFace += fc;
			}
		}
	}

	if (totalOpaque > 0) {
		const totalBytes = totalOpaque << 2;

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

	if (totalTransparent > 0) {
		const totalBytes = totalTransparent << 2;

		if (!group.transparentVertexData) {
			group.transparentVertexData = {
				faceDataA: new Uint8Array(0),
				faceDataB: new Uint8Array(0),
				faceDataC: new Uint8Array(0),
				faceCount: 0,
			};
		}

		const vd = group.transparentVertexData;

		vd.faceDataA =
			transparentA!.length === totalBytes
				? transparentA!
				: transparentA!.subarray(0, totalBytes);
		vd.faceDataB =
			transparentB!.length === totalBytes
				? transparentB!
				: transparentB!.subarray(0, totalBytes);
		vd.faceDataC =
			transparentC!.length === totalBytes
				? transparentC!
				: transparentC!.subarray(0, totalBytes);
		vd.faceCount = totalTransparent;

		group.cachedTransparent = vd;
	}

	group.dirty = false;
}
