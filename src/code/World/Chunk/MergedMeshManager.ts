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
	_requestFlush?.();
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

export function getMergedMeshFlushStats(): { lastMs: number; avgMs: number } {
	return {
		lastMs: _lastMergedFlushMs,
		avgMs: _mergedFlushCount > 0 ? _mergedFlushTotalMs / _mergedFlushCount : 0,
	};
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
		const maxFaces = maxFacesPerArena();
		capacity = Math.min(Math.max(faceCount, capacity << 1, 256), maxFaces);
		group.opaqueCapacityFaces = capacity;
		const byte4 = capacity << 2;
		const a = new Uint8Array(byte4),
			b = new Uint8Array(byte4),
			c = new Uint8Array(byte4);
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
		`[MergedMeshManager] chunk #${chunkId} (lod ${lod}) ${kindName} faceCount (${raw}) inconsistent with buffer lengths (${aLen}/${bLen}/${cLen} bytes) — using ${derived} instead.`,
	);
	return derived;
}

function rebuildGroupData(group: MergedMeshGroup): void {
	const members = group.membersArray;
	const memberCount = members.length;

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

	const maxGroupFaces = maxFacesPerArena();
	if (
		totalOpaque > maxGroupFaces ||
		totalWater > maxGroupFaces ||
		totalCutout > maxGroupFaces
	) {
		console.warn(
			`[MergedMeshManager] group (${group.gridX}, ${group.gridY}, ${group.gridZ}) lod bucket ${group.lodBucket} exceeds the per-mesh arena limit (opaque ${totalOpaque}, water ${totalWater}, cutout ${totalCutout}, max ${maxGroupFaces} faces) — mesh rebuild skipped.`,
		);
		group.dirty = false;
		return;
	}

	const opaqueGrew = totalOpaque > group.opaqueCapacityFaces;
	const waterGrew = totalWater > group.waterCapacityFaces;
	const cutoutGrew = totalCutout > group.cutoutCapacityFaces;

	let opaqueA: Uint8Array | null = null,
		opaqueB: Uint8Array | null = null,
		opaqueC: Uint8Array | null = null;
	let waterA: Uint8Array | null = null,
		waterB: Uint8Array | null = null,
		waterC: Uint8Array | null = null;
	let cutoutA: Uint8Array | null = null,
		cutoutB: Uint8Array | null = null,
		cutoutC: Uint8Array | null = null;

	if (totalOpaque > 0) {
		const buffers = ensureOpaqueMergedCapacity(group, totalOpaque);
		opaqueA = buffers.a;
		opaqueB = buffers.b;
		opaqueC = buffers.c;
		if (opaqueGrew)
			for (let i = 0; i < memberCount; i++) {
				members[i].lastBuiltOpaque = null;
				members[i].lastBuiltOpaqueOffset = -1;
			}
	} else group.cachedOpaque = null;

	if (totalWater > 0) {
		const buffers = ensureWaterMergedCapacity(group, totalWater);
		waterA = buffers.a;
		waterB = buffers.b;
		waterC = buffers.c;
		if (waterGrew)
			for (let i = 0; i < memberCount; i++) {
				members[i].lastBuiltWater = null;
				members[i].lastBuiltWaterOffset = -1;
			}
	} else group.cachedWater = null;

	if (totalCutout > 0) {
		const buffers = ensureCutoutMergedCapacity(group, totalCutout);
		cutoutA = buffers.a;
		cutoutB = buffers.b;
		cutoutC = buffers.c;
		if (cutoutGrew)
			for (let i = 0; i < memberCount; i++) {
				members[i].lastBuiltCutout = null;
				members[i].lastBuiltCutoutOffset = -1;
			}
	} else group.cachedCutout = null;

	let opaqueWriteByte = 0,
		opaqueWriteFace = 0;
	let waterWriteByte = 0,
		waterWriteFace = 0;
	let cutoutWriteByte = 0,
		cutoutWriteFace = 0;

	for (let i = 0; i < memberCount; i++) {
		const m = members[i];

		// --- OPAQUE ---
		const opaque = m.opaqueData;
		const opaqueFaceCount = _opaqueFaceCounts[i];
		if (opaque && opaqueFaceCount > 0) {
			const byteCount = opaqueFaceCount << 2;
			if (
				m.lastBuiltOpaque !== opaque ||
				m.lastBuiltOpaqueOffset !== opaqueWriteByte
			) {
				copyFaceBytes(opaqueA!, opaque.faceDataA, byteCount, opaqueWriteByte);
				copyFaceBytes(opaqueB!, opaque.faceDataB, byteCount, opaqueWriteByte);
				copyFaceBytes(opaqueC!, opaque.faceDataC, byteCount, opaqueWriteByte);

				const ci = m.localIndex;
				if (ci !== 0) {
					// Engine optimization: 32-bit SIMD vectorization instead of byte-stride loop
					const mask = IS_LITTLE_ENDIAN ? ci << 24 : ci;
					const c32 = new Uint32Array(
						opaqueC!.buffer,
						opaqueC!.byteOffset + opaqueWriteByte,
						opaqueFaceCount,
					);
					for (let j = 0; j < opaqueFaceCount; j++) c32[j] |= mask;
				}
				m.lastBuiltOpaque = opaque;
				m.lastBuiltOpaqueOffset = opaqueWriteByte;
				pushDirtyRange(opaqueRanges, opaqueWriteFace, opaqueFaceCount);
			}
			opaqueWriteByte += byteCount;
			opaqueWriteFace += opaqueFaceCount;
		}

		// --- WATER ---
		const water = m.waterData;
		const waterFaceCount = _waterFaceCounts[i];
		if (water && waterFaceCount > 0) {
			const byteCount = waterFaceCount << 2;
			if (
				m.lastBuiltWater !== water ||
				m.lastBuiltWaterOffset !== waterWriteByte
			) {
				copyFaceBytes(waterA!, water.faceDataA, byteCount, waterWriteByte);
				copyFaceBytes(waterB!, water.faceDataB, byteCount, waterWriteByte);
				copyFaceBytes(waterC!, water.faceDataC, byteCount, waterWriteByte);

				const ci = m.localIndex;
				if (ci !== 0) {
					const mask = IS_LITTLE_ENDIAN ? ci << 24 : ci;
					const c32 = new Uint32Array(
						waterC!.buffer,
						waterC!.byteOffset + waterWriteByte,
						waterFaceCount,
					);
					for (let j = 0; j < waterFaceCount; j++) c32[j] |= mask;
				}
				m.lastBuiltWater = water;
				m.lastBuiltWaterOffset = waterWriteByte;
				pushDirtyRange(waterRanges, waterWriteFace, waterFaceCount);
			}
			waterWriteByte += byteCount;
			waterWriteFace += waterFaceCount;
		}

		// --- CUTOUT ---
		const cutout = m.cutoutData;
		const cutoutFaceCount = _cutoutFaceCounts[i];
		if (cutout && cutoutFaceCount > 0) {
			const byteCount = cutoutFaceCount << 2;
			if (
				m.lastBuiltCutout !== cutout ||
				m.lastBuiltCutoutOffset !== cutoutWriteByte
			) {
				copyFaceBytes(cutoutA!, cutout.faceDataA, byteCount, cutoutWriteByte);
				copyFaceBytes(cutoutB!, cutout.faceDataB, byteCount, cutoutWriteByte);
				copyFaceBytes(cutoutC!, cutout.faceDataC, byteCount, cutoutWriteByte);

				const ci = m.localIndex;
				if (ci !== 0) {
					const mask = IS_LITTLE_ENDIAN ? ci << 24 : ci;
					const c32 = new Uint32Array(
						cutoutC!.buffer,
						cutoutC!.byteOffset + cutoutWriteByte,
						cutoutFaceCount,
					);
					for (let j = 0; j < cutoutFaceCount; j++) c32[j] |= mask;
				}
				m.lastBuiltCutout = cutout;
				m.lastBuiltCutoutOffset = cutoutWriteByte;
				pushDirtyRange(cutoutRanges, cutoutWriteFace, cutoutFaceCount);
			}
			cutoutWriteByte += byteCount;
			cutoutWriteFace += cutoutFaceCount;
		}
	}

	// Wrap up vertex data buffers
	if (totalOpaque > 0) {
		const totalBytes = totalOpaque << 2;
		if (!group.opaqueVertexData)
			group.opaqueVertexData = {
				faceDataA: new Uint8Array(0),
				faceDataB: new Uint8Array(0),
				faceDataC: new Uint8Array(0),
				faceCount: 0,
			};
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
		const totalBytes = totalWater << 2;
		if (!group.waterVertexData)
			group.waterVertexData = {
				faceDataA: new Uint8Array(0),
				faceDataB: new Uint8Array(0),
				faceDataC: new Uint8Array(0),
				faceCount: 0,
			};
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
		const totalBytes = totalCutout << 2;
		if (!group.cutoutVertexData)
			group.cutoutVertexData = {
				faceDataA: new Uint8Array(0),
				faceDataB: new Uint8Array(0),
				faceDataC: new Uint8Array(0),
				faceCount: 0,
			};
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
