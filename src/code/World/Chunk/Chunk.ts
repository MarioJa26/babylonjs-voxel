import type { Mesh } from "@babylonjs/core";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { getFinalTerrainHeight } from "@/code/Generation/TerrainHeightMap";
import {
	packBlockValue,
	unpackBlockId,
	unpackBlockState,
} from "../BlockEncoding";
import {
	CUBE_SHAPE_INDEX,
	FACE_ALL,
	FACE_NX,
	FACE_NY,
	FACE_NZ,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
	ShapeByBlockId,
	ShapeDefinitions,
} from "../Shape/BlockShapes";
import { getSliceAxis, transformBox } from "../Shape/BlockShapeTransforms";
import type { MeshData } from "./DataStructures/MeshData";

// ---------------------------------------------------------------------------
// LIGHT_DIRS – flattened into a typed array for cache-friendly iteration.
// Layout per entry (stride 6):  dx, dy, dz, axis, dir, isDown
// ---------------------------------------------------------------------------
const LIGHT_DIRS_FLAT = new Int8Array([
	1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0, 0, 1, 0, 1, 1, 0, 0, -1, 0, 1, -1, 1, 0,
	0, 1, 2, 1, 0, 0, 0, -1, 2, -1, 0,
]);
const LIGHT_DIR_STRIDE = 6;
const LIGHT_DIR_COUNT = 6;

type CachedLODMesh = {
	opaque: MeshData | null;
	transparent: MeshData | null;
};
type SerializedLODMeshCache = Record<
	number,
	{ opaque?: MeshData | null; transparent?: MeshData | null }
>;

// ---------------------------------------------------------------------------
// BFS queue – flat, interleaved typed arrays; no per-node heap allocation.
//
// Capacity must be a power of two for the bitwise ring-buffer mask.
// 32 768 slots covers the worst-case full-chunk BFS (SIZE^3 ≤ 32^3 = 32 768)
// plus cross-chunk spill.
// ---------------------------------------------------------------------------
const BFS_CAPACITY = 32768; // power of two

class LightQueue {
	/** Chunk object references – one per slot (cannot live in TypedArray). */
	readonly chunks = new Array<Chunk | null>(BFS_CAPACITY).fill(null);
	/** Packed local coords: x | (y<<5) | (z<<10).  Fits in int32; 5 bits each. */
	readonly coords = new Int32Array(BFS_CAPACITY);
	/** Queued light level – stored so removal BFS can read it without re-fetching. */
	readonly levels = new Int32Array(BFS_CAPACITY);

	/** Next-read index (ring pointer). */
	head = 0;
	/** Next-write index (ring pointer). */
	tail = 0;

	get length(): number {
		return (this.tail - this.head + BFS_CAPACITY) & (BFS_CAPACITY - 1);
	}

	clear(): void {
		this.head = this.tail = 0;
	}

	push(chunk: Chunk, x: number, y: number, z: number, level: number): void {
		const slot = this.tail & (BFS_CAPACITY - 1);
		this.chunks[slot] = chunk;
		this.coords[slot] = x | (y << 5) | (z << 10);
		this.levels[slot] = level;
		this.tail = (this.tail + 1) & (BFS_CAPACITY - 1);
	}
}

// Two permanent instances shared across all BFS calls – zero allocation per call.
const Q_A = new LightQueue();
const Q_B = new LightQueue();

// ---------------------------------------------------------------------------
// Face-rect scratch buffers – reused inside getClosedFaceMaskForPacked to
// avoid allocating new FaceRect[] arrays on every call.
//
// Layout per rect (RECT_STRIDE=4 floats): u0, u1, v0, v1
// ---------------------------------------------------------------------------
const MAX_RECTS = 64;
const RECT_STRIDE = 4;
/** Six flat buffers, one per face direction (PX NX PY NY PZ NZ). */
const _rectBufs = Array.from(
	{ length: 6 },
	() => new Float32Array(MAX_RECTS * RECT_STRIDE),
);
/** Number of valid rects currently stored in each face buffer. */
const _rectCounts = new Int32Array(6);
/** Scratch space for edge deduplication; sized for 2*MAX_RECTS+2 edges × 2 axes. */
const _edgeScratch = new Float64Array((MAX_RECTS * 2 + 4) * 2);

export class Chunk {
	public readonly id: bigint;

	public lodLevel = 0;

	public static readonly SIZE = GenerationParams.CHUNK_SIZE;
	public static readonly SIZE2 = Chunk.SIZE * Chunk.SIZE;
	public static readonly SIZE3 = Chunk.SIZE * Chunk.SIZE * Chunk.SIZE;
	public static readonly chunkInstances = new Map<bigint, Chunk>();

	public isModified = false;
	/** Persistent chunks are managed by systems outside world streaming
	 *  (e.g. movable boat chunks) and must never be auto-unloaded/saved. */
	public isPersistent = false;
	public isDirty = false;
	public isLoaded = false;
	public isTerrainScheduled = false;
	public colliderDirty = true;
	public isLightDirty = false;

	private remeshQueued = false;
	private remeshQueuedPriority = false;

	public static onRequestRemesh:
		| ((chunk: Chunk, priority: boolean) => void)
		| null = null;
	public static onChunkLoaded: ((chunk: Chunk) => void) | null = null;

	private _block_array: Uint8Array | Uint16Array | null = null;
	private _isUniform = true;
	private _uniformBlockId = 0;
	private _palette: Uint16Array | null = null;
	private _hasVoxelData = false;

	#chunkY: number;
	#chunkX: number;
	#chunkZ: number;

	public mesh: Mesh | null = null;
	public transparentMesh: Mesh | null = null;
	public opaqueMeshData: MeshData | null = null;
	public transparentMeshData: MeshData | null = null;

	light_array: Uint8Array;

	public static readonly SKY_LIGHT_SHIFT = 4;
	public static readonly BLOCK_LIGHT_MASK = 0xf;
	private static readonly SKYLIGHT_GENERATION_MIN_WORLD_Y = 32;
	private static readonly WATER_BLOCK_ID = 30;
	private static readonly GLASS_01_BLOCK_ID = 60;
	private static readonly GLASS_02_BLOCK_ID = 61;
	private static readonly EPS = 1e-6;

	private static readonly CLOSED_FACE_MASK_CACHE = (() => {
		const cache = new Int16Array(1 << 16);
		cache.fill(-1);
		return cache;
	})();

	private static readonly EMPTY_LIGHT_ARRAY =
		typeof SharedArrayBuffer !== "undefined"
			? new Uint8Array(new SharedArrayBuffer(0))
			: new Uint8Array(0);

	public cachedLODMeshes = new Map<number, CachedLODMesh>();
	public isLODMeshCacheDirty = false;

	private static remeshFlushScheduled = false;
	private static remeshQueue = [] as Chunk[];
	private static remeshQueueSet = new Set<bigint>();

	// Block ID → emitted light level.
	public static readonly LIGHT_EMISSION: Record<number, number> = {
		10: 15, // Lava
		11: 15, // Glowstone
		24: 15, // Lava
	};
	public static getLightEmission(blockId: number): number {
		return Chunk.LIGHT_EMISSION[blockId] || 0;
	}

	// =========================================================================
	// Construction
	// =========================================================================

	constructor(chunkX: number, chunkY: number, chunkZ: number) {
		this.#chunkX = chunkX;
		this.#chunkY = chunkY;
		this.#chunkZ = chunkZ;
		this.id = Chunk.packCoords(chunkX, chunkY, chunkZ);
		this.light_array = Chunk.EMPTY_LIGHT_ARRAY;
		Chunk.chunkInstances.set(this.id, this);
	}

	// =========================================================================
	// Block storage – accessors & nibble helpers
	// =========================================================================

	get block_array(): Uint8Array | Uint16Array | null {
		return this._block_array;
	}
	get palette(): Uint16Array | null {
		return this._palette;
	}
	get isUniform(): boolean {
		return this._isUniform;
	}
	get uniformBlockId(): number {
		return this._uniformBlockId;
	}
	get hasVoxelData(): boolean {
		return this._hasVoxelData;
	}

	private getNibble(index: number): number {
		const arr = this._block_array as Uint8Array | null;
		if (!arr) return 0;
		const byte = arr[index >>> 1];
		return (index & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;
	}

	private setNibble(index: number, value: number): void {
		const arr = this._block_array as Uint8Array | null;
		if (!arr) return;
		const byteIndex = index >>> 1;
		const nibble = value & 0x0f;
		const byte = arr[byteIndex];
		arr[byteIndex] =
			(index & 1) === 0
				? (byte & 0xf0) | nibble
				: (byte & 0x0f) | (nibble << 4);
	}

	// =========================================================================
	// Load / unload
	// =========================================================================

	public populate(
		blocks: Uint8Array | Uint16Array | null,
		palette: Uint16Array | null,
		isUniform: boolean,
		uniformBlockId: number,
		light_array?: Uint8Array,
		scheduleRemesh = true,
	): void {
		this.loadFromStorage(
			blocks,
			palette,
			isUniform,
			uniformBlockId,
			light_array,
			scheduleRemesh,
		);
	}

	public loadFromStorage(
		blocks: Uint8Array | Uint16Array | null,
		palette: Uint16Array | null | undefined,
		isUniform: boolean | undefined,
		uniformBlockId: number | undefined,
		light_array?: Uint8Array,
		scheduleRemesh = true,
	): void {
		this.clearCachedLODMeshes();
		this._hasVoxelData = true;

		if (isUniform && typeof uniformBlockId === "number") {
			this._isUniform = true;
			this._uniformBlockId = uniformBlockId;
			this._block_array = null;
			this._palette = null;
		} else if (palette && blocks instanceof Uint8Array) {
			this._isUniform = false;
			this._uniformBlockId = 0;
			this._palette = palette;
			this._block_array = blocks;
		} else if (blocks) {
			this._isUniform = false;
			this._uniformBlockId = 0;
			this._palette = null;
			this._block_array = blocks;
		} else {
			this._isUniform = true;
			this._uniformBlockId = 0;
			this._block_array = null;
			this._palette = null;
		}

		if (light_array) {
			this.light_array = light_array;
		} else {
			this.initializeSunlight();
		}

		this.isLoaded = true;
		this.isTerrainScheduled = false;
		this.colliderDirty = true;
		Chunk.onChunkLoaded?.(this);
		if (scheduleRemesh) this.scheduleRemesh(true, true);
	}

	public loadLodOnlyFromStorage(scheduleRemesh = false): void {
		this._hasVoxelData = false;
		this._isUniform = true;
		this._uniformBlockId = 0;
		this._block_array = null;
		this._palette = null;
		this.light_array = Chunk.EMPTY_LIGHT_ARRAY;
		this.isLoaded = true;
		this.isTerrainScheduled = false;
		this.colliderDirty = false;
		if (scheduleRemesh) this.scheduleRemesh();
	}

	public unload(): void {
		if (!this.isLoaded) return;
		this._block_array = null;
		this._isUniform = true;
		this._uniformBlockId = 0;
		this._palette = null;
		this._hasVoxelData = false;
		this.light_array = Chunk.EMPTY_LIGHT_ARRAY;
		this.isLoaded = false;
		this.isTerrainScheduled = false;
		this.isModified = false;
		this.colliderDirty = true;
	}

	// =========================================================================
	// LOD mesh cache
	// =========================================================================

	public getCachedLODMesh(lod: number): CachedLODMesh | null {
		return this.cachedLODMeshes.get(lod) ?? null;
	}
	public hasCachedLODMesh(lod: number): boolean {
		const c = this.cachedLODMeshes.get(lod);
		return !!c && (!!c.opaque || !!c.transparent);
	}
	public setCachedLODMesh(lod: number, mesh: CachedLODMesh): void {
		this.cachedLODMeshes.set(lod, {
			opaque: mesh.opaque ?? null,
			transparent: mesh.transparent ?? null,
		});
		this.isLODMeshCacheDirty = true;
	}
	public clearCachedLODMeshes(): void {
		this.cachedLODMeshes.clear();
		this.isLODMeshCacheDirty = false;
	}
	public invalidateLODMeshCaches(): void {
		if (this.cachedLODMeshes.size > 0) this.cachedLODMeshes.clear();
		this.isLODMeshCacheDirty = true;
	}
	public getSerializableLODMeshCache(): SerializedLODMeshCache | undefined {
		if (this.cachedLODMeshes.size === 0) return undefined;
		const out: SerializedLODMeshCache = {};
		for (const [lod, mesh] of this.cachedLODMeshes.entries()) {
			if (!mesh.opaque && !mesh.transparent) continue;
			out[lod] = {
				opaque: mesh.opaque ?? null,
				transparent: mesh.transparent ?? null,
			};
		}
		return Object.keys(out).length === 0 ? undefined : out;
	}
	public restoreLODMeshCache(cache?: SerializedLODMeshCache): void {
		this.cachedLODMeshes.clear();
		if (!cache) {
			this.isLODMeshCacheDirty = false;
			return;
		}
		for (const key of Object.keys(cache)) {
			const lod = Number(key);
			if (!Number.isFinite(lod)) continue;
			const entry = cache[lod];
			if (!entry?.opaque && !entry?.transparent) continue;
			this.cachedLODMeshes.set(lod, {
				opaque: entry?.opaque ?? null,
				transparent: entry?.transparent ?? null,
			});
		}
		this.isLODMeshCacheDirty = false;
	}

	// =========================================================================
	// Sunlight initialisation
	// =========================================================================

	public initializeSunlight(): void {
		const size = Chunk.SIZE;
		const size2 = Chunk.SIZE2;
		const skyShift = Chunk.SKY_LIGHT_SHIFT;
		const blockMask = Chunk.BLOCK_LIGHT_MASK;
		const topWorldY = this.#chunkY * size + size - 1;
		const aboveChunk = this.getNeighbor(0, 1, 0);

		if (this.light_array.length !== Chunk.SIZE3) {
			this.light_array =
				typeof SharedArrayBuffer !== "undefined"
					? new Uint8Array(new SharedArrayBuffer(Chunk.SIZE3))
					: new Uint8Array(Chunk.SIZE3);
		}

		// Preserve block-light nibble; zero sky-light nibble.
		const la = this.light_array;
		for (let i = 0; i < Chunk.SIZE3; i++) la[i] &= blockMask;

		Q_A.clear();

		const chunkBaseX = this.#chunkX * size;
		const chunkBaseZ = this.#chunkZ * size;
		const hasLoadedAbove = !!aboveChunk?.isLoaded;

		for (let x = 0; x < size; x++) {
			const worldX = chunkBaseX + x;
			for (let z = 0; z < size; z++) {
				const worldZ = chunkBaseZ + z;
				let incomingSkyLight = 0;
				let sourceFiltersFullSun = false;

				if (hasLoadedAbove) {
					const aboveBlockPacked = aboveChunk!.getBlockPacked(x, 0, z);
					if (aboveChunk!.isTransparent(aboveBlockPacked, 1, -1)) {
						incomingSkyLight = aboveChunk!.getSkyLight(x, 0, z);
						sourceFiltersFullSun = Chunk.filtersFullSunlight(
							unpackBlockId(aboveBlockPacked),
						);
					}
				} else {
					const terrainHeight = getFinalTerrainHeight(worldX, worldZ);
					if (
						topWorldY >= Chunk.SKYLIGHT_GENERATION_MIN_WORLD_Y &&
						topWorldY >= terrainHeight - 48
					) {
						incomingSkyLight = 15;
					}
				}

				for (let y = size - 1; y >= 0; y--) {
					const worldY = this.#chunkY * size + y;
					if (
						!hasLoadedAbove &&
						worldY < Chunk.SKYLIGHT_GENERATION_MIN_WORLD_Y
					) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = false;
						continue;
					}

					const blockPacked = this.getBlockPacked(x, y, z);
					if (!this.isTransparent(blockPacked, 1, 1)) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = false;
						continue;
					}
					if (incomingSkyLight <= 0) continue;

					const thisFiltersFullSun = Chunk.filtersFullSunlight(
						unpackBlockId(blockPacked),
					);
					const preservesFullSun =
						incomingSkyLight === 15 &&
						!sourceFiltersFullSun &&
						!thisFiltersFullSun;
					const cellSkyLight = preservesFullSun
						? 15
						: Math.max(incomingSkyLight - 1, 0);

					if (cellSkyLight === 0) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = thisFiltersFullSun;
						continue;
					}

					const idx = x + y * size + z * size2;
					la[idx] = (la[idx] & blockMask) | (cellSkyLight << skyShift);

					// Water passes light downward only — never seed into BFS to
					// prevent sideways spreading at chunk borders.
					if (!thisFiltersFullSun) Q_A.push(this, x, y, z, cellSkyLight);

					if (!this.isTransparent(blockPacked, 1, -1)) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = thisFiltersFullSun;
						continue;
					}
					incomingSkyLight = cellSkyLight;
					sourceFiltersFullSun = thisFiltersFullSun;
				}
			}
		}

		this.processLightPropagationQueue(Q_A, true);
	}

	// =========================================================================
	// Light accessors
	// =========================================================================

	public getBlockLight(lx: number, ly: number, lz: number): number {
		if (!this.isLoaded) return 0;
		return (
			this.light_array[lx + ly * Chunk.SIZE + lz * Chunk.SIZE2] &
			Chunk.BLOCK_LIGHT_MASK
		);
	}
	public getSkyLight(lx: number, ly: number, lz: number): number {
		if (!this.isLoaded) return 0;
		return (
			(this.light_array[lx + ly * Chunk.SIZE + lz * Chunk.SIZE2] >>
				Chunk.SKY_LIGHT_SHIFT) &
			Chunk.BLOCK_LIGHT_MASK
		);
	}
	public getLight(lx: number, ly: number, lz: number): number {
		if (!this.isLoaded) return 0;
		return this.light_array[lx + ly * Chunk.SIZE + lz * Chunk.SIZE2];
	}
	public setLight(x: number, y: number, z: number, level: number): void {
		if (!this.isLoaded) return;
		const idx = x + y * Chunk.SIZE + z * Chunk.SIZE2;
		if (this.light_array[idx] !== level) {
			this.light_array[idx] = level;
			this.isModified = true;
		}
	}
	public setBlockLight(x: number, y: number, z: number, level: number): void {
		const cur = this.getLight(x, y, z);
		this.setLight(
			x,
			y,
			z,
			(cur & ~Chunk.BLOCK_LIGHT_MASK) | (level & Chunk.BLOCK_LIGHT_MASK),
		);
	}
	public setSkyLight(x: number, y: number, z: number, level: number): void {
		const cur = this.getLight(x, y, z);
		this.setLight(
			x,
			y,
			z,
			(cur & Chunk.BLOCK_LIGHT_MASK) |
				((level & Chunk.BLOCK_LIGHT_MASK) << Chunk.SKY_LIGHT_SHIFT),
		);
	}

	// =========================================================================
	// Block accessors
	// =========================================================================

	public getBlock(lx: number, ly: number, lz: number): number {
		return unpackBlockId(this.getBlockPacked(lx, ly, lz));
	}
	public getBlockState(lx: number, ly: number, lz: number): number {
		return unpackBlockState(this.getBlockPacked(lx, ly, lz));
	}
	public getBlockPacked(lx: number, ly: number, lz: number): number {
		if (!this.isLoaded) return 0;
		if (this._isUniform) return this._uniformBlockId;
		const index = lx + ly * Chunk.SIZE + lz * Chunk.SIZE2;
		if (this._palette) return this._palette[this.getNibble(index)];
		return this._block_array![index];
	}

	private static flushRemeshQueue(): void {
		Chunk.remeshFlushScheduled = false;
		while (Chunk.remeshQueue.length > 0) {
			const chunk = Chunk.remeshQueue.shift()!;
			Chunk.remeshQueueSet.delete(chunk.id);
			chunk.remeshQueued = false;
			const p = chunk.remeshQueuedPriority;
			chunk.remeshQueuedPriority = false;
			Chunk.onRequestRemesh?.(chunk, p);
		}
	}

	public setBlock(
		localX: number,
		localY: number,
		localZ: number,
		blockId: number,
		state = 0,
	): void {
		if (!this.isLoaded) {
			console.warn(
				"Attempted to set block on an unloaded chunk. Action ignored. ",
				this.id,
				localX,
				localY,
				localZ,
			);
			return;
		}

		const index = localX + localY * Chunk.SIZE + localZ * Chunk.SIZE2;
		const packedBlock = packBlockValue(blockId, state);
		let oldPacked = 0;

		if (this._isUniform) {
			oldPacked = this._uniformBlockId;
			if (oldPacked === packedBlock) return;

			this._isUniform = false;
			this._palette = new Uint16Array([this._uniformBlockId]);
			let newIndex = 0;
			if (this._palette[0] !== packedBlock) {
				const ep = new Uint16Array(2);
				ep[0] = this._palette[0];
				ep[1] = packedBlock;
				this._palette = ep;
				newIndex = 1;
			}
			this._block_array = new Uint8Array(
				new SharedArrayBuffer(Chunk.SIZE3 / 2),
			);
			this._block_array.fill(0);
			this.setNibble(index, newIndex);
		} else if (this._palette) {
			const paletteIndex = this.getNibble(index);
			oldPacked = this._palette[paletteIndex];
			if (oldPacked === packedBlock) return;

			let npi = this._palette.indexOf(packedBlock);
			if (npi === -1) {
				if (this._palette.length < 16) {
					npi = this._palette.length;
					const ep = new Uint16Array(npi + 1);
					ep.set(this._palette);
					ep[npi] = packedBlock;
					this._palette = ep;
					this.setNibble(index, npi);
				} else {
					// Palette full → expand to raw Uint16Array.
					const na = new Uint16Array(new SharedArrayBuffer(Chunk.SIZE3 * 2));
					for (let i = 0; i < Chunk.SIZE3; i++)
						na[i] = this._palette[this.getNibble(i)];
					na[index] = packedBlock;
					this._block_array = na;
					this._palette = null;
				}
			} else {
				this.setNibble(index, npi);
			}
		} else {
			if (packedBlock > 255 && this._block_array instanceof Uint8Array) {
				const na = new Uint16Array(new SharedArrayBuffer(Chunk.SIZE3 * 2));
				na.set(this._block_array);
				this._block_array = na;
			}
			oldPacked = this._block_array![index];
			if (oldPacked === packedBlock) return;
			this._block_array![index] = packedBlock;
		}

		const oldBlockLight = this.getBlockLight(localX, localY, localZ);
		const oldSkyLight = this.getSkyLight(localX, localY, localZ);
		const newBlockId = unpackBlockId(packedBlock);
		const newIsTransparent = this.isTransparent(packedBlock);
		const oldWasSkyTransparent = this.isTransparent(oldPacked, 1);
		const newIsSkyTransparent = this.isTransparent(packedBlock, 1);

		// Block light
		if (oldBlockLight > 0)
			this.removeLight(localX, localY, localZ, false, oldPacked);
		if (newIsTransparent)
			this.updateLightFromNeighbors(localX, localY, localZ, false);

		// Sky light
		if (oldSkyLight > 0)
			this.removeLight(localX, localY, localZ, true, oldPacked);
		if (newIsSkyTransparent)
			this.updateLightFromNeighbors(localX, localY, localZ, true);
		if (oldWasSkyTransparent && !newIsSkyTransparent && oldSkyLight > 0)
			this.cutSkyLightBelow(localX, localY, localZ);

		const emission = Chunk.getLightEmission(newBlockId);
		if (emission > 0) this.addLight(localX, localY, localZ, emission);

		this.isModified = true;
		this.colliderDirty = true;
		this.clearCachedLODMeshes();
		this.scheduleRemesh(true);

		const S = Chunk.SIZE;
		if (localX === 0) this.getNeighbor(-1, 0, 0)?.scheduleRemesh(true);
		else if (localX === S - 1) this.getNeighbor(1, 0, 0)?.scheduleRemesh(true);
		if (localY === 0) this.getNeighbor(0, -1, 0)?.scheduleRemesh(true);
		else if (localY === S - 1) this.getNeighbor(0, 1, 0)?.scheduleRemesh(true);
		if (localZ === 0) this.getNeighbor(0, 0, -1)?.scheduleRemesh(true);
		else if (localZ === S - 1) this.getNeighbor(0, 0, 1)?.scheduleRemesh(true);
	}

	public deleteBlock(localX: number, localY: number, localZ: number): void {
		this.setBlock(localX, localY, localZ, 0);
	}

	// =========================================================================
	// Public light manipulation
	// =========================================================================

	public addLight(x: number, y: number, z: number, level: number): void {
		if (!this.isLoaded) return;
		level &= Chunk.BLOCK_LIGHT_MASK;
		if (level <= 0 || this.getBlockLight(x, y, z) >= level) return;
		this.setBlockLight(x, y, z, level);
		Q_A.clear();
		Q_A.push(this, x, y, z, level);
		this.processLightPropagationQueue(Q_A, false);
	}

	public propagateLight(
		queue: Array<{
			chunk: Chunk;
			x: number;
			y: number;
			z: number;
			level: number;
		}>,
		isSkyLight = true,
	): void {
		Q_A.clear();
		for (let i = 0; i < queue.length; i++) {
			const n = queue[i];
			Q_A.push(n.chunk, n.x, n.y, n.z, n.level);
		}
		this.processLightPropagationQueue(Q_A, isSkyLight);
	}

	public propagateDeferredLight(seedState: {
		queue: Uint16Array;
		length: number;
	}): void {
		if (seedState.length <= 0) return;
		Q_A.clear();
		const size = Chunk.SIZE;
		const size2 = Chunk.SIZE2;
		const skyShift = Chunk.SKY_LIGHT_SHIFT;
		for (let i = 0; i < seedState.length; i++) {
			const val = seedState.queue[i];
			const x = (val >> 10) & 0x1f;
			const y = (val >> 5) & 0x1f;
			const z = val & 0x1f;
			const level =
				(this.light_array[x + y * size + z * size2] >> skyShift) & 0xf;
			// Skip water blocks — seeding them causes lateral spread at chunk borders.
			if (
				level > 0 &&
				!Chunk.filtersFullSunlight(unpackBlockId(this.getBlockPacked(x, y, z)))
			)
				Q_A.push(this, x, y, z, level);
		}
		if (Q_A.head !== Q_A.tail) {
			this.processLightPropagationQueue(Q_A, true);
			this.scheduleRemesh(false, true);
		}
	}

	// =========================================================================
	// updateLightFromNeighbors
	// =========================================================================

	public updateLightFromNeighbors(
		x: number,
		y: number,
		z: number,
		isSkyLight = false,
	): void {
		if (!this.isLoaded) return;
		Q_A.clear();

		const size = Chunk.SIZE;
		const targetBlockPacked = this.getBlockPacked(x, y, z);
		const currentTargetLevel = isSkyLight
			? this.getSkyLight(x, y, z)
			: this.getBlockLight(x, y, z);
		const targetBlockId2 = unpackBlockId(targetBlockPacked);

		for (let i = 0; i < LIGHT_DIR_COUNT; i++) {
			const base = i * LIGHT_DIR_STRIDE;
			const dx = LIGHT_DIRS_FLAT[base];
			const dy = LIGHT_DIRS_FLAT[base + 1];
			const dz = LIGHT_DIRS_FLAT[base + 2];
			const axis = LIGHT_DIRS_FLAT[base + 3];
			// dir in the table is the outgoing travel direction; invert for incoming.
			const dir = -LIGHT_DIRS_FLAT[base + 4] as -1 | 1;
			// In updateLightFromNeighbors (dx,dy,dz) points target→source,
			// so dy>0 means the source is ABOVE the target (incoming downward
			// light). isDown in LIGHT_DIRS_FLAT marks the dy=-1 entry (outgoing
			// downward) — use sourceIsAbove for water/sun checks here instead.
			const sourceIsAbove = dy > 0;

			let sourceChunk: Chunk | undefined = this;
			let sx = x + dx;
			let sy = y + dy;
			let sz = z + dz;

			if (sx < 0) {
				sourceChunk = sourceChunk.getNeighbor(-1, 0, 0);
				sx = size - 1;
			} else if (sx >= size) {
				sourceChunk = sourceChunk.getNeighbor(1, 0, 0);
				sx = 0;
			}
			if (!sourceChunk) continue;

			if (sy < 0) {
				sourceChunk = sourceChunk.getNeighbor(0, -1, 0);
				sy = size - 1;
			} else if (sy >= size) {
				sourceChunk = sourceChunk.getNeighbor(0, 1, 0);
				sy = 0;
			}
			if (!sourceChunk) continue;

			if (sz < 0) {
				sourceChunk = sourceChunk.getNeighbor(0, 0, -1);
				sz = size - 1;
			} else if (sz >= size) {
				sourceChunk = sourceChunk.getNeighbor(0, 0, 1);
				sz = 0;
			}
			if (!sourceChunk) continue;

			const sourceBlockPacked = sourceChunk.getBlockPacked(sx, sy, sz);
			const sourceBlockId = unpackBlockId(sourceBlockPacked);
			const sourceEmits =
				!isSkyLight && Chunk.getLightEmission(sourceBlockId) > 0;

			// Allow water→water lateral flow only (both sides water).
			// sourceIsAbove=true means downward light which water CAN pass freely.
			const lateralWaterToWater =
				isSkyLight &&
				!sourceIsAbove &&
				Chunk.filtersFullSunlight(sourceBlockId) &&
				Chunk.filtersFullSunlight(targetBlockId2);

			const sourceAllows = isSkyLight
				? sourceChunk.isTransparent(sourceBlockPacked, axis, dir) &&
					(sourceIsAbove ||
						!Chunk.filtersFullSunlight(sourceBlockId) ||
						lateralWaterToWater)
				: sourceEmits ||
					sourceChunk.isTransparent(sourceBlockPacked, axis, dir);
			if (!sourceAllows) continue;

			if (!this.isTransparent(targetBlockPacked, axis, -dir)) continue;

			const level = isSkyLight
				? sourceChunk.getSkyLight(sx, sy, sz)
				: sourceChunk.getBlockLight(sx, sy, sz);
			if (level <= 0) continue;

			const targetBlockId = unpackBlockId(targetBlockPacked);
			const preservesFullSun =
				isSkyLight &&
				sourceIsAbove &&
				level === 15 &&
				!Chunk.filtersFullSunlight(sourceBlockId) &&
				!Chunk.filtersFullSunlight(targetBlockId);

			const nextLevel = preservesFullSun ? 15 : level - 1;
			if (nextLevel <= 0 || nextLevel <= currentTargetLevel) continue;
			Q_A.push(sourceChunk, sx, sy, sz, level);
		}

		if (Q_A.head !== Q_A.tail)
			this.processLightPropagationQueue(Q_A, isSkyLight);
	}

	// =========================================================================
	// processLightPropagationQueue  (BFS forward pass)
	// =========================================================================

	private processLightPropagationQueue(
		q: LightQueue,
		isSkyLight: boolean,
	): void {
		const size = Chunk.SIZE;
		const size2 = Chunk.SIZE2;
		const skyShift = Chunk.SKY_LIGHT_SHIFT;
		const blockMask = Chunk.BLOCK_LIGHT_MASK;

		while (q.head !== q.tail) {
			const slot = q.head & (BFS_CAPACITY - 1);
			q.head = (q.head + 1) & (BFS_CAPACITY - 1);
			const chunk = q.chunks[slot]!;
			const coord = q.coords[slot];
			const x = coord & 0x1f;
			const y = (coord >> 5) & 0x1f;
			const z = (coord >> 10) & 0x1f;

			const lightArr = chunk.light_array;
			if (lightArr.length === 0) continue;

			const idx = x + y * size + z * size2;
			const level = isSkyLight
				? (lightArr[idx] >> skyShift) & 0xf
				: lightArr[idx] & 0xf;
			if (level <= 0) continue;

			const sourcePacked = chunk.getBlockPacked(x, y, z);
			const sourceBlockId = unpackBlockId(sourcePacked);
			const sourceEmits =
				!isSkyLight && Chunk.getLightEmission(sourceBlockId) > 0;

			for (let i = 0; i < LIGHT_DIR_COUNT; i++) {
				const base = i * LIGHT_DIR_STRIDE;
				let tx = x + LIGHT_DIRS_FLAT[base];
				let ty = y + LIGHT_DIRS_FLAT[base + 1];
				let tz = z + LIGHT_DIRS_FLAT[base + 2];
				const axis = LIGHT_DIRS_FLAT[base + 3];
				const dir = LIGHT_DIRS_FLAT[base + 4];
				const isDown = LIGHT_DIRS_FLAT[base + 5];

				let targetChunk: Chunk | undefined = chunk;

				if (tx < 0) {
					targetChunk = targetChunk.getNeighbor(-1, 0, 0);
					tx = size - 1;
				} else if (tx >= size) {
					targetChunk = targetChunk.getNeighbor(1, 0, 0);
					tx = 0;
				}
				if (!targetChunk) continue;

				if (ty < 0) {
					targetChunk = targetChunk.getNeighbor(0, -1, 0);
					ty = size - 1;
				} else if (ty >= size) {
					targetChunk = targetChunk.getNeighbor(0, 1, 0);
					ty = 0;
				}
				if (!targetChunk) continue;

				if (tz < 0) {
					targetChunk = targetChunk.getNeighbor(0, 0, -1);
					tz = size - 1;
				} else if (tz >= size) {
					targetChunk = targetChunk.getNeighbor(0, 0, 1);
					tz = 0;
				}
				if (!targetChunk?.isLoaded) continue;

				// Can light leave source?
				// Water-like blocks cannot emit skylight sideways (only downward)
				// to prevent artificial full-sun columns.  Exception: water→water
				// lateral flow is allowed with -1 attenuation so that a column
				// below a placed block can be re-lit by horizontal neighbours.
				if (
					isSkyLight &&
					isDown !== 1 &&
					Chunk.filtersFullSunlight(sourceBlockId)
				) {
					const peekId = unpackBlockId(targetChunk.getBlockPacked(tx, ty, tz));
					if (!Chunk.filtersFullSunlight(peekId)) continue; // non-water: block
					// Both water: fall through for attenuated lateral propagation.
				} else if (
					isSkyLight
						? !chunk.isTransparent(sourcePacked, axis, dir)
						: !sourceEmits && !chunk.isTransparent(sourcePacked, axis, dir)
				) {
					continue;
				}

				const targetPacked = targetChunk.getBlockPacked(tx, ty, tz);
				if (!targetChunk.isTransparent(targetPacked, axis, -dir)) continue;

				const tidx = tx + ty * size + tz * size2;
				const targetLightArr = targetChunk.light_array;
				const currentLevel = isSkyLight
					? (targetLightArr[tidx] >> skyShift) & 0xf
					: targetLightArr[tidx] & 0xf;

				const targetBlockId = unpackBlockId(targetPacked);

				// Water-like blocks normally only receive skylight from directly
				// above.  Exception: water→water lateral with attenuation.
				if (
					isSkyLight &&
					isDown !== 1 &&
					Chunk.filtersFullSunlight(targetBlockId)
				) {
					if (!Chunk.filtersFullSunlight(sourceBlockId)) continue;
					// Both water: fall through.
				}

				const preservesFullSun =
					isSkyLight &&
					isDown === 1 &&
					level === 15 &&
					!Chunk.filtersFullSunlight(sourceBlockId) &&
					!Chunk.filtersFullSunlight(targetBlockId);

				const nextLevel = preservesFullSun ? 15 : level - 1;
				if (nextLevel <= 0 || currentLevel >= nextLevel) continue;

				if (isSkyLight) {
					targetLightArr[tidx] =
						(targetLightArr[tidx] & blockMask) | (nextLevel << skyShift);
				} else {
					targetLightArr[tidx] =
						(targetLightArr[tidx] & ~blockMask) | nextLevel;
				}

				targetChunk.scheduleRemesh();
				q.push(targetChunk, tx, ty, tz, nextLevel);
			}
		}
	}

	// =========================================================================
	// removeLight  (BFS removal pass)
	// =========================================================================

	public removeLight(
		x: number,
		y: number,
		z: number,
		isSkyLight = false,
		sourcePackedOverride?: number,
	): void {
		const size = Chunk.SIZE;
		const size2 = Chunk.SIZE2;
		const skyShift = Chunk.SKY_LIGHT_SHIFT;
		const blockMask = Chunk.BLOCK_LIGHT_MASK;

		const startIdx = x + y * size + z * size2;
		const startLevel = isSkyLight
			? (this.light_array[startIdx] >> skyShift) & 0xf
			: this.light_array[startIdx] & 0xf;
		if (startLevel === 0) return;

		Q_A.clear();
		Q_B.clear();
		Q_A.push(this, x, y, z, startLevel);

		if (isSkyLight) this.light_array[startIdx] &= blockMask;
		else this.light_array[startIdx] &= ~blockMask;
		this.scheduleRemesh();

		// Indexed loop so we can keep appending to Q_A while iterating.
		// tail advances as we push; we read from [head..tail).
		let head = 0;
		while (head !== Q_A.tail) {
			const slot = head & (BFS_CAPACITY - 1);
			head = (head + 1) & (BFS_CAPACITY - 1);
			const chunk = Q_A.chunks[slot]!;
			const coord = Q_A.coords[slot];
			const cx = coord & 0x1f;
			const cy = (coord >> 5) & 0x1f;
			const cz = (coord >> 10) & 0x1f;
			const level = Q_A.levels[slot];

			const sourcePacked =
				head === 1 && sourcePackedOverride !== undefined
					? sourcePackedOverride
					: chunk.getBlockPacked(cx, cy, cz);
			const sourceBlockId = unpackBlockId(sourcePacked);
			const sourceEmits =
				!isSkyLight && Chunk.getLightEmission(sourceBlockId) > 0;

			for (let i = 0; i < LIGHT_DIR_COUNT; i++) {
				const base = i * LIGHT_DIR_STRIDE;
				let tx = cx + LIGHT_DIRS_FLAT[base];
				let ty = cy + LIGHT_DIRS_FLAT[base + 1];
				let tz = cz + LIGHT_DIRS_FLAT[base + 2];
				const axis = LIGHT_DIRS_FLAT[base + 3];
				const dir = LIGHT_DIRS_FLAT[base + 4];
				const isDown = LIGHT_DIRS_FLAT[base + 5];

				let targetChunk: Chunk | undefined = chunk;

				if (tx < 0) {
					targetChunk = targetChunk.getNeighbor(-1, 0, 0);
					tx = size - 1;
				} else if (tx >= size) {
					targetChunk = targetChunk.getNeighbor(1, 0, 0);
					tx = 0;
				}
				if (!targetChunk) continue;

				if (ty < 0) {
					targetChunk = targetChunk.getNeighbor(0, -1, 0);
					ty = size - 1;
				} else if (ty >= size) {
					targetChunk = targetChunk.getNeighbor(0, 1, 0);
					ty = 0;
				}
				if (!targetChunk) continue;

				if (tz < 0) {
					targetChunk = targetChunk.getNeighbor(0, 0, -1);
					tz = size - 1;
				} else if (tz >= size) {
					targetChunk = targetChunk.getNeighbor(0, 0, 1);
					tz = 0;
				}
				if (!targetChunk?.isLoaded) continue;

				if (
					isSkyLight
						? !chunk.isTransparent(sourcePacked, axis, dir) ||
							(isDown !== 1 && Chunk.filtersFullSunlight(sourceBlockId))
						: !sourceEmits && !chunk.isTransparent(sourcePacked, axis, dir)
				)
					continue;

				const targetPacked = targetChunk.getBlockPacked(tx, ty, tz);
				if (!targetChunk.isTransparent(targetPacked, axis, -dir)) continue;

				const tIdx = tx + ty * size + tz * size2;
				const tArr = targetChunk.light_array;
				const neighborLevel = isSkyLight
					? (tArr[tIdx] >> skyShift) & 0xf
					: tArr[tIdx] & 0xf;
				if (neighborLevel === 0) continue;

				const targetBlockId = unpackBlockId(targetPacked);
				const preservesFullSun =
					isSkyLight &&
					isDown === 1 &&
					level === 15 &&
					!Chunk.filtersFullSunlight(sourceBlockId) &&
					!Chunk.filtersFullSunlight(targetBlockId);
				const isDependent =
					neighborLevel < level || (preservesFullSun && neighborLevel === 15);

				if (isDependent) {
					if (isSkyLight) tArr[tIdx] &= blockMask;
					else tArr[tIdx] &= ~blockMask;
					targetChunk.scheduleRemesh();
					Q_A.push(targetChunk, tx, ty, tz, neighborLevel);
				} else {
					Q_B.push(targetChunk, tx, ty, tz, neighborLevel);
				}
			}
		}

		if (Q_B.head !== Q_B.tail)
			this.processLightPropagationQueue(Q_B, isSkyLight);
	}

	// =========================================================================
	// cutSkyLightBelow
	// =========================================================================

	private cutSkyLightBelow(
		localX: number,
		localY: number,
		localZ: number,
	): void {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		let targetChunk: Chunk | undefined = this;
		const tx = localX;
		let ty = localY - 1;
		const tz = localZ;

		if (ty < 0) {
			targetChunk = targetChunk.getNeighbor(0, -1, 0);
			ty = Chunk.SIZE - 1;
		}
		if (!targetChunk?.isLoaded) return;

		const belowBlockPacked = targetChunk.getBlockPacked(tx, ty, tz);
		if (!targetChunk.isTransparent(belowBlockPacked, 1, 1)) return;

		if (targetChunk.getSkyLight(tx, ty, tz) > 0)
			targetChunk.removeLight(tx, ty, tz, true);

		// Re-propagate into the block directly below the placed block so that
		// any water column below it can recover light from horizontal neighbours.
		targetChunk.updateLightFromNeighbors(tx, ty, tz, true);
	}

	// =========================================================================
	// Remesh scheduling
	// =========================================================================

	public scheduleRemesh(priority = false, includeNeighbors = false): void {
		if (!this.isLoaded) return;
		this.isDirty = true;
		if (priority) this.remeshQueuedPriority = true;
		if (this.remeshQueued) return;
		this.remeshQueued = true;

		if (includeNeighbors) {
			this.getNeighbor(-1, 0, 0)?.scheduleRemesh(priority);
			this.getNeighbor(1, 0, 0)?.scheduleRemesh(priority);
			this.getNeighbor(0, -1, 0)?.scheduleRemesh(priority);
			this.getNeighbor(0, 1, 0)?.scheduleRemesh(priority);
			this.getNeighbor(0, 0, -1)?.scheduleRemesh(priority);
			this.getNeighbor(0, 0, 1)?.scheduleRemesh(priority);
		}

		if (!Chunk.remeshQueueSet.has(this.id)) {
			Chunk.remeshQueueSet.add(this.id);
			Chunk.remeshQueue.push(this);
		}
		if (!Chunk.remeshFlushScheduled) {
			Chunk.remeshFlushScheduled = true;
			requestAnimationFrame(Chunk.flushRemeshQueue);
		}
	}

	// =========================================================================
	// Neighbour / coordinate helpers
	// =========================================================================

	get chunkX(): number {
		return this.#chunkX;
	}
	get chunkY(): number {
		return this.#chunkY;
	}
	get chunkZ(): number {
		return this.#chunkZ;
	}

	public getNeighbor(dx: number, dy: number, dz: number): Chunk | undefined {
		return Chunk.getChunk(
			this.#chunkX + dx,
			this.#chunkY + dy,
			this.#chunkZ + dz,
		);
	}
	public static getChunk(
		cx: number,
		cy: number,
		cz: number,
	): Chunk | undefined {
		return Chunk.chunkInstances.get(Chunk.packCoords(cx, cy, cz));
	}
	public markLightChanged(): void {
		this.isLightDirty = true;
	}
	public needsPersistence(): boolean {
		return this.isModified || this.isLODMeshCacheDirty || this.isLightDirty;
	}

	private static readonly BITS = 21n;
	private static readonly MASK = (1n << Chunk.BITS) - 1n;
	private static readonly Y_SHIFT = Chunk.BITS;
	private static readonly Z_SHIFT = Chunk.BITS * 2n;

	public static packCoords(x: number, y: number, z: number): bigint {
		return (
			(BigInt(x) & Chunk.MASK) |
			((BigInt(y) & Chunk.MASK) << Chunk.Y_SHIFT) |
			((BigInt(z) & Chunk.MASK) << Chunk.Z_SHIFT)
		);
	}

	// =========================================================================
	// Face-mask geometry (closed-face checks for lighting)
	// =========================================================================

	private static filtersFullSunlight(blockId: number): boolean {
		return unpackBlockId(blockId) === Chunk.WATER_BLOCK_ID;
	}

	private static getClosedFaceMaskForPacked(blockPacked: number): number {
		const cacheIndex = blockPacked & 0xffff;
		const cached = Chunk.CLOSED_FACE_MASK_CACHE[cacheIndex];
		if (cached !== -1) return cached;

		const blockId = unpackBlockId(blockPacked);
		if (
			blockId === 0 ||
			blockId === Chunk.WATER_BLOCK_ID ||
			blockId === Chunk.GLASS_01_BLOCK_ID ||
			blockId === Chunk.GLASS_02_BLOCK_ID
		) {
			Chunk.CLOSED_FACE_MASK_CACHE[cacheIndex] = 0;
			return 0;
		}

		const state = unpackBlockState(blockPacked);
		const shapeIndex = ShapeByBlockId[blockId] ?? CUBE_SHAPE_INDEX;
		const shape =
			ShapeDefinitions[shapeIndex] ?? ShapeDefinitions[CUBE_SHAPE_INDEX];
		if (!shape) {
			Chunk.CLOSED_FACE_MASK_CACHE[cacheIndex] = FACE_ALL;
			return FACE_ALL;
		}

		const rotation = shape.rotateY ? state & 3 : 0;
		const flipY = Boolean(shape.allowFlipY && (state & 4) !== 0);

		_rectCounts.fill(0);

		for (const box of shape.boxes) {
			const transformed = transformBox(box.min, box.max, rotation, flipY);
			const sliced = shape.usesSliceState
				? Chunk.applySliceStateToBoxForLight(
						transformed.min,
						transformed.max,
						state,
					)
				: transformed;

			const min = sliced.min;
			const max = sliced.max;
			const faceMask = box.faceMask ?? FACE_ALL;
			const EPS = Chunk.EPS;

			if (
				max[0] - min[0] <= EPS ||
				max[1] - min[1] <= EPS ||
				max[2] - min[2] <= EPS
			)
				continue;

			// Face index: 0=PX 1=NX 2=PY 3=NY 4=PZ 5=NZ
			if (faceMask & FACE_PX && max[0] >= 1 - EPS)
				Chunk.pushRectFlat(0, min[1], max[1], min[2], max[2]);
			if (faceMask & FACE_NX && min[0] <= EPS)
				Chunk.pushRectFlat(1, min[1], max[1], min[2], max[2]);
			if (faceMask & FACE_PY && max[1] >= 1 - EPS)
				Chunk.pushRectFlat(2, min[0], max[0], min[2], max[2]);
			if (faceMask & FACE_NY && min[1] <= EPS)
				Chunk.pushRectFlat(3, min[0], max[0], min[2], max[2]);
			if (faceMask & FACE_PZ && max[2] >= 1 - EPS)
				Chunk.pushRectFlat(4, min[0], max[0], min[1], max[1]);
			if (faceMask & FACE_NZ && min[2] <= EPS)
				Chunk.pushRectFlat(5, min[0], max[0], min[1], max[1]);
		}

		let closedMask = 0;
		if (Chunk.doesFlatRectsCoverUnitSquare(0)) closedMask |= FACE_PX;
		if (Chunk.doesFlatRectsCoverUnitSquare(1)) closedMask |= FACE_NX;
		if (Chunk.doesFlatRectsCoverUnitSquare(2)) closedMask |= FACE_PY;
		if (Chunk.doesFlatRectsCoverUnitSquare(3)) closedMask |= FACE_NY;
		if (Chunk.doesFlatRectsCoverUnitSquare(4)) closedMask |= FACE_PZ;
		if (Chunk.doesFlatRectsCoverUnitSquare(5)) closedMask |= FACE_NZ;

		Chunk.CLOSED_FACE_MASK_CACHE[cacheIndex] = closedMask;
		return closedMask;
	}

	/** Write a clamped rect into the flat scratch buffer for face index `f`. */
	private static pushRectFlat(
		f: number,
		u0: number,
		u1: number,
		v0: number,
		v1: number,
	): void {
		const EPS = Chunk.EPS;
		const cu0 = Math.min(1, Math.max(0, Math.min(u0, u1)));
		const cu1 = Math.min(1, Math.max(0, Math.max(u0, u1)));
		const cv0 = Math.min(1, Math.max(0, Math.min(v0, v1)));
		const cv1 = Math.min(1, Math.max(0, Math.max(v0, v1)));
		if (cu1 - cu0 <= EPS || cv1 - cv0 <= EPS) return;
		const cnt = _rectCounts[f];
		if (cnt >= MAX_RECTS) return;
		const base = cnt * RECT_STRIDE;
		const buf = _rectBufs[f];
		buf[base] = cu0;
		buf[base + 1] = cu1;
		buf[base + 2] = cv0;
		buf[base + 3] = cv1;
		_rectCounts[f] = cnt + 1;
	}

	/** Returns true if the rects stored for face `f` fully cover the unit square. */
	private static doesFlatRectsCoverUnitSquare(f: number): boolean {
		const count = _rectCounts[f];
		if (count === 0) return false;

		const buf = _rectBufs[f];
		const EPS = Chunk.EPS;
		// U edges go into _edgeScratch[0 .. uLen),
		// V edges go into _edgeScratch[HALF .. HALF+vLen).
		const HALF = MAX_RECTS * 2 + 2; // guaranteed to not overlap

		let uLen = 0;
		let vLen = 0;
		for (let i = 0; i < count; i++) {
			const b = i * RECT_STRIDE;
			_edgeScratch[uLen++] = buf[b];
			_edgeScratch[uLen++] = buf[b + 1];
			_edgeScratch[HALF + vLen++] = buf[b + 2];
			_edgeScratch[HALF + vLen++] = buf[b + 3];
		}

		// Sort (insertion sort; tiny N, avoids closure/array alloc).
		Chunk.insertionSortEdges(0, uLen);
		Chunk.insertionSortEdges(HALF, vLen);

		// Deduplicate and bracket with 0 and 1.
		uLen = Chunk.dedupeEdges(0, uLen);
		vLen = Chunk.dedupeEdges(HALF, vLen);

		for (let ui = 0; ui < uLen - 1; ui++) {
			const u0e = _edgeScratch[ui];
			const u1e = _edgeScratch[ui + 1];
			if (u1e - u0e <= EPS) continue;
			for (let vi = 0; vi < vLen - 1; vi++) {
				const v0e = _edgeScratch[HALF + vi];
				const v1e = _edgeScratch[HALF + vi + 1];
				if (v1e - v0e <= EPS) continue;
				let covered = false;
				for (let r = 0; r < count; r++) {
					const rb = r * RECT_STRIDE;
					if (
						buf[rb] <= u0e + EPS &&
						buf[rb + 1] >= u1e - EPS &&
						buf[rb + 2] <= v0e + EPS &&
						buf[rb + 3] >= v1e - EPS
					) {
						covered = true;
						break;
					}
				}
				if (!covered) return false;
			}
		}
		return true;
	}

	/** In-place insertion sort on a region of _edgeScratch[start..start+len). */
	private static insertionSortEdges(start: number, len: number): void {
		for (let i = 1; i < len; i++) {
			const key = _edgeScratch[start + i];
			let j = i - 1;
			while (j >= 0 && _edgeScratch[start + j] > key) {
				_edgeScratch[start + j + 1] = _edgeScratch[start + j];
				j--;
			}
			_edgeScratch[start + j + 1] = key;
		}
	}

	/**
	 * Deduplicates a sorted region of _edgeScratch in-place and ensures it is
	 * bracketed by 0 and 1.  Returns the new element count.
	 */
	private static dedupeEdges(start: number, len: number): number {
		const EPS = Chunk.EPS;
		// Prepend 0 if needed.
		if (len === 0 || _edgeScratch[start] > EPS) {
			for (let i = len; i > 0; i--)
				_edgeScratch[start + i] = _edgeScratch[start + i - 1];
			_edgeScratch[start] = 0;
			len++;
		}
		// Append 1 if needed.
		if (_edgeScratch[start + len - 1] < 1 - EPS) {
			_edgeScratch[start + len] = 1;
			len++;
		}
		// Deduplicate in-place.
		let write = 1;
		for (let read = 1; read < len; read++) {
			if (
				Math.abs(_edgeScratch[start + read] - _edgeScratch[start + write - 1]) >
				EPS
			) {
				_edgeScratch[start + write++] = _edgeScratch[start + read];
			}
		}
		return write;
	}

	private static getFaceBit(axis: number, dir: number): number {
		if (axis === 0) return dir >= 0 ? FACE_PX : FACE_NX;
		if (axis === 1) return dir >= 0 ? FACE_PY : FACE_NY;
		return dir >= 0 ? FACE_PZ : FACE_NZ;
	}

	private isTransparent(
		blockPacked: number,
		axis?: number,
		dir?: number,
	): boolean {
		const closedMask = Chunk.getClosedFaceMaskForPacked(blockPacked);
		if (axis === undefined) return closedMask !== FACE_ALL;
		if (dir === undefined) {
			return (
				(closedMask & Chunk.getFaceBit(axis, 1)) === 0 ||
				(closedMask & Chunk.getFaceBit(axis, -1)) === 0
			);
		}
		return (closedMask & Chunk.getFaceBit(axis, dir)) === 0;
	}

	private static applySliceStateToBoxForLight(
		min: [number, number, number],
		max: [number, number, number],
		state: number,
	): { min: [number, number, number]; max: [number, number, number] } {
		const slice = (state >>> 3) & 7;
		if (slice === 0) return { min, max };

		const rotation = state & 7;
		const sliceAxis = getSliceAxis(rotation);
		const flip = (rotation & 4) !== 0;
		const heightScale = slice / 8;
		const outMin: [number, number, number] = [min[0], min[1], min[2]];
		const outMax: [number, number, number] = [max[0], max[1], max[2]];

		if (flip) {
			outMin[sliceAxis] = 1 - (1 - min[sliceAxis]) * heightScale;
			outMax[sliceAxis] = 1 - (1 - max[sliceAxis]) * heightScale;
		} else {
			outMin[sliceAxis] = min[sliceAxis] * heightScale;
			outMax[sliceAxis] = max[sliceAxis] * heightScale;
		}
		if (outMin[sliceAxis] > outMax[sliceAxis]) {
			const tmp = outMin[sliceAxis];
			outMin[sliceAxis] = outMax[sliceAxis];
			outMax[sliceAxis] = tmp;
		}
		return { min: outMin, max: outMax };
	}

	// =========================================================================
	// Dispose
	// =========================================================================

	public dispose(): void {
		this.clearCachedLODMeshes();
		this.mesh?.dispose();
		this.transparentMesh?.dispose();
		this.mesh = null;
		this.transparentMesh = null;
		this.opaqueMeshData = null;
		this.transparentMeshData = null;
		this._block_array = null;
		this._isUniform = true;
		this._uniformBlockId = 0;
		this._palette = null;
		this._hasVoxelData = false;
		this.light_array = Chunk.EMPTY_LIGHT_ARRAY;
		this.isLoaded = false;
		this.isTerrainScheduled = false;
		this.colliderDirty = true;
	}
}
