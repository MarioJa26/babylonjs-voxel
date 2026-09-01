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
	// when the member's own slot class changes — never because a NEIGHBOR
	// resized — so content-only rebuilds skip the copy entirely.
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
// visibility sweep even when the camera is standing still — otherwise rebuilt
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

// ---------------------------------------------------------------------------
// Allocation-light constants and scratch state
// ---------------------------------------------------------------------------

const FACE_BYTES = 12;
const FACE_WORDS = 3;
const MIN_SLOT_FACES = 32;
const COMPACT_MIN_WASTE_FACES = 1024;
const LAYER_SHRINK_MIN_CAPACITY_FACES = 2048;

// rebuildGroupData is synchronous, so one module-level result is sufficient.
const _slotResult: SlotResult = { offset: 0, faces: 0 };

interface SlotResult {
	offset: number;
	faces: number;
}

// ---------------------------------------------------------------------------
// SlotHole pool
// ---------------------------------------------------------------------------

const _slotHolePool: SlotHole[] = [];
const MAX_POOLED_SLOT_HOLES = 1024;

function allocSlotHole(offset: number, faces: number): SlotHole {
	const hole = _slotHolePool.pop();

	if (hole) {
		hole.offset = offset;
		hole.faces = faces;
		return hole;
	}

	return { offset, faces };
}

function releaseSlotHole(hole: SlotHole): void {
	if (_slotHolePool.length >= MAX_POOLED_SLOT_HOLES) return;

	hole.offset = 0;
	hole.faces = 0;
	_slotHolePool.push(hole);
}

function clearSlotHoleArray(array: SlotHole[]): void {
	for (let i = 0; i < array.length; i++) {
		releaseSlotHole(array[i]);
	}

	array.length = 0;
}

function pushReleasedSlot(
	state: SlotLayerState,
	offset: number,
	faces: number,
): void {
	if (faces > 0) {
		state.released.push(allocSlotHole(offset, faces));
	}
}

function releaseSlotLayerState(state: SlotLayerState): void {
	clearSlotHoleArray(state.holes);
	clearSlotHoleArray(state.released);
	state.appendedFaces = 0;
}

/**
 * Inserts an already-owned SlotHole into the sorted hole list.
 *
 * Ownership is transferred to this function. It either stores the record in
 * state.holes or returns it to the pool after merging it into another record.
 */
function insertOwnedSlotHole(state: SlotLayerState, hole: SlotHole): void {
	const holes = state.holes;

	let lo = 0;
	let hi = holes.length;

	while (lo < hi) {
		const mid = (lo + hi) >>> 1;

		if (holes[mid].offset < hole.offset) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}

	// Prefer merging into the left record. If that merge bridges to the
	// right record, merge all three regions without losing the right size.
	if (lo > 0) {
		const left = holes[lo - 1];

		if (left.offset + left.faces === hole.offset) {
			left.faces += hole.faces;
			releaseSlotHole(hole);

			if (lo < holes.length) {
				const right = holes[lo];

				if (left.offset + left.faces === right.offset) {
					left.faces += right.faces;
					holes.splice(lo, 1);
					releaseSlotHole(right);
				}
			}

			return;
		}
	}

	// If only the right region is adjacent, extend it to the left.
	if (lo < holes.length) {
		const right = holes[lo];

		if (hole.offset + hole.faces === right.offset) {
			right.offset = hole.offset;
			right.faces += hole.faces;
			releaseSlotHole(hole);
			return;
		}
	}

	holes.splice(lo, 0, hole);
}

/**
 * Writes the acquired slot into a caller-owned result.
 *
 * This avoids allocating `{ offset, faces }` for every slot acquisition.
 */
function acquireSlotInto(
	state: SlotLayerState,
	wantedFaces: number,
	result: SlotResult,
): void {
	const holes = state.holes;

	for (let i = 0; i < holes.length; i++) {
		const hole = holes[i];

		if (hole.faces < wantedFaces) continue;

		result.offset = hole.offset;
		result.faces = wantedFaces;

		if (hole.faces === wantedFaces) {
			holes.splice(i, 1);
			releaseSlotHole(hole);
		} else {
			hole.offset += wantedFaces;
			hole.faces -= wantedFaces;
		}

		return;
	}

	result.offset = state.appendedFaces;
	result.faces = wantedFaces;
	state.appendedFaces += wantedFaces;
}

/** Sum of free (hole) faces — the fragmentation metric for compaction. */
function slotWasteFaces(st: SlotLayerState): number {
	let sum = 0;
	for (let i = 0; i < st.holes.length; i++) sum += st.holes[i].faces;
	return sum;
}

// ---------------------------------------------------------------------------
// Bounded Uint8Array pool
// ---------------------------------------------------------------------------

const MAX_POOLED_ARRAYS_PER_SIZE = 4;
const MAX_POOLED_U8_BYTES = 32 * 1024 * 1024;

const _uint8Pool = new Map<number, Uint8Array[]>();
let _uint8PoolBytes = 0;

function allocPooledU8(bytes: number): Uint8Array {
	const list = _uint8Pool.get(bytes);

	if (list && list.length > 0) {
		const array = list.pop()!;
		_uint8PoolBytes -= bytes;

		if (list.length === 0) {
			_uint8Pool.delete(bytes);
		}

		return array;
	}

	return new Uint8Array(bytes);
}

function releasePooledU8(array: Uint8Array | null): void {
	if (!array || array.byteLength === 0) return;

	const bytes = array.byteLength;

	// Do not let one large allocation consume most of the retained pool.
	if (
		bytes > MAX_POOLED_U8_BYTES >>> 1 ||
		_uint8PoolBytes + bytes > MAX_POOLED_U8_BYTES
	) {
		return;
	}

	let list = _uint8Pool.get(bytes);

	if (!list) {
		list = [];
		_uint8Pool.set(bytes, list);
	} else if (list.length >= MAX_POOLED_ARRAYS_PER_SIZE) {
		return;
	}

	array.fill(0);
	list.push(array);
	_uint8PoolBytes += bytes;
}

// ---------------------------------------------------------------------------
// Allocation-light copies
// ---------------------------------------------------------------------------

function copyFaceBytes(
	destination: Uint8Array,
	source: Uint8Array,
	byteCount: number,
	destinationByteOffset: number,
): void {
	destination.set(source.subarray(0, byteCount), destinationByteOffset);
}

function copyPrefix(
	destination: Uint8Array,
	source: Uint8Array,
	byteCount: number,
): void {
	destination.set(source.subarray(0, byteCount), 0);
}

// ---------------------------------------------------------------------------
// Slot sizing
// ---------------------------------------------------------------------------

function slotClassFor(count: number, maximumFaces: number): number {
	let size = MIN_SLOT_FACES;

	while (size < count) {
		const next = size * 2;

		if (next > maximumFaces) {
			return maximumFaces;
		}

		size = next;
	}

	return size;
}

// ---------------------------------------------------------------------------
// Range pool & dirty-range helpers
// ---------------------------------------------------------------------------

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
// Module-level state continued
// ---------------------------------------------------------------------------

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

let _requestFlush: (() => void) | null = null;

export function setRequestFlush(cb: () => void): void {
	_requestFlush = cb;
}

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

	const member = group.members.get(chunk.numericId);

	if (member) {
		pushReleasedSlot(
			group.opaqueSlots,
			member.slotOpaqueOffset,
			member.slotOpaqueFaces,
		);
		pushReleasedSlot(
			group.waterSlots,
			member.slotWaterOffset,
			member.slotWaterFaces,
		);
		pushReleasedSlot(
			group.cutoutSlots,
			member.slotCutoutOffset,
			member.slotCutoutFaces,
		);
	}

	group.members.delete(chunk.numericId);

	if (group.members.size === 0) {
		if (group.opaqueMeshRef) {
			disposeGroupMesh(group.opaqueMeshRef);
		}

		if (group.waterMeshRef) {
			disposeGroupMesh(group.waterMeshRef);
		}

		if (group.cutoutMeshRef) {
			disposeGroupMesh(group.cutoutMeshRef);
		}

		releasePooledU8(group.opaqueData);
		releasePooledU8(group.waterData);
		releasePooledU8(group.cutoutData);

		releaseSlotLayerState(group.opaqueSlots);
		releaseSlotLayerState(group.waterSlots);
		releaseSlotLayerState(group.cutoutSlots);

		groups.delete(groupKey);
		dirtyGroups.delete(group);

		clearDiscardedGroup(group);

		_groupsMutatedSinceSweep = true;
		return;
	}

	const members = group.membersArray;
	const removedId = chunk.numericId;

	let writeIndex = 0;
	let minimumLod = Infinity;

	for (let i = 0; i < members.length; i++) {
		const current = members[i];

		if (current.chunkId === removedId) continue;

		members[writeIndex++] = current;

		const lod = current.chunk.lodLevel ?? 0;

		if (lod < minimumLod) {
			minimumLod = lod;
		}
	}

	members.length = writeIndex;
	group.minLodLevel = minimumLod;

	invalidateGroupBuildCache(group);
	markGroupDirty(group);
}
function validateSettledSlotExtents(
	group: MergedMeshGroup,
	maximumFaces: number,
): boolean {
	const opaqueExtent = group.opaqueSlots.appendedFaces;
	const waterExtent = group.waterSlots.appendedFaces;
	const cutoutExtent = group.cutoutSlots.appendedFaces;

	if (
		opaqueExtent <= maximumFaces &&
		waterExtent <= maximumFaces &&
		cutoutExtent <= maximumFaces
	) {
		return true;
	}

	console.warn(
		`[MergedMeshManager] group (${group.gridX}, ${group.gridY}, ` +
			`${group.gridZ}) lod bucket ${group.lodBucket} exceeds the ` +
			`per-mesh arena limit after slot padding ` +
			`(opaque ${opaqueExtent}, water ${waterExtent}, ` +
			`cutout ${cutoutExtent}, max ${maximumFaces} faces).`,
	);

	return false;
}

let _lastMergedFlushMs = 0;
let _mergedFlushTotalMs = 0;
let _mergedFlushCount = 0;

// PERF instrumentation for the stable-slot layout: how many member copies the
// skip-check avoided vs performed, and how many face bytes were marked dirty
// for GPU upload. Healthy numbers: copies ≪ members×layers during bursts,
// dirtyBytes ≈ actually-changed content (not whole-group rewrites).
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

	const startedAt = performance.now();
	const deadline =
		maxBudgetMs > 0 ? startedAt + maxBudgetMs : Number.POSITIVE_INFINITY;

	_statMembersSeen = 0;
	_statCopiesPerformed = 0;
	_statDirtyFacesFlush = 0;
	_statWasteFacesMax = 0;

	let processedCount = 0;
	let budgetExhausted = false;

	/*
	 * Delete each group immediately before processing it rather than copying
	 * the entire Set into _flushSnapshot and clearing it.
	 *
	 * This has two useful properties:
	 * 1. No O(n) snapshot copy is required.
	 * 2. If rebuildGroupData() or the callback dirties the group again,
	 *    markGroupDirty() can safely add it back to dirtyGroups.
	 */
	for (const group of dirtyGroups) {
		if (processedCount !== 0 && performance.now() >= deadline) {
			budgetExhausted = true;
			break;
		}

		dirtyGroups.delete(group);

		/*
		 * Ignore groups that were removed or superseded after being queued.
		 * Checking Map identity also handles a newly created group that happens
		 * to reuse the same numeric key.
		 */
		if (!group.dirty || groups.get(group.groupKey) !== group) {
			continue;
		}

		rebuildGroupData(group);

		/*
		 * rebuildGroupData() can deliberately leave a group dirty when its
		 * settled slot extent exceeds the arena limit. Requeue it only when a
		 * custom scheduler exists, otherwise the zero-delay fallback would
		 * create an unbounded retry loop with no state change.
		 */
		if (group.dirty) {
			if (_requestFlush) {
				dirtyGroups.add(group);
			}
		} else {
			_onGroupMeshNeedsRebuild?.(group);
		}

		processedCount++;
	}

	/*
	 * The Set already contains all unprocessed groups because entries are
	 * removed only immediately before they are processed. It may additionally
	 * contain groups dirtied during rebuild callbacks.
	 */
	if (dirtyGroups.size > 0) {
		if (_requestFlush) {
			_requestFlush();
		} else if (budgetExhausted && !_mergedFlushRafScheduled) {
			_mergedFlushRafScheduled = true;

			setTimeout(() => {
				_mergedFlushRafScheduled = false;
				flushDirtyMergedGroups(maxBudgetMs);
			}, 0);
		}
	}

	const elapsed = performance.now() - startedAt;
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

		releaseSlotLayerState(group.opaqueSlots);
		releaseSlotLayerState(group.waterSlots);
		releaseSlotLayerState(group.cutoutSlots);

		group.cachedOpaque = null;
		group.cachedWater = null;
		group.cachedCutout = null;

		group.opaqueVertexData = null;
		group.waterVertexData = null;
		group.cutoutVertexData = null;

		group.opaqueData = null;
		group.waterData = null;
		group.cutoutData = null;

		group.opaqueCapacityFaces = 0;
		group.waterCapacityFaces = 0;
		group.cutoutCapacityFaces = 0;

		group.members.clear();
		group.membersArray.length = 0;
	}

	groups.clear();
	dirtyGroups.clear();
	_flushSnapshot.length = 0;
	_allGroupsReuse.length = 0;
}

// ---------------------------------------------------------------------------
// Internal: rebuild combined vertex data
// ---------------------------------------------------------------------------

// Growth now WHOLESALE-COPIES the old buffers (`.set`) instead of handing back
// fresh zeroed arrays: slot contents stay valid, so no member invalidation and
// no mass recopy on the next pass. The geometric slack above the slot extent
// is harmless — vertex data is exposed as a subarray limited to the slot
// extent, so the mesh's face count only changes when slots are acquired.

function ensureOpaqueMergedCapacity(
	group: MergedMeshGroup,
	faceCount: number,
	maximumFaces: number,
): void {
	let capacity = group.opaqueCapacityFaces;
	if (capacity >= faceCount) return;

	capacity = Math.min(
		Math.max(faceCount, capacity > 0 ? capacity * 2 : 0, 256),
		maximumFaces,
	);

	const next = allocPooledU8(capacity * FACE_BYTES);
	const previous = group.opaqueData;

	if (previous) {
		next.set(previous);
		releasePooledU8(previous);
	}

	group.opaqueData = next;
	group.opaqueCapacityFaces = capacity;
}

function ensureWaterMergedCapacity(
	group: MergedMeshGroup,
	faceCount: number,
	maximumFaces: number,
): void {
	let capacity = group.waterCapacityFaces;
	if (capacity >= faceCount) return;

	capacity = Math.min(
		Math.max(faceCount, capacity > 0 ? capacity * 2 : 0, 256),
		maximumFaces,
	);

	const next = allocPooledU8(capacity * FACE_BYTES);
	const previous = group.waterData;

	if (previous) {
		next.set(previous);
		releasePooledU8(previous);
	}

	group.waterData = next;
	group.waterCapacityFaces = capacity;
}

function ensureCutoutMergedCapacity(
	group: MergedMeshGroup,
	faceCount: number,
	maximumFaces: number,
): void {
	let capacity = group.cutoutCapacityFaces;
	if (capacity >= faceCount) return;

	capacity = Math.min(
		Math.max(faceCount, capacity > 0 ? capacity * 2 : 0, 256),
		maximumFaces,
	);

	const next = allocPooledU8(capacity * FACE_BYTES);
	const previous = group.cutoutData;

	if (previous) {
		next.set(previous);
		releasePooledU8(previous);
	}

	group.cutoutData = next;
	group.cutoutCapacityFaces = capacity;
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
// Allocation-light shrinking
// ---------------------------------------------------------------------------

function shrinkGroupLayer(
	group: MergedMeshGroup,
	kind: 0 | 1 | 2,
	extentFaces: number,
): void {
	let data: Uint8Array | null;
	let capacityFaces: number;

	if (kind === 0) {
		data = group.opaqueData;
		capacityFaces = group.opaqueCapacityFaces;
	} else if (kind === 1) {
		data = group.waterData;
		capacityFaces = group.waterCapacityFaces;
	} else {
		data = group.cutoutData;
		capacityFaces = group.cutoutCapacityFaces;
	}

	if (
		!data ||
		capacityFaces < LAYER_SHRINK_MIN_CAPACITY_FACES ||
		extentFaces > capacityFaces ||
		extentFaces * 4 > capacityFaces
	) {
		return;
	}

	const newCapacity = Math.max(256, Math.min(extentFaces * 2, capacityFaces));

	if (newCapacity >= capacityFaces) return;

	const byteLength = newCapacity * FACE_BYTES;
	const next = allocPooledU8(byteLength);

	copyPrefix(next, data, byteLength);
	releasePooledU8(data);

	if (kind === 0) {
		group.opaqueData = next;
		group.opaqueCapacityFaces = newCapacity;
	} else if (kind === 1) {
		group.waterData = next;
		group.waterCapacityFaces = newCapacity;
	} else {
		group.cutoutData = next;
		group.cutoutCapacityFaces = newCapacity;
	}
}

function maybeShrinkGroupLayers(group: MergedMeshGroup): void {
	shrinkGroupLayer(group, 0, group.opaqueSlots.appendedFaces);
	shrinkGroupLayer(group, 1, group.waterSlots.appendedFaces);
	shrinkGroupLayer(group, 2, group.cutoutSlots.appendedFaces);
}

// ---------------------------------------------------------------------------
// Vertex-data view reuse
// ---------------------------------------------------------------------------

function exposeLayerData(
	vertexData: MergedVertexData | null,
	backing: Uint8Array,
	faceCount: number,
): MergedVertexData {
	const byteLength = faceCount * FACE_BYTES;

	if (!vertexData) {
		return {
			faceData: backing.subarray(0, byteLength),
			faceCount,
		};
	}

	const current = vertexData.faceData;

	if (
		current.buffer !== backing.buffer ||
		current.byteOffset !== backing.byteOffset ||
		current.byteLength !== byteLength
	) {
		vertexData.faceData = backing.subarray(0, byteLength);
	}

	vertexData.faceCount = faceCount;
	return vertexData;
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

function newSlotLayerState(): SlotLayerState {
	return { holes: [], released: [], appendedFaces: 0 };
}

function rebuildGroupData(group: MergedMeshGroup): void {
	const members = group.membersArray;
	const memberCount = members.length;

	_statMembersSeen += memberCount;

	let opaqueRanges = group.dirtyOpaqueRanges;

	if (opaqueRanges) {
		for (let i = 0; i < opaqueRanges.length; i++) {
			_rangePool.push(opaqueRanges[i]);
		}

		opaqueRanges.length = 0;
	} else {
		opaqueRanges = [];
		group.dirtyOpaqueRanges = opaqueRanges;
	}

	let waterRanges = group.dirtyWaterRanges;

	if (waterRanges) {
		for (let i = 0; i < waterRanges.length; i++) {
			_rangePool.push(waterRanges[i]);
		}

		waterRanges.length = 0;
	} else {
		waterRanges = [];
		group.dirtyWaterRanges = waterRanges;
	}

	let cutoutRanges = group.dirtyCutoutRanges;

	if (cutoutRanges) {
		for (let i = 0; i < cutoutRanges.length; i++) {
			_rangePool.push(cutoutRanges[i]);
		}

		cutoutRanges.length = 0;
	} else {
		cutoutRanges = [];
		group.dirtyCutoutRanges = cutoutRanges;
	}

	let totalOpaque = 0;
	let totalWater = 0;
	let totalCutout = 0;

	for (let i = 0; i < memberCount; i++) {
		const member = members[i];
		const lod = member.chunk.lodLevel ?? 0;

		const opaqueCount = getValidatedFaceCount(
			member.opaqueData,
			member.chunkId,
			lod,
			"opaque",
		);
		const waterCount = getValidatedFaceCount(
			member.waterData,
			member.chunkId,
			lod,
			"water",
		);
		const cutoutCount = getValidatedFaceCount(
			member.cutoutData,
			member.chunkId,
			lod,
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

	const opaqueState = group.opaqueSlots;
	const waterState = group.waterSlots;
	const cutoutState = group.cutoutSlots;
	const maximumFaces = maxFacesPerArena();

	if (
		totalOpaque > maximumFaces ||
		totalWater > maximumFaces ||
		totalCutout > maximumFaces ||
		opaqueState.appendedFaces > maximumFaces ||
		waterState.appendedFaces > maximumFaces ||
		cutoutState.appendedFaces > maximumFaces
	) {
		console.warn(
			`[MergedMeshManager] group (${group.gridX}, ${group.gridY}, ` +
				`${group.gridZ}) lod bucket ${group.lodBucket} exceeds the ` +
				`per-mesh arena limit (opaque ${totalOpaque}/` +
				`${opaqueState.appendedFaces}, water ${totalWater}/` +
				`${waterState.appendedFaces}, cutout ${totalCutout}/` +
				`${cutoutState.appendedFaces}, max ${maximumFaces} faces).`,
		);

		group.dirty = false;
		return;
	}

	const opaqueWaste = slotWasteFaces(opaqueState);
	const waterWaste = slotWasteFaces(waterState);
	const cutoutWaste = slotWasteFaces(cutoutState);
	const totalWaste = opaqueWaste + waterWaste + cutoutWaste;

	if (totalWaste > _statWasteFacesMax) {
		_statWasteFacesMax = totalWaste;
	}

	const previousOpaqueExtent = opaqueState.appendedFaces;
	const previousWaterExtent = waterState.appendedFaces;
	const previousCutoutExtent = cutoutState.appendedFaces;

	let opaqueStructuralChange = false;
	let waterStructuralChange = false;
	let cutoutStructuralChange = false;

	if (
		opaqueState.appendedFaces > 0 &&
		opaqueWaste > COMPACT_MIN_WASTE_FACES &&
		opaqueWaste * 2 > opaqueState.appendedFaces
	) {
		clearSlotHoleArray(opaqueState.holes);
		clearSlotHoleArray(opaqueState.released);
		opaqueState.appendedFaces = 0;
		opaqueStructuralChange = true;

		group.opaqueData?.fill(0);

		for (let i = 0; i < memberCount; i++) {
			const member = members[i];

			member.slotOpaqueOffset = 0;
			member.slotOpaqueFaces = 0;
			member.lastBuiltOpaque = null;
			member.lastBuiltOpaqueOffset = -1;
		}
	}

	if (
		waterState.appendedFaces > 0 &&
		waterWaste > COMPACT_MIN_WASTE_FACES &&
		waterWaste * 2 > waterState.appendedFaces
	) {
		clearSlotHoleArray(waterState.holes);
		clearSlotHoleArray(waterState.released);
		waterState.appendedFaces = 0;
		waterStructuralChange = true;

		group.waterData?.fill(0);

		for (let i = 0; i < memberCount; i++) {
			const member = members[i];

			member.slotWaterOffset = 0;
			member.slotWaterFaces = 0;
			member.lastBuiltWater = null;
			member.lastBuiltWaterOffset = -1;
		}
	}

	if (
		cutoutState.appendedFaces > 0 &&
		cutoutWaste > COMPACT_MIN_WASTE_FACES &&
		cutoutWaste * 2 > cutoutState.appendedFaces
	) {
		clearSlotHoleArray(cutoutState.holes);
		clearSlotHoleArray(cutoutState.released);
		cutoutState.appendedFaces = 0;
		cutoutStructuralChange = true;

		group.cutoutData?.fill(0);

		for (let i = 0; i < memberCount; i++) {
			const member = members[i];

			member.slotCutoutOffset = 0;
			member.slotCutoutFaces = 0;
			member.lastBuiltCutout = null;
			member.lastBuiltCutoutOffset = -1;
		}
	}

	for (let i = 0; i < memberCount; i++) {
		const member = members[i];

		const opaqueCount = _opaqueFaceCounts[i];

		if (opaqueCount === 0) {
			if (member.slotOpaqueFaces > 0) {
				pushReleasedSlot(
					opaqueState,
					member.slotOpaqueOffset,
					member.slotOpaqueFaces,
				);

				member.slotOpaqueOffset = 0;
				member.slotOpaqueFaces = 0;
				member.lastBuiltOpaque = null;
				member.lastBuiltOpaqueOffset = -1;
			}
		} else {
			const wantedFaces = slotClassFor(opaqueCount, maximumFaces);

			if (member.slotOpaqueFaces !== wantedFaces) {
				pushReleasedSlot(
					opaqueState,
					member.slotOpaqueOffset,
					member.slotOpaqueFaces,
				);

				acquireSlotInto(opaqueState, wantedFaces, _slotResult);

				member.slotOpaqueOffset = _slotResult.offset;
				member.slotOpaqueFaces = _slotResult.faces;
				member.lastBuiltOpaque = null;
				member.lastBuiltOpaqueOffset = -1;
			}
		}

		const waterCount = _waterFaceCounts[i];

		if (waterCount === 0) {
			if (member.slotWaterFaces > 0) {
				pushReleasedSlot(
					waterState,
					member.slotWaterOffset,
					member.slotWaterFaces,
				);

				member.slotWaterOffset = 0;
				member.slotWaterFaces = 0;
				member.lastBuiltWater = null;
				member.lastBuiltWaterOffset = -1;
			}
		} else {
			const wantedFaces = slotClassFor(waterCount, maximumFaces);

			if (member.slotWaterFaces !== wantedFaces) {
				pushReleasedSlot(
					waterState,
					member.slotWaterOffset,
					member.slotWaterFaces,
				);

				acquireSlotInto(waterState, wantedFaces, _slotResult);

				member.slotWaterOffset = _slotResult.offset;
				member.slotWaterFaces = _slotResult.faces;
				member.lastBuiltWater = null;
				member.lastBuiltWaterOffset = -1;
			}
		}

		const cutoutCount = _cutoutFaceCounts[i];

		if (cutoutCount === 0) {
			if (member.slotCutoutFaces > 0) {
				pushReleasedSlot(
					cutoutState,
					member.slotCutoutOffset,
					member.slotCutoutFaces,
				);

				member.slotCutoutOffset = 0;
				member.slotCutoutFaces = 0;
				member.lastBuiltCutout = null;
				member.lastBuiltCutoutOffset = -1;
			}
		} else {
			const wantedFaces = slotClassFor(cutoutCount, maximumFaces);

			if (member.slotCutoutFaces !== wantedFaces) {
				pushReleasedSlot(
					cutoutState,
					member.slotCutoutOffset,
					member.slotCutoutFaces,
				);

				acquireSlotInto(cutoutState, wantedFaces, _slotResult);

				member.slotCutoutOffset = _slotResult.offset;
				member.slotCutoutFaces = _slotResult.faces;
				member.lastBuiltCutout = null;
				member.lastBuiltCutoutOffset = -1;
			}
		}
	}

	/*
	 * This check must happen after slot acquisition because padding, not just
	 * actual face totals, determines backing-array size.
	 */
	if (!validateSettledSlotExtents(group, maximumFaces)) {
		/*
		 * Keep the group dirty so a higher-level fallback or arena resizing
		 * policy can retry it. Marking it clean here would silently freeze the
		 * previous mesh contents.
		 */
		group.dirty = true;
		return;
	}

	if (opaqueState.appendedFaces > 0) {
		ensureOpaqueMergedCapacity(group, opaqueState.appendedFaces, maximumFaces);
	} else {
		group.cachedOpaque = null;
	}

	if (
		opaqueState.released.length > 0 ||
		opaqueState.appendedFaces !== previousOpaqueExtent
	) {
		opaqueStructuralChange = true;
	}

	while (opaqueState.released.length > 0 && group.opaqueData) {
		const released = opaqueState.released.pop()!;
		const begin = released.offset * FACE_BYTES;
		const end = begin + released.faces * FACE_BYTES;

		group.opaqueData.fill(0, begin, end);
		insertOwnedSlotHole(opaqueState, released);
	}

	if (waterState.appendedFaces > 0) {
		ensureWaterMergedCapacity(group, waterState.appendedFaces, maximumFaces);
	} else {
		group.cachedWater = null;
	}

	if (
		waterState.released.length > 0 ||
		waterState.appendedFaces !== previousWaterExtent
	) {
		waterStructuralChange = true;
	}

	while (waterState.released.length > 0 && group.waterData) {
		const released = waterState.released.pop()!;
		const begin = released.offset * FACE_BYTES;
		const end = begin + released.faces * FACE_BYTES;

		group.waterData.fill(0, begin, end);
		insertOwnedSlotHole(waterState, released);
	}

	if (cutoutState.appendedFaces > 0) {
		ensureCutoutMergedCapacity(group, cutoutState.appendedFaces, maximumFaces);
	} else {
		group.cachedCutout = null;
	}

	if (
		cutoutState.released.length > 0 ||
		cutoutState.appendedFaces !== previousCutoutExtent
	) {
		cutoutStructuralChange = true;
	}

	while (cutoutState.released.length > 0 && group.cutoutData) {
		const released = cutoutState.released.pop()!;
		const begin = released.offset * FACE_BYTES;
		const end = begin + released.faces * FACE_BYTES;

		group.cutoutData.fill(0, begin, end);
		insertOwnedSlotHole(cutoutState, released);
	}

	const opaqueData = group.opaqueData;
	const waterData = group.waterData;
	const cutoutData = group.cutoutData;

	let opaqueWords: Uint32Array | null = null;
	let waterWords: Uint32Array | null = null;
	let cutoutWords: Uint32Array | null = null;

	for (let i = 0; i < memberCount; i++) {
		const member = members[i];
		const chunkIndex = member.localIndex;
		const chunkMask = IS_LITTLE_ENDIAN ? chunkIndex * 0x1000000 : chunkIndex;

		const opaque = member.opaqueData;
		const opaqueFaceCount = _opaqueFaceCounts[i];

		if (
			opaqueData &&
			opaque &&
			opaqueFaceCount > 0 &&
			member.slotOpaqueFaces > 0 &&
			member.lastBuiltOpaque !== opaque
		) {
			const byteOffset = member.slotOpaqueOffset * FACE_BYTES;

			copyFaceBytes(
				opaqueData,
				opaque.faceData,
				opaqueFaceCount * FACE_BYTES,
				byteOffset,
			);

			if (chunkIndex !== 0) {
				opaqueWords ??= new Uint32Array(
					opaqueData.buffer,
					opaqueData.byteOffset,
					opaqueData.byteLength >>> 2,
				);

				let wordIndex = (byteOffset >>> 2) + 2;
				const wordEnd = wordIndex + opaqueFaceCount * FACE_WORDS;

				for (; wordIndex < wordEnd; wordIndex += FACE_WORDS) {
					opaqueWords[wordIndex] |= chunkMask;
				}
			}

			member.lastBuiltOpaque = opaque;
			member.lastBuiltOpaqueOffset = byteOffset;
			_statCopiesPerformed++;

			if (!opaqueStructuralChange) {
				pushDirtyRange(opaqueRanges, member.slotOpaqueOffset, opaqueFaceCount);
			}
		}

		const water = member.waterData;
		const waterFaceCount = _waterFaceCounts[i];

		if (
			waterData &&
			water &&
			waterFaceCount > 0 &&
			member.slotWaterFaces > 0 &&
			member.lastBuiltWater !== water
		) {
			const byteOffset = member.slotWaterOffset * FACE_BYTES;

			copyFaceBytes(
				waterData,
				water.faceData,
				waterFaceCount * FACE_BYTES,
				byteOffset,
			);

			if (chunkIndex !== 0) {
				waterWords ??= new Uint32Array(
					waterData.buffer,
					waterData.byteOffset,
					waterData.byteLength >>> 2,
				);

				let wordIndex = (byteOffset >>> 2) + 2;
				const wordEnd = wordIndex + waterFaceCount * FACE_WORDS;

				for (; wordIndex < wordEnd; wordIndex += FACE_WORDS) {
					waterWords[wordIndex] |= chunkMask;
				}
			}

			member.lastBuiltWater = water;
			member.lastBuiltWaterOffset = byteOffset;
			_statCopiesPerformed++;

			if (!waterStructuralChange) {
				pushDirtyRange(waterRanges, member.slotWaterOffset, waterFaceCount);
			}
		}

		const cutout = member.cutoutData;
		const cutoutFaceCount = _cutoutFaceCounts[i];

		if (
			cutoutData &&
			cutout &&
			cutoutFaceCount > 0 &&
			member.slotCutoutFaces > 0 &&
			member.lastBuiltCutout !== cutout
		) {
			const byteOffset = member.slotCutoutOffset * FACE_BYTES;

			copyFaceBytes(
				cutoutData,
				cutout.faceData,
				cutoutFaceCount * FACE_BYTES,
				byteOffset,
			);

			if (chunkIndex !== 0) {
				cutoutWords ??= new Uint32Array(
					cutoutData.buffer,
					cutoutData.byteOffset,
					cutoutData.byteLength >>> 2,
				);

				let wordIndex = (byteOffset >>> 2) + 2;
				const wordEnd = wordIndex + cutoutFaceCount * FACE_WORDS;

				for (; wordIndex < wordEnd; wordIndex += FACE_WORDS) {
					cutoutWords[wordIndex] |= chunkMask;
				}
			}

			member.lastBuiltCutout = cutout;
			member.lastBuiltCutoutOffset = byteOffset;
			_statCopiesPerformed++;

			if (!cutoutStructuralChange) {
				pushDirtyRange(cutoutRanges, member.slotCutoutOffset, cutoutFaceCount);
			}
		}
	}

	if (opaqueStructuralChange && opaqueState.appendedFaces > 0) {
		pushDirtyRange(opaqueRanges, 0, opaqueState.appendedFaces);
	}

	if (waterStructuralChange && waterState.appendedFaces > 0) {
		pushDirtyRange(waterRanges, 0, waterState.appendedFaces);
	}

	if (cutoutStructuralChange && cutoutState.appendedFaces > 0) {
		pushDirtyRange(cutoutRanges, 0, cutoutState.appendedFaces);
	}

	maybeShrinkGroupLayers(group);

	const finalOpaqueData = group.opaqueData;
	const finalWaterData = group.waterData;
	const finalCutoutData = group.cutoutData;

	if (opaqueState.appendedFaces > 0 && finalOpaqueData) {
		const vertexData = exposeLayerData(
			group.opaqueVertexData,
			finalOpaqueData,
			opaqueState.appendedFaces,
		);

		group.opaqueVertexData = vertexData;
		group.cachedOpaque = vertexData;
	} else {
		group.cachedOpaque = null;
	}

	if (waterState.appendedFaces > 0 && finalWaterData) {
		const vertexData = exposeLayerData(
			group.waterVertexData,
			finalWaterData,
			waterState.appendedFaces,
		);

		group.waterVertexData = vertexData;
		group.cachedWater = vertexData;
	} else {
		group.cachedWater = null;
	}

	if (cutoutState.appendedFaces > 0 && finalCutoutData) {
		const vertexData = exposeLayerData(
			group.cutoutVertexData,
			finalCutoutData,
			cutoutState.appendedFaces,
		);

		group.cutoutVertexData = vertexData;
		group.cachedCutout = vertexData;
	} else {
		group.cachedCutout = null;
	}

	group.dirty = false;
}

function clearDiscardedGroup(group: MergedMeshGroup): void {
	group.members.clear();
	group.membersArray.length = 0;

	group.cachedOpaque = null;
	group.cachedWater = null;
	group.cachedCutout = null;

	group.opaqueVertexData = null;
	group.waterVertexData = null;
	group.cutoutVertexData = null;

	group.opaqueData = null;
	group.waterData = null;
	group.cutoutData = null;

	group.opaqueCapacityFaces = 0;
	group.waterCapacityFaces = 0;
	group.cutoutCapacityFaces = 0;

	group.dirtyOpaqueRanges = null;
	group.dirtyWaterRanges = null;
	group.dirtyCutoutRanges = null;

	group.opaqueMeshRef = null;
	group.waterMeshRef = null;
	group.cutoutMeshRef = null;

	group.dirty = false;
}
