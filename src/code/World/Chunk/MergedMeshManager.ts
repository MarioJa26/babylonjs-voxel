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
	/** Interleaved face records (12 bytes = 3 u32 words per face). */
	faceData: Uint8Array;
	faceCount: number;
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
	holes: SlotHole[];
	released: SlotHole[];
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

	// One interleaved face-record buffer per layer (12 bytes per face).
	// Replaces the old opaqueA/B/C SoA triple: member assembly is a single
	// memcpy, and the chunk-index OR pass strides through one u32 view.
	opaqueData: Uint8Array | null;
	waterData: Uint8Array | null;
	cutoutData: Uint8Array | null;

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

// Pooled Uint8Array per byteLength to avoid per-growth GC (profile: 1.1 MB Uint8Array per flush).
const _uint8Pool = new Map<number, Uint8Array[]>();
function allocPooledU8(bytes: number): Uint8Array {
	const list = _uint8Pool.get(bytes);
	if (list && list.length > 0) return list.pop()!;
	return new Uint8Array(bytes);
}
function releasePooledU8(arr: Uint8Array | null): void {
	if (!arr || arr.byteLength === 0) return;
	let list = _uint8Pool.get(arr.byteLength);
	if (!list) {
		list = [];
		_uint8Pool.set(arr.byteLength, list);
	}
	if (list.length < 32) {
		// Keep zeroed for slot reuse correctness (stale quads would render)
		arr.fill(0);
		list.push(arr);
	}
}

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

const EMPTY_U12 = new Uint8Array(0);

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

export type GroupMeshRebuildCallback = (group: MergedMeshGroup) => void;
let _onGroupMeshNeedsRebuild: GroupMeshRebuildCallback | null = null;

export function setOnGroupMeshNeedsRebuild(cb: GroupMeshRebuildCallback): void {
	_onGroupMeshNeedsRebuild = cb;
}

function getLodRenderBucket(lod: number): number {
	if (lod <= 1) return 0;
	if (lod === 2) return 2;
	if (lod === 3) return 3;
	// LOD4+ (lodStep > 1): dedicated bucket so these meshes get the slim
	// raw-units materials (Lod4ShaderLite) — their face words carry whole
	// blocks, not the ×8-scaled encoding the LOD0-3 shaders decode.
	return 4;
}

// Engine optimization: Bitwise shifts instead of multiplication to keep V8 SMIs (Small Integers)
// Field layout (little-endian digit order): lodBucket occupies 3 bits (0..7 —
// widened from 2 when the LOD4+ raw-units bucket was added), gz 10 bits,
// gy 11 bits, gx the remainder. All terms non-negative and disjoint.
function makeGroupKey(
	gx: number,
	gy: number,
	gz: number,
	lodBucket: number,
): number {
	return (gx + 512) * 16777216 + (gy + 512) * 8192 + (gz + 512) * 8 + lodBucket;
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
			opaqueData: null,
			waterData: null,
			cutoutData: null,
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
		releasePooledU8(group.opaqueData);
		releasePooledU8(group.waterData);
		releasePooledU8(group.cutoutData);
		group.opaqueData = null;
		group.waterData = null;
		group.cutoutData = null;
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
		releasePooledU8(group.opaqueData);
		releasePooledU8(group.waterData);
		releasePooledU8(group.cutoutData);
		group.cachedOpaque = group.cachedWater = group.cachedCutout = null;
		group.opaqueData = null;
		group.opaqueCapacityFaces = 0;
		group.waterData = null;
		group.waterCapacityFaces = 0;
		group.cutoutData = null;
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
): void {
	let capacity = group.opaqueCapacityFaces;
	if (capacity < faceCount) {
		const maxFaces = maxFacesPerArena();
		capacity = Math.min(Math.max(faceCount, capacity << 1, 256), maxFaces);
		group.opaqueCapacityFaces = capacity;
		const bytes = capacity * 12;
		const data = allocPooledU8(bytes);
		const old = group.opaqueData;
		if (old) {
			data.set(old.subarray(0, Math.min(old.length, bytes)));
			releasePooledU8(old);
		}
		group.opaqueData = data;
	}
}

function ensureWaterMergedCapacity(
	group: MergedMeshGroup,
	faceCount: number,
): void {
	let capacity = group.waterCapacityFaces;
	if (capacity < faceCount) {
		const maxFaces = maxFacesPerArena();
		capacity = Math.min(Math.max(faceCount, capacity << 1, 256), maxFaces);
		group.waterCapacityFaces = capacity;
		const bytes = capacity * 12;
		const data = allocPooledU8(bytes);
		const old = group.waterData;
		if (old) {
			data.set(old.subarray(0, Math.min(old.length, bytes)));
			releasePooledU8(old);
		}
		group.waterData = data;
	}
}

function ensureCutoutMergedCapacity(
	group: MergedMeshGroup,
	faceCount: number,
): void {
	let capacity = group.cutoutCapacityFaces;
	if (capacity < faceCount) {
		const maxFaces = maxFacesPerArena();
		capacity = Math.min(Math.max(faceCount, capacity << 1, 256), maxFaces);
		group.cutoutCapacityFaces = capacity;
		const bytes = capacity * 12;
		const data = allocPooledU8(bytes);
		const old = group.cutoutData;
		if (old) {
			data.set(old.subarray(0, Math.min(old.length, bytes)));
			releasePooledU8(old);
		}
		group.cutoutData = data;
	}
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
	const byteLen = data.faceData.length;
	if (raw >= 0 && raw * 12 === byteLen) {
		return raw;
	}
	const derived = (byteLen / 12) | 0;
	console.warn(
		`[MergedMeshManager] chunk #${chunkId} (lod ${lod}) ${kindName} faceCount (${raw}) inconsistent with buffer length (${byteLen} bytes) — using ${derived} instead.`,
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

function shrinkLayer(
	data: Uint8Array | null,
	capacityFaces: number,
	extentFaces: number,
): { data: Uint8Array; cap: number } | null {
	if (
		!data ||
		capacityFaces < LAYER_SHRINK_MIN_CAPACITY_FACES ||
		extentFaces > capacityFaces ||
		extentFaces * 4 > capacityFaces
	) {
		return null;
	}
	const newCap = Math.max(256, Math.min(extentFaces << 1, capacityFaces));
	if (newCap >= capacityFaces) return null;
	const bytes = newCap * 12;
	// data.length == oldCapacity*12 >= bytes: the live prefix always fits.
	const n = allocPooledU8(bytes);
	n.set(data.subarray(0, bytes));
	releasePooledU8(data);
	return { data: n, cap: newCap };
}

function maybeShrinkGroupLayers(group: MergedMeshGroup): void {
	const op = shrinkLayer(
		group.opaqueData,
		group.opaqueCapacityFaces,
		group.opaqueSlots.appendedFaces,
	);
	if (op) {
		group.opaqueData = op.data;
		group.opaqueCapacityFaces = op.cap;
	}

	const wa = shrinkLayer(
		group.waterData,
		group.waterCapacityFaces,
		group.waterSlots.appendedFaces,
	);
	if (wa) {
		group.waterData = wa.data;
		group.waterCapacityFaces = wa.cap;
	}

	const cu = shrinkLayer(
		group.cutoutData,
		group.cutoutCapacityFaces,
		group.cutoutSlots.appendedFaces,
	);
	if (cu) {
		group.cutoutData = cu.data;
		group.cutoutCapacityFaces = cu.cap;
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
		group.opaqueData?.fill(0);
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
		group.waterData?.fill(0);
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
		group.cutoutData?.fill(0);
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
	while (opSt.released.length > 0 && group.opaqueData) {
		const r = opSt.released.pop()!;
		const b12 = r.offset * 12;
		const n12 = r.faces * 12;
		group.opaqueData.fill(0, b12, b12 + n12);
		insertSlotHole(opSt, r.offset, r.faces);
	}

	if (waSt.appendedFaces > 0)
		ensureWaterMergedCapacity(group, waSt.appendedFaces);
	else group.cachedWater = null;
	if (waSt.released.length > 0 || waSt.appendedFaces !== prevWaAppended)
		waStructChanged = true;
	while (waSt.released.length > 0 && group.waterData) {
		const r = waSt.released.pop()!;
		const b12 = r.offset * 12;
		const n12 = r.faces * 12;
		group.waterData.fill(0, b12, b12 + n12);
		insertSlotHole(waSt, r.offset, r.faces);
	}

	if (cuSt.appendedFaces > 0)
		ensureCutoutMergedCapacity(group, cuSt.appendedFaces);
	else group.cachedCutout = null;
	if (cuSt.released.length > 0 || cuSt.appendedFaces !== prevCuAppended)
		cuStructChanged = true;
	while (cuSt.released.length > 0 && group.cutoutData) {
		const r = cuSt.released.pop()!;
		const b12 = r.offset * 12;
		const n12 = r.faces * 12;
		group.cutoutData.fill(0, b12, b12 + n12);
		insertSlotHole(cuSt, r.offset, r.faces);
	}

	const opaqueData = group.opaqueData;
	const waterData = group.waterData;
	const cutoutData = group.cutoutData;

	// PERF: one u32 view per layer, created lazily on the first member whose
	// chunk index needs stamping and reused for every subsequent member. The
	// old code allocated a fresh Uint32Array view per member per layer.
	let opaqueWords: Uint32Array | null = null;
	let waterWords: Uint32Array | null = null;
	let cutoutWords: Uint32Array | null = null;

	for (let i = 0; i < memberCount; i++) {
		const m = members[i];

		// --- OPAQUE ---
		const opaque = m.opaqueData;
		const opaqueFaceCount = _opaqueFaceCounts[i];
		if (opaque && opaqueFaceCount > 0 && m.slotOpaqueFaces > 0) {
			const byteCount = opaqueFaceCount * 12;
			// Slot offsets are stable, so identity alone decides the skip.
			if (m.lastBuiltOpaque !== opaque) {
				const byteOff = m.slotOpaqueOffset * 12;
				copyFaceBytes(opaqueData!, opaque.faceData, byteCount, byteOff);

				const ci = m.localIndex;
				if (ci !== 0) {
					// Engine optimization: 32-bit SIMD vectorization instead of byte-stride loop
					const mask = IS_LITTLE_ENDIAN ? ci << 24 : ci;
					if (!opaqueWords) {
						opaqueWords = new Uint32Array(
							opaqueData!.buffer,
							opaqueData!.byteOffset,
							opaqueData!.length >>> 2,
						);
					}
					let w = (byteOff >> 2) + 2; // word2 = chunk-index lane
					for (let j = 0; j < opaqueFaceCount; j++) {
						opaqueWords[w] |= mask;
						w += 3;
					}
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
			const byteCount = waterFaceCount * 12;
			if (m.lastBuiltWater !== water) {
				const byteOff = m.slotWaterOffset * 12;
				copyFaceBytes(waterData!, water.faceData, byteCount, byteOff);

				const ci = m.localIndex;
				if (ci !== 0) {
					const mask = IS_LITTLE_ENDIAN ? ci << 24 : ci;
					if (!waterWords) {
						waterWords = new Uint32Array(
							waterData!.buffer,
							waterData!.byteOffset,
							waterData!.length >>> 2,
						);
					}
					let w = (byteOff >> 2) + 2;
					for (let j = 0; j < waterFaceCount; j++) {
						waterWords[w] |= mask;
						w += 3;
					}
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
			const byteCount = cutoutFaceCount * 12;
			if (m.lastBuiltCutout !== cutout) {
				const byteOff = m.slotCutoutOffset * 12;
				copyFaceBytes(cutoutData!, cutout.faceData, byteCount, byteOff);

				const ci = m.localIndex;
				if (ci !== 0) {
					const mask = IS_LITTLE_ENDIAN ? ci << 24 : ci;
					if (!cutoutWords) {
						cutoutWords = new Uint32Array(
							cutoutData!.buffer,
							cutoutData!.byteOffset,
							cutoutData!.length >>> 2,
						);
					}
					let w = (byteOff >> 2) + 2;
					for (let j = 0; j < cutoutFaceCount; j++) {
						cutoutWords[w] |= mask;
						w += 3;
					}
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

	// Release layer-array slack after spikes (see shrinkLayer) BEFORE
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
		const totalBytes = opSt.appendedFaces * 12;
		if (!group.opaqueVertexData)
			group.opaqueVertexData = { faceData: EMPTY_U12, faceCount: 0 };
		const vd = group.opaqueVertexData;
		vd.faceData = opaqueData!.subarray(0, totalBytes);
		vd.faceCount = opSt.appendedFaces;
		group.cachedOpaque = vd;
	}
	if (waSt.appendedFaces > 0) {
		const totalBytes = waSt.appendedFaces * 12;
		if (!group.waterVertexData)
			group.waterVertexData = { faceData: EMPTY_U12, faceCount: 0 };
		const vd = group.waterVertexData;
		vd.faceData = waterData!.subarray(0, totalBytes);
		vd.faceCount = waSt.appendedFaces;
		group.cachedWater = vd;
	}

	if (cuSt.appendedFaces > 0) {
		const totalBytes = cuSt.appendedFaces * 12;
		if (!group.cutoutVertexData)
			group.cutoutVertexData = { faceData: EMPTY_U12, faceCount: 0 };
		const vd = group.cutoutVertexData;
		vd.faceData = cutoutData!.subarray(0, totalBytes);
		vd.faceCount = cuSt.appendedFaces;
		group.cachedCutout = vd;
	}

	group.dirty = false;
}
