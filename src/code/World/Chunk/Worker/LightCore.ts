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
// Light tasks are routed to a single designated worker (worker index 0),
// so there is never cross-worker contention on light_array writes.
// Direct array reads/writes are used instead of Atomics.
// ---------------------------------------------------------------------------

import { unpackBlockId } from "../DataStructures/BlockEncoding";
import { packCoords } from "../DataStructures/ChunkCoords";
import {
	bumpHeaderLightSeq,
	LIGHT_HEADER_FLAG_HAS_PALETTE,
	LIGHT_HEADER_FLAG_LOADED,
	LIGHT_HEADER_FLAG_STORAGE_U16,
	LIGHT_HEADER_FLAG_UNIFORM,
	type LightHeaderView,
	readHeaderMeta,
} from "./ChunkLightHeader";
import { filtersFullSunlight, WATER_BLOCK_ID } from "./ChunkMesherConstants";

// Reusable scratch Set for dirtySlots — avoids per-call allocation.
// Safe because the light worker is single-threaded and each function
// consumes the Set synchronously before returning.
const _dirtySlotsScratch = new Set<number>();

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

export const LIGHT_CHUNK_SIZE = 32;
export const LIGHT_CHUNK_SIZE2 = LIGHT_CHUNK_SIZE * LIGHT_CHUNK_SIZE;
export const LIGHT_CHUNK_SIZE3 =
	LIGHT_CHUNK_SIZE * LIGHT_CHUNK_SIZE * LIGHT_CHUNK_SIZE;

// Reusable face descriptors for lightBlockReconcile (size = 32, last = 31).
const RECONCILE_FACES = [
	{ dx: -1, dy: 0, dz: 0, axis: 0, selfEdge: 0, neighborEdge: 31, dir: -1 },
	{ dx: 1, dy: 0, dz: 0, axis: 0, selfEdge: 31, neighborEdge: 0, dir: 1 },
	{ dx: 0, dy: -1, dz: 0, axis: 1, selfEdge: 0, neighborEdge: 31, dir: -1 },
	{ dx: 0, dy: 1, dz: 0, axis: 1, selfEdge: 31, neighborEdge: 0, dir: 1 },
	{ dx: 0, dy: 0, dz: -1, axis: 2, selfEdge: 0, neighborEdge: 31, dir: -1 },
	{ dx: 0, dy: 0, dz: 1, axis: 2, selfEdge: 31, neighborEdge: 0, dir: 1 },
] as const;

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

// Reusable seed buffers for lightSkyReconcile — hoisted to module level to
// avoid per-call allocation (safe: single worker thread).
const SEED_CAPACITY = 6144;
const seedChunks = new BigInt64Array(SEED_CAPACITY);
const seedCoords = new Int32Array(SEED_CAPACITY * 3);
const seedLevels = new Uint8Array(SEED_CAPACITY);

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

const GLASS_01_BLOCK_ID = 60;
const GLASS_02_BLOCK_ID = 61;
const _emptyNumberSet = new Set<number>();

const _lightEmissionLUT = (() => {
	const lut = new Uint8Array(256);
	lut[10] = 15;
	lut[11] = 15;
	lut[24] = 15;
	return lut;
})();

function getLightEmission(blockId: number): number {
	return blockId >= 0 && blockId < 256 ? _lightEmissionLUT[blockId] : 0;
}

// LUT: index = axis * 2 + (dir >= 0 ? 0 : 1)
const FACE_BIT_LUT = new Uint8Array([
	FACE_PX,
	FACE_NX,
	FACE_PY,
	FACE_NY,
	FACE_PZ,
	FACE_NZ,
]);

function getFaceBit(axis: number, dir: number): number {
	return FACE_BIT_LUT[axis * 2 + (dir >= 0 ? 0 : 1)];
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
	64: 0, // GrassCross
	66: 0, // SavannahGrassCross
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

/**
 * Populate the closed-face mask cache from a precomputed lookup table
 * (generated on the main thread using the full shape geometry).  Called
 * once after block shapes finish loading so that non-full blocks
 * (slabs, stairs, fences, etc.) get correct per-face transparency.
 */
export function applyClosedFaceMaskLUT(lut: Uint8Array): void {
	for (let i = 0; i < lut.length && i < CLOSED_FACE_MASK_CACHE.length; i++) {
		CLOSED_FACE_MASK_CACHE[i] = lut[i];
	}
}

function isTransparent(packed: number, axis: number, dir: number): boolean {
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
	/** Cached face-adjacent neighbor views. Index: 0=+X,1=-X,2=+Y,3=-Y,4=+Z,5=-Z */
	neighborViews: (ChunkView | null)[];
};

export type ChunkViewRegistry = {
	header: LightHeaderView;
	views: Map<bigint, ChunkView>;
};

export function createRegistry(header: LightHeaderView): ChunkViewRegistry {
	return { header, views: new Map() };
}

/**
 * Direction index constants matching neighborViews layout:
 *   0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z
 */
const DIR_PX = 0;
const DIR_NX = 1;
const DIR_PY = 2;
const DIR_NY = 3;
const DIR_PZ = 4;
const DIR_NZ = 5;

/**
 * Populate a ChunkView's neighborViews from the registry.
 * Also back-links this view into each found neighbor's neighborViews.
 */
function linkNeighborViews(registry: ChunkViewRegistry, view: ChunkView): void {
	const n = view.neighborViews;
	const cx = view.chunkX;
	const cy = view.chunkY;
	const cz = view.chunkZ;
	n[DIR_PX] = registry.views.get(packCoords(cx + 1, cy, cz)) ?? null;
	n[DIR_NX] = registry.views.get(packCoords(cx - 1, cy, cz)) ?? null;
	n[DIR_PY] = registry.views.get(packCoords(cx, cy + 1, cz)) ?? null;
	n[DIR_NY] = registry.views.get(packCoords(cx, cy - 1, cz)) ?? null;
	n[DIR_PZ] = registry.views.get(packCoords(cx, cy, cz + 1)) ?? null;
	n[DIR_NZ] = registry.views.get(packCoords(cx, cy, cz - 1)) ?? null;

	// Back-link: each neighbor points to this view in the opposite direction.
	if (n[DIR_PX]) n[DIR_PX].neighborViews[DIR_NX] = view;
	if (n[DIR_NX]) n[DIR_NX].neighborViews[DIR_PX] = view;
	if (n[DIR_PY]) n[DIR_PY].neighborViews[DIR_NY] = view;
	if (n[DIR_NY]) n[DIR_NY].neighborViews[DIR_PY] = view;
	if (n[DIR_PZ]) n[DIR_PZ].neighborViews[DIR_NZ] = view;
	if (n[DIR_NZ]) n[DIR_NZ].neighborViews[DIR_PZ] = view;
}

/**
 * Resolve cross-chunk boundaries using cached neighbor views.
 * Returns the target ChunkView and adjusted local coords, or null if the
 * neighbor chunk isn't loaded.
 */
function resolveNeighborView(
	startView: ChunkView,
	tx: number,
	ty: number,
	tz: number,
	size: number,
): { view: ChunkView; x: number; y: number; z: number } | null {
	let cur = startView;
	let rx = tx,
		ry = ty,
		rz = tz;
	if (rx < 0 || rx >= size) {
		const next = cur.neighborViews[rx < 0 ? DIR_NX : DIR_PX];
		if (!next) return null;
		cur = next;
		rx = rx < 0 ? size - 1 : 0;
	}
	if (ry < 0 || ry >= size) {
		const next = cur.neighborViews[ry < 0 ? DIR_NY : DIR_PY];
		if (!next) return null;
		cur = next;
		ry = ry < 0 ? size - 1 : 0;
	}
	if (rz < 0 || rz >= size) {
		const next = cur.neighborViews[rz < 0 ? DIR_NZ : DIR_PZ];
		if (!next) return null;
		cur = next;
		rz = rz < 0 ? size - 1 : 0;
	}
	return { view: cur, x: rx, y: ry, z: rz };
}

export function refreshLayout(
	registry: ChunkViewRegistry,
	view: ChunkView,
): void {
	const meta = readHeaderMeta(registry.header, view.headerSlot);
	view.isUniform = (meta & LIGHT_HEADER_FLAG_UNIFORM) !== 0;
	view.storageIsUint16 = (meta & LIGHT_HEADER_FLAG_STORAGE_U16) !== 0;
	view.hasPalette = (meta & LIGHT_HEADER_FLAG_HAS_PALETTE) !== 0;
	view.isLoaded = (meta & LIGHT_HEADER_FLAG_LOADED) !== 0;
	view.uniformBlockId = (meta >>> 16) & 0xffff;
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
		neighborViews: [null, null, null, null, null, null],
	};
	refreshLayout(registry, view);
	registry.views.set(view.chunkId, view);
	linkNeighborViews(registry, view);
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
	const view = registry.views.get(chunkId);
	if (view) {
		// Null back-links from neighbors so they don't hold stale refs.
		const n = view.neighborViews;
		for (let d = 0; d < 6; d++) {
			const nbr = n[d];
			if (nbr) {
				// Opposite direction: d ^ 1 swaps 0↔1, 2↔3, 4↔5
				nbr.neighborViews[d ^ 1] = null;
			}
		}
	}
	registry.views.delete(chunkId);
}

/**
 * If the cell at (x, y, z) in `view` touches a chunk border, look up the
 * adjacent chunk across that border and add its header slot to dirtySlots.
 * This ensures the neighbour's mesh is rebuilt with the updated lighting
 * at the shared face.
 */
function addAdjacentBorderSlots(
	dirtySlots: Set<number>,
	view: ChunkView,
	x: number,
	y: number,
	z: number,
): void {
	const size = LIGHT_CHUNK_SIZE;
	if (x === 0) _tryAddNeighbour(dirtySlots, view, -1, 0, 0);
	else if (x === size - 1) _tryAddNeighbour(dirtySlots, view, 1, 0, 0);
	if (y === 0) _tryAddNeighbour(dirtySlots, view, 0, -1, 0);
	else if (y === size - 1) _tryAddNeighbour(dirtySlots, view, 0, 1, 0);
	if (z === 0) _tryAddNeighbour(dirtySlots, view, 0, 0, -1);
	else if (z === size - 1) _tryAddNeighbour(dirtySlots, view, 0, 0, 1);
}

function _tryAddNeighbour(
	dirtySlots: Set<number>,
	view: ChunkView,
	dx: number,
	dy: number,
	dz: number,
): void {
	let next: ChunkView | null = null;
	if (dx !== 0) next = view.neighborViews[dx > 0 ? DIR_PX : DIR_NX];
	else if (dy !== 0) next = view.neighborViews[dy > 0 ? DIR_PY : DIR_NY];
	else next = view.neighborViews[dz > 0 ? DIR_PZ : DIR_NZ];
	if (next) {
		dirtySlots.add(next.headerSlot);
	}
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
		return view.palette[nibble];
	}
	const arr = view.block_array as Uint8Array | Uint16Array;
	return arr[idx];
}

function getBlockLight(view: ChunkView, idx: number): number {
	return view.light_array[idx] & LIGHT_BLOCK_MASK;
}

function getSkyLight(view: ChunkView, idx: number): number {
	return (view.light_array[idx] >> LIGHT_SKY_SHIFT) & LIGHT_BLOCK_MASK;
}

const enum WriteResult {
	Wrote,
	Skipped,
	Aborted,
}

/**
 * Update a light byte if `next` strictly improves it.
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
	if (!view.isLoaded) return WriteResult.Aborted;
	const light = view.light_array;
	const mask = isSky ? LIGHT_BLOCK_MASK : LIGHT_BLOCK_MASK << LIGHT_SKY_SHIFT;
	const shift = isSky ? LIGHT_SKY_SHIFT : 0;
	const currentMask = isSky
		? LIGHT_BLOCK_MASK << LIGHT_SKY_SHIFT
		: LIGHT_BLOCK_MASK;

	const cur = light[idx];
	const curLevel = (cur & currentMask) >> shift;
	if (curLevel >= nextLevel) return WriteResult.Skipped;
	light[idx] = (cur & mask) | (nextLevel << shift);
	return WriteResult.Wrote;
}

function clearLightByte(view: ChunkView, idx: number, isSky: boolean): boolean {
	if (!view.isLoaded) return false;
	const light = view.light_array;
	const mask = isSky ? LIGHT_BLOCK_MASK : LIGHT_BLOCK_MASK << LIGHT_SKY_SHIFT;
	const cur = light[idx];
	const newByte = cur & mask;
	if (newByte === cur) return false;
	light[idx] = newByte;
	return true;
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
		const chunkId = q.chunks[slot] as bigint;
		const coord = q.coords[slot];
		const x = coord & 0x1f;
		const y = (coord >> 5) & 0x1f;
		const z = (coord >> 10) & 0x1f;

		const view = registry.views.get(chunkId);
		if (!view) continue;
		refreshLayout(registry, view);
		if (!view.isLoaded) continue;

		const lightArr = view.light_array;
		if (lightArr.length === 0) continue;

		const idx = x + y * size + z * size2;
		const level = isSkyLight
			? (lightArr[idx] >> skyShift) & 0xf
			: lightArr[idx] & 0xf;
		if (level <= 0) continue;

		const sourcePacked = getViewBlockPacked(view, x, y, z);
		const sourceBlockId = unpackBlockId(sourcePacked);
		const sourceEmits = !isSkyLight && getLightEmission(sourceBlockId) > 0;

		for (let i = 0; i < LIGHT_DIR_COUNT; i++) {
			const base = i * LIGHT_DIR_STRIDE;
			const dx = LIGHT_DIRS_FLAT[base];
			const dy = LIGHT_DIRS_FLAT[base + 1];
			const dz = LIGHT_DIRS_FLAT[base + 2];
			const axis = LIGHT_DIRS_FLAT[base + 3];
			const dir = LIGHT_DIRS_FLAT[base + 4];
			const isDown = LIGHT_DIRS_FLAT[base + 5];

			let tx = x + dx;
			let ty = y + dy;
			let tz = z + dz;
			let targetView: ChunkView = view;

			// Resolve cross-chunk boundaries via cached neighbor views.
			if (
				tx < 0 ||
				tx >= size ||
				ty < 0 ||
				ty >= size ||
				tz < 0 ||
				tz >= size
			) {
				const resolved = resolveNeighborView(view, tx, ty, tz, size);
				if (!resolved) continue;
				targetView = resolved.view;
				tx = resolved.x;
				ty = resolved.y;
				tz = resolved.z;
			}
			if (targetView !== view) {
				refreshLayout(registry, targetView);
			}
			if (!targetView.isLoaded) continue;

			const targetPacked = getViewBlockPacked(targetView, tx, ty, tz);

			if (isSkyLight && isDown !== 1 && filtersFullSunlight(sourceBlockId)) {
				const peekId = unpackBlockId(targetPacked);
				if (!filtersFullSunlight(peekId)) continue;
			} else if (
				isSkyLight
					? !isTransparent(sourcePacked, axis, dir)
					: !sourceEmits && !isTransparent(sourcePacked, axis, dir)
			) {
				continue;
			}

			if (!isTransparent(targetPacked, axis, -dir)) continue;

			const tidx = tx + ty * size + tz * size2;
			const currentLevel = isSkyLight
				? (targetView.light_array[tidx] >> skyShift) & 0xf
				: targetView.light_array[tidx] & 0xf;

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
			if (result === WriteResult.Wrote) {
				dirtySlots.add(targetView.headerSlot);
				addAdjacentBorderSlots(dirtySlots, targetView, tx, ty, tz);
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
	initialOldPacked?: number,
): void {
	const size = LIGHT_CHUNK_SIZE;
	const size2 = LIGHT_CHUNK_SIZE2;

	let isFirstDequeue = true;

	while (q.head !== q.tail) {
		const slot = q.head & (BFS_CAPACITY - 1);
		q.head = (q.head + 1) & (BFS_CAPACITY - 1);
		const chunkId = q.chunks[slot] as bigint;
		const coord = q.coords[slot];
		const cx = coord & 0x1f;
		const cy = (coord >> 5) & 0x1f;
		const cz = (coord >> 10) & 0x1f;
		const view = registry.views.get(chunkId);
		if (!view) continue;
		refreshLayout(registry, view);
		if (!view.isLoaded) continue;

		const level = q.levels[slot];

		const sourcePacked =
			isFirstDequeue && initialOldPacked !== undefined
				? initialOldPacked
				: getViewBlockPacked(view, cx, cy, cz);
		isFirstDequeue = false;
		const sourceBlockId = unpackBlockId(sourcePacked);
		const sourceEmits = !isSkyLight && getLightEmission(sourceBlockId) > 0;

		for (let i = 0; i < LIGHT_DIR_COUNT; i++) {
			const base = i * LIGHT_DIR_STRIDE;
			const dx = LIGHT_DIRS_FLAT[base];
			const dy = LIGHT_DIRS_FLAT[base + 1];
			const dz = LIGHT_DIRS_FLAT[base + 2];
			const axis = LIGHT_DIRS_FLAT[base + 3];
			const dir = LIGHT_DIRS_FLAT[base + 4];
			const isDown = LIGHT_DIRS_FLAT[base + 5];

			let tx = cx + dx;
			let ty = cy + dy;
			let tz = cz + dz;
			let targetView: ChunkView | undefined = view;

			if (
				tx < 0 ||
				tx >= size ||
				ty < 0 ||
				ty >= size ||
				tz < 0 ||
				tz >= size
			) {
				const resolved = resolveNeighborView(view, tx, ty, tz, size);
				if (!resolved) continue;
				targetView = resolved.view;
				tx = resolved.x;
				ty = resolved.y;
				tz = resolved.z;
			}
			if (targetView !== view) {
				refreshLayout(registry, targetView);
			}
			if (!targetView.isLoaded) continue;

			if (
				isSkyLight
					? !isTransparent(sourcePacked, axis, dir) ||
						(isDown !== 1 && filtersFullSunlight(sourceBlockId))
					: !sourceEmits && !isTransparent(sourcePacked, axis, dir)
			)
				continue;

			const targetPacked = getViewBlockPacked(targetView, tx, ty, tz);
			if (!isTransparent(targetPacked, axis, -dir)) continue;

			const tIdx = tx + ty * size + tz * size2;
			const tArr = targetView.light_array;
			const neighborLevel = isSkyLight
				? (tArr[tIdx] >> LIGHT_SKY_SHIFT) & 0xf
				: tArr[tIdx] & 0xf;
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
					addAdjacentBorderSlots(dirtySlots, targetView, tx, ty, tz);
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
	if (!view) return _emptyNumberSet;
	refreshLayout(registry, view);
	if (!view.isLoaded) return _emptyNumberSet;

	const idx = x + y * LIGHT_CHUNK_SIZE + z * LIGHT_CHUNK_SIZE2;
	_dirtySlotsScratch.clear();
	const dirtySlots = _dirtySlotsScratch;

	const oldBlockLight = getBlockLight(view, idx);
	const oldSkyLight = getSkyLight(view, idx);

	if (oldBlockLight > 0) {
		removeLightAt(
			registry,
			view,
			x,
			y,
			z,
			oldBlockLight,
			false,
			dirtySlots,
			oldPacked,
		);
	}

	const newBlockId = unpackBlockId(_newPacked);
	const emission = getLightEmission(newBlockId);
	if (emission > 0) {
		addLightAt(registry, view, x, y, z, emission, dirtySlots);
	}

	updateLightFromNeighborsAt(registry, view, x, y, z, false, dirtySlots);

	if (oldSkyLight > 0) {
		removeLightAt(
			registry,
			view,
			x,
			y,
			z,
			oldSkyLight,
			true,
			dirtySlots,
			oldPacked,
		);
	}
	updateLightFromNeighborsAt(registry, view, x, y, z, true, dirtySlots);

	const newIsSkyTransparent = isTransparent(_newPacked, 1, 1);
	const oldWasSkyTransparent = isTransparent(oldPacked, 1, 1);
	if (oldWasSkyTransparent && !newIsSkyTransparent && oldSkyLight > 0) {
		cutSkyLightBelowAt(registry, view, x, y, z, dirtySlots);
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
	oldPacked?: number,
): void {
	const idx = x + y * LIGHT_CHUNK_SIZE + z * LIGHT_CHUNK_SIZE2;
	if (startLevel === 0) return;

	if (clearLightByte(view, idx, isSkyLight)) {
		dirtySlots.add(view.headerSlot);
		addAdjacentBorderSlots(dirtySlots, view, x, y, z);
	}

	Q_A.clear();
	Q_B.clear();
	Q_A.push(view.chunkId, x, y, z, startLevel);

	processRemoveQueue(registry, Q_A, isSkyLight, dirtySlots, oldPacked);

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
	let currentTargetLevel = isSkyLight
		? getSkyLight(view, x + y * size + z * size2)
		: getBlockLight(view, x + y * size + z * size2);
	const targetBlockId2 = unpackBlockId(targetBlockPacked);

	Q_A.clear();

	for (let i = 0; i < LIGHT_DIR_COUNT; i++) {
		const base = i * LIGHT_DIR_STRIDE;
		const dx = LIGHT_DIRS_FLAT[base];
		const dy = LIGHT_DIRS_FLAT[base + 1];
		const dz = LIGHT_DIRS_FLAT[base + 2];
		const axis = LIGHT_DIRS_FLAT[base + 3];
		const dir = -LIGHT_DIRS_FLAT[base + 4] as -1 | 1;
		const sourceIsAbove = dy > 0;

		let sourceView: ChunkView | undefined = view;
		let sx = x + dx;
		let sy = y + dy;
		let sz = z + dz;

		if (sx < 0 || sx >= size || sy < 0 || sy >= size || sz < 0 || sz >= size) {
			const resolved = resolveNeighborView(view, sx, sy, sz, size);
			if (!resolved) continue;
			sourceView = resolved.view;
			sx = resolved.x;
			sy = resolved.y;
			sz = resolved.z;
		}
		if (sourceView !== view) {
			refreshLayout(registry, sourceView);
			if (!sourceView.isLoaded) continue;
		}

		const sourceBlockPacked = getViewBlockPacked(sourceView, sx, sy, sz);
		const sourceBlockId = unpackBlockId(sourceBlockPacked);
		const sourceEmits = !isSkyLight && getLightEmission(sourceBlockId) > 0;

		const lateralWaterToWater =
			isSkyLight &&
			!sourceIsAbove &&
			filtersFullSunlight(sourceBlockId) &&
			filtersFullSunlight(targetBlockId2);

		const sourceAllows = isSkyLight
			? isTransparent(sourceBlockPacked, axis, dir) &&
				(sourceIsAbove ||
					!filtersFullSunlight(sourceBlockId) ||
					lateralWaterToWater)
			: sourceEmits || isTransparent(sourceBlockPacked, axis, dir);
		if (!sourceAllows) continue;

		if (!isTransparent(targetBlockPacked, axis, -dir)) continue;

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
		const result3 = casLightByte(
			view,
			x + y * size + z * size2,
			isSkyLight,
			nextLevel,
		);
		if (result3 === WriteResult.Wrote) {
			currentTargetLevel = nextLevel;
			dirtySlots.add(view.headerSlot);
			addAdjacentBorderSlots(dirtySlots, view, x, y, z);
		}
		Q_A.push(view.chunkId, x, y, z, nextLevel);
	}

	if (Q_A.head !== Q_A.tail) {
		processQueue(registry, Q_A, isSkyLight, dirtySlots);
	}
}

export function addLightAt(
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

	if (casLightByte(view, idx, false, level) === WriteResult.Wrote) {
		dirtySlots.add(view.headerSlot);
		addAdjacentBorderSlots(dirtySlots, view, x, y, z);
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
	const size2 = size * size;

	let targetView: ChunkView = view;
	const tx = x;
	let ty = y - 1;
	const tz = z;

	if (ty < 0) {
		const next = targetView.neighborViews[DIR_NY];
		if (!next) return;
		targetView = next;
		ty = size - 1;
	}
	refreshLayout(registry, targetView);
	if (!targetView.isLoaded) return;

	while (true) {
		const tidx = tx + ty * size + tz * size2;
		const belowBlockPacked = getViewBlockPacked(targetView, tx, ty, tz);
		if (!isTransparent(belowBlockPacked, 1, 1)) break;

		const belowSky = getSkyLight(targetView, tidx);
		if (belowSky <= 0) break;

		removeLightAt(registry, targetView, tx, ty, tz, belowSky, true, dirtySlots);
		updateLightFromNeighborsAt(
			registry,
			targetView,
			tx,
			ty,
			tz,
			true,
			dirtySlots,
		);

		ty--;
		if (ty < 0) {
			const next = targetView.neighborViews[DIR_NY];
			if (!next) break;
			targetView = next;
			ty = size - 1;
			refreshLayout(registry, targetView);
			if (!targetView.isLoaded) break;
		}
	}
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
	_dirtySlotsScratch.clear();
	const dirtySlots = _dirtySlotsScratch;
	const view = registry.views.get(chunkId);
	if (!view) return dirtySlots;
	refreshLayout(registry, view);
	if (!view.isLoaded) return dirtySlots;

	const size = LIGHT_CHUNK_SIZE;
	const size2 = size * size;
	const last = size - 1;

	const selfEdges = [0, last, 0, last, 0, last];
	const neighborEdges = [last, 0, last, 0, last, 0];

	let seedCount = 0;

	for (let f = 0; f < 6; f++) {
		const neighbor = view.neighborViews[f ^ 1];
		if (!neighbor) continue;
		refreshLayout(registry, neighbor);
		refreshLayout(registry, view);
		if (!neighbor.isLoaded) continue;

		const selfEdge = selfEdges[f];
		const neighborEdge = neighborEdges[f];
		const axis = f < 2 ? 0 : f < 4 ? 1 : 2;

		if (axis === 0) {
			const selfX = selfEdge;
			const nbrX = neighborEdge;
			for (let u = 0; u < size; u++) {
				for (let v = 0; v < size; v++) {
					const sidx = selfX + u * size + v * size2;
					const nidx = nbrX + u * size + v * size2;
					const selfSky = (view.light_array[sidx] >> LIGHT_SKY_SHIFT) & 0xf;
					const neighborSky =
						(neighbor.light_array[nidx] >> LIGHT_SKY_SHIFT) & 0xf;
					if (selfSky === neighborSky) continue;
					if (seedCount >= 6144) return dirtySlots;
					const selfHigher = selfSky > neighborSky;
					seedChunks[seedCount] = selfHigher ? view.chunkId : neighbor.chunkId;
					seedCoords[seedCount * 3] = selfHigher ? selfX : nbrX;
					seedCoords[seedCount * 3 + 1] = selfHigher ? u : u;
					seedCoords[seedCount * 3 + 2] = selfHigher ? v : v;
					seedLevels[seedCount] = selfHigher ? selfSky : neighborSky;
					seedCount++;
				}
			}
		} else if (axis === 1) {
			const selfY = selfEdge;
			const nbrY = neighborEdge;
			for (let u = 0; u < size; u++) {
				for (let v = 0; v < size; v++) {
					const sidx = u + selfY * size + v * size2;
					const nidx = u + nbrY * size + v * size2;
					const selfSky = (view.light_array[sidx] >> LIGHT_SKY_SHIFT) & 0xf;
					const neighborSky =
						(neighbor.light_array[nidx] >> LIGHT_SKY_SHIFT) & 0xf;
					if (selfSky === neighborSky) continue;
					if (seedCount >= 6144) return dirtySlots;
					const selfHigher = selfSky > neighborSky;
					seedChunks[seedCount] = selfHigher ? view.chunkId : neighbor.chunkId;
					seedCoords[seedCount * 3] = selfHigher ? u : u;
					seedCoords[seedCount * 3 + 1] = selfHigher ? selfY : nbrY;
					seedCoords[seedCount * 3 + 2] = selfHigher ? v : v;
					seedLevels[seedCount] = selfHigher ? selfSky : neighborSky;
					seedCount++;
				}
			}
		} else {
			const selfZ = selfEdge;
			const nbrZ = neighborEdge;
			for (let u = 0; u < size; u++) {
				for (let v = 0; v < size; v++) {
					const sidx = u + v * size + selfZ * size2;
					const nidx = u + v * size + nbrZ * size2;
					const selfSky = (view.light_array[sidx] >> LIGHT_SKY_SHIFT) & 0xf;
					const neighborSky =
						(neighbor.light_array[nidx] >> LIGHT_SKY_SHIFT) & 0xf;
					if (selfSky === neighborSky) continue;
					if (seedCount >= 6144) return dirtySlots;
					const selfHigher = selfSky > neighborSky;
					seedChunks[seedCount] = selfHigher ? view.chunkId : neighbor.chunkId;
					seedCoords[seedCount * 3] = selfHigher ? u : u;
					seedCoords[seedCount * 3 + 1] = selfHigher ? v : v;
					seedCoords[seedCount * 3 + 2] = selfHigher ? selfZ : nbrZ;
					seedLevels[seedCount] = selfHigher ? selfSky : neighborSky;
					seedCount++;
				}
			}
		}
	}

	if (seedCount > 0) {
		return batchPropagate(
			registry,
			seedChunks,
			seedCoords,
			seedLevels,
			seedCount,
			dirtySlots,
		);
	}
	return dirtySlots;

	function batchPropagate(
		registry: ChunkViewRegistry,
		chunks: BigInt64Array,
		coords: Int32Array,
		levels: Uint8Array,
		count: number,
		dirty: Set<number>,
	): Set<number> {
		Q_A.clear();
		for (let i = 0; i < count; i++) {
			const base = i * 3;
			Q_A.push(
				chunks[i],
				coords[base],
				coords[base + 1],
				coords[base + 2],
				levels[i],
			);
		}
		if (Q_A.head !== Q_A.tail) {
			processQueue(registry, Q_A, true, dirty);
		}
		return dirty;
	}
}

/**
 * Reconcile block (non-sky) light across chunk borders after a neighbour
 * chunk registers in the worker.  Catches light that was dropped by a BFS
 * pass because the destination chunk wasn't available yet.
 */
export function lightBlockReconcile(
	registry: ChunkViewRegistry,
	chunkId: bigint,
): Set<number> {
	_dirtySlotsScratch.clear();
	const dirtySlots = _dirtySlotsScratch;
	const view = registry.views.get(chunkId);
	if (!view) return dirtySlots;
	refreshLayout(registry, view);
	if (!view.isLoaded) return dirtySlots;

	const size = LIGHT_CHUNK_SIZE;
	const size2 = size * size;

	Q_A.clear();

	for (let fi = 0; fi < 6; fi++) {
		const f = RECONCILE_FACES[fi];
		const neighbor = view.neighborViews[fi ^ 1];
		if (!neighbor) continue;
		refreshLayout(registry, neighbor);
		if (!neighbor.isLoaded) continue;

		const fAxis = f.axis;
		const fDir = f.dir;
		const fSelfEdge = f.selfEdge;
		const fNbrEdge = f.neighborEdge;

		if (fAxis === 0) {
			const selfX = fSelfEdge;
			const nbrX = fNbrEdge;
			for (let u = 0; u < size; u++) {
				for (let v = 0; v < size; v++) {
					const sidx = selfX + u * size + v * size2;
					const nidx = nbrX + u * size + v * size2;
					const selfLevel = getBlockLight(view, sidx);
					const neighborLevel = getBlockLight(neighbor, nidx);

					if (selfLevel > 1 && neighborLevel < selfLevel - 1) {
						const sourcePacked = getViewBlockPacked(view, selfX, u, v);
						const targetPacked = getViewBlockPacked(neighbor, nbrX, u, v);
						const sourceBlockId = unpackBlockId(sourcePacked);
						const sourceEmits = getLightEmission(sourceBlockId) > 0;
						if (
							(sourceEmits || isTransparent(sourcePacked, fAxis, fDir)) &&
							isTransparent(targetPacked, fAxis, -fDir)
						) {
							Q_A.push(view.chunkId, selfX, u, v, selfLevel);
						}
					}

					if (neighborLevel > 1 && selfLevel < neighborLevel - 1) {
						const sourcePacked = getViewBlockPacked(neighbor, nbrX, u, v);
						const targetPacked = getViewBlockPacked(view, selfX, u, v);
						const sourceBlockId = unpackBlockId(sourcePacked);
						const sourceEmits = getLightEmission(sourceBlockId) > 0;
						if (
							(sourceEmits || isTransparent(sourcePacked, fAxis, -fDir)) &&
							isTransparent(targetPacked, fAxis, fDir)
						) {
							Q_A.push(neighbor.chunkId, nbrX, u, v, neighborLevel);
						}
					}
				}
			}
		} else if (fAxis === 1) {
			const selfY = fSelfEdge;
			const nbrY = fNbrEdge;
			for (let u = 0; u < size; u++) {
				for (let v = 0; v < size; v++) {
					const sidx = u + selfY * size + v * size2;
					const nidx = u + nbrY * size + v * size2;
					const selfLevel = getBlockLight(view, sidx);
					const neighborLevel = getBlockLight(neighbor, nidx);

					if (selfLevel > 1 && neighborLevel < selfLevel - 1) {
						const sourcePacked = getViewBlockPacked(view, u, selfY, v);
						const targetPacked = getViewBlockPacked(neighbor, u, nbrY, v);
						const sourceBlockId = unpackBlockId(sourcePacked);
						const sourceEmits = getLightEmission(sourceBlockId) > 0;
						if (
							(sourceEmits || isTransparent(sourcePacked, fAxis, fDir)) &&
							isTransparent(targetPacked, fAxis, -fDir)
						) {
							Q_A.push(view.chunkId, u, selfY, v, selfLevel);
						}
					}

					if (neighborLevel > 1 && selfLevel < neighborLevel - 1) {
						const sourcePacked = getViewBlockPacked(neighbor, u, nbrY, v);
						const targetPacked = getViewBlockPacked(view, u, selfY, v);
						const sourceBlockId = unpackBlockId(sourcePacked);
						const sourceEmits = getLightEmission(sourceBlockId) > 0;
						if (
							(sourceEmits || isTransparent(sourcePacked, fAxis, -fDir)) &&
							isTransparent(targetPacked, fAxis, fDir)
						) {
							Q_A.push(neighbor.chunkId, u, nbrY, v, neighborLevel);
						}
					}
				}
			}
		} else {
			const selfZ = fSelfEdge;
			const nbrZ = fNbrEdge;
			for (let u = 0; u < size; u++) {
				for (let v = 0; v < size; v++) {
					const sidx = u + v * size + selfZ * size2;
					const nidx = u + v * size + nbrZ * size2;
					const selfLevel = getBlockLight(view, sidx);
					const neighborLevel = getBlockLight(neighbor, nidx);

					if (selfLevel > 1 && neighborLevel < selfLevel - 1) {
						const sourcePacked = getViewBlockPacked(view, u, v, selfZ);
						const targetPacked = getViewBlockPacked(neighbor, u, v, nbrZ);
						const sourceBlockId = unpackBlockId(sourcePacked);
						const sourceEmits = getLightEmission(sourceBlockId) > 0;
						if (
							(sourceEmits || isTransparent(sourcePacked, fAxis, fDir)) &&
							isTransparent(targetPacked, fAxis, -fDir)
						) {
							Q_A.push(view.chunkId, u, v, selfZ, selfLevel);
						}
					}

					if (neighborLevel > 1 && selfLevel < neighborLevel - 1) {
						const sourcePacked = getViewBlockPacked(neighbor, u, v, nbrZ);
						const targetPacked = getViewBlockPacked(view, u, v, selfZ);
						const sourceBlockId = unpackBlockId(sourcePacked);
						const sourceEmits = getLightEmission(sourceBlockId) > 0;
						if (
							(sourceEmits || isTransparent(sourcePacked, fAxis, -fDir)) &&
							isTransparent(targetPacked, fAxis, fDir)
						) {
							Q_A.push(neighbor.chunkId, u, v, nbrZ, neighborLevel);
						}
					}
				}
			}
		}
	}

	if (Q_A.head !== Q_A.tail) {
		processQueue(registry, Q_A, false, dirtySlots);
	}

	return dirtySlots;
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
	_dirtySlotsScratch.clear();
	const dirtySlots = _dirtySlotsScratch;
	const view = registry.views.get(chunkId);
	if (!view) return dirtySlots;
	refreshLayout(registry, view);
	if (!view.isLoaded) return dirtySlots;
	if (seedState.length <= 0) return dirtySlots;

	const size = LIGHT_CHUNK_SIZE;
	const size2 = LIGHT_CHUNK_SIZE2;
	const skyShift = LIGHT_SKY_SHIFT;
	Q_A.clear();

	for (let i = 0; i < seedState.length; i++) {
		const val = seedState.queue[i];
		const x = (val >> 10) & 0x1f;
		const y = (val >> 5) & 0x1f;
		const z = val & 0x1f;
		const level =
			(view.light_array[x + y * size + z * size2] >> skyShift) & 0xf;
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
	bumpHeaderLightSeq(registry.header, slot);
}
