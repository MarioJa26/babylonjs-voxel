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
	chunkId: bigint;
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
	chunkIndex: Uint8Array;
	faceCount: number;
}

interface MergedBuffers {
	a: Uint8Array;
	b: Uint8Array;
	c: Uint8Array;
	d: Uint8Array;
}

export interface MergedMeshGroup {
	groupKey: string;
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
	members: Map<bigint, ChunkMemberData>;
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
	opaqueD: Uint8Array | null;

	transparentA: Uint8Array | null;
	transparentB: Uint8Array | null;
	transparentC: Uint8Array | null;
	transparentD: Uint8Array | null;

	// Cached wrappers to avoid allocating `{ a, b, c, d }` every rebuild.
	opaqueBuffers: MergedBuffers | null;
	transparentBuffers: MergedBuffers | null;

	// Cached vertex data wrappers to avoid allocating new objects every rebuild.
	opaqueVertexData: MergedVertexData | null;
	transparentVertexData: MergedVertexData | null;

	dirty: boolean;

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

const groups = new Map<string, MergedMeshGroup>();
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

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

// Reused across calls — getGroupGridCoords is synchronous and never
// re-entrant (no call site invokes it again before consuming the result),
// so a single scratch object avoids an allocation on every chunk
// assign/lookup instead of a fresh `{ gx, gy, gz }` literal each time.
const _gridCoordsScratch = { gx: 0, gy: 0, gz: 0 };

function getGroupGridCoords(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
): { gx: number; gy: number; gz: number } {
	_gridCoordsScratch.gx = Math.floor(chunkX / GROUP_SIZE);
	_gridCoordsScratch.gy = Math.floor(chunkY / GROUP_SIZE);
	_gridCoordsScratch.gz = Math.floor(chunkZ / GROUP_SIZE);
	return _gridCoordsScratch;
}

function getLodRenderBucket(lod: number): number {
	if (lod <= 1) return 0;
	if (lod === 2) return 2;
	return 3;
}

function makeGroupKey(
	gx: number,
	gy: number,
	gz: number,
	lodBucket: number,
): string {
	return `${gx}_${gy}_${gz}_${lodBucket}`;
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

export function getGroupKeyForChunk(chunk: Chunk): string {
	const { gx, gy, gz } = getGroupGridCoords(
		chunk.chunkX,
		chunk.chunkY,
		chunk.chunkZ,
	);

	const lodBucket = getLodRenderBucket(chunk.lodLevel ?? 0);

	return makeGroupKey(gx, gy, gz, lodBucket);
}

export function getGroup(groupKey: string): MergedMeshGroup | undefined {
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
	const groupKey = getGroupKeyForChunk(chunk);

	// If LOD bucket changed, remove stale faces from the old merged mesh first.
	if (chunk.mergedGroupKey && chunk.mergedGroupKey !== groupKey) {
		removeChunkFromGroup(chunk);
	}

	let group = groups.get(groupKey);

	if (!group) {
		const { gx, gy, gz } = getGroupGridCoords(
			chunk.chunkX,
			chunk.chunkY,
			chunk.chunkZ,
		);

		const chunkLod = chunk.lodLevel ?? 0;
		const lodBucket = getLodRenderBucket(chunkLod);

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
			opaqueD: null,

			transparentA: null,
			transparentB: null,
			transparentC: null,
			transparentD: null,

			opaqueBuffers: null,
			transparentBuffers: null,

			opaqueVertexData: null,
			transparentVertexData: null,

			dirty: true,

			opaqueMeshRef: null,
			transparentMeshRef: null,
		};

		groups.set(groupKey, group);
	}

	const localIndex = getLocalIndex(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
	const chunkLod = chunk.lodLevel ?? 0;

	const existing = group.members.get(chunk.id);

	if (existing) {
		const dataUnchanged =
			existing.opaqueData === opaqueData &&
			existing.transparentData === transparentData;

		if (dataUnchanged && chunk.mergedGroupKey === groupKey) {
			return group;
		} else {
			existing.opaqueData = opaqueData;
			existing.transparentData = transparentData;
		}
	} else {
		const memberData: ChunkMemberData = {
			chunkId: chunk.id,
			chunk,
			opaqueData,
			transparentData,
			localIndex,
			lastBuiltOpaque: null,
			lastBuiltTransparent: null,
			lastBuiltOpaqueOffset: -1,
			lastBuiltTransparentOffset: -1,
		};

		group.members.set(chunk.id, memberData);
		group.membersArray.push(memberData);
		// New member changes layout (offset of later members shifts), so the
		// "already built" cache is no longer valid — force a full rebuild.
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

	group.members.delete(chunk.id);

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

	// Compact membersArray without allocating a replacement array.
	const arr = group.membersArray;
	let w = 0;

	for (let i = 0, len = arr.length; i < len; i++) {
		const m = arr[i];

		if (m.chunkId !== chunk.id) {
			arr[w++] = m;
		}
	}

	arr.length = w;

	let minLod = Infinity;

	for (let i = 0; i < w; i++) {
		const lod = arr[i]?.chunk.lodLevel ?? 0;

		if (lod < minLod) {
			minLod = lod;
		}
	}

	group.minLodLevel = minLod;

	// Removal shifts membersArray order, so previously-skipped members'
	// bytes are now at the wrong offset. Force a full rebuild once.
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

export function flushDirtyMergedGroups(): void {
	if (dirtyGroups.size === 0) return;

	const _start = performance.now();
	for (const group of dirtyGroups) {
		if (!groups.has(group.groupKey)) continue;
		if (!group.dirty) continue;

		rebuildGroupData(group);

		_onGroupMeshNeedsRebuild?.(group);
	}

	dirtyGroups.clear();

	const _elapsed = performance.now() - _start;
	_lastMergedFlushMs = _elapsed;
	_mergedFlushTotalMs += _elapsed;
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
		group.opaqueD = null;
		group.opaqueBuffers = null;
		group.opaqueCapacityFaces = 0;

		group.transparentA = null;
		group.transparentB = null;
		group.transparentC = null;
		group.transparentD = null;
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
		capacity = Math.max(faceCount, capacity * 2, 256);
		group.opaqueCapacityFaces = capacity;

		const byte4 = capacity << 2;

		const a = new Uint8Array(byte4);
		const b = new Uint8Array(byte4);
		const c = new Uint8Array(byte4);
		const d = new Uint8Array(capacity);

		group.opaqueA = a;
		group.opaqueB = b;
		group.opaqueC = c;
		group.opaqueD = d;

		group.opaqueBuffers = { a, b, c, d };
	}

	return group.opaqueBuffers!;
}

function ensureTransparentMergedCapacity(
	group: MergedMeshGroup,
	faceCount: number,
): MergedBuffers {
	let capacity = group.transparentCapacityFaces;

	if (capacity < faceCount) {
		capacity = Math.max(faceCount, capacity * 2, 256);
		group.transparentCapacityFaces = capacity;

		const byte4 = capacity << 2;

		const a = new Uint8Array(byte4);
		const b = new Uint8Array(byte4);
		const c = new Uint8Array(byte4);
		const d = new Uint8Array(capacity);

		group.transparentA = a;
		group.transparentB = b;
		group.transparentC = c;
		group.transparentD = d;

		group.transparentBuffers = { a, b, c, d };
	}

	return group.transparentBuffers!;
}

function rebuildGroupData(group: MergedMeshGroup): void {
	const members = group.membersArray;
	const memberCount = members.length;

	// Single pass to compute both totals instead of scanning membersArray
	// twice (once per face-data kind). Member count is bounded at 64, so
	// this isn't about a single rebuild being slow — it's a free win with
	// no tradeoff, and better cache locality since opaqueData and
	// transparentData live on the same member object.
	let totalOpaque = 0;
	let totalTransparent = 0;

	for (let i = 0; i < memberCount; i++) {
		const m = members[i];
		if (m.opaqueData) totalOpaque += m.opaqueData.faceCount;
		if (m.transparentData) totalTransparent += m.transparentData.faceCount;
	}

	group.totalOpaqueFaces = totalOpaque;
	group.totalTransparentFaces = totalTransparent;

	// -----------------------------------------------------------------------
	// Opaque
	// -----------------------------------------------------------------------

	if (totalOpaque > 0) {
		// ensure* reallocates (discarding old bytes) only when capacity grows.
		// Detect that and force a full opaque re-copy so skipped members
		// don't keep referencing lost byte ranges.
		const opaqueGrew = totalOpaque > group.opaqueCapacityFaces;
		const buffers = ensureOpaqueMergedCapacity(group, totalOpaque);
		if (opaqueGrew) {
			for (const m of members) m.lastBuiltOpaque = null;
		}

		const mergedA = buffers.a;
		const mergedB = buffers.b;
		const mergedC = buffers.c;
		const mergedD = buffers.d;

		let writeByte = 0;
		let writeFace = 0;

		for (let i = 0; i < memberCount; i++) {
			const m = members[i];
			const data = m.opaqueData;

			if (!data) continue;

			const fc = data.faceCount;

			if (fc === 0) continue;

			const byteCount = fc << 2;

			// Geometry-stable skip: if this member's opaque data is the exact
			// same reference we last copied into the merged buffer, its bytes
			// are already in place at this deterministic offset — re-copying
			// is pure waste. Only the members that actually remeshed this
			// pass (incl. relit ones, which get a fresh MeshData) are
			// re-copied. This is the dominant cost on relight-only updates
			// (the other up-to-63 members are skipped in place).
			if (m.lastBuiltOpaque !== data || m.lastBuiltOpaqueOffset !== writeByte) {
				copyFaceBytes(mergedA, data.faceDataA, byteCount, writeByte);
				copyFaceBytes(mergedB, data.faceDataB, byteCount, writeByte);
				copyFaceBytes(mergedC, data.faceDataC, byteCount, writeByte);
				m.lastBuiltOpaque = data;
				m.lastBuiltOpaqueOffset = writeByte;
			}

			mergedD.fill(m.localIndex, writeFace, writeFace + fc);

			writeByte += byteCount;
			writeFace += fc;
		}

		const totalBytes = totalOpaque << 2;

		if (!group.opaqueVertexData) {
			group.opaqueVertexData = {
				faceDataA: new Uint8Array(0),
				faceDataB: new Uint8Array(0),
				faceDataC: new Uint8Array(0),
				chunkIndex: new Uint8Array(0),
				faceCount: 0,
			};
		}
		const vd = group.opaqueVertexData;
		vd.faceDataA = mergedA.subarray(0, totalBytes);
		vd.faceDataB = mergedB.subarray(0, totalBytes);
		vd.faceDataC = mergedC.subarray(0, totalBytes);
		vd.chunkIndex = mergedD.subarray(0, totalOpaque);
		vd.faceCount = totalOpaque;
		group.cachedOpaque = vd;
	} else {
		group.cachedOpaque = null;
	}

	// -----------------------------------------------------------------------
	// Transparent
	// -----------------------------------------------------------------------

	if (totalTransparent > 0) {
		const transparentGrew = totalTransparent > group.transparentCapacityFaces;
		const buffers = ensureTransparentMergedCapacity(group, totalTransparent);
		if (transparentGrew) {
			for (const m of members) m.lastBuiltTransparent = null;
		}

		const mergedA = buffers.a;
		const mergedB = buffers.b;
		const mergedC = buffers.c;
		const mergedD = buffers.d;

		let writeByte = 0;
		let writeFace = 0;

		for (let i = 0; i < memberCount; i++) {
			const m = members[i];
			const data = m.transparentData;

			if (!data) continue;

			const fc = data.faceCount;

			if (fc === 0) continue;

			const byteCount = fc << 2;

			if (
				m.lastBuiltTransparent !== data ||
				m.lastBuiltTransparentOffset !== writeByte
			) {
				copyFaceBytes(mergedA, data.faceDataA, byteCount, writeByte);
				copyFaceBytes(mergedB, data.faceDataB, byteCount, writeByte);
				copyFaceBytes(mergedC, data.faceDataC, byteCount, writeByte);
				m.lastBuiltTransparent = data;
				m.lastBuiltTransparentOffset = writeByte;
			}

			mergedD.fill(m.localIndex, writeFace, writeFace + fc);

			writeByte += byteCount;
			writeFace += fc;
		}

		const totalBytes = totalTransparent << 2;

		if (!group.transparentVertexData) {
			group.transparentVertexData = {
				faceDataA: new Uint8Array(0),
				faceDataB: new Uint8Array(0),
				faceDataC: new Uint8Array(0),
				chunkIndex: new Uint8Array(0),
				faceCount: 0,
			};
		}
		const vd = group.transparentVertexData;
		vd.faceDataA = mergedA.subarray(0, totalBytes);
		vd.faceDataB = mergedB.subarray(0, totalBytes);
		vd.faceDataC = mergedC.subarray(0, totalBytes);
		vd.chunkIndex = mergedD.subarray(0, totalTransparent);
		vd.faceCount = totalTransparent;
		group.cachedTransparent = vd;
	} else {
		group.cachedTransparent = null;
	}

	group.dirty = false;
}
