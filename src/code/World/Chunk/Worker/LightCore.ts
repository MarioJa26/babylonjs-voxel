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

import {
	CHUNK_SIZE,
	CHUNK_SIZE2,
	CHUNK_SIZE3,
	LIGHT_NIBBLE_MASK,
	SKY_LIGHT_SHIFT,
} from "@/code/Lib/VoxelMath";
import { unpackBlockId } from "../DataStructures/BlockEncoding";
import { packCoords } from "../DataStructures/ChunkCoords";
import {
	bumpHeaderLightSeq,
	LIGHT_HEADER_FLAG_HAS_PALETTE,
	LIGHT_HEADER_FLAG_LOADED,
	LIGHT_HEADER_FLAG_STORAGE_U16,
	LIGHT_HEADER_FLAG_UNIFORM,
	type LightHeaderView,
	MAX_HEADER_SLOTS,
	readHeaderMeta,
} from "./ChunkLightHeader";
import { filtersFullSunlight, WATER_BLOCK_ID } from "./ChunkMesherConstants";

// ---------------------------------------------------------------------------
// DirtySlotSet — stamp-epoch bitmap backed by a touched list.  Replaces the
// Set<number> scratch accumulators: Set.add() is relatively expensive and
// per-call allocations show up in profiles.  clear() is O(touched), add()
// is two array writes, iteration walks the touched list directly.
// Safe because the light worker is single-threaded and each function
// consumes the collection synchronously before the next clear().
// ---------------------------------------------------------------------------

export class DirtySlotSet {
	private readonly stamps = new Uint8Array(MAX_HEADER_SLOTS);
	private readonly touched = new Int32Array(MAX_HEADER_SLOTS);
	private epoch = 0;
	private count = 0;

	get size(): number {
		return this.count;
	}

	clear(): void {
		this.epoch++;
		if (this.epoch === 255) {
			this.stamps.fill(0);
			this.epoch = 1;
		}
		this.count = 0;
	}

	add(slot: number): void {
		if (this.stamps[slot] === this.epoch) return;
		this.stamps[slot] = this.epoch;
		this.touched[this.count++] = slot;
	}

	[Symbol.iterator](): Iterator<number> {
		const n = this.count;
		const touched = this.touched;
		let i = 0;
		return {
			next(): IteratorResult<number> {
				return i < n
					? { value: touched[i++], done: false }
					: { value: undefined, done: true };
			},
		};
	}

	// NEW: Zero-allocation direct iteration for engine-level hot paths
	forEach(fn: (slot: number) => void): void {
		const n = this.count;
		const touched = this.touched;
		for (let i = 0; i < n; i++) {
			fn(touched[i]);
		}
	}
}

// Reusable scratch for dirtySlots — avoids per-call allocation.
const _dirtySlotsScratch = new DirtySlotSet();

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

export const LIGHT_CHUNK_SIZE = CHUNK_SIZE;
export const LIGHT_CHUNK_SIZE2 = CHUNK_SIZE2;
export const LIGHT_CHUNK_SIZE3 = CHUNK_SIZE3;

// Reusable face descriptors for lightBlockReconcile (size = 32, last = 31).
const RECONCILE_FACES = [
	{ dx: -1, dy: 0, dz: 0, axis: 0, selfEdge: 0, neighborEdge: 31, dir: -1 },
	{ dx: 1, dy: 0, dz: 0, axis: 0, selfEdge: 31, neighborEdge: 0, dir: 1 },
	{ dx: 0, dy: -1, dz: 0, axis: 1, selfEdge: 0, neighborEdge: 31, dir: -1 },
	{ dx: 0, dy: 1, dz: 0, axis: 1, selfEdge: 31, neighborEdge: 0, dir: 1 },
	{ dx: 0, dy: 0, dz: -1, axis: 2, selfEdge: 0, neighborEdge: 31, dir: -1 },
	{ dx: 0, dy: 0, dz: 1, axis: 2, selfEdge: 31, neighborEdge: 0, dir: 1 },
] as const;

export const LIGHT_SKY_SHIFT = SKY_LIGHT_SHIFT;
export const LIGHT_BLOCK_MASK = LIGHT_NIBBLE_MASK;

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
	// Queue nodes store the dense header slot, not the chunkId — the BFS
	// only needs the slot to index the registry's flat bySlot array, which
	// skips the bigint-hash Map lookup that used to run per node.
	readonly slots = new Int32Array(BFS_CAPACITY);
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

	push(
		headerSlot: number,
		x: number,
		y: number,
		z: number,
		level: number,
	): void {
		const slot = this.tail & (BFS_CAPACITY - 1);
		this.slots[slot] = headerSlot;
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
const seedSlots = new Int32Array(SEED_CAPACITY);
const seedCoords = new Int32Array(SEED_CAPACITY * 3);
const seedLevels = new Uint8Array(SEED_CAPACITY);

// ---------------------------------------------------------------------------
// Face / transparency tables
// ---------------------------------------------------------------------------

import {
	FACE_ALL,
	FACE_NX,
	FACE_NY,
	FACE_NZ,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
} from "../../Shape/BlockShapes";

const GLASS_01_BLOCK_ID = 60;
const GLASS_02_BLOCK_ID = 61;
// Shared empty collection for early-return paths in the public entry points.
const _emptyDirtySlots = new DirtySlotSet();

const _lightEmissionLUT = (() => {
	const lut = new Uint8Array(256);
	lut[10] = 15;
	lut[11] = 15;
	lut[24] = 15;
	lut[94] = 15;
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

// Dense lookup indexed by blockId for O(1) cold-path resolution.
// Default FACE_ALL (cube) — only transparent/air blocks differ.
const QUICK_CLOSED_MASK = new Uint8Array(256).fill(FACE_ALL);
QUICK_CLOSED_MASK[0] = 0; // Air
QUICK_CLOSED_MASK[WATER_BLOCK_ID] = 0;
QUICK_CLOSED_MASK[GLASS_01_BLOCK_ID] = 0;
QUICK_CLOSED_MASK[GLASS_02_BLOCK_ID] = 0;
QUICK_CLOSED_MASK[64] = 0; // GrassCross
QUICK_CLOSED_MASK[66] = 0; // SavannahGrassCross
QUICK_CLOSED_MASK[91] = 0; // Grass006Cross
QUICK_CLOSED_MASK[94] = 0; // Torch

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
	CLOSED_FACE_MASK_CACHE[cacheIndex] = quick;
	return quick;
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
	/**
	 * Views indexed by dense header slot (the pool's slot allocation is
	 * sent to the worker in every Light* message). The BFS hot paths look
	 * up views here with a single array index instead of a bigint-keyed
	 * Map.get(). Size = MAX_HEADER_SLOTS; a slot is null when unassigned.
	 */
	bySlot: (ChunkView | null)[];
	/** chunkId → view, for the rare chunkId-keyed entry points (unregister, neighbor linking). */
	byChunkId: Map<bigint, ChunkView>;
};

export function createRegistry(header: LightHeaderView): ChunkViewRegistry {
	return {
		header,
		bySlot: new Array<ChunkView | null>(MAX_HEADER_SLOTS).fill(null),
		byChunkId: new Map(),
	};
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
	n[DIR_PX] = registry.byChunkId.get(packCoords(cx + 1, cy, cz)) ?? null;
	n[DIR_NX] = registry.byChunkId.get(packCoords(cx - 1, cy, cz)) ?? null;
	n[DIR_PY] = registry.byChunkId.get(packCoords(cx, cy + 1, cz)) ?? null;
	n[DIR_NY] = registry.byChunkId.get(packCoords(cx, cy - 1, cz)) ?? null;
	n[DIR_PZ] = registry.byChunkId.get(packCoords(cx, cy, cz + 1)) ?? null;
	n[DIR_NZ] = registry.byChunkId.get(packCoords(cx, cy, cz - 1)) ?? null;

	// Back-link: each neighbor points to this view in the opposite direction.
	if (n[DIR_PX]) n[DIR_PX].neighborViews[DIR_NX] = view;
	if (n[DIR_NX]) n[DIR_NX].neighborViews[DIR_PX] = view;
	if (n[DIR_PY]) n[DIR_PY].neighborViews[DIR_NY] = view;
	if (n[DIR_NY]) n[DIR_NY].neighborViews[DIR_PY] = view;
	if (n[DIR_PZ]) n[DIR_PZ].neighborViews[DIR_NZ] = view;
	if (n[DIR_NZ]) n[DIR_NZ].neighborViews[DIR_PZ] = view;
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
): ChunkView | null {
	if (args.headerSlot < 0 || args.headerSlot >= MAX_HEADER_SLOTS) return null;
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
	registry.byChunkId.set(view.chunkId, view);
	registry.bySlot[view.headerSlot] = view;
	linkNeighborViews(registry, view);
	return view;
}

export function updateChunkBuffers(
	registry: ChunkViewRegistry,
	headerSlot: number,
	updates: {
		block_array?: Uint8Array | Uint16Array | null;
		palette?: Uint16Array | null;
		light_array?: Uint8Array;
	},
): void {
	const view =
		headerSlot >= 0 && headerSlot < MAX_HEADER_SLOTS
			? registry.bySlot[headerSlot]
			: undefined;
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
	const view = registry.byChunkId.get(chunkId);
	if (view) {
		// Null the slot entry so a stale slot can never alias a reused slot.
		if (
			view.headerSlot >= 0 &&
			view.headerSlot < MAX_HEADER_SLOTS &&
			registry.bySlot[view.headerSlot] === view
		) {
			registry.bySlot[view.headerSlot] = null;
		}
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
	registry.byChunkId.delete(chunkId);
}

/**
 * If the cell at (x, y, z) in `view` touches a chunk border, look up the
 * adjacent chunk across that border and add its header slot to dirtySlots.
 * This ensures the neighbour's mesh is rebuilt with the updated lighting
 * at the shared face.
 */
function addAdjacentBorderSlots(
	dirtySlots: DirtySlotSet,
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
	dirtySlots: DirtySlotSet,
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

/**
 * Read a packed block value at a flattened index.  The BFS hot loops always
 * have the flattened index in hand, so the x,y,z-computing variant was
 * removed — callers that once recomputed it now pass it directly.
 */
function getViewBlockPackedAt(view: ChunkView, idx: number): number {
	if (view.isUniform) return view.uniformBlockId;
	if (!view.block_array) return 0;
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
//
// Split by light channel (sky / block) so the invariant `isSkyLight` flag
// never branches inside the hot loop; the shift/mask constants are baked in.
// ---------------------------------------------------------------------------

function processSkyQueue(
	registry: ChunkViewRegistry,
	q: LightQueue,
	dirtySlots: DirtySlotSet,
): void {
	const skyShift = LIGHT_SKY_SHIFT;
	const blockMask = LIGHT_BLOCK_MASK;

	let lastRefreshedView: ChunkView | null = null;
	let lastRefreshedTarget: ChunkView | null = null;

	while (q.head !== q.tail) {
		const slot = q.head & (BFS_CAPACITY - 1);
		q.head = (q.head + 1) & (BFS_CAPACITY - 1);
		const headerSlot = q.slots[slot];
		const coord = q.coords[slot];
		const x = coord & 0x1f;
		const y = (coord >> 5) & 0x1f;
		const z = (coord >> 10) & 0x1f;

		const view =
			headerSlot >= 0 && headerSlot < MAX_HEADER_SLOTS
				? registry.bySlot[headerSlot]
				: undefined;
		if (!view) continue;
		if (view !== lastRefreshedView) {
			lastRefreshedView = view;
			refreshLayout(registry, view);
		}
		if (!view.isLoaded) continue;

		const lightArr = view.light_array;
		if (lightArr.length === 0) continue;

		const idx = x + (y << 5) + (z << 10);
		const level = (lightArr[idx] >> skyShift) & 0xf;
		if (level <= 0) continue;

		const sourcePacked = getViewBlockPackedAt(view, idx);
		const sourceBlockId = unpackBlockId(sourcePacked);
		const srcFiltersFullSun = filtersFullSunlight(sourceBlockId);

		for (
			let i = 0, base = 0;
			i < LIGHT_DIR_COUNT;
			i++, base += LIGHT_DIR_STRIDE
		) {
			const dx = LIGHT_DIRS_FLAT[base];
			const dy = LIGHT_DIRS_FLAT[base + 1];
			const dz = LIGHT_DIRS_FLAT[base + 2];
			const axis = LIGHT_DIRS_FLAT[base + 3];
			const dir = LIGHT_DIRS_FLAT[base + 4];
			const isDown = LIGHT_DIRS_FLAT[base + 5];

			let tx = x + dx;
			let ty = y + dy;
			let tz = z + dz;
			// FIX: Type as ChunkView | null to allow neighbor assignment
			let targetView: ChunkView | null = view;

			if (tx < 0) {
				targetView = view.neighborViews[DIR_NX];
				if (!targetView) continue;
				tx = 31;
			} else if (tx >= 32) {
				targetView = view.neighborViews[DIR_PX];
				if (!targetView) continue;
				tx = 0;
			} else if (ty < 0) {
				targetView = view.neighborViews[DIR_NY];
				if (!targetView) continue;
				ty = 31;
			} else if (ty >= 32) {
				targetView = view.neighborViews[DIR_PY];
				if (!targetView) continue;
				ty = 0;
			} else if (tz < 0) {
				targetView = view.neighborViews[DIR_NZ];
				if (!targetView) continue;
				tz = 31;
			} else if (tz >= 32) {
				targetView = view.neighborViews[DIR_PZ];
				if (!targetView) continue;
				tz = 0;
			}

			if (targetView !== view) {
				if (!targetView.isLoaded) continue;
				if (targetView !== lastRefreshedTarget) {
					lastRefreshedTarget = targetView;
					refreshLayout(registry, targetView);
				}
			}

			const tidx = tx + (ty << 5) + (tz << 10);
			const tSlot = targetView.headerSlot;
			const targetPacked = getViewBlockPackedAt(targetView, tidx);

			if (isDown !== 1 && srcFiltersFullSun) {
				if (!filtersFullSunlight(unpackBlockId(targetPacked))) continue;
			} else if (!isTransparent(sourcePacked, axis, dir)) {
				continue;
			}

			if (!isTransparent(targetPacked, axis, -dir)) continue;

			const tLight = targetView.light_array;
			const curLight = tLight[tidx];
			const currentLevel = (curLight >> skyShift) & 0xf;
			const targetBlockId = unpackBlockId(targetPacked);

			const preservesFullSun =
				isDown === 1 &&
				level === 15 &&
				!srcFiltersFullSun &&
				!filtersFullSunlight(targetBlockId);
			const nextLevel = preservesFullSun ? 15 : level - 1;
			if (nextLevel <= 0 || currentLevel >= nextLevel) continue;

			tLight[tidx] = (curLight & blockMask) | (nextLevel << skyShift);
			dirtySlots.add(tSlot);
			addAdjacentBorderSlots(dirtySlots, targetView, tx, ty, tz);
			q.push(tSlot, tx, ty, tz, nextLevel);
		}
	}
}

function processBlockQueue(
	registry: ChunkViewRegistry,
	q: LightQueue,
	dirtySlots: DirtySlotSet,
): void {
	const skyMask = LIGHT_BLOCK_MASK << LIGHT_SKY_SHIFT;

	let lastRefreshedView: ChunkView | null = null;
	let lastRefreshedTarget: ChunkView | null = null;

	while (q.head !== q.tail) {
		const slot = q.head & (BFS_CAPACITY - 1);
		q.head = (q.head + 1) & (BFS_CAPACITY - 1);
		const headerSlot = q.slots[slot];
		const coord = q.coords[slot];
		const x = coord & 0x1f;
		const y = (coord >> 5) & 0x1f;
		const z = (coord >> 10) & 0x1f;

		const view =
			headerSlot >= 0 && headerSlot < MAX_HEADER_SLOTS
				? registry.bySlot[headerSlot]
				: undefined;
		if (!view) continue;
		if (view !== lastRefreshedView) {
			lastRefreshedView = view;
			refreshLayout(registry, view);
		}
		if (!view.isLoaded) continue;

		const lightArr = view.light_array;
		if (lightArr.length === 0) continue;

		const idx = x + (y << 5) + (z << 10);
		const level = lightArr[idx] & LIGHT_BLOCK_MASK;
		if (level <= 0) continue;

		const sourcePacked = getViewBlockPackedAt(view, idx);
		const sourceBlockId = unpackBlockId(sourcePacked);
		const sourceEmits =
			sourceBlockId < 256 && _lightEmissionLUT[sourceBlockId] > 0;

		for (
			let i = 0, base = 0;
			i < LIGHT_DIR_COUNT;
			i++, base += LIGHT_DIR_STRIDE
		) {
			const dx = LIGHT_DIRS_FLAT[base];
			const dy = LIGHT_DIRS_FLAT[base + 1];
			const dz = LIGHT_DIRS_FLAT[base + 2];
			const axis = LIGHT_DIRS_FLAT[base + 3];
			const dir = LIGHT_DIRS_FLAT[base + 4];

			let tx = x + dx;
			let ty = y + dy;
			let tz = z + dz;
			let targetView: ChunkView | null = view;

			if (tx < 0) {
				targetView = view.neighborViews[DIR_NX];
				if (!targetView) continue;
				tx = 31;
			} else if (tx >= 32) {
				targetView = view.neighborViews[DIR_PX];
				if (!targetView) continue;
				tx = 0;
			} else if (ty < 0) {
				targetView = view.neighborViews[DIR_NY];
				if (!targetView) continue;
				ty = 31;
			} else if (ty >= 32) {
				targetView = view.neighborViews[DIR_PY];
				if (!targetView) continue;
				ty = 0;
			} else if (tz < 0) {
				targetView = view.neighborViews[DIR_NZ];
				if (!targetView) continue;
				tz = 31;
			} else if (tz >= 32) {
				targetView = view.neighborViews[DIR_PZ];
				if (!targetView) continue;
				tz = 0;
			}

			if (targetView !== view) {
				if (!targetView.isLoaded) continue;
				if (targetView !== lastRefreshedTarget) {
					lastRefreshedTarget = targetView;
					refreshLayout(registry, targetView);
				}
			}

			const tidx = tx + (ty << 5) + (tz << 10);
			const tSlot = targetView.headerSlot;
			const targetPacked = getViewBlockPackedAt(targetView, tidx);

			if (!sourceEmits && !isTransparent(sourcePacked, axis, dir)) continue;
			if (!isTransparent(targetPacked, axis, -dir)) continue;

			const tLight = targetView.light_array;
			const curLight = tLight[tidx];
			const currentLevel = curLight & LIGHT_BLOCK_MASK;

			const nextLevel = level - 1;
			if (nextLevel <= 0 || currentLevel >= nextLevel) continue;

			tLight[tidx] = (curLight & skyMask) | nextLevel;
			dirtySlots.add(tSlot);
			addAdjacentBorderSlots(dirtySlots, targetView, tx, ty, tz);
			q.push(tSlot, tx, ty, tz, nextLevel);
		}
	}
}

// ---------------------------------------------------------------------------
// BFS — removeLight
// ---------------------------------------------------------------------------

function processRemoveSkyQueue(
	registry: ChunkViewRegistry,
	q: LightQueue,
	dirtySlots: DirtySlotSet,
	initialOldPacked?: number,
): void {
	const blockMask = LIGHT_BLOCK_MASK;

	let isFirstDequeue = true;
	let lastRefreshedView: ChunkView | null = null;
	let lastRefreshedTarget: ChunkView | null = null;

	while (q.head !== q.tail) {
		const slot = q.head & (BFS_CAPACITY - 1);
		q.head = (q.head + 1) & (BFS_CAPACITY - 1);
		const headerSlot = q.slots[slot];
		const coord = q.coords[slot];
		const cx = coord & 0x1f;
		const cy = (coord >> 5) & 0x1f;
		const cz = (coord >> 10) & 0x1f;

		const view =
			headerSlot >= 0 && headerSlot < MAX_HEADER_SLOTS
				? registry.bySlot[headerSlot]
				: undefined;
		if (!view) continue;
		if (view !== lastRefreshedView) {
			lastRefreshedView = view;
			refreshLayout(registry, view);
		}
		if (!view.isLoaded) continue;

		const level = q.levels[slot];
		const sourcePacked =
			isFirstDequeue && initialOldPacked !== undefined
				? initialOldPacked
				: getViewBlockPackedAt(view, cx + (cy << 5) + (cz << 10));
		isFirstDequeue = false;
		const sourceBlockId = unpackBlockId(sourcePacked);
		const srcFiltersFullSun = filtersFullSunlight(sourceBlockId);

		for (
			let i = 0, base = 0;
			i < LIGHT_DIR_COUNT;
			i++, base += LIGHT_DIR_STRIDE
		) {
			const dx = LIGHT_DIRS_FLAT[base];
			const dy = LIGHT_DIRS_FLAT[base + 1];
			const dz = LIGHT_DIRS_FLAT[base + 2];
			const axis = LIGHT_DIRS_FLAT[base + 3];
			const dir = LIGHT_DIRS_FLAT[base + 4];
			const isDown = LIGHT_DIRS_FLAT[base + 5];

			let tx = cx + dx;
			let ty = cy + dy;
			let tz = cz + dz;
			let targetView: ChunkView | null = view;

			if (tx < 0) {
				targetView = view.neighborViews[DIR_NX];
				if (!targetView) continue;
				tx = 31;
			} else if (tx >= 32) {
				targetView = view.neighborViews[DIR_PX];
				if (!targetView) continue;
				tx = 0;
			} else if (ty < 0) {
				targetView = view.neighborViews[DIR_NY];
				if (!targetView) continue;
				ty = 31;
			} else if (ty >= 32) {
				targetView = view.neighborViews[DIR_PY];
				if (!targetView) continue;
				ty = 0;
			} else if (tz < 0) {
				targetView = view.neighborViews[DIR_NZ];
				if (!targetView) continue;
				tz = 31;
			} else if (tz >= 32) {
				targetView = view.neighborViews[DIR_PZ];
				if (!targetView) continue;
				tz = 0;
			}

			if (targetView !== view) {
				if (!targetView.isLoaded) continue;
				if (targetView !== lastRefreshedTarget) {
					lastRefreshedTarget = targetView;
					refreshLayout(registry, targetView);
				}
			}

			if (!isTransparent(sourcePacked, axis, dir)) continue;

			const isWaterLateralBlock = isDown !== 1 && srcFiltersFullSun;
			const tIdx = tx + (ty << 5) + (tz << 10);
			const targetPacked = getViewBlockPackedAt(targetView, tIdx);
			if (!isTransparent(targetPacked, axis, -dir)) continue;

			const tArr = targetView.light_array;
			const neighborLevel = (tArr[tIdx] >> LIGHT_SKY_SHIFT) & 0xf;
			if (neighborLevel === 0) continue;

			if (isWaterLateralBlock) {
				Q_B.push(targetView.headerSlot, tx, ty, tz, neighborLevel);
				continue;
			}

			const targetBlockId = unpackBlockId(targetPacked);
			const preservesFullSun =
				isDown === 1 &&
				level === 15 &&
				!srcFiltersFullSun &&
				!filtersFullSunlight(targetBlockId);
			const isDependent =
				neighborLevel < level || (preservesFullSun && neighborLevel === 15);

			if (isDependent) {
				const cur = tArr[tIdx];
				const newByte = cur & blockMask;
				if (newByte !== cur) {
					tArr[tIdx] = newByte;
					dirtySlots.add(targetView.headerSlot);
					addAdjacentBorderSlots(dirtySlots, targetView, tx, ty, tz);
				}
				q.push(targetView.headerSlot, tx, ty, tz, neighborLevel);
			} else {
				Q_B.push(targetView.headerSlot, tx, ty, tz, neighborLevel);
			}
		}
	}
}

function processRemoveBlockQueue(
	registry: ChunkViewRegistry,
	q: LightQueue,
	dirtySlots: DirtySlotSet,
	initialOldPacked?: number,
): void {
	const skyMask = LIGHT_BLOCK_MASK << LIGHT_SKY_SHIFT;

	let isFirstDequeue = true;
	let lastRefreshedView: ChunkView | null = null;
	let lastRefreshedTarget: ChunkView | null = null;

	while (q.head !== q.tail) {
		const slot = q.head & (BFS_CAPACITY - 1);
		q.head = (q.head + 1) & (BFS_CAPACITY - 1);
		const headerSlot = q.slots[slot];
		const coord = q.coords[slot];
		const cx = coord & 0x1f;
		const cy = (coord >> 5) & 0x1f;
		const cz = (coord >> 10) & 0x1f;

		const view =
			headerSlot >= 0 && headerSlot < MAX_HEADER_SLOTS
				? registry.bySlot[headerSlot]
				: undefined;
		if (!view) continue;
		if (view !== lastRefreshedView) {
			lastRefreshedView = view;
			refreshLayout(registry, view);
		}
		if (!view.isLoaded) continue;

		const level = q.levels[slot];
		const sourcePacked =
			isFirstDequeue && initialOldPacked !== undefined
				? initialOldPacked
				: getViewBlockPackedAt(view, cx + (cy << 5) + (cz << 10));
		isFirstDequeue = false;
		const sourceBlockId = unpackBlockId(sourcePacked);
		const sourceEmits =
			sourceBlockId < 256 && _lightEmissionLUT[sourceBlockId] > 0;

		for (
			let i = 0, base = 0;
			i < LIGHT_DIR_COUNT;
			i++, base += LIGHT_DIR_STRIDE
		) {
			const dx = LIGHT_DIRS_FLAT[base];
			const dy = LIGHT_DIRS_FLAT[base + 1];
			const dz = LIGHT_DIRS_FLAT[base + 2];
			const axis = LIGHT_DIRS_FLAT[base + 3];
			const dir = LIGHT_DIRS_FLAT[base + 4];

			let tx = cx + dx;
			let ty = cy + dy;
			let tz = cz + dz;
			let targetView: ChunkView | null = view;

			if (tx < 0) {
				targetView = view.neighborViews[DIR_NX];
				if (!targetView) continue;
				tx = 31;
			} else if (tx >= 32) {
				targetView = view.neighborViews[DIR_PX];
				if (!targetView) continue;
				tx = 0;
			} else if (ty < 0) {
				targetView = view.neighborViews[DIR_NY];
				if (!targetView) continue;
				ty = 31;
			} else if (ty >= 32) {
				targetView = view.neighborViews[DIR_PY];
				if (!targetView) continue;
				ty = 0;
			} else if (tz < 0) {
				targetView = view.neighborViews[DIR_NZ];
				if (!targetView) continue;
				tz = 31;
			} else if (tz >= 32) {
				targetView = view.neighborViews[DIR_PZ];
				if (!targetView) continue;
				tz = 0;
			}

			if (targetView !== view) {
				if (!targetView.isLoaded) continue;
				if (targetView !== lastRefreshedTarget) {
					lastRefreshedTarget = targetView;
					refreshLayout(registry, targetView);
				}
			}

			if (!sourceEmits && !isTransparent(sourcePacked, axis, dir)) continue;

			const tIdx = tx + (ty << 5) + (tz << 10);
			const targetPacked = getViewBlockPackedAt(targetView, tIdx);
			if (!isTransparent(targetPacked, axis, -dir)) continue;

			const tArr = targetView.light_array;
			const neighborLevel = tArr[tIdx] & LIGHT_BLOCK_MASK;
			if (neighborLevel === 0) continue;

			const isDependent = neighborLevel < level;
			if (isDependent) {
				const cur = tArr[tIdx];
				const newByte = cur & skyMask;
				if (newByte !== cur) {
					tArr[tIdx] = newByte;
					dirtySlots.add(targetView.headerSlot);
					addAdjacentBorderSlots(dirtySlots, targetView, tx, ty, tz);
				}
				q.push(targetView.headerSlot, tx, ty, tz, neighborLevel);
			} else {
				Q_B.push(targetView.headerSlot, tx, ty, tz, neighborLevel);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export function lightMutate(
	registry: ChunkViewRegistry,
	headerSlot: number,
	x: number,
	y: number,
	z: number,
	oldPacked: number,
	_newPacked: number,
): DirtySlotSet {
	const view =
		headerSlot >= 0 && headerSlot < MAX_HEADER_SLOTS
			? registry.bySlot[headerSlot]
			: undefined;
	if (!view) return _emptyDirtySlots;
	refreshLayout(registry, view);
	if (!view.isLoaded) return _emptyDirtySlots;

	// OPTIMIZATION: Bitwise shift instead of multiplication
	const idx = x + (y << 5) + (z << 10);
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
	dirtySlots: DirtySlotSet,
	oldPacked?: number,
): void {
	// OPTIMIZATION: Bitwise shift instead of multiplication
	const idx = x + (y << 5) + (z << 10);
	if (startLevel === 0) return;

	if (clearLightByte(view, idx, isSkyLight)) {
		dirtySlots.add(view.headerSlot);
		addAdjacentBorderSlots(dirtySlots, view, x, y, z);
	}

	Q_A.clear();
	Q_B.clear();
	Q_A.push(view.headerSlot, x, y, z, startLevel);

	if (isSkyLight) {
		processRemoveSkyQueue(registry, Q_A, dirtySlots, oldPacked);
	} else {
		processRemoveBlockQueue(registry, Q_A, dirtySlots, oldPacked);
	}

	if (Q_B.head !== Q_B.tail) {
		if (isSkyLight) {
			processSkyQueue(registry, Q_B, dirtySlots);
		} else {
			processBlockQueue(registry, Q_B, dirtySlots);
		}
	}
}

function updateLightFromNeighborsAt(
	registry: ChunkViewRegistry,
	view: ChunkView,
	x: number,
	y: number,
	z: number,
	isSkyLight: boolean,
	dirtySlots: DirtySlotSet,
): void {
	if (!view.isLoaded) return;
	refreshLayout(registry, view);

	const selfIdx = x + (y << 5) + (z << 10);
	const targetBlockPacked = getViewBlockPackedAt(view, selfIdx);
	let currentTargetLevel = isSkyLight
		? getSkyLight(view, selfIdx)
		: getBlockLight(view, selfIdx);
	const targetBlockId2 = unpackBlockId(targetBlockPacked);
	const targetFiltersFullSun = filtersFullSunlight(targetBlockId2);

	let lastRefreshed: ChunkView = view;
	Q_A.clear();

	for (
		let i = 0, base = 0;
		i < LIGHT_DIR_COUNT;
		i++, base += LIGHT_DIR_STRIDE
	) {
		const dx = LIGHT_DIRS_FLAT[base];
		const dy = LIGHT_DIRS_FLAT[base + 1];
		const dz = LIGHT_DIRS_FLAT[base + 2];
		const axis = LIGHT_DIRS_FLAT[base + 3];
		const dir = -LIGHT_DIRS_FLAT[base + 4] as -1 | 1;
		const sourceIsAbove = dy > 0;

		let sx = x + dx;
		let sy = y + dy;
		let sz = z + dz;
		let sourceView: ChunkView | null = view;

		if (sx < 0) {
			sourceView = view.neighborViews[DIR_NX];
			if (!sourceView) continue;
			sx = 31;
		} else if (sx >= 32) {
			sourceView = view.neighborViews[DIR_PX];
			if (!sourceView) continue;
			sx = 0;
		} else if (sy < 0) {
			sourceView = view.neighborViews[DIR_NY];
			if (!sourceView) continue;
			sy = 31;
		} else if (sy >= 32) {
			sourceView = view.neighborViews[DIR_PY];
			if (!sourceView) continue;
			sy = 0;
		} else if (sz < 0) {
			sourceView = view.neighborViews[DIR_NZ];
			if (!sourceView) continue;
			sz = 31;
		} else if (sz >= 32) {
			sourceView = view.neighborViews[DIR_PZ];
			if (!sourceView) continue;
			sz = 0;
		}

		if (sourceView !== lastRefreshed) {
			lastRefreshed = sourceView;
			refreshLayout(registry, sourceView);
			if (!sourceView.isLoaded) continue;
		}

		const sidx = sx + (sy << 5) + (sz << 10);
		const sourceBlockPacked = getViewBlockPackedAt(sourceView, sidx);
		const sourceBlockId = unpackBlockId(sourceBlockPacked);
		const sourceEmits =
			!isSkyLight &&
			sourceBlockId < 256 &&
			_lightEmissionLUT[sourceBlockId] > 0;
		const sourceFiltersFullSun = filtersFullSunlight(sourceBlockId);

		const lateralWaterToWater =
			isSkyLight &&
			!sourceIsAbove &&
			sourceFiltersFullSun &&
			targetFiltersFullSun;
		const sourceAllows = isSkyLight
			? isTransparent(sourceBlockPacked, axis, dir) &&
				(sourceIsAbove || !sourceFiltersFullSun || lateralWaterToWater)
			: sourceEmits || isTransparent(sourceBlockPacked, axis, dir);

		if (!sourceAllows) continue;
		if (!isTransparent(targetBlockPacked, axis, -dir)) continue;

		const level = isSkyLight
			? getSkyLight(sourceView, sidx)
			: getBlockLight(sourceView, sidx);
		if (level <= 0) continue;

		const preservesFullSun =
			isSkyLight &&
			sourceIsAbove &&
			level === 15 &&
			!sourceFiltersFullSun &&
			!targetFiltersFullSun;
		const nextLevel = preservesFullSun ? 15 : level - 1;
		if (nextLevel <= 0 || nextLevel <= currentTargetLevel) continue;

		const result3 = casLightByte(view, selfIdx, isSkyLight, nextLevel);
		if (result3 === WriteResult.Wrote) {
			currentTargetLevel = nextLevel;
			dirtySlots.add(view.headerSlot);
			addAdjacentBorderSlots(dirtySlots, view, x, y, z);
		}
		Q_A.push(view.headerSlot, x, y, z, nextLevel);
	}

	if (Q_A.head !== Q_A.tail) {
		if (isSkyLight) processSkyQueue(registry, Q_A, dirtySlots);
		else processBlockQueue(registry, Q_A, dirtySlots);
	}
}

export function addLightAt(
	registry: ChunkViewRegistry,
	view: ChunkView,
	x: number,
	y: number,
	z: number,
	level: number,
	dirtySlots: DirtySlotSet,
): void {
	if (!view.isLoaded) return;
	refreshLayout(registry, view);
	level &= LIGHT_BLOCK_MASK;
	if (level <= 0) return;
	// OPTIMIZATION: Bitwise shift instead of multiplication
	const idx = x + (y << 5) + (z << 10);
	if (getBlockLight(view, idx) >= level) return;

	if (casLightByte(view, idx, false, level) === WriteResult.Wrote) {
		dirtySlots.add(view.headerSlot);
		addAdjacentBorderSlots(dirtySlots, view, x, y, z);
	}
	Q_A.clear();
	Q_A.push(view.headerSlot, x, y, z, level);
	processBlockQueue(registry, Q_A, dirtySlots);
}

function cutSkyLightBelowAt(
	registry: ChunkViewRegistry,
	view: ChunkView,
	x: number,
	y: number,
	z: number,
	dirtySlots: DirtySlotSet,
): void {
	if (!view.isLoaded) return;
	refreshLayout(registry, view);
	const size = LIGHT_CHUNK_SIZE;

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
	if (targetView !== view) {
		refreshLayout(registry, targetView);
	}
	if (!targetView.isLoaded) return;

	while (true) {
		// OPTIMIZATION: Bitwise shift instead of multiplication
		const tidx = tx + (ty << 5) + (tz << 10);
		const belowBlockPacked = getViewBlockPackedAt(targetView, tidx);
		if (!isTransparent(belowBlockPacked, 1, 1)) break;

		const belowSky = getSkyLight(targetView, tidx);
		if (belowSky > 0) {
			removeLightAt(
				registry,
				targetView,
				tx,
				ty,
				tz,
				belowSky,
				true,
				dirtySlots,
			);
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

		if (getSkyLight(targetView, tidx) <= 0) break;

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

export function lightSkyReconcile(
	registry: ChunkViewRegistry,
	headerSlot: number,
): DirtySlotSet {
	_dirtySlotsScratch.clear();
	const dirtySlots = _dirtySlotsScratch;
	const view =
		headerSlot >= 0 && headerSlot < MAX_HEADER_SLOTS
			? registry.bySlot[headerSlot]
			: undefined;
	if (!view) return dirtySlots;
	refreshLayout(registry, view);
	if (!view.isLoaded) return dirtySlots;

	const size = LIGHT_CHUNK_SIZE;
	const size2 = size * size;
	const last = size - 1;

	const selfEdges = [0, last, 0, last, 0, last];
	const neighborEdges = [last, 0, last, 0, last, 0];

	let seedCount = 0;

	for (let x = 0; x < size && seedCount < 6144; x++) {
		for (let z = 0; z < size && seedCount < 6144; z++) {
			for (let y = 0; y < size; y++) {
				// OPTIMIZATION: Bitwise shift instead of multiplication
				const idx = x + (y << 5) + (z << 10);
				const sky = (view.light_array[idx] >> LIGHT_SKY_SHIFT) & 0xf;
				if (sky <= 1) continue;
				if (!isTransparent(getViewBlockPackedAt(view, idx), 1, 1)) {
					continue;
				}
				let seed = false;
				for (let i = 0; i < LIGHT_DIR_COUNT; i++) {
					const base = i * LIGHT_DIR_STRIDE;
					const tx = x + LIGHT_DIRS_FLAT[base];
					const ty = y + LIGHT_DIRS_FLAT[base + 1];
					const tz = z + LIGHT_DIRS_FLAT[base + 2];
					if (
						tx < 0 ||
						tx >= size ||
						ty < 0 ||
						ty >= size ||
						tz < 0 ||
						tz >= size
					) {
						seed = true;
						break;
					}
					// OPTIMIZATION: Bitwise shift instead of multiplication
					const nIdx = tx + (ty << 5) + (tz << 10);
					const neighborSky = (view.light_array[nIdx] >> LIGHT_SKY_SHIFT) & 0xf;
					if (
						neighborSky < sky - 1 &&
						isTransparent(getViewBlockPackedAt(view, nIdx), 1, 1)
					) {
						seed = true;
						break;
					}
				}
				if (!seed) continue;
				seedSlots[seedCount] = view.headerSlot;
				seedCoords[seedCount * 3] = x;
				seedCoords[seedCount * 3 + 1] = y;
				seedCoords[seedCount * 3 + 2] = z;
				seedLevels[seedCount] = sky;
				seedCount++;
				if (seedCount >= 6144) break;
			}
		}
	}

	for (let f = 0; f < 6; f++) {
		const neighbor = view.neighborViews[f ^ 1];
		if (!neighbor) continue;
		refreshLayout(registry, neighbor);
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
					seedSlots[seedCount] = selfHigher
						? view.headerSlot
						: neighbor.headerSlot;
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
					seedSlots[seedCount] = selfHigher
						? view.headerSlot
						: neighbor.headerSlot;
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
					seedSlots[seedCount] = selfHigher
						? view.headerSlot
						: neighbor.headerSlot;
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
			seedSlots,
			seedCoords,
			seedLevels,
			seedCount,
			dirtySlots,
		);
	}
	return dirtySlots;

	function batchPropagate(
		registry: ChunkViewRegistry,
		slots: Int32Array,
		coords: Int32Array,
		levels: Uint8Array,
		count: number,
		dirty: DirtySlotSet,
	): DirtySlotSet {
		Q_A.clear();
		for (let i = 0; i < count; i++) {
			const base = i * 3;
			Q_A.push(
				slots[i],
				coords[base],
				coords[base + 1],
				coords[base + 2],
				levels[i],
			);
		}
		if (Q_A.head !== Q_A.tail) {
			processSkyQueue(registry, Q_A, dirty);
		}
		return dirty;
	}
}

export function lightBlockReconcile(
	registry: ChunkViewRegistry,
	headerSlot: number,
): DirtySlotSet {
	_dirtySlotsScratch.clear();
	const dirtySlots = _dirtySlotsScratch;
	const view =
		headerSlot >= 0 && headerSlot < MAX_HEADER_SLOTS
			? registry.bySlot[headerSlot]
			: undefined;
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
						const sourcePacked = getViewBlockPackedAt(view, sidx);
						const targetPacked = getViewBlockPackedAt(neighbor, nidx);
						const sourceBlockId = unpackBlockId(sourcePacked);
						const sourceEmits =
							sourceBlockId < 256 && _lightEmissionLUT[sourceBlockId] > 0;
						if (
							(sourceEmits || isTransparent(sourcePacked, fAxis, fDir)) &&
							isTransparent(targetPacked, fAxis, -fDir)
						) {
							Q_A.push(view.headerSlot, selfX, u, v, selfLevel);
						}
					}

					if (neighborLevel > 1 && selfLevel < neighborLevel - 1) {
						const sourcePacked = getViewBlockPackedAt(neighbor, nidx);
						const targetPacked = getViewBlockPackedAt(view, sidx);
						const sourceBlockId = unpackBlockId(sourcePacked);
						const sourceEmits =
							sourceBlockId < 256 && _lightEmissionLUT[sourceBlockId] > 0;
						if (
							(sourceEmits || isTransparent(sourcePacked, fAxis, -fDir)) &&
							isTransparent(targetPacked, fAxis, fDir)
						) {
							Q_A.push(neighbor.headerSlot, nbrX, u, v, neighborLevel);
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
						const sourcePacked = getViewBlockPackedAt(view, sidx);
						const targetPacked = getViewBlockPackedAt(neighbor, nidx);
						const sourceBlockId = unpackBlockId(sourcePacked);
						const sourceEmits =
							sourceBlockId < 256 && _lightEmissionLUT[sourceBlockId] > 0;
						if (
							(sourceEmits || isTransparent(sourcePacked, fAxis, fDir)) &&
							isTransparent(targetPacked, fAxis, -fDir)
						) {
							Q_A.push(view.headerSlot, u, selfY, v, selfLevel);
						}
					}

					if (neighborLevel > 1 && selfLevel < neighborLevel - 1) {
						const sourcePacked = getViewBlockPackedAt(neighbor, nidx);
						const targetPacked = getViewBlockPackedAt(view, sidx);
						const sourceBlockId = unpackBlockId(sourcePacked);
						const sourceEmits =
							sourceBlockId < 256 && _lightEmissionLUT[sourceBlockId] > 0;
						if (
							(sourceEmits || isTransparent(sourcePacked, fAxis, -fDir)) &&
							isTransparent(targetPacked, fAxis, fDir)
						) {
							Q_A.push(neighbor.headerSlot, u, nbrY, v, neighborLevel);
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
						const sourcePacked = getViewBlockPackedAt(view, sidx);
						const targetPacked = getViewBlockPackedAt(neighbor, nidx);
						const sourceBlockId = unpackBlockId(sourcePacked);
						const sourceEmits =
							sourceBlockId < 256 && _lightEmissionLUT[sourceBlockId] > 0;
						if (
							(sourceEmits || isTransparent(sourcePacked, fAxis, fDir)) &&
							isTransparent(targetPacked, fAxis, -fDir)
						) {
							Q_A.push(view.headerSlot, u, v, selfZ, selfLevel);
						}
					}

					if (neighborLevel > 1 && selfLevel < neighborLevel - 1) {
						const sourcePacked = getViewBlockPackedAt(neighbor, nidx);
						const targetPacked = getViewBlockPackedAt(view, sidx);
						const sourceBlockId = unpackBlockId(sourcePacked);
						const sourceEmits =
							sourceBlockId < 256 && _lightEmissionLUT[sourceBlockId] > 0;
						if (
							(sourceEmits || isTransparent(sourcePacked, fAxis, -fDir)) &&
							isTransparent(targetPacked, fAxis, fDir)
						) {
							Q_A.push(neighbor.headerSlot, u, v, nbrZ, neighborLevel);
						}
					}
				}
			}
		}
	}

	if (Q_A.head !== Q_A.tail) {
		processBlockQueue(registry, Q_A, dirtySlots);
	}

	return dirtySlots;
}

export function propagateDeferred(
	registry: ChunkViewRegistry,
	headerSlot: number,
	seedState: { queue: Uint16Array; length: number },
): DirtySlotSet {
	_dirtySlotsScratch.clear();
	const dirtySlots = _dirtySlotsScratch;
	const view =
		headerSlot >= 0 && headerSlot < MAX_HEADER_SLOTS
			? registry.bySlot[headerSlot]
			: undefined;
	if (!view) return dirtySlots;
	refreshLayout(registry, view);
	if (!view.isLoaded) return dirtySlots;
	if (seedState.length <= 0) return dirtySlots;

	const skyShift = LIGHT_SKY_SHIFT;
	Q_A.clear();

	for (let i = 0; i < seedState.length; i++) {
		const val = seedState.queue[i];
		const x = (val >> 10) & 0x1f;
		const y = (val >> 5) & 0x1f;
		const z = val & 0x1f;
		// OPTIMIZATION: Bitwise shift instead of multiplication
		const idx = x + (y << 5) + (z << 10);
		const level = (view.light_array[idx] >> skyShift) & 0xf;
		if (
			level > 0 &&
			!filtersFullSunlight(unpackBlockId(getViewBlockPackedAt(view, idx)))
		)
			Q_A.push(view.headerSlot, x, y, z, level);
	}
	if (Q_A.head !== Q_A.tail) {
		processSkyQueue(registry, Q_A, dirtySlots);
	}
	return dirtySlots;
}

export function bumpLightVersion(
	registry: ChunkViewRegistry,
	slot: number,
): void {
	bumpHeaderLightSeq(registry.header, slot);
}
