import type { Mesh } from "@babylonjs/lite";
import { CHUNK_SIZE } from "@/code/Lib/VoxelMath";
import type { Chunk } from "./Chunk";
import type { MeshData } from "./DataStructures/MeshData";
import { disposePackedMesh, maxFacesPerArena } from "./PackedChunkMesh.js";

// Lite `Mesh` has no `.dispose()` â€” free its packed-arena slices, unregister
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
	waterData: MeshData | null;
	cutoutData: MeshData | null;
	localIndex: number; // 0-63 within the group
	lastBuiltOpaque: MeshData | null;
	lastBuiltWater: MeshData | null;
	lastBuiltCutout: MeshData | null;
	lastBuiltOpaqueOffset: number;
	lastBuiltWaterOffset: number;
	lastBuiltCutoutOffset: number;
	// Stable per-layer slot regions (in merged-FACE units). Offsets only move
	// when the member's own slot class changes â€” never because a NEIGHBOR
	// resized â€” so content-only rebuilds skip the copy entirely.
	slotOpaqueOffset: number;
	slotOpaqueFaces: number;
	slotWaterOffset: number;
	slotWaterFaces: number;
	slotCutoutOffset: number;
	slotCutoutFaces: number;
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

interface SlotHole {
	offset: number; // in merged faces
	faces: number;
}

interface SlotLayerState {
	/** Sorted-by-offset free regions available for slot reuse. */
	holes: SlotHole[];
	/** Regions freed by member removal, awaiting zero+upload at next rebuild. */
	released: SlotHole[];
	/** High-water extent of all slot regions (used + holes + released). */
	appendedFaces: number;
}

export interface MergedMeshGroup {
	groupKey: number;
	gridX: number;
	gridY: number;
	gridZ: number;
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

	opaqueBuffers: MergedBuffers | null;
	waterBuffers: MergedBuffers | null;
	cutoutBuffers: MergedBuffers | null;

	opaqueVertexData: MergedVertexData | null;
	waterVertexData: MergedVertexData | null;
	cutoutVertexData: MergedVertexData | null;

	dirty: boolean;

	// Stable-slot allocator state per layer. `appendedFaces` is the high-water
	// extent of handed-out slot regions (= the merged mesh's face count);
	// `holes` are freed regions available for reuse (sorted by offset);
	// `released` are regions freed by member removal that still need a
	// zero-fill + upload on the next rebuild before they can be reused.
	opaqueSlots: SlotLayerState;
	waterSlots: SlotLayerState;
	cutoutSlots: SlotLayerState;

	dirtyOpaqueRanges: MergedFaceRange[] | null;
	dirtyWaterRanges: MergedFaceRange[] | null;
	dirtyCutoutRanges: MergedFaceRange[] | null;

	opaqueMeshRef: any | null;
	waterMeshRef: any | null;
	cutoutMeshRef: any | null;
}

export class MergedMeshMeta {
	chunkOffsets: Float32Array | null = null;
	chunkOffsetsArray: number[] | null = null;
	isMerged = true;
	__lodLevel = 0;
}

// ---------------------------------------------------------------------------
// Constants & Module State
// ---------------------------------------------------------------------------

const GROUP_SIZE = 4;
const MAX_GROUP_MEMBERS = GROUP_SIZE * GROUP_SIZE * GROUP_SIZE;

const groups = new Map<number, MergedMeshGroup>();
const dirtyGroups = new Set<MergedMeshGroup>();

// Set whenever group membership or mesh refs change (new/removed members,
// rebuilt meshes). The occlusion culler consumes it once per frame to force a
// visibility sweep even when the camera is standing still â€” otherwise rebuilt
// meshes come back forced-visible and stay unculled until the camera moves.
let _groupsMutatedSinceSweep = false;

export function consumeGroupsMutated(): boolean {
	const mutated = _groupsMutatedSinceSweep;
	_groupsMutatedSinceSweep = false;
	return mutated;
}

const _opaqueFaceCounts = new Uint32Array(MAX_GROUP_MEMBERS);
const _waterFaceCounts = new Uint32Array(MAX_GROUP_MEMBERS);
const _cutoutFaceCounts = new Uint32Array(MAX_GROUP_MEMBERS);

function invalidateGroupBuildCache(group: MergedMeshGroup): void {
	const arr = group.membersArray;
	for (let i = 0, len = arr.length; i < len; i++) {
		const m = arr[i];
		m.lastBuiltOpaque = null;
		m.lastBuiltWater = null;
		m.lastBuiltCutout = null;
	}
}

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

function pushDirtyRange(
	ranges: MergedFaceRange[],
	start: number,
	count: number,
): void {
	if (count <= 0) return;
	_statDirtyFacesFlush += count;
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
	_groupsMutatedSinceSweep = true;
	_requestFlush?.();
}

// ---------------------------------------------------------------------------
// Stable-slot allocator
//
// PERF: rebuildGroupData used to pack members sequentially, so any member
// whose face count changed shifted every LATER member's byte offset and broke
// the copy-skip check â€” under streaming churn that recopied essentially the
// whole group (3 layers Ã— all members) on every flush (~11% of a main-thread
// profile during multiplayer chunk streaming). Slots pin each member to its
// own power-of-two region: neighbor resizes never move it, so only genuinely
// rewritten members are copied and uploaded via the dirty-range path.
// ---------------------------------------------------------------------------

const MIN_SLOT_FACES = 32;
const COMPACT_MIN_WASTE_FACES = 1024;

function slotClassFor(count: number): number {
	let c = MIN_SLOT_FACES;
	const cap = maxFacesPerArena();
	while (c < count && c < cap) c <<= 1;
	return c;
}

function newSlotLayerState(): SlotLayerState {
	return { holes: [], released: [], appendedFaces: 0 };
}

/** Insert a hole keeping the list sorted by offset; merges adjacent regions. */
function insertSlotHole(
	st: SlotLayerState,
	offset: number,
	faces: number,
): void {
	const holes = st.holes;

	let lo = 0;
	let hi = holes.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (holes[mid].offset < offset) lo = mid + 1;
		else hi = mid;
	}

	holes.length += 1;
	for (let j = holes.length - 1; j > lo; j--) holes[j] = holes[j - 1];
	holes[lo] = { offset, faces };

	// Merge right.
	if (lo + 1 < holes.length && offset + faces === holes[lo + 1].offset) {
		holes[lo].faces += holes[lo + 1].faces;
		holes.splice(lo + 1, 1);
	}
	// Merge left.
	if (lo > 0) {
		const prev = holes[lo - 1];
		if (prev.offset + prev.faces === offset) {
			prev.faces += faces;
			holes.splice(lo, 1);
		}
	}
}

/** First-fit hole reuse, else append at the layer's high-water mark. */
function acquireSlot(
	st: SlotLayerState,
	wantFaces: number,
): { offset: number; faces: number } {
	const holes = st.holes;
	for (let i = 0; i < holes.length; i++) {
		if (holes[i].faces >= wantFaces) {
			const offset = holes[i].offset;
			const leftover = holes[i].faces - wantFaces;
			if (leftover > 0) {
				holes[i] = { offset: offset + wantFaces, faces: leftover };
			} else {
				holes.splice(i, 1);
			}
			return { offset, faces: wantFaces };
		}
	}

	const offset = st.appendedFaces;
	st.appendedFaces += wantFaces;
	return { offset, faces: wantFaces };
}

/** Sum of free (hole) faces â€” the fragmentation metric for compaction. */
function slotWasteFaces(st: SlotLayerState): number {
	let sum = 0;
	for (let i = 0; i < st.holes.length; i++) sum += st.holes[i].faces;
	return sum;
}

let _requestFlush: (() => void) | null = null;

export function setRequestFlush(cb: () => void): void {
	_requestFlush = cb;
}

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

const _precomputedOffsets = (() => {
	const offsets = new Float32Array(MAX_GROUP_MEMBERS * 3);
	for (let i = 0; i < MAX_GROUP_MEMBERS; i++) {
		const lx = i & 3;
		const ly = (i >> 2) & 3;
		const lz = i >> 4;
		const base = i * 3;
		offsets[base] = lx * CHUNK_SIZE;
		offsets[base + 1] = ly * CHUNK_SIZE;
		offsets[base + 2] = lz * CHUNK_SIZE;
	}
	return offsets;
})();

const _allGroupsReuse: MergedMeshGroup[] = [];
export const PRECOMPUTED_CHUNK_OFFSETS_ARRAY = Array.from(_precomputedOffsets);

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

// Engine optimization: Bitwise shifts instead of multiplication to keep V8 SMIs (Small Integers)
function makeGroupKey(
	gx: number,
	gy: number,
	gz: number,
	lodBucket: number,
): number {
	return (gx + 512) * 1048576 + (gy + 512) * 4096 + (gz + 512) * 4 + lodBucket;
}

function getLocalIndex(chunkX: number, chunkY: number, chunkZ: number): number {
	const lx = chunkX & 3;
	const ly = chunkY & 3;
	const lz = chunkZ & 3;
	return lx | (ly << 2) | (lz << 4);
}

// Platform endianness check for SIMD bit-packing
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// ---------------------------------------------------------------------------
// Public: group lookup
// ---------------------------------------------------------------------------

export function getGroupKeyForChunk(chunk: Chunk): number {
	return makeGroupKey(
		chunk.chunkX >> 2, // Fast Math.floor(x / 4)
		chunk.chunkY >> 2,
		chunk.chunkZ >> 2,
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

export function assignChunkToGroup(
	chunk: Chunk,
	opaqueData: MeshData | null,
	waterData: MeshData | null,
	cutoutData: MeshData | null,
): MergedMeshGroup {
	const gx = chunk.chunkX >> 2;
	const gy = chunk.chunkY >> 2;
	const gz = chunk.chunkZ >> 2;

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
			opaqueSlots: newSlotLayerState(),
			waterSlots: newSlotLayerState(),
			cutoutSlots: newSlotLayerState(),
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
			slotOpaqueOffset: 0,
			slotOpaqueFaces: 0,
			slotWaterOffset: 0,
			slotWaterFaces: 0,
			slotCutoutOffset: 0,
			slotCutoutFaces: 0,
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

export function removeChunkFromGroup(chunk: Chunk): void {
	const groupKey = chunk.mergedGroupKey;
	if (groupKey === null) return;

	const group = groups.get(groupKey);
	chunk.mergedGroupKey = null;
	if (!group) return;

	// Release the departing member's slots: they move to the layer's
	// `released` list so the next rebuild zero-fills + uploads those regions
	// (stale quads must stop rendering) before the holes become reusable.
	// Bookkeeping happens at rebuild time â€” this path runs on the hot
	// unload/edit path and must stay allocation-light.
	const member = group.members.get(chunk.numericId);
	if (member) {
		if (member.slotOpaqueFaces > 0)
			group.opaqueSlots.released.push({
				offset: member.slotOpaqueOffset,
				faces: member.slotOpaqueFaces,
			});
		if (member.slotWaterFaces > 0)
			group.waterSlots.released.push({
				offset: member.slotWaterOffset,
				faces: member.slotWaterFaces,
			});
		if (member.slotCutoutFaces > 0)
			group.cutoutSlots.released.push({
				offset: member.slotCutoutOffset,
				faces: member.slotCutoutFaces,
			});
	}

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
		_groupsMutatedSinceSweep = true;
		return;
	}

	const arr = group.membersArray;
	let write = 0;
	let minLod = Infinity;
	const removedId = chunk.numericId;

	for (let i = 0, len = arr.length; i < len; i++) {
		const m = arr[i];
		if (m.chunkId === removedId) continue;
		arr[write++] = m;
		const lod = m.chunk.lodLevel ?? 0;
		if (lod < minLod) minLod = lod;
	}

	arr.length = write;
	group.minLodLevel = minLod;
	invalidateGroupBuildCache(group);
	markGroupDirty(group);
}

let _lastMergedFlushMs = 0;
let _mergedFlushTotalMs = 0;
let _mergedFlushCount = 0;

// PERF instrumentation for the stable-slot layout: how many member copies the
// skip-check avoided vs performed, and how many face bytes were marked dirty
// for GPU upload. Healthy numbers: copies â‰ª membersÃ—layers during bursts,
// dirtyBytes â‰ˆ actually-changed content (not whole-group rewrites).
let _statMembersSeen = 0;
let _statCopiesPerformed = 0;
let _statDirtyFacesFlush = 0;
let _statWasteFacesMax = 0;

export function getMergedSlotStats(): {
	membersSeen: number;
	copiesPerformed: number;
	dirtyFaces: number;
	wasteFacesMax: number;
} {
	return {
		membersSeen: _statMembersSeen,
		copiesPerformed: _statCopiesPerformed,
		dirtyFaces: _statDirtyFacesFlush,
		wasteFacesMax: _statWasteFacesMax,
	};
}

export function getMergedMeshFlushStats(): { lastMs: number; avgMs: number } {
	return {
		lastMs: _lastMergedFlushMs,
		avgMs: _mergedFlushCount > 0 ? _mergedFlushTotalMs / _mergedFlushCount : 0,
	};
}

// Diagnostics: CPU bytes held by merged-group layer arrays (3 layers ×
// A/B/C × capacity×4 B). Compare against getPackedMeshMemoryStats().
export function getMergedLayerMemoryStats(): {
	groups: number;
	layerBytes: number;
} {
	let groupCount = 0;
	let layerBytes = 0;
	for (const g of groups.values()) {
		groupCount++;
		layerBytes +=
			(g.opaqueCapacityFaces + g.waterCapacityFaces + g.cutoutCapacityFaces) *
			4 *
			3;
	}
	return { groups: groupCount, layerBytes };
}

let _mergedFlushRafScheduled = false;
const _flushSnapshot: MergedMeshGroup[] = [];

export function flushDirtyMergedGroups(maxBudgetMs = 5): void {
	if (dirtyGroups.size === 0) return;
	const start = performance.now();
	const snapshot = _flushSnapshot;
	snapshot.length = 0;

	for (const group of dirtyGroups) snapshot.push(group);
	dirtyGroups.clear();

	_statMembersSeen = 0;
	_statCopiesPerformed = 0;
	_statDirtyFacesFlush = 0;
	_statWasteFacesMax = 0;

	let i = 0;
	let budgetExhausted = false;

	for (; i < snapshot.length; i++) {
		if (i !== 0 && performance.now() - start > maxBudgetMs) {
			budgetExhausted = true;
			break;
		}
		const group = snapshot[i];
		if (!group.dirty || groups.get(group.groupKey) !== group) continue;
		rebuildGroupData(group);
		_onGroupMeshNeedsRebuild?.(group);
	}

	if (budgetExhausted) {
		for (; i < snapshot.length; i++) {
			const group = snapshot[i];
			if (group.dirty && groups.get(group.groupKey) === group)
				dirtyGroups.add(group);
		}
		if (_requestFlush) _requestFlush();
		else if (!_mergedFlushRafScheduled) {
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
		group.cachedOpaque = group.cachedWater = group.cachedCutout = null;
		group.opaqueA = group.opaqueB = group.opaqueC = null;
		group.opaqueBuffers = null;
		group.opaqueCapacityFaces = 0;
		group.waterA = group.waterB = group.waterC = null;
		group.waterBuffers = null;
		group.waterCapacityFaces = 0;
		group.cutoutA = group.cutoutB = group.cutoutC = null;
		group.cutoutBuffers = null;
		group.cutoutCapacityFaces = 0;
		group.opaqueSlots = newSlotLayerState();
		group.waterSlots = newSlotLayerState();
		group.cutoutSlots = newSlotLayerState();
		group.members.clear();
		group.membersArray.length = 0;
	}
	groups.clear();
	dirtyGroups.clear();
}

// ---------------------------------------------------------------------------
// Internal: rebuild combined vertex data
// ---------------------------------------------------------------------------

// Growth now WHOLESALE-COPIES the old buffers (`.set`) instead of handing back
// fresh zeroed arrays: slot contents stay valid, so no member invalidation and
// no mass recopy on the next pass. The geometric slack above the slot extent
// is harmless â€” vertex data is exposed as a subarray limited to the slot
// extent, so the mesh's face count only changes when slots are acquired.

function ensureOpaqueMergedCapacity(
	group: MergedMeshGroup,
	faceCount: number,
): MergedBuffers {
	let capacity = group.opaqueCapacityFaces;
	if (capacity < faceCount) {
		const maxFaces = maxFacesPerArena();
		capacity = Math.min(Math.max(faceCount, capacity << 1, 256), maxFaces);
		group.opaqueCapacityFaces = capacity;
		const byte4 = capacity << 2;
		const a = new Uint8Array(byte4),
			b = new Uint8Array(byte4),
			c = new Uint8Array(byte4);
		if (group.opaqueA) a.set(group.opaqueA);
		if (group.opaqueB) b.set(group.opaqueB);
		if (group.opaqueC) c.set(group.opaqueC);
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
		const maxFaces = maxFacesPerArena();
		capacity = Math.min(Math.max(faceCount, capacity << 1, 256), maxFaces);
		group.waterCapacityFaces = capacity;
		const byte4 = capacity << 2;
		const a = new Uint8Array(byte4),
			b = new Uint8Array(byte4),
			c = new Uint8Array(byte4);
		if (group.waterA) a.set(group.waterA);
		if (group.waterB) b.set(group.waterB);
		if (group.waterC) c.set(group.waterC);
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
		const maxFaces = maxFacesPerArena();
		capacity = Math.min(Math.max(faceCount, capacity << 1, 256), maxFaces);
		group.cutoutCapacityFaces = capacity;
		const byte4 = capacity << 2;
		const a = new Uint8Array(byte4),
			b = new Uint8Array(byte4),
			c = new Uint8Array(byte4);
		if (group.cutoutA) a.set(group.cutoutA);
		if (group.cutoutB) b.set(group.cutoutB);
		if (group.cutoutC) c.set(group.cutoutC);
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

// Engine optimization: Inlined Meshkind enum switch to reduce branching in the hot path
function getValidatedFaceCount(
	data: MeshData | null,
	chunkId: number,
	lod: number,
	kindName: string,
): number {
	if (!data) return 0;
	const raw = data.faceCount;
	const aLen = data.faceDataA.length;
	if (
		raw >= 0 &&
		raw << 2 === aLen &&
		aLen === data.faceDataB.length &&
		aLen === data.faceDataC.length
	) {
		return raw;
	}
	const bLen = data.faceDataB.length;
	const cLen = data.faceDataC.length;
	const derived = Math.min(aLen, bLen, cLen) >> 2;
	console.warn(
		`[MergedMeshManager] chunk #${chunkId} (lod ${lod}) ${kindName} faceCount (${raw}) inconsistent with buffer lengths (${aLen}/${bLen}/${cLen} bytes) â€” using ${derived} instead.`,
	);
	return derived;
}

// ---------------------------------------------------------------------------
// Hysteresis shrink for a merged layer's backing arrays.
//
// Layer arrays grow by doubling (ensure*MergedCapacity) and used to never
// release: after a streaming spike or LOD swap every group kept its peak
// allocation forever — 3 arrays × capacity×4 B per layer, ×3 layers. When the
// settled slot extent falls to a quarter of capacity, reallocate at
// max(256, extent*2) faces and wholesale-copy the live prefix [0, extent).
// Slot offsets are stable and fully contained in the prefix, so member
// lastBuilt* bookkeeping stays valid without invalidation; only the group's
// own array identity changes, and the vertex-data views are re-sliced right
// after this runs in rebuildGroupData.
//
// Thresholds: never touch groups below 2048-face capacity (8 KiB/array — the
// copy churn isn't worth it), and the *4 hysteresis vs *2 regrowth slack
// prevents grow/shrink oscillation.
// ---------------------------------------------------------------------------

const LAYER_SHRINK_MIN_CAPACITY_FACES = 2048;

function shrinkLayerTriple(
	a: Uint8Array | null,
	b: Uint8Array | null,
	c: Uint8Array | null,
	capacityFaces: number,
	extentFaces: number,
): { a: Uint8Array; b: Uint8Array; c: Uint8Array; cap: number } | null {
	if (
		!a ||
		capacityFaces < LAYER_SHRINK_MIN_CAPACITY_FACES ||
		extentFaces > capacityFaces ||
		extentFaces << 2 > capacityFaces
	) {
		return null;
	}
	const newCap = Math.max(256, Math.min(extentFaces << 1, capacityFaces));
	if (newCap >= capacityFaces) return null;
	const byte4 = newCap << 2;
	const copyPrefix = (src: Uint8Array | null): Uint8Array => {
		// src.length == oldCapacity<<2 >= byte4: the live prefix always fits.
		const n = new Uint8Array(byte4);
		if (src) n.set(src.subarray(0, byte4));
		return n;
	};
	return {
		a: copyPrefix(a),
		b: copyPrefix(b),
		c: copyPrefix(c),
		cap: newCap,
	};
}

function maybeShrinkGroupLayers(group: MergedMeshGroup): void {
	const op = shrinkLayerTriple(
		group.opaqueA,
		group.opaqueB,
		group.opaqueC,
		group.opaqueCapacityFaces,
		group.opaqueSlots.appendedFaces,
	);
	if (op) {
		group.opaqueA = op.a;
		group.opaqueB = op.b;
		group.opaqueC = op.c;
		group.opaqueCapacityFaces = op.cap;
		if (group.opaqueBuffers) {
			group.opaqueBuffers.a = op.a;
			group.opaqueBuffers.b = op.b;
			group.opaqueBuffers.c = op.c;
		}
	}

	const wa = shrinkLayerTriple(
		group.waterA,
		group.waterB,
		group.waterC,
		group.waterCapacityFaces,
		group.waterSlots.appendedFaces,
	);
	if (wa) {
		group.waterA = wa.a;
		group.waterB = wa.b;
		group.waterC = wa.c;
		group.waterCapacityFaces = wa.cap;
		if (group.waterBuffers) {
			group.waterBuffers.a = wa.a;
			group.waterBuffers.b = wa.b;
			group.waterBuffers.c = wa.c;
		}
	}

	const cu = shrinkLayerTriple(
		group.cutoutA,
		group.cutoutB,
		group.cutoutC,
		group.cutoutCapacityFaces,
		group.cutoutSlots.appendedFaces,
	);
	if (cu) {
		group.cutoutA = cu.a;
		group.cutoutB = cu.b;
		group.cutoutC = cu.c;
		group.cutoutCapacityFaces = cu.cap;
		if (group.cutoutBuffers) {
			group.cutoutBuffers.a = cu.a;
			group.cutoutBuffers.b = cu.b;
			group.cutoutBuffers.c = cu.c;
		}
	}
}

function rebuildGroupData(group: MergedMeshGroup): void {
	const members = group.membersArray;
	const memberCount = members.length;
	_statMembersSeen += memberCount;

	const prevOpaqueRanges = group.dirtyOpaqueRanges;
	if (prevOpaqueRanges)
		for (let i = 0, len = prevOpaqueRanges.length; i < len; i++)
			_rangePool.push(prevOpaqueRanges[i]);
	const prevWaterRanges = group.dirtyWaterRanges;
	if (prevWaterRanges)
		for (let i = 0, len = prevWaterRanges.length; i < len; i++)
			_rangePool.push(prevWaterRanges[i]);
	const prevCutoutRanges = group.dirtyCutoutRanges;
	if (prevCutoutRanges)
		for (let i = 0, len = prevCutoutRanges.length; i < len; i++)
			_rangePool.push(prevCutoutRanges[i]);

	group.dirtyOpaqueRanges ??= [];
	const opaqueRanges = group.dirtyOpaqueRanges;
	opaqueRanges.length = 0;
	group.dirtyWaterRanges ??= [];
	const waterRanges = group.dirtyWaterRanges;
	waterRanges.length = 0;
	group.dirtyCutoutRanges ??= [];
	const cutoutRanges = group.dirtyCutoutRanges;
	cutoutRanges.length = 0;

	let totalOpaque = 0,
		totalWater = 0,
		totalCutout = 0;

	for (let i = 0; i < memberCount; i++) {
		const m = members[i];
		const opaqueCount = getValidatedFaceCount(
			m.opaqueData,
			m.chunkId,
			m.chunk.lodLevel ?? 0,
			"opaque",
		);
		const waterCount = getValidatedFaceCount(
			m.waterData,
			m.chunkId,
			m.chunk.lodLevel ?? 0,
			"water",
		);
		const cutoutCount = getValidatedFaceCount(
			m.cutoutData,
			m.chunkId,
			m.chunk.lodLevel ?? 0,
			"cutout",
		);

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

	const opSt = group.opaqueSlots;
	const waSt = group.waterSlots;
	const cuSt = group.cutoutSlots;

	const maxGroupFaces = maxFacesPerArena();
	if (
		totalOpaque > maxGroupFaces ||
		totalWater > maxGroupFaces ||
		totalCutout > maxGroupFaces ||
		opSt.appendedFaces > maxGroupFaces ||
		waSt.appendedFaces > maxGroupFaces ||
		cuSt.appendedFaces > maxGroupFaces
	) {
		console.warn(
			`[MergedMeshManager] group (${group.gridX}, ${group.gridY}, ${group.gridZ}) lod bucket ${group.lodBucket} exceeds the per-mesh arena limit (opaque ${totalOpaque}/${opSt.appendedFaces}, water ${totalWater}/${waSt.appendedFaces}, cutout ${totalCutout}/${cuSt.appendedFaces}, max ${maxGroupFaces} faces) â€” mesh rebuild skipped.`,
		);
		group.dirty = false;
		return;
	}

	// -----------------------------------------------------------------------
	// SLOT LAYOUT PASS (per layer): settle each member's stable slot before
	// any copying. Neighbor resizes can no longer shift a member's offset,
	// which is what makes the copy-skip checks below effective.
	// -----------------------------------------------------------------------

	{
		const w =
			slotWasteFaces(opSt) + slotWasteFaces(waSt) + slotWasteFaces(cuSt);
		if (w > _statWasteFacesMax) _statWasteFacesMax = w;
	}

	// CORRECTNESS: structural slot events (extent growth into fresh arena
	// tail, hole recycling, compaction) invalidate GPU bytes that dirty-range
	// uploads from member copies alone do NOT cover — the arena block beyond
	// a mesh's previous face count holds whatever the previous occupant left
	// there. When any layer is structurally touched this flush, its ENTIRE
	// extent is re-uploaded once instead of relying on per-copy ranges.
	const prevOpAppended = opSt.appendedFaces;
	const prevWaAppended = waSt.appendedFaces;
	const prevCuAppended = cuSt.appendedFaces;
	let opStructChanged = false;
	let waStructChanged = false;
	let cuStructChanged = false;

	// Compaction: when holes dominate a layer's extent, relayout it
	// contiguously once instead of carrying dead regions indefinitely.
	if (
		opSt.appendedFaces > 0 &&
		slotWasteFaces(opSt) > COMPACT_MIN_WASTE_FACES &&
		slotWasteFaces(opSt) * 2 > opSt.appendedFaces
	) {
		opSt.holes.length = 0;
		opSt.released.length = 0;
		opSt.appendedFaces = 0;
		opStructChanged = true;
		// Re-acquired slot padding must be guaranteed-zero: wipe the layer so
		// stale bytes from the discarded layout can't resurface as quads.
		group.opaqueA?.fill(0);
		group.opaqueB?.fill(0);
		group.opaqueC?.fill(0);
		for (let i = 0; i < memberCount; i++) {
			members[i].slotOpaqueOffset = 0;
			members[i].slotOpaqueFaces = 0;
			members[i].lastBuiltOpaque = null;
			members[i].lastBuiltOpaqueOffset = -1;
		}
	}
	if (
		waSt.appendedFaces > 0 &&
		slotWasteFaces(waSt) > COMPACT_MIN_WASTE_FACES &&
		slotWasteFaces(waSt) * 2 > waSt.appendedFaces
	) {
		waSt.holes.length = 0;
		waSt.released.length = 0;
		waSt.appendedFaces = 0;
		waStructChanged = true;
		group.waterA?.fill(0);
		group.waterB?.fill(0);
		group.waterC?.fill(0);
		for (let i = 0; i < memberCount; i++) {
			members[i].slotWaterOffset = 0;
			members[i].slotWaterFaces = 0;
			members[i].lastBuiltWater = null;
			members[i].lastBuiltWaterOffset = -1;
		}
	}
	if (
		cuSt.appendedFaces > 0 &&
		slotWasteFaces(cuSt) > COMPACT_MIN_WASTE_FACES &&
		slotWasteFaces(cuSt) * 2 > cuSt.appendedFaces
	) {
		cuSt.holes.length = 0;
		cuSt.released.length = 0;
		cuSt.appendedFaces = 0;
		cuStructChanged = true;
		group.cutoutA?.fill(0);
		group.cutoutB?.fill(0);
		group.cutoutC?.fill(0);
		for (let i = 0; i < memberCount; i++) {
			members[i].slotCutoutOffset = 0;
			members[i].slotCutoutFaces = 0;
			members[i].lastBuiltCutout = null;
			members[i].lastBuiltCutoutOffset = -1;
		}
	}

	for (let i = 0; i < memberCount; i++) {
		const m = members[i];

		const oc = _opaqueFaceCounts[i];
		let osOff = m.slotOpaqueOffset;
		let osFaces = m.slotOpaqueFaces;
		if (oc === 0) {
			if (osFaces > 0) {
				opSt.released.push({ offset: osOff, faces: osFaces });
				osOff = 0;
				osFaces = 0;
				m.lastBuiltOpaque = null;
				m.lastBuiltOpaqueOffset = -1;
			}
		} else {
			const want = slotClassFor(oc);
			if (osFaces !== want) {
				if (osFaces > 0) opSt.released.push({ offset: osOff, faces: osFaces });
				const s = acquireSlot(opSt, want);
				osOff = s.offset;
				osFaces = s.faces;
				m.lastBuiltOpaque = null;
				m.lastBuiltOpaqueOffset = -1;
			}
		}
		m.slotOpaqueOffset = osOff;
		m.slotOpaqueFaces = osFaces;

		const wc = _waterFaceCounts[i];
		let wsOff = m.slotWaterOffset;
		let wsFaces = m.slotWaterFaces;
		if (wc === 0) {
			if (wsFaces > 0) {
				waSt.released.push({ offset: wsOff, faces: wsFaces });
				wsOff = 0;
				wsFaces = 0;
				m.lastBuiltWater = null;
				m.lastBuiltWaterOffset = -1;
			}
		} else {
			const want = slotClassFor(wc);
			if (wsFaces !== want) {
				if (wsFaces > 0) waSt.released.push({ offset: wsOff, faces: wsFaces });
				const s = acquireSlot(waSt, want);
				wsOff = s.offset;
				wsFaces = s.faces;
				m.lastBuiltWater = null;
				m.lastBuiltWaterOffset = -1;
			}
		}
		m.slotWaterOffset = wsOff;
		m.slotWaterFaces = wsFaces;

		const cc = _cutoutFaceCounts[i];
		let csOff = m.slotCutoutOffset;
		let csFaces = m.slotCutoutFaces;
		if (cc === 0) {
			if (csFaces > 0) {
				cuSt.released.push({ offset: csOff, faces: csFaces });
				csOff = 0;
				csFaces = 0;
				m.lastBuiltCutout = null;
				m.lastBuiltCutoutOffset = -1;
			}
		} else {
			const want = slotClassFor(cc);
			if (csFaces !== want) {
				if (csFaces > 0) cuSt.released.push({ offset: csOff, faces: csFaces });
				const s = acquireSlot(cuSt, want);
				csOff = s.offset;
				csFaces = s.faces;
				m.lastBuiltCutout = null;
				m.lastBuiltCutoutOffset = -1;
			}
		}
		m.slotCutoutOffset = csOff;
		m.slotCutoutFaces = csFaces;
	}

	// Grow backing buffers to cover each layer's new slot extent (wholesale
	// copy — contents stay valid), then drain pending releases: zero-fill the
	// region so its stale quads stop rendering, and recycle it into the hole
	// list. Any release or extent change marks the layer structural → one
	// full-extent upload below covers every gap member ranges would miss.
	if (opSt.appendedFaces > 0)
		ensureOpaqueMergedCapacity(group, opSt.appendedFaces);
	else group.cachedOpaque = null;
	if (opSt.released.length > 0 || opSt.appendedFaces !== prevOpAppended)
		opStructChanged = true;
	while (opSt.released.length > 0 && group.opaqueA) {
		const r = opSt.released.pop()!;
		const b4 = r.offset << 2;
		const n4 = r.faces << 2;
		group.opaqueA.fill(0, b4, b4 + n4);
		group.opaqueB!.fill(0, b4, b4 + n4);
		group.opaqueC!.fill(0, b4, b4 + n4);
		insertSlotHole(opSt, r.offset, r.faces);
	}

	if (waSt.appendedFaces > 0)
		ensureWaterMergedCapacity(group, waSt.appendedFaces);
	else group.cachedWater = null;
	if (waSt.released.length > 0 || waSt.appendedFaces !== prevWaAppended)
		waStructChanged = true;
	while (waSt.released.length > 0 && group.waterA) {
		const r = waSt.released.pop()!;
		const b4 = r.offset << 2;
		const n4 = r.faces << 2;
		group.waterA.fill(0, b4, b4 + n4);
		group.waterB!.fill(0, b4, b4 + n4);
		group.waterC!.fill(0, b4, b4 + n4);
		insertSlotHole(waSt, r.offset, r.faces);
	}

	if (cuSt.appendedFaces > 0)
		ensureCutoutMergedCapacity(group, cuSt.appendedFaces);
	else group.cachedCutout = null;
	if (cuSt.released.length > 0 || cuSt.appendedFaces !== prevCuAppended)
		cuStructChanged = true;
	while (cuSt.released.length > 0 && group.cutoutA) {
		const r = cuSt.released.pop()!;
		const b4 = r.offset << 2;
		const n4 = r.faces << 2;
		group.cutoutA.fill(0, b4, b4 + n4);
		group.cutoutB!.fill(0, b4, b4 + n4);
		group.cutoutC!.fill(0, b4, b4 + n4);
		insertSlotHole(cuSt, r.offset, r.faces);
	}

	const opaqueA = group.opaqueA;
	const opaqueB = group.opaqueB;
	const opaqueC = group.opaqueC;
	const waterA = group.waterA;
	const waterB = group.waterB;
	const waterC = group.waterC;
	const cutoutA = group.cutoutA;
	const cutoutB = group.cutoutB;
	const cutoutC = group.cutoutC;

	for (let i = 0; i < memberCount; i++) {
		const m = members[i];

		// --- OPAQUE ---
		const opaque = m.opaqueData;
		const opaqueFaceCount = _opaqueFaceCounts[i];
		if (opaque && opaqueFaceCount > 0 && m.slotOpaqueFaces > 0) {
			const byteCount = opaqueFaceCount << 2;
			// Slot offsets are stable, so identity alone decides the skip.
			if (m.lastBuiltOpaque !== opaque) {
				const byteOff = m.slotOpaqueOffset << 2;
				copyFaceBytes(opaqueA!, opaque.faceDataA, byteCount, byteOff);
				copyFaceBytes(opaqueB!, opaque.faceDataB, byteCount, byteOff);
				copyFaceBytes(opaqueC!, opaque.faceDataC, byteCount, byteOff);

				const ci = m.localIndex;
				if (ci !== 0) {
					// Engine optimization: 32-bit SIMD vectorization instead of byte-stride loop
					const mask = IS_LITTLE_ENDIAN ? ci << 24 : ci;
					const c32 = new Uint32Array(
						opaqueC!.buffer,
						opaqueC!.byteOffset + byteOff,
						opaqueFaceCount,
					);
					for (let j = 0; j < opaqueFaceCount; j++) c32[j] |= mask;
				}
				m.lastBuiltOpaque = opaque;
				m.lastBuiltOpaqueOffset = byteOff;
				_statCopiesPerformed++;
				if (!opStructChanged)
					pushDirtyRange(opaqueRanges, m.slotOpaqueOffset, opaqueFaceCount);
			}
		}

		// --- WATER ---
		const water = m.waterData;
		const waterFaceCount = _waterFaceCounts[i];
		if (water && waterFaceCount > 0 && m.slotWaterFaces > 0) {
			const byteCount = waterFaceCount << 2;
			if (m.lastBuiltWater !== water) {
				const byteOff = m.slotWaterOffset << 2;
				copyFaceBytes(waterA!, water.faceDataA, byteCount, byteOff);
				copyFaceBytes(waterB!, water.faceDataB, byteCount, byteOff);
				copyFaceBytes(waterC!, water.faceDataC, byteCount, byteOff);

				const ci = m.localIndex;
				if (ci !== 0) {
					const mask = IS_LITTLE_ENDIAN ? ci << 24 : ci;
					const c32 = new Uint32Array(
						waterC!.buffer,
						waterC!.byteOffset + byteOff,
						waterFaceCount,
					);
					for (let j = 0; j < waterFaceCount; j++) c32[j] |= mask;
				}
				m.lastBuiltWater = water;
				m.lastBuiltWaterOffset = byteOff;
				_statCopiesPerformed++;
				if (!waStructChanged)
					pushDirtyRange(waterRanges, m.slotWaterOffset, waterFaceCount);
			}
		}

		// --- CUTOUT ---
		const cutout = m.cutoutData;
		const cutoutFaceCount = _cutoutFaceCounts[i];
		if (cutout && cutoutFaceCount > 0 && m.slotCutoutFaces > 0) {
			const byteCount = cutoutFaceCount << 2;
			if (m.lastBuiltCutout !== cutout) {
				const byteOff = m.slotCutoutOffset << 2;
				copyFaceBytes(cutoutA!, cutout.faceDataA, byteCount, byteOff);
				copyFaceBytes(cutoutB!, cutout.faceDataB, byteCount, byteOff);
				copyFaceBytes(cutoutC!, cutout.faceDataC, byteCount, byteOff);

				const ci = m.localIndex;
				if (ci !== 0) {
					const mask = IS_LITTLE_ENDIAN ? ci << 24 : ci;
					const c32 = new Uint32Array(
						cutoutC!.buffer,
						cutoutC!.byteOffset + byteOff,
						cutoutFaceCount,
					);
					for (let j = 0; j < cutoutFaceCount; j++) c32[j] |= mask;
				}
				m.lastBuiltCutout = cutout;
				m.lastBuiltCutoutOffset = byteOff;
				_statCopiesPerformed++;
				if (!cuStructChanged)
					pushDirtyRange(cutoutRanges, m.slotCutoutOffset, cutoutFaceCount);
			}
		}
	}

	// Structural layers: one full-extent range covers every gap the skipped
	// per-member ranges would have missed (fresh arena tail, recycled holes,
	// post-compaction relayout). Content-only flushes keep tiny ranges.
	if (opStructChanged && opSt.appendedFaces > 0)
		pushDirtyRange(opaqueRanges, 0, opSt.appendedFaces);
	if (waStructChanged && waSt.appendedFaces > 0)
		pushDirtyRange(waterRanges, 0, waSt.appendedFaces);
	if (cuStructChanged && cuSt.appendedFaces > 0)
		pushDirtyRange(cutoutRanges, 0, cuSt.appendedFaces);

	// Release layer-array slack after spikes (see shrinkLayerTriple) BEFORE
	// re-slicing the vertex-data views, so they wrap the shrunken arrays.
	maybeShrinkGroupLayers(group);

	// Wrap up vertex data buffers.
	//
	// The exposed extent is the SLOT EXTENT (appendedFaces), not the used-face
	// sum: padding faces are zero-filled so they render nothing, and keeping
	// the extent stable across content-only rebuilds is what lets
	// updatePackedChunkMesh take its dirty-range fast path instead of
	// reallocating the GPU arena block on every flush.
	if (opSt.appendedFaces > 0) {
		const totalBytes = opSt.appendedFaces << 2;
		if (!group.opaqueVertexData)
			group.opaqueVertexData = {
				faceDataA: new Uint8Array(0),
				faceDataB: new Uint8Array(0),
				faceDataC: new Uint8Array(0),
				faceCount: 0,
			};
		const vd = group.opaqueVertexData;
		vd.faceDataA = opaqueA!.subarray(0, totalBytes);
		vd.faceDataB = opaqueB!.subarray(0, totalBytes);
		vd.faceDataC = opaqueC!.subarray(0, totalBytes);
		vd.faceCount = opSt.appendedFaces;
		group.cachedOpaque = vd;
	}
	if (waSt.appendedFaces > 0) {
		const totalBytes = waSt.appendedFaces << 2;
		if (!group.waterVertexData)
			group.waterVertexData = {
				faceDataA: new Uint8Array(0),
				faceDataB: new Uint8Array(0),
				faceDataC: new Uint8Array(0),
				faceCount: 0,
			};
		const vd = group.waterVertexData;
		vd.faceDataA = waterA!.subarray(0, totalBytes);
		vd.faceDataB = waterB!.subarray(0, totalBytes);
		vd.faceDataC = waterC!.subarray(0, totalBytes);
		vd.faceCount = waSt.appendedFaces;
		group.cachedWater = vd;
	}

	if (cuSt.appendedFaces > 0) {
		const totalBytes = cuSt.appendedFaces << 2;
		if (!group.cutoutVertexData)
			group.cutoutVertexData = {
				faceDataA: new Uint8Array(0),
				faceDataB: new Uint8Array(0),
				faceDataC: new Uint8Array(0),
				faceCount: 0,
			};
		const vd = group.cutoutVertexData;
		vd.faceDataA = cutoutA!.subarray(0, totalBytes);
		vd.faceDataB = cutoutB!.subarray(0, totalBytes);
		vd.faceDataC = cutoutC!.subarray(0, totalBytes);
		vd.faceCount = cuSt.appendedFaces;
		group.cachedCutout = vd;
	}

	group.dirty = false;
}
