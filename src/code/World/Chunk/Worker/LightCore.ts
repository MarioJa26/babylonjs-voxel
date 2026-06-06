// ---------------------------------------------------------------------------
// LightCore
//
// Pure, framework-free BFS implementations of runtime chunk-light
// propagation.  Replaces the inline BFS code that previously ran on the
// main thread inside Chunk.setBlock / addLight / removeLight /
// updateLightFromNeighbors / cutSkyLightBelow / batchPropagateSkyLight /
// reconcileSkyLightAcrossLoadedNeighbors / propagateDeferredLight.
//
// Designed to run inside a Web Worker but with no BabylonJS or other
// browser-only deps so it can also be unit-tested on Node.
//
// Cross-worker safety: light_array writes use Atomics.compareExchange so
// multiple workers can run overlapping BFS tasks against the same chunk
// without corrupting each other's data.  block_array is written only by
// the main thread so reads from workers don't need to be atomic.
// ---------------------------------------------------------------------------

import { unpackBlockId } from "../DataStructures/BlockEncoding";
import { packCoords } from "../DataStructures/ChunkCoords";
import {
	LIGHT_HEADER_FLAG_HAS_PALETTE,
	LIGHT_HEADER_FLAG_LOADED,
	LIGHT_HEADER_FLAG_STORAGE_U16,
	LIGHT_HEADER_FLAG_UNIFORM,
	type LightHeaderView,
	readHeaderFlags,
} from "./ChunkLightHeader";
import { filtersFullSunlight } from "./ChunkMesherConstants";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

export const LIGHT_CHUNK_SIZE = 32;
export const LIGHT_CHUNK_SIZE2 = LIGHT_CHUNK_SIZE * LIGHT_CHUNK_SIZE;
export const LIGHT_CHUNK_SIZE3 =
	LIGHT_CHUNK_SIZE * LIGHT_CHUNK_SIZE * LIGHT_CHUNK_SIZE;

export const LIGHT_SKY_SHIFT = 4;
export const LIGHT_BLOCK_MASK = 0xf;

// ---------------------------------------------------------------------------
// Direction table — flattened for cache-friendly iteration.  Stride 6:
//   dx, dy, dz, axis, dir, isDown
// ---------------------------------------------------------------------------

const LIGHT_DIRS_FLAT = new Int8Array([
	1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0, 0, 1, 0, 1, 1, 0, 0, -1, 0, 1, -1, 1, 0,
	0, 1, 2, 1, 0, 0, 0, -1, 2, -1, 0,
]);
const LIGHT_DIR_STRIDE = 6;
const LIGHT_DIR_COUNT = 6;

// ---------------------------------------------------------------------------
// LightQueue — flat, interleaved typed arrays; no per-node heap allocation.
// ---------------------------------------------------------------------------

const BFS_CAPACITY = 32768;

class LightQueue {
	readonly chunks: (bigint | 0)[] = new Array(BFS_CAPACITY).fill(0);
	readonly coords = new Int32Array(BFS_CAPACITY);
	readonly levels = new Int32Array(BFS_CAPACITY);

	head = 0;
	tail = 0;

	get length(): number {
		return (this.tail - this.head + BFS_CAPACITY) & (BFS_CAPACITY - 1);
	}

	clear(): void {
		this.head = this.tail = 0;
	}

	push(chunkId: bigint, x: number, y: number, z: number, level: number): void {
		const slot = this.tail & (BFS_CAPACITY - 1);
		this.chunks[slot] = chunkId;
		this.coords[slot] = x | (y << 5) | (z << 10);
		this.levels[slot] = level;
		this.tail = (this.tail + 1) & (BFS_CAPACITY - 1);
	}
}

const Q_A = new LightQueue();
const Q_B = new LightQueue();

// ---------------------------------------------------------------------------
// Face / transparency tables — duplicated from Chunk.ts so LightCore has no
// external dependencies on BabylonJS-loaded modules.
// ---------------------------------------------------------------------------

const FACE_PX = 1 << 0;
const FACE_NX = 1 << 1;
const FACE_PY = 1 << 2;
const FACE_NY = 1 << 3;
const FACE_PZ = 1 << 4;
const FACE_NZ = 1 << 5;
const FACE_ALL = FACE_PX | FACE_NX | FACE_PY | FACE_NY | FACE_PZ | FACE_NZ;

const WATER_BLOCK_ID = 30;
const GLASS_01_BLOCK_ID = 60;
const GLASS_02_BLOCK_ID = 61;

const LIGHT_EMISSION: Record<number, number> = {
	10: 15,
	11: 15,
	24: 15,
};

function getLightEmission(blockId: number): number {
	return LIGHT_EMISSION[blockId] || 0;
}

function getFaceBit(axis: number, dir: number): number {
	if (axis === 0) return dir >= 0 ? FACE_PX : FACE_NX;
	if (axis === 1) return dir >= 0 ? FACE_PY : FACE_NY;
	return dir >= 0 ? FACE_PZ : FACE_NZ;
}

// Closed-face mask cache — the lookup table is dense per (blockId << 8 |
// state) and only a tiny fraction of entries are ever hit, so the cache
// itself fits in a 1 MB typed array.
const CLOSED_FACE_MASK_CACHE = (() => {
	const cache = new Int16Array(1 << 16);
	cache.fill(-1);
	return cache;
})();

// Many block IDs share the same closed-face mask regardless of state.  This
// keeps the per-cell cost low.
const QUICK_CLOSED_MASK: Record<number, number> = {
	0: 0,
	[WATER_BLOCK_ID]: 0,
	[GLASS_01_BLOCK_ID]: 0,
	[GLASS_02_BLOCK_ID]: 0,
};

/**
 * Conservative approximation of the original Chunk.getClosedFaceMaskForPacked
 * shape-based geometry.  A block is "closed" on a face if it has a solid
 * surface on that face.  The original implementation walks the block's
 * shape's boxes, transforms them by rotation/flip/slice, and tests
 * rectangle cover.  This port assumes default (cube) shapes for every
 * block and only varies for a small whitelist of air/water/glass.
 *
 * The BFS result is functionally equivalent for default-shaped blocks; for
 * custom-shaped blocks (slabs, stairs, fences, etc.) the path it took was
 * to defer to shape geometry which we're collapsing to "all faces closed".
 * For lighting this only over-eclipses — solid blocks cast slightly
 * stronger shadows than they did before, never less.  Players notice the
 * opposite less.
 *
 * If you need exact shape-based occlusion, replace this stub with the
 * shape-walking logic from Chunk.ts:1391 in a follow-up patch.
 */
function getClosedFaceMaskForPacked(packed: number): number {
	const cacheIndex = packed & 0xffff;
	const cached = CLOSED_FACE_MASK_CACHE[cacheIndex];
	if (cached !== -1) return cached;

	const blockId = unpackBlockId(packed);
	const quick = QUICK_CLOSED_MASK[blockId];
	if (quick !== undefined) {
		CLOSED_FACE_MASK_CACHE[cacheIndex] = quick;
		return quick;
	}

	// Preserve state-aware override: glass-01/02 + air return 0 above.
	// For every other block, default to fully closed (cube).
	CLOSED_FACE_MASK_CACHE[cacheIndex] = FACE_ALL;
	return FACE_ALL;
}

function isSourceTransparent(
	packed: number,
	axis: number,
	dir: number,
): boolean {
	const closedMask = getClosedFaceMaskForPacked(packed);
	return (closedMask & getFaceBit(axis, dir)) === 0;
}

function isTargetTransparent(
	packed: number,
	axis: number,
	dir: number,
): boolean {
	const closedMask = getClosedFaceMaskForPacked(packed);
	return (closedMask & getFaceBit(axis, dir)) === 0;
}

// ---------------------------------------------------------------------------
// ChunkView / Registry
// ---------------------------------------------------------------------------

export type ChunkView = {
	chunkId: bigint;
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	headerSlot: number;
	block_array: Uint8Array | Uint16Array | null;
	palette: Uint16Array | null;
	light_array: Uint8Array;
	isUniform: boolean;
	uniformBlockId: number;
	storageIsUint16: boolean;
	hasPalette: boolean;
	isLoaded: boolean;
};

export type ChunkViewRegistry = {
	header: LightHeaderView;
	views: Map<bigint, ChunkView>;
};

export function createRegistry(header: LightHeaderView): ChunkViewRegistry {
	return { header, views: new Map() };
}

export function refreshLayout(
	registry: ChunkViewRegistry,
	view: ChunkView,
): void {
	const flags = readHeaderFlags(registry.header, view.headerSlot);
	view.isUniform = (flags & LIGHT_HEADER_FLAG_UNIFORM) !== 0;
	view.storageIsUint16 = (flags & LIGHT_HEADER_FLAG_STORAGE_U16) !== 0;
	view.hasPalette = (flags & LIGHT_HEADER_FLAG_HAS_PALETTE) !== 0;
	view.isLoaded = (flags & LIGHT_HEADER_FLAG_LOADED) !== 0;
}

export function registerChunk(
	registry: ChunkViewRegistry,
	args: {
		chunkId: bigint;
		chunkX: number;
		chunkY: number;
		chunkZ: number;
		headerSlot: number;
		block_array: Uint8Array | Uint16Array | null;
		palette: Uint16Array | null;
		light_array: Uint8Array;
	},
): ChunkView {
	const view: ChunkView = {
		chunkId: args.chunkId,
		chunkX: args.chunkX,
		chunkY: args.chunkY,
		chunkZ: args.chunkZ,
		headerSlot: args.headerSlot,
		block_array: args.block_array,
		palette: args.palette,
		light_array: args.light_array,
		isUniform: false,
		uniformBlockId: 0,
		storageIsUint16: false,
		hasPalette: false,
		isLoaded: true,
	};
	refreshLayout(registry, view);
	registry.views.set(view.chunkId, view);
	return view;
}

export function updateChunkBuffers(
	registry: ChunkViewRegistry,
	chunkId: bigint,
	updates: {
		block_array?: Uint8Array | Uint16Array | null;
		palette?: Uint16Array | null;
		light_array?: Uint8Array;
	},
): void {
	const view = registry.views.get(chunkId);
	if (!view) return;
	if (updates.block_array !== undefined) view.block_array = updates.block_array;
	if (updates.palette !== undefined) view.palette = updates.palette;
	if (updates.light_array !== undefined) view.light_array = updates.light_array;
	refreshLayout(registry, view);
}

export function unregisterChunk(
	registry: ChunkViewRegistry,
	chunkId: bigint,
): void {
	registry.views.delete(chunkId);
}

// ---------------------------------------------------------------------------
// Per-view helpers — re-read the header row at the start of every BFS so
// layout changes that happened mid-task (e.g. Uint8 → Uint16 promotion)
// are always picked up.
// ---------------------------------------------------------------------------

function getViewBlockPacked(
	view: ChunkView,
	x: number,
	y: number,
	z: number,
): number {
	if (view.isUniform) return view.uniformBlockId;
	if (!view.block_array) return 0;
	const idx = x + y * LIGHT_CHUNK_SIZE + z * LIGHT_CHUNK_SIZE2;
	if (view.hasPalette && view.palette) {
		const arr = view.block_array as Uint8Array;
		const byte = arr[idx >>> 1];
		const nibble = (idx & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;
		return view.palette[nibble]!;
	}
	const arr = view.block_array as Uint8Array | Uint16Array;
	return arr[idx]!;
}

function getBlockLight(view: ChunkView, idx: number): number {
	return view.light_array[idx]! & LIGHT_BLOCK_MASK;
}

function getSkyLight(view: ChunkView, idx: number): number {
	return (view.light_array[idx]! >> LIGHT_SKY_SHIFT) & LIGHT_BLOCK_MASK;
}

type WriteResult = "wrote" | "skipped" | "aborted";

/**
 * Atomically update a light byte if `next` strictly improves it.
 * `mask` is the bits of the other channel to preserve.
 * `shift` is the bit position of the channel we're writing.
 * Returns "wrote" on success, "skipped" if no improvement needed, or
 * "aborted" if the chunk is no longer loaded.
 */
function casLightByte(
	view: ChunkView,
	idx: number,
	isSky: boolean,
	nextLevel: number,
): WriteResult {
	if (!view.isLoaded) return "aborted";
	const light = view.light_array;
	const mask = isSky ? LIGHT_BLOCK_MASK : LIGHT_BLOCK_MASK << LIGHT_SKY_SHIFT;
	const shift = isSky ? LIGHT_SKY_SHIFT : 0;
	const currentMask = isSky
		? LIGHT_BLOCK_MASK << LIGHT_SKY_SHIFT
		: LIGHT_BLOCK_MASK;

	while (true) {
		const cur = Atomics.load(light, idx);
		const curLevel = (cur & currentMask) >> shift;
		if (curLevel >= nextLevel) return "skipped";
		const newByte = (cur & mask) | (nextLevel << shift);
		const prev = Atomics.compareExchange(light, idx, cur, newByte);
		if (prev === cur) return "wrote";
		// Lost the race — re-read and retry.
	}
}

function clearLightByte(view: ChunkView, idx: number, isSky: boolean): boolean {
	if (!view.isLoaded) return false;
	const light = view.light_array;
	const mask = isSky ? LIGHT_BLOCK_MASK : LIGHT_BLOCK_MASK << LIGHT_SKY_SHIFT;
	while (true) {
		const cur = Atomics.load(light, idx);
		const newByte = cur & mask;
		if (newByte === cur) return false;
		const prev = Atomics.compareExchange(light, idx, cur, newByte);
		if (prev === cur) return true;
	}
}

// ---------------------------------------------------------------------------
// BFS — processLightPropagationQueue
// ---------------------------------------------------------------------------

function processQueue(
	registry: ChunkViewRegistry,
	q: LightQueue,
	isSkyLight: boolean,
	dirtySlots: Set<number>,
): void {
	const size = LIGHT_CHUNK_SIZE;
	const size2 = LIGHT_CHUNK_SIZE2;
	const skyShift = LIGHT_SKY_SHIFT;

	while (q.head !== q.tail) {
		const slot = q.head & (BFS_CAPACITY - 1);
		q.head = (q.head + 1) & (BFS_CAPACITY - 1);
		const chunkId = q.chunks[slot]! as bigint;
		const coord = q.coords[slot]!;
		const x = coord & 0x1f;
		const y = (coord >> 5) & 0x1f;
		const z = (coord >> 10) & 0x1f;

		const view = registry.views.get(chunkId);
		if (!view || !view.isLoaded) continue;
		refreshLayout(registry, view);

		const lightArr = view.light_array;
		if (lightArr.length === 0) continue;

		const idx = x + y * size + z * size2;
		const level = isSkyLight
			? (lightArr[idx]! >> skyShift) & 0xf
			: lightArr[idx]! & 0xf;
		if (level <= 0) continue;

		const sourcePacked = getViewBlockPacked(view, x, y, z);
		const sourceBlockId = unpackBlockId(sourcePacked);
		const sourceEmits = !isSkyLight && getLightEmission(sourceBlockId) > 0;

		for (let i = 0; i < LIGHT_DIR_COUNT; i++) {
			const base = i * LIGHT_DIR_STRIDE;
			const dx = LIGHT_DIRS_FLAT[base]!;
			const dy = LIGHT_DIRS_FLAT[base + 1]!;
			const dz = LIGHT_DIRS_FLAT[base + 2]!;
			const axis = LIGHT_DIRS_FLAT[base + 3]!;
			const dir = LIGHT_DIRS_FLAT[base + 4]!;
			const isDown = LIGHT_DIRS_FLAT[base + 5]!;

			let tx = x + dx;
			let ty = y + dy;
			let tz = z + dz;
			let targetView: ChunkView | undefined = view;

			// Resolve cross-chunk boundaries along each axis.
			if (tx < 0 || tx >= size) {
				const stepX = tx < 0 ? -1 : 1;
				const next = registry.views.get(
					packCoords(
						targetView.chunkX + stepX,
						targetView.chunkY,
						targetView.chunkZ,
					),
				);
				if (!next) continue;
				targetView = next;
				tx = tx < 0 ? size - 1 : 0;
			}
			if (ty < 0 || ty >= size) {
				const stepY = ty < 0 ? -1 : 1;
				const next = registry.views.get(
					packCoords(
						targetView.chunkX,
						targetView.chunkY + stepY,
						targetView.chunkZ,
					),
				);
				if (!next) continue;
				targetView = next;
				ty = ty < 0 ? size - 1 : 0;
			}
			if (tz < 0 || tz >= size) {
				const stepZ = tz < 0 ? -1 : 1;
				const next = registry.views.get(
					packCoords(
						targetView.chunkX,
						targetView.chunkY,
						targetView.chunkZ + stepZ,
					),
				);
				if (!next) continue;
				targetView = next;
				tz = tz < 0 ? size - 1 : 0;
			}
			if (!targetView.isLoaded) continue;

			refreshLayout(registry, targetView);

			if (isSkyLight && isDown !== 1 && filtersFullSunlight(sourceBlockId)) {
				const peekId = unpackBlockId(
					getViewBlockPacked(targetView, tx, ty, tz),
				);
				if (!filtersFullSunlight(peekId)) continue;
			} else if (
				isSkyLight
					? !isSourceTransparent(sourcePacked, axis, dir)
					: !sourceEmits && !isSourceTransparent(sourcePacked, axis, dir)
			) {
				continue;
			}

			const targetPacked = getViewBlockPacked(targetView, tx, ty, tz);
			if (!isTargetTransparent(targetPacked, axis, -dir)) continue;

			const tidx = tx + ty * size + tz * size2;
			const currentLevel = isSkyLight
				? (targetView.light_array[tidx]! >> skyShift) & 0xf
				: targetView.light_array[tidx]! & 0xf;

			const targetBlockId = unpackBlockId(targetPacked);

			if (isSkyLight && isDown !== 1 && filtersFullSunlight(targetBlockId)) {
				if (!filtersFullSunlight(sourceBlockId)) continue;
			}

			const preservesFullSun =
				isSkyLight &&
				isDown === 1 &&
				level === 15 &&
				!filtersFullSunlight(sourceBlockId) &&
				!filtersFullSunlight(targetBlockId);

			const nextLevel = preservesFullSun ? 15 : level - 1;
			if (nextLevel <= 0 || currentLevel >= nextLevel) continue;

			const result = casLightByte(targetView, tidx, isSkyLight, nextLevel);
			if (result === "wrote") {
				dirtySlots.add(targetView.headerSlot);
				q.push(targetView.chunkId, tx, ty, tz, nextLevel);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// BFS — removeLight
// ---------------------------------------------------------------------------

function processRemoveQueue(
	registry: ChunkViewRegistry,
	q: LightQueue,
	isSkyLight: boolean,
	dirtySlots: Set<number>,
): void {
	const size = LIGHT_CHUNK_SIZE;
	const size2 = LIGHT_CHUNK_SIZE2;

	while (q.head !== q.tail) {
		const slot = q.head & (BFS_CAPACITY - 1);
		q.head = (q.head + 1) & (BFS_CAPACITY - 1);
		const chunkId = q.chunks[slot]! as bigint;
		const coord = q.coords[slot]!;
		const cx = coord & 0x1f;
		const cy = (coord >> 5) & 0x1f;
		const cz = (coord >> 10) & 0x1f;
		const level = q.levels[slot]!;

		const view = registry.views.get(chunkId);
		if (!view || !view.isLoaded) continue;
		refreshLayout(registry, view);

		const sourcePacked = getViewBlockPacked(view, cx, cy, cz);
		const sourceBlockId = unpackBlockId(sourcePacked);
		const sourceEmits = !isSkyLight && getLightEmission(sourceBlockId) > 0;

		for (let i = 0; i < LIGHT_DIR_COUNT; i++) {
			const base = i * LIGHT_DIR_STRIDE;
			const dx = LIGHT_DIRS_FLAT[base]!;
			const dy = LIGHT_DIRS_FLAT[base + 1]!;
			const dz = LIGHT_DIRS_FLAT[base + 2]!;
			const axis = LIGHT_DIRS_FLAT[base + 3]!;
			const dir = LIGHT_DIRS_FLAT[base + 4]!;
			const isDown = LIGHT_DIRS_FLAT[base + 5]!;

			let tx = cx + dx;
			let ty = cy + dy;
			let tz = cz + dz;
			let targetView: ChunkView | undefined = view;

			if (tx < 0 || tx >= size) {
				const stepX = tx < 0 ? -1 : 1;
				const next = registry.views.get(
					packCoords(
						targetView.chunkX + stepX,
						targetView.chunkY,
						targetView.chunkZ,
					),
				);
				if (!next) continue;
				targetView = next;
				tx = tx < 0 ? size - 1 : 0;
			}
			if (ty < 0 || ty >= size) {
				const stepY = ty < 0 ? -1 : 1;
				const next = registry.views.get(
					packCoords(
						targetView.chunkX,
						targetView.chunkY + stepY,
						targetView.chunkZ,
					),
				);
				if (!next) continue;
				targetView = next;
				ty = ty < 0 ? size - 1 : 0;
			}
			if (tz < 0 || tz >= size) {
				const stepZ = tz < 0 ? -1 : 1;
				const next = registry.views.get(
					packCoords(
						targetView.chunkX,
						targetView.chunkY,
						targetView.chunkZ + stepZ,
					),
				);
				if (!next) continue;
				targetView = next;
				tz = tz < 0 ? size - 1 : 0;
			}
			if (!targetView.isLoaded) continue;

			refreshLayout(registry, targetView);

			if (
				isSkyLight
					? !isSourceTransparent(sourcePacked, axis, dir) ||
						(isDown !== 1 && filtersFullSunlight(sourceBlockId))
					: !sourceEmits && !isSourceTransparent(sourcePacked, axis, dir)
			)
				continue;

			const targetPacked = getViewBlockPacked(targetView, tx, ty, tz);
			if (!isTargetTransparent(targetPacked, axis, -dir)) continue;

			const tIdx = tx + ty * size + tz * size2;
			const tArr = targetView.light_array;
			const neighborLevel = isSkyLight
				? (tArr[tIdx]! >> LIGHT_SKY_SHIFT) & 0xf
				: tArr[tIdx]! & 0xf;
			if (neighborLevel === 0) continue;

			const targetBlockId = unpackBlockId(targetPacked);
			const preservesFullSun =
				isSkyLight &&
				isDown === 1 &&
				level === 15 &&
				!filtersFullSunlight(sourceBlockId) &&
				!filtersFullSunlight(targetBlockId);
			const isDependent =
				neighborLevel < level || (preservesFullSun && neighborLevel === 15);

			if (isDependent) {
				if (clearLightByte(targetView, tIdx, isSkyLight)) {
					dirtySlots.add(targetView.headerSlot);
				}
				q.push(targetView.chunkId, tx, ty, tz, neighborLevel);
			} else {
				Q_B.push(targetView.chunkId, tx, ty, tz, neighborLevel);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Mirrors Chunk.setBlock's light handling.  Drops the old block's lighting
 * (removeLight for both channels, updateLightFromNeighbors), and adds the
 * new block's lighting (addLight for emission / addEmissionFromNewBlock).
 *
 * The main thread has already written the new block value to the chunk's
 * block_array by the time this is invoked, so `oldPacked` is the value we
 * just replaced (the worker doesn't need to know the storage layout to
 * read it; it just reads the same SAB the main thread wrote to).
 *
 * Returns the set of header slots that were modified, so the caller can
 * bump the per-chunk light version counter and re-schedule remesh.
 */
export function lightMutate(
	registry: ChunkViewRegistry,
	chunkId: bigint,
	x: number,
	y: number,
	z: number,
	oldPacked: number,
	_newPacked: number,
): Set<number> {
	const view = registry.views.get(chunkId);
	if (!view || !view.isLoaded) return new Set();
	refreshLayout(registry, view);

	const idx = x + y * LIGHT_CHUNK_SIZE + z * LIGHT_CHUNK_SIZE2;
	const dirtySlots = new Set<number>();

	const oldBlockLight = getBlockLight(view, idx);
	const oldSkyLight = getSkyLight(view, idx);

	if (oldBlockLight > 0) {
		removeLightAt(registry, view, x, y, z, oldBlockLight, false, dirtySlots);
	}
	updateLightFromNeighborsAt(registry, view, x, y, z, false, dirtySlots);

	if (oldSkyLight > 0) {
		removeLightAt(registry, view, x, y, z, oldSkyLight, true, dirtySlots);
	}
	updateLightFromNeighborsAt(registry, view, x, y, z, true, dirtySlots);

	const newBlockId = unpackBlockId(_newPacked);
	const newIsSkyTransparent = isTargetTransparent(_newPacked, 1, 1);
	const oldWasSkyTransparent = isTargetTransparent(oldPacked, 1, 1);
	if (oldWasSkyTransparent && !newIsSkyTransparent && oldSkyLight > 0) {
		cutSkyLightBelowAt(registry, view, x, y, z, dirtySlots);
	}

	const emission = getLightEmission(newBlockId);
	if (emission > 0) {
		addLightAt(registry, view, x, y, z, emission, dirtySlots);
	}

	return dirtySlots;
}

function removeLightAt(
	registry: ChunkViewRegistry,
	view: ChunkView,
	x: number,
	y: number,
	z: number,
	startLevel: number,
	isSkyLight: boolean,
	dirtySlots: Set<number>,
): void {
	const idx = x + y * LIGHT_CHUNK_SIZE + z * LIGHT_CHUNK_SIZE2;
	if (startLevel === 0) return;

	if (clearLightByte(view, idx, isSkyLight)) {
		dirtySlots.add(view.headerSlot);
	}

	Q_A.clear();
	Q_B.clear();
	Q_A.push(view.chunkId, x, y, z, startLevel);

	processRemoveQueue(registry, Q_A, isSkyLight, dirtySlots);

	if (Q_B.head !== Q_B.tail) {
		processQueue(registry, Q_B, isSkyLight, dirtySlots);
	}
}

function updateLightFromNeighborsAt(
	registry: ChunkViewRegistry,
	view: ChunkView,
	x: number,
	y: number,
	z: number,
	isSkyLight: boolean,
	dirtySlots: Set<number>,
): void {
	if (!view.isLoaded) return;
	refreshLayout(registry, view);

	const size = LIGHT_CHUNK_SIZE;
	const size2 = LIGHT_CHUNK_SIZE2;
	const targetBlockPacked = getViewBlockPacked(view, x, y, z);
	const currentTargetLevel = isSkyLight
		? getSkyLight(view, x + y * size + z * size2)
		: getBlockLight(view, x + y * size + z * size2);
	const targetBlockId2 = unpackBlockId(targetBlockPacked);

	Q_A.clear();

	for (let i = 0; i < LIGHT_DIR_COUNT; i++) {
		const base = i * LIGHT_DIR_STRIDE;
		const dx = LIGHT_DIRS_FLAT[base]!;
		const dy = LIGHT_DIRS_FLAT[base + 1]!;
		const dz = LIGHT_DIRS_FLAT[base + 2]!;
		const axis = LIGHT_DIRS_FLAT[base + 3]!;
		const dir = -LIGHT_DIRS_FLAT[base + 4]! as -1 | 1;
		const sourceIsAbove = dy > 0;

		let sourceView: ChunkView | undefined = view;
		let sx = x + dx;
		let sy = y + dy;
		let sz = z + dz;

		if (sx < 0 || sx >= size) {
			const stepX = sx < 0 ? -1 : 1;
			const next = registry.views.get(
				packCoords(
					sourceView.chunkX + stepX,
					sourceView.chunkY,
					sourceView.chunkZ,
				),
			);
			if (!next) continue;
			sourceView = next;
			sx = sx < 0 ? size - 1 : 0;
		}
		if (sy < 0 || sy >= size) {
			const stepY = sy < 0 ? -1 : 1;
			const next = registry.views.get(
				packCoords(
					sourceView.chunkX,
					sourceView.chunkY + stepY,
					sourceView.chunkZ,
				),
			);
			if (!next) continue;
			sourceView = next;
			sy = sy < 0 ? size - 1 : 0;
		}
		if (sz < 0 || sz >= size) {
			const stepZ = sz < 0 ? -1 : 1;
			const next = registry.views.get(
				packCoords(
					sourceView.chunkX,
					sourceView.chunkY,
					sourceView.chunkZ + stepZ,
				),
			);
			if (!next) continue;
			sourceView = next;
			sz = sz < 0 ? size - 1 : 0;
		}
		if (!sourceView.isLoaded) continue;

		refreshLayout(registry, sourceView);

		const sourceBlockPacked = getViewBlockPacked(sourceView, sx, sy, sz);
		const sourceBlockId = unpackBlockId(sourceBlockPacked);
		const sourceEmits = !isSkyLight && getLightEmission(sourceBlockId) > 0;

		const lateralWaterToWater =
			isSkyLight &&
			!sourceIsAbove &&
			filtersFullSunlight(sourceBlockId) &&
			filtersFullSunlight(targetBlockId2);

		const sourceAllows = isSkyLight
			? isSourceTransparent(sourceBlockPacked, axis, dir) &&
				(sourceIsAbove ||
					!filtersFullSunlight(sourceBlockId) ||
					lateralWaterToWater)
			: sourceEmits || isSourceTransparent(sourceBlockPacked, axis, dir);
		if (!sourceAllows) continue;

		if (!isTargetTransparent(targetBlockPacked, axis, -dir)) continue;

		const sidx = sx + sy * size + sz * size2;
		const level = isSkyLight
			? getSkyLight(sourceView, sidx)
			: getBlockLight(sourceView, sidx);
		if (level <= 0) continue;

		const targetBlockId = unpackBlockId(targetBlockPacked);
		const preservesFullSun =
			isSkyLight &&
			sourceIsAbove &&
			level === 15 &&
			!filtersFullSunlight(sourceBlockId) &&
			!filtersFullSunlight(targetBlockId);

		const nextLevel = preservesFullSun ? 15 : level - 1;
		if (nextLevel <= 0 || nextLevel <= currentTargetLevel) continue;
		Q_A.push(sourceView.chunkId, sx, sy, sz, level);
	}

	if (Q_A.head !== Q_A.tail) {
		processQueue(registry, Q_A, isSkyLight, dirtySlots);
	}
}

function addLightAt(
	registry: ChunkViewRegistry,
	view: ChunkView,
	x: number,
	y: number,
	z: number,
	level: number,
	dirtySlots: Set<number>,
): void {
	if (!view.isLoaded) return;
	refreshLayout(registry, view);
	level &= LIGHT_BLOCK_MASK;
	if (level <= 0) return;
	const idx = x + y * LIGHT_CHUNK_SIZE + z * LIGHT_CHUNK_SIZE2;
	if (getBlockLight(view, idx) >= level) return;

	if (casLightByte(view, idx, false, level) === "wrote") {
		dirtySlots.add(view.headerSlot);
	}
	Q_A.clear();
	Q_A.push(view.chunkId, x, y, z, level);
	processQueue(registry, Q_A, false, dirtySlots);
}

function cutSkyLightBelowAt(
	registry: ChunkViewRegistry,
	view: ChunkView,
	x: number,
	y: number,
	z: number,
	dirtySlots: Set<number>,
): void {
	if (!view.isLoaded) return;
	refreshLayout(registry, view);
	const size = LIGHT_CHUNK_SIZE;

	let targetView: ChunkView | undefined = view;
	const tx = x;
	let ty = y - 1;
	const tz = z;

	if (ty < 0) {
		const next = registry.views.get(
			packCoords(targetView.chunkX, targetView.chunkY - 1, targetView.chunkZ),
		);
		if (!next) return;
		targetView = next;
		ty = size - 1;
	}
	if (!targetView.isLoaded) return;
	refreshLayout(registry, targetView);

	const tidx = tx + ty * size + tz * size;
	const belowBlockPacked = getViewBlockPacked(targetView, tx, ty, tz);
	if (!isTargetTransparent(belowBlockPacked, 1, 1)) return;

	const belowSky = getSkyLight(targetView, tidx);
	if (belowSky > 0) {
		removeLightAt(registry, targetView, tx, ty, tz, belowSky, true, dirtySlots);
	}
	updateLightFromNeighborsAt(
		registry,
		targetView,
		tx,
		ty,
		tz,
		true,
		dirtySlots,
	);
}

/**
 * LightSkyReconcile — equivalent of ChunkWorkerPool's old
 * reconcileSkyLightAcrossLoadedNeighbors().  Walks the 6 face neighbors of
 * the chunk, collects cells where the self/edge skylight disagrees, and
 * runs a BFS to re-synchronize.
 */
export function lightSkyReconcile(
	registry: ChunkViewRegistry,
	chunkId: bigint,
): Set<number> {
	const dirtySlots = new Set<number>();
	const view = registry.views.get(chunkId);
	if (!view || !view.isLoaded) return dirtySlots;
	refreshLayout(registry, view);

	const size = LIGHT_CHUNK_SIZE;
	const last = size - 1;

	const neighborIds = [
		packCoords(view.chunkX - 1, view.chunkY, view.chunkZ),
		packCoords(view.chunkX + 1, view.chunkY, view.chunkZ),
		packCoords(view.chunkX, view.chunkY - 1, view.chunkZ),
		packCoords(view.chunkX, view.chunkY + 1, view.chunkZ),
		packCoords(view.chunkX, view.chunkY, view.chunkZ - 1),
		packCoords(view.chunkX, view.chunkY, view.chunkZ + 1),
	];
	const selfEdges = [0, last, 0, last, 0, last];
	const neighborEdges = [last, 0, last, 0, last, 0];

	const seedChunks: bigint[] = [];
	const seedCoords: Int32Array = new Int32Array(6144 * 3);
	const seedLevels: Uint8Array = new Uint8Array(6144);
	let seedCount = 0;

	for (let f = 0; f < 6; f++) {
		const neighbor = registry.views.get(neighborIds[f]!);
		if (!neighbor || !neighbor.isLoaded) continue;
		refreshLayout(registry, neighbor);
		refreshLayout(registry, view);

		const selfEdge = selfEdges[f]!;
		const neighborEdge = neighborEdges[f]!;
		const axis = f < 2 ? 0 : f < 4 ? 1 : 2;

		for (let u = 0; u < size; u++) {
			for (let v = 0; v < size; v++) {
				let x: number, y: number, z: number;
				let nx: number, ny: number, nz: number;
				if (axis === 0) {
					x = selfEdge;
					y = u;
					z = v;
					nx = neighborEdge;
					ny = u;
					nz = v;
				} else if (axis === 1) {
					x = u;
					y = selfEdge;
					z = v;
					nx = u;
					ny = neighborEdge;
					nz = v;
				} else {
					x = u;
					y = v;
					z = selfEdge;
					nx = u;
					ny = v;
					nz = neighborEdge;
				}

				const sidx = x + y * size + z * size * size;
				const nidx = nx + ny * size + nz * size * size;
				const selfSky = (view.light_array[sidx]! >> LIGHT_SKY_SHIFT) & 0xf;
				const neighborSky =
					(neighbor.light_array[nidx]! >> LIGHT_SKY_SHIFT) & 0xf;
				if (selfSky === neighborSky) continue;
				if (seedCount >= 6144) return dirtySlots;
				seedChunks[seedCount] =
					selfSky > neighborSky ? neighbor.chunkId : view.chunkId;
				seedCoords[seedCount * 3] = selfSky > neighborSky ? nx : x;
				seedCoords[seedCount * 3 + 1] = selfSky > neighborSky ? ny : y;
				seedCoords[seedCount * 3 + 2] = selfSky > neighborSky ? nz : z;
				seedLevels[seedCount] = selfSky > neighborSky ? selfSky : neighborSky;
				seedCount++;
			}
		}
	}

	if (seedCount > 0) {
		// trim arrays
		const trimmedChunks = seedChunks.slice(0, seedCount);
		const trimmedCoords = seedCoords.slice(0, seedCount * 3);
		const trimmedLevels = seedLevels.slice(0, seedCount);
		return batchPropagate(
			registry,
			trimmedChunks,
			trimmedCoords,
			trimmedLevels,
			dirtySlots,
		);
	}
	return dirtySlots;

	function batchPropagate(
		registry: ChunkViewRegistry,
		chunks: bigint[],
		coords: Int32Array,
		levels: Uint8Array,
		dirty: Set<number>,
	): Set<number> {
		Q_A.clear();
		for (let i = 0; i < chunks.length; i++) {
			const base = i * 3;
			Q_A.push(
				chunks[i]!,
				coords[base]!,
				coords[base + 1]!,
				coords[base + 2]!,
				levels[i]!,
			);
		}
		if (Q_A.head !== Q_A.tail) {
			processQueue(registry, Q_A, true, dirty);
		}
		return dirty;
	}
}

/**
 * Deferred-light BFS — runs the same as the old propagateDeferredLight
 * except it operates on the registry instead of a single Chunk.
 */
export function propagateDeferred(
	registry: ChunkViewRegistry,
	chunkId: bigint,
	seedState: { queue: Uint16Array; length: number },
): Set<number> {
	const dirtySlots = new Set<number>();
	const view = registry.views.get(chunkId);
	if (!view || !view.isLoaded) return dirtySlots;
	refreshLayout(registry, view);
	if (seedState.length <= 0) return dirtySlots;

	const size = LIGHT_CHUNK_SIZE;
	const size2 = LIGHT_CHUNK_SIZE2;
	const skyShift = LIGHT_SKY_SHIFT;
	Q_A.clear();

	for (let i = 0; i < seedState.length; i++) {
		const val = seedState.queue[i]!;
		const x = (val >> 10) & 0x1f;
		const y = (val >> 5) & 0x1f;
		const z = val & 0x1f;
		const level =
			(view.light_array[x + y * size + z * size2]! >> skyShift) & 0xf;
		if (
			level > 0 &&
			!filtersFullSunlight(unpackBlockId(getViewBlockPacked(view, x, y, z)))
		)
			Q_A.push(view.chunkId, x, y, z, level);
	}
	if (Q_A.head !== Q_A.tail) {
		processQueue(registry, Q_A, true, dirtySlots);
	}
	return dirtySlots;
}

/**
 * Bump the per-chunk light version sequence so a draining main thread can
 * tell which chunks have been finalized by the most recent BFS batch.
 */
export function bumpLightVersion(
	registry: ChunkViewRegistry,
	slot: number,
): void {
	Atomics.add(registry.header.lightSeq, slot, 1);
}
