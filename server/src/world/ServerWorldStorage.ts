/**
 * ServerWorldStorage — LevelDB-backed chunk storage for the server.
 *
 * Stores full chunk data using the same VoxelSerializer blob format as
 * singleplayer. On startup, stored chunks are checked before generation so
 * terrain persists across restarts.
 */

import { LightGenerator } from "@/code/Generation/LightGenerator";
import { DEBUG_ENABLED, debugLog } from "@/code/Lib/debugLog";
import { CHUNK_SHIFT, CHUNK_SIZE } from "@/code/Lib/VoxelMath.ts";
import { precomputeClosedFaceMasks } from "@/code/World/Chunk/ChunkFaceMasks";
import {
	packBlockValue,
	unpackBlockId,
} from "@/code/World/Chunk/DataStructures/BlockEncoding";
import {
	FACE_NY,
	FACE_PY,
	shapeInitPromise,
} from "@/code/World/Shape/BlockShapes";
import {
	packChunkKeyFast,
	unpackChunkKeyFast,
} from "@/code/World/Storage/ChunkKey.ts";
import { LevelDbChunkStore } from "@/code/World/Storage/LevelDbChunkStore";
import {
	deserializeVoxelData,
	serializeVoxelData,
} from "@/code/World/Storage/VoxelSerializer";
import {
	CHUNK_VOLUME,
	compressBlocks,
	decompressBlocks,
	MAX_BLOCK_ID,
	releaseDecompBuffer,
} from "./ChunkCompression.ts";
import type { ChunkGenerationService } from "./ChunkGenerationService.ts";

export interface StoredChunkData {
	readonly chunkX: number;
	readonly chunkY: number;
	readonly chunkZ: number;
	readonly blocks: Uint8Array | Uint16Array;
	readonly light: Uint8Array;
	palette?: number[];
	readonly isUniform: boolean;
	readonly uniformBlockId: number;
	version: number;
}

export interface BlockEdit {
	x: number;
	y: number;
	z: number;
	blockId: number;
	/**
	 * Shape state bits (rotation/flipY/slice) stored alongside the block id.
	 * Optional so generation-time edits ({x,y,z,blockId} literals) stay valid;
	 * defaults to 0, and packBlockValue(id, 0) === id keeps old data intact.
	 */
	blockState?: number;
}

interface StoredPlayerPosition {
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
}

interface CacheNode {
	key: number;
	data: StoredChunkData;

	/**
	 * Lazily materialized dense 32³ block buffer for synchronous samplers.
	 * - Raw chunks may point directly at data.blocks.
	 * - Uniform/palette/compressed chunks get one owned dense buffer.
	 * Invalidated whenever data is replaced in addToCache().
	 */
	denseBlocks: Uint8Array | Uint16Array | null;

	prev: CacheNode | null;
	next: CacheNode | null;
}

interface MissCoordEntry {
	cx: number;
	cy: number;
	cz: number;
	cacheKey: number;
	key: string;
}

/**
 * Serializable snapshot of a mob for per-chunk-column persistence. Covers the
 * full ServerMob state so a mob resumes exactly where it was when its column
 * was unloaded.
 */
export interface PersistedMob {
	id: number;
	typeId: number;
	x: number;
	y: number;
	z: number;
	yaw: number;
	/** Remaining hit points. Optional for pre-existing saved data. */
	hp?: number;
	headingTimer: number;
	stuckTimer: number;
	fleeing: boolean;
	/** ms remaining in a damage-triggered panic. Optional for pre-existing saved data. */
	fleeTimer?: number;
	path: Array<{ x: number; z: number; groundY: number }>;
	pathIndex: number;
	pathTimer: number;
	/** Spawn-egg mobs are cap-exempt. Optional for pre-existing saved data. */
	egg?: boolean;
}

const DEFAULT_CACHE_SIZE = 1024;
const DEFAULT_BLOB_CACHE_SIZE = 128;

const WATER_BLOCK_ID = 30;
const FLUSH_DELAY_MS = 500;

/** Largest packed block value: 10-bit id | 6-bit state << 10 (u16 range). */
const MAX_PACKED_VALUE = 65535;
/** Shape-state bits per voxel (matches BLOCK_STATE_BITS in BlockEncoding). */
const MAX_BLOCK_STATE_BITS = 63;

/** Set once the shape-aware closed-face LUT has been built in this process. */
let closedFaceMaskLUTReady = false;

function ensureClosedFaceMaskLUT(): Promise<void> {
	if (closedFaceMaskLUTReady) return Promise.resolve();
	closedFaceMaskLUTReady = true;
	// One-time walk of every packed block value (64K entries, cached inside
	// ChunkFaceMasks). Gives the sky-mask walk exact per-face shape parity
	// with the client's incremental engine. The shape registry loads
	// asynchronously — await it or every block degrades to a full cube.
	return shapeInitPromise.then(() => {
		LightGenerator.setClosedFaceMaskLUT(precomputeClosedFaceMasks());
	});
}

/**
 * Face-neighbor offsets in the order shared with LightGenerator's border
 * seeding: [+X, -X, +Y, -Y, +Z, -Z].
 */
const FACE_NORMALS: ReadonlyArray<readonly [number, number, number]> = [
	[1, 0, 0],
	[-1, 0, 0],
	[0, 1, 0],
	[0, -1, 0],
	[0, 0, 1],
	[0, 0, -1],
];

/**
 * Build a transfer-safe copy for relightChunk.
 *
 * The worker pool TRANSFERS the blocks buffer to the worker, so the input
 * must never alias cached or pooled storage — hence the unconditional copy.
 * Values stay PACKED (id | state << 10): the shape-aware light LUT indexes
 * by packed value so slab/stair orientation affects light flow, and all
 * other LUT lookups in the generator mask to the raw id.
 */
function buildRelightInput(
	dense: Uint8Array | Uint16Array,
): Uint8Array | Uint16Array {
	return dense.slice();
}

// Chunks whose center is within this horizontal distance of a player are
// pinned in the LRU cache (distance-aware eviction). The client streams its
// chunk shell nearest-first, so without this the pure-LRU eviction would
// discard exactly the near-surface chunks the mob sim samples (ring 32-128).
const PLAYER_PROTECTED_RADIUS_CHUNKS = 6;
const PLAYER_PROTECTED_RADIUS_SQ =
	PLAYER_PROTECTED_RADIUS_CHUNKS *
	PLAYER_PROTECTED_RADIUS_CHUNKS *
	CHUNK_SIZE *
	CHUNK_SIZE;

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Validates that every palette entry is a storable packed block value —
 * either a raw 10-bit block id or that id with its 6-bit shape state packed
 * above it (see BlockEncoding.packBlockValue), fitting a u16 in [0, 65535].
 */
function isValidPalette(palette: number[] | Uint16Array): boolean {
	for (let i = 0; i < palette.length; i++) {
		const value = palette[i];
		if (!Number.isInteger(value) || value < 0 || value > MAX_PACKED_VALUE) {
			return false;
		}
	}
	return true;
}

function isValidBlockId(id: number): boolean {
	return Number.isInteger(id) && id >= 0 && id <= MAX_BLOCK_ID;
}

function isValidBlockState(state: number): boolean {
	return Number.isInteger(state) && state >= 0 && state <= MAX_BLOCK_STATE_BITS;
}

export class ServerWorldStorage {
	private static readonly MAX_MISS_COORD_POOL = 512;

	private store: LevelDbChunkStore;
	private dirtyChunks = new Set<number>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushPromise: Promise<void> | null = null;
	private flushRequested = false;
	private seed: string;
	private worldGen: ChunkGenerationService | null = null;

	private readonly chunkMutationQueues = new Map<number, Promise<void>>();

	private disposing = false;
	private disposed = false;

	private readonly pendingReads = new Map<
		number,
		Promise<StoredChunkData | null>
	>();

	private readonly chunkCache = new Map<number, CacheNode>();
	private cacheHead: CacheNode | null = null;
	private cacheTail: CacheNode | null = null;
	private readonly maxCacheSize: number;

	/** Current player positions (updated per room tick) used for eviction pinning. */
	private readonly playerPositions: Array<{ x: number; z: number }> = [];

	private readonly missCoordPool: MissCoordEntry[] = [];

	constructor(
		worldName: string,
		seed: string,
		basePath = "./server-data",
		maxCacheSize = DEFAULT_CACHE_SIZE,
		blobCacheSize = DEFAULT_BLOB_CACHE_SIZE,
	) {
		this.seed = seed;
		this.store = new LevelDbChunkStore(worldName, basePath, blobCacheSize);
		this.maxCacheSize = Math.max(0, Math.trunc(maxCacheSize));
	}

	private assertActive(): void {
		if (this.disposing || this.disposed) {
			throw new Error("ServerWorldStorage is closing or closed");
		}
	}

	async init(): Promise<void> {
		await this.store.open();

		const storedSeed = await this.store.getMeta("seed");
		if (storedSeed !== null && storedSeed !== this.seed) {
			await this.store.close();
			throw new Error(
				`World seed mismatch: storage uses "${storedSeed}", ` +
					`server configured "${this.seed}". Delete or migrate ` +
					`the world database before changing the seed.`,
			);
		}

		if (storedSeed === null) {
			await this.store.setMeta("seed", this.seed);
		}

		const version = await this.store.getMeta("version");
		if (version === null) {
			await this.store.setMeta("version", "1");
		} else if (version !== "1") {
			await this.store.close();
			throw new Error(`Unsupported world storage version: ${version}`);
		}

		await this.store.flush();
	}

	setWorldGenerator(gen: ChunkGenerationService): void {
		this.worldGen = gen;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		if (this.disposing) {
			throw new Error("ServerWorldStorage disposal already in progress");
		}

		this.disposing = true;

		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}

		try {
			while (this.chunkMutationQueues.size > 0) {
				const mutations = Array.from(this.chunkMutationQueues.values());
				const results = await Promise.allSettled(mutations);

				for (let i = 0; i < results.length; i++) {
					const result = results[i];
					if (result.status === "rejected") {
						console.error(
							"[ServerWorldStorage] Mutation failed during disposal:",
							result.reason,
						);
					}
				}
			}

			await this.flush();
			await this.store.close();
		} finally {
			this.clearCache();
			this.chunkMutationQueues.clear();
			this.pendingReads.clear();
			this.disposed = true;
			this.disposing = false;
		}
	}

	async readChunk(
		cx: number,
		cy: number,
		cz: number,
	): Promise<StoredChunkData | null> {
		this.assertActive();
		return this.readChunkInternal(cx, cy, cz);
	}

	/**
	 * World-Y of the topmost solid non-air, non-water block in column
	 * (worldX, worldZ), or -Infinity if the column is empty or liquid.
	 */
	async getTopSolidY(
		worldX: number,
		worldZ: number,
		yMax: number = 256,
		yMin: number = 0,
	): Promise<number> {
		this.assertActive();

		const cx = Math.floor(worldX / CHUNK_SIZE);
		const cz = Math.floor(worldZ / CHUNK_SIZE);
		const localX = worldX - cx * CHUNK_SIZE;
		const localZ = worldZ - cz * CHUNK_SIZE;

		const topCy = Math.floor(yMax / CHUNK_SIZE);
		const bottomCy = Math.floor(yMin / CHUNK_SIZE);

		for (let cy = topCy; cy >= bottomCy; cy--) {
			const chunk = await this.readChunkInternal(cx, cy, cz);
			if (!chunk) continue;

			const chunkBaseY = cy * CHUNK_SIZE;
			const startLocalY = Math.min(CHUNK_SIZE - 1, yMax - chunkBaseY);
			const endLocalY = Math.max(0, yMin - chunkBaseY);

			const decomp = decompressBlocks({
				data: chunk.blocks,
				palette: chunk.palette,
				isUniform: chunk.isUniform,
				uniformBlockId: chunk.uniformBlockId,
			});

			try {
				const blocks = decomp;
				const columnBase = localX + (localZ << 10);

				for (let localY = startLocalY; localY >= endLocalY; localY--) {
					// Entries are packed values — compare the unpacked block id.
					const id = unpackBlockId(
						blocks[columnBase + (localY << CHUNK_SHIFT)],
					);
					if (id !== 0 && id !== WATER_BLOCK_ID) {
						return chunkBaseY + localY;
					}
				}
			} finally {
				if (decomp !== chunk.blocks) {
					releaseDecompBuffer(decomp);
				}
			}
		}

		return -Infinity;
	}

	/**
	 * Synchronous dense-block accessor for the fixed-rate mob simulation.
	 * Returns the chunk's 32³ block array from the in-memory LRU cache, or
	 * null when the chunk is not cached. Never touches LevelDB.
	 *
	 * The returned array is owned by the storage cache. Callers must not mutate it
	 * or retain it beyond their short synchronous use.
	 */
	getCachedChunkBlocks(
		cx: number,
		cy: number,
		cz: number,
	): Uint8Array | Uint16Array | null {
		if (this.disposing || this.disposed) return null;

		const node = this.chunkCache.get(packChunkKeyFast(cx, cy, cz));
		if (!node) return null;

		// Keep mob-sampled chunks hot in the LRU. TickBlockSampler already avoids
		// repeated touches for the same chunk inside one simulation tick.
		this.lruTouch(node);

		return this.getDenseBlocksForNode(node);
	}

	/**
	 * Synchronous single-voxel write for the fixed-rate water simulation.
	 *
	 * Writes a packed block value into the cached dense blocks of the chunk
	 * containing (worldX, worldY, worldZ) and marks the chunk dirty so the
	 * next flush persists it. Returns false when the chunk is not cached
	 * (the simulation can't flow into an unloaded chunk anyway).
	 *
	 * Copy-on-write: the dense buffer may alias the stored `data.blocks`
	 * (already-dense uncompressed chunks). We detach it before writing so the
	 * stored blob is never mutated. The dirty-chunk flush re-compresses and
	 * persists the edited buffer.
	 */
	setCachedBlock(
		worldX: number,
		worldY: number,
		worldZ: number,
		blockId: number,
		blockState: number,
	): boolean {
		if (this.disposing || this.disposed) return false;

		const cx = Math.floor(worldX / CHUNK_SIZE);
		const cy = Math.floor(worldY / CHUNK_SIZE);
		const cz = Math.floor(worldZ / CHUNK_SIZE);
		const key = packChunkKeyFast(cx, cy, cz);
		const node = this.chunkCache.get(key);
		if (!node) return false;

		this.lruTouch(node);

		let dense = this.getDenseBlocksForNode(node);

		// Copy-on-write: detach a dense buffer that aliases the stored blob.
		if (dense === node.data.blocks) {
			dense = dense.slice();
			node.denseBlocks = dense;
		}

		const lx = worldX - cx * CHUNK_SIZE;
		const ly = worldY - cy * CHUNK_SIZE;
		const lz = worldZ - cz * CHUNK_SIZE;
		const idx = lx + (ly << CHUNK_SHIFT) + (lz << 10);

		const packed = packBlockValue(blockId, blockState);

		// Widen a u8 buffer to u16 when the new value exceeds 255 (nonzero
		// shape state or a block id above 255). Water itself never needs this,
		// but the method is shared and must not corrupt adjacent voxels.
		if (dense instanceof Uint8Array && packed > 255) {
			const widened = new Uint16Array(CHUNK_VOLUME);
			widened.set(dense);
			widened[idx] = packed;
			node.denseBlocks = widened;
		} else {
			dense[idx] = packed;
		}

		this.dirtyChunks.add(key);
		this.scheduleFlush();

		return true;
	}

	private async readChunkFromStore(
		key: number,
		cx: number,
		cy: number,
		cz: number,
	): Promise<StoredChunkData | null> {
		const blob = await this.store.readChunk(cx, cy, cz);
		if (!blob) return null;

		const newerNode = this.chunkCache.get(key);
		if (newerNode) {
			this.lruTouch(newerNode);
			return newerNode.data;
		}

		const data = this.parseBlob(cx, cy, cz, blob);
		this.addToCache(key, data);
		return data;
	}

	private readChunkInternal(
		cx: number,
		cy: number,
		cz: number,
	): Promise<StoredChunkData | null> {
		const key = packChunkKeyFast(cx, cy, cz);

		const node = this.chunkCache.get(key);
		if (node) {
			this.lruTouch(node);
			return Promise.resolve(node.data);
		}

		const pending = this.pendingReads.get(key);
		if (pending) return pending;

		const promise = this.readChunkFromStore(key, cx, cy, cz);
		this.pendingReads.set(key, promise);

		void promise
			.finally(() => {
				if (this.pendingReads.get(key) === promise) {
					this.pendingReads.delete(key);
				}
			})
			.catch(() => {});

		return promise;
	}

	async readChunks(
		coords: Array<{ cx: number; cy: number; cz: number }>,
	): Promise<Map<number, StoredChunkData>> {
		this.assertActive();

		const results = new Map<number, StoredChunkData>();
		const seen = new Set<number>();
		const missCoords: MissCoordEntry[] = [];
		const pendingKeys: number[] = [];
		const pendingPromises: Array<Promise<StoredChunkData | null>> = [];

		try {
			for (let i = 0; i < coords.length; i++) {
				const { cx, cy, cz } = coords[i];
				const cacheKey = packChunkKeyFast(cx, cy, cz);

				if (seen.has(cacheKey)) continue;
				seen.add(cacheKey);

				const node = this.chunkCache.get(cacheKey);
				if (node) {
					this.lruTouch(node);
					results.set(cacheKey, node.data);
					continue;
				}

				const pending = this.pendingReads.get(cacheKey);
				if (pending) {
					pendingKeys.push(cacheKey);
					pendingPromises.push(pending);
					continue;
				}

				const entry = this.missCoordPool.pop() ?? {
					cx: 0,
					cy: 0,
					cz: 0,
					cacheKey: 0,
					key: "",
				};

				entry.cx = cx;
				entry.cy = cy;
				entry.cz = cz;
				entry.cacheKey = cacheKey;
				entry.key = `${cx},${cy},${cz}`;
				missCoords.push(entry);
			}

			if (missCoords.length > 0) {
				const found = await this.store.readChunks(missCoords);

				let parsedSinceYield = 0;
				for (let i = 0; i < missCoords.length; i++) {
					const entry = missCoords[i];
					const blob = found.get(entry.key);
					if (!blob) continue;

					const node = this.chunkCache.get(entry.cacheKey);
					if (node) {
						this.lruTouch(node);
						results.set(entry.cacheKey, node.data);
						continue;
					}

					const data = this.parseBlob(entry.cx, entry.cy, entry.cz, blob);
					this.addToCache(entry.cacheKey, data);
					results.set(entry.cacheKey, data);

					if (++parsedSinceYield >= 16) {
						parsedSinceYield = 0;
						await yieldToEventLoop();
					}
				}
			}

			if (pendingPromises.length > 0) {
				const pendingResults = await Promise.all(pendingPromises);

				for (let i = 0; i < pendingResults.length; i++) {
					const data = pendingResults[i];
					if (data) {
						results.set(pendingKeys[i], data);
					}
				}
			}

			return results;
		} finally {
			for (let i = missCoords.length - 1; i >= 0; i--) {
				if (
					this.missCoordPool.length < ServerWorldStorage.MAX_MISS_COORD_POOL
				) {
					this.missCoordPool.push(missCoords[i]);
				}
			}
		}
	}
	private getDenseBlocksForNode(node: CacheNode): Uint8Array | Uint16Array {
		const cached = node.denseBlocks;
		if (cached) return cached;

		const c = node.data;

		if (c.isUniform) {
			if (c.uniformBlockId > 255) {
				const dense = new Uint16Array(CHUNK_VOLUME);
				dense.fill(c.uniformBlockId);
				node.denseBlocks = dense;
				return dense;
			}

			const dense = new Uint8Array(CHUNK_VOLUME);
			dense.fill(c.uniformBlockId);
			node.denseBlocks = dense;
			return dense;
		}

		// Fast path for already-dense, uncompressed chunks (u8 or u16).
		if (
			!c.palette &&
			(c.blocks.byteLength === CHUNK_VOLUME ||
				c.blocks.byteLength === CHUNK_VOLUME * 2)
		) {
			node.denseBlocks = c.blocks;
			return c.blocks;
		}

		const decomp = decompressBlocks({
			data: c.blocks,
			palette: c.palette,
			isUniform: c.isUniform,
			uniformBlockId: c.uniformBlockId,
		});

		// If decompression returned the stored buffer itself, it is safe to retain.
		if (decomp === c.blocks) {
			node.denseBlocks = c.blocks;
			return c.blocks;
		}

		// Otherwise copy into an owned cache buffer, then release the pooled buffer.
		const dense = decomp.slice();
		releaseDecompBuffer(decomp);

		node.denseBlocks = dense;
		return dense;
	}
	private parseBlob(
		cx: number,
		cy: number,
		cz: number,
		blob: Uint8Array,
	): StoredChunkData {
		const value = deserializeVoxelData(blob);

		if (!value.blocks) {
			throw new Error(`Chunk ${cx},${cy},${cz} has no block data`);
		}

		// Keep dense u16 payloads (block ids > 255) as u16; the serializer
		// already returns them typed. Everything else normalizes to a u8 copy.
		const blocks =
			value.blocks instanceof Uint16Array && !value.compressed
				? value.blocks
				: value.blocks instanceof Uint8Array
					? value.blocks
					: new Uint8Array(
							value.blocks.buffer,
							value.blocks.byteOffset,
							value.blocks.byteLength,
						);

		const light =
			value.lightArray instanceof Uint8Array
				? value.lightArray
				: new Uint8Array(0);

		const palette = value.palette ? Array.from(value.palette) : undefined;
		const isUniform = value.isUniform ?? false;
		const uniformBlockId = value.uniformBlockId ?? 0;

		// Uniform ids may be raw block ids (generated chunks) or packed
		// id|state values (chunks whose every voxel shares one edited block).
		if (
			!Number.isInteger(uniformBlockId) ||
			uniformBlockId < 0 ||
			uniformBlockId > MAX_PACKED_VALUE
		) {
			throw new Error(`Chunk ${cx},${cy},${cz} has invalid uniform block ID`);
		}

		if (palette && !isValidPalette(palette)) {
			throw new Error(`Chunk ${cx},${cy},${cz} has an invalid palette`);
		}

		return {
			chunkX: cx,
			chunkY: cy,
			chunkZ: cz,
			blocks,
			light,
			palette,
			isUniform,
			uniformBlockId,
			version: value.version ?? 0,
		};
	}

	async writeChunk(data: StoredChunkData): Promise<void> {
		this.assertActive();

		const key = packChunkKeyFast(data.chunkX, data.chunkY, data.chunkZ);
		return this.queueChunkMutation(key, () => this.writeChunkUnlocked(data));
	}

	private async writeChunkUnlocked(data: StoredChunkData): Promise<void> {
		const key = packChunkKeyFast(data.chunkX, data.chunkY, data.chunkZ);
		const paletteArr = data.palette ? Uint16Array.from(data.palette) : null;

		const blob = serializeVoxelData(
			data.blocks,
			paletteArr,
			data.isUniform,
			data.uniformBlockId,
			data.light,
			false,
			data.version,
		);

		await this.store.writeChunk(data.chunkX, data.chunkY, data.chunkZ, blob);

		this.addToCache(key, data);
		this.dirtyChunks.add(key);
		this.scheduleFlush();
	}

	async applyBlockEdits(
		cx: number,
		cy: number,
		cz: number,
		edits: Iterable<BlockEdit>,
	): Promise<void> {
		const editArr = Array.isArray(edits) ? edits : [...edits];
		if (editArr.length === 0) return;

		this.assertActive();

		const key = packChunkKeyFast(cx, cy, cz);
		return this.queueChunkMutation(key, () =>
			this.applyBlockEditsUnlocked(cx, cy, cz, editArr),
		);
	}

	private async applyBlockEditsUnlocked(
		cx: number,
		cy: number,
		cz: number,
		edits: readonly BlockEdit[],
	): Promise<void> {
		const existing = await this.readChunkInternal(cx, cy, cz);
		if (!existing) return;

		const cx32 = cx << CHUNK_SHIFT;
		const cy32 = cy << CHUNK_SHIFT;
		const cz32 = cz << CHUNK_SHIFT;
		const maxX = cx32 + CHUNK_SIZE;
		const maxY = cy32 + CHUNK_SIZE;
		const maxZ = cz32 + CHUNK_SIZE;

		for (let i = 0; i < edits.length; i++) {
			const edit = edits[i];

			if (
				edit.x < cx32 ||
				edit.x >= maxX ||
				edit.y < cy32 ||
				edit.y >= maxY ||
				edit.z < cz32 ||
				edit.z >= maxZ
			) {
				throw new Error(
					`Edit for (${edit.x},${edit.y},${edit.z}) ` +
						`is outside chunk (${cx},${cy},${cz})`,
				);
			}

			if (!isValidBlockId(edit.blockId)) {
				throw new Error(
					`Invalid block ID ${edit.blockId} for edit ` +
						`(${edit.x},${edit.y},${edit.z})`,
				);
			}

			const state = edit.blockState ?? 0;
			if (!isValidBlockState(state)) {
				throw new Error(
					`Invalid block state ${state} for edit ` +
						`(${edit.x},${edit.y},${edit.z})`,
				);
			}
		}

		const decomp = decompressBlocks({
			data: existing.blocks,
			palette: existing.palette,
			isUniform: existing.isUniform,
			uniformBlockId: existing.uniformBlockId,
		});

		try {
			// Copy when the decompressed buffer aliases the cached chunk data so
			// the mutation below never touches the live cache entry.
			let blocks: Uint8Array | Uint16Array =
				decomp === existing.blocks ? decomp.slice() : decomp;

			// Entries hold packed id|state values. Widen to u16 when any edit
			// introduces a value above 255 — any nonzero shape state qualifies
			// (state << 10), as does a block id above 255.
			let needsWide = blocks instanceof Uint16Array;
			if (!needsWide) {
				for (let i = 0; i < edits.length; i++) {
					if (
						packBlockValue(edits[i].blockId, edits[i].blockState ?? 0) > 255
					) {
						needsWide = true;
						break;
					}
				}
				if (needsWide) {
					const upgraded = new Uint16Array(CHUNK_VOLUME);
					upgraded.set(blocks);
					blocks = upgraded;
				}
			}

			for (let i = 0; i < edits.length; i++) {
				const edit = edits[i];
				const idx =
					edit.x -
					cx32 +
					((edit.y - cy32) << CHUNK_SHIFT) +
					((edit.z - cz32) << 10);

				blocks[idx] = packBlockValue(edit.blockId, edit.blockState ?? 0);
			}

			const compressed = compressBlocks(blocks);

			if (compressed.data === blocks) {
				compressed.data = blocks.slice();
			}

			let newLight = existing.light;
			if (this.worldGen) {
				const result = await this.relightEditedChunk(cx, cy, cz, blocks, edits);
				newLight = result;
			}

			const baseVersion = existing.version > 0 ? existing.version : 1;
			const newVersion = baseVersion + 1;

			if (DEBUG_ENABLED) {
				debugLog(
					`[ServerWorldStorage] applyBlockEdits ${cx},${cy},${cz}: ` +
						`version ${existing.version} (base ${baseVersion}) -> ${newVersion}`,
				);
			}

			await this.writeChunkUnlocked({
				chunkX: cx,
				chunkY: cy,
				chunkZ: cz,
				blocks: compressed.data,
				light: newLight,
				palette: compressed.palette,
				isUniform: compressed.isUniform,
				uniformBlockId: compressed.uniformBlockId,
				version: newVersion,
			});
		} finally {
			releaseDecompBuffer(decomp);
		}
	}

	/**
	 * Recompute authoritative light after block edits.
	 *
	 * Relights the edited chunk AND every face-adjacent chunk whose lighting
	 * the edits can reach (max light radius 15 < chunk width 32, so direct
	 * neighbors suffice):
	 *
	 * - Per-column sky masks are derived from the stored chunks ABOVE each
	 *   relit chunk, replacing the old every-column-sunlit assumption that
	 *   flooded underground chunks with skylight.
	 * - Neighbors' border light values seed the BFS, so torch glow and lateral
	 *   skylight flow across chunk boundaries instead of stopping dead.
	 * - Both nibbles come from the fresh computation — the previous
	 *   "keep old sky nibble" merge froze pre-edit shadows/brightness in
	 *   place, one cause of visible light resets on client reload.
	 *
	 * Neighbors are persisted (version bumped) only when their light actually
	 * changed, so distant caches stay valid.
	 *
	 * Returns the edited chunk's new light array.
	 */
	private async relightEditedChunk(
		cx: number,
		cy: number,
		cz: number,
		editedBlocks: Uint8Array | Uint16Array,
		edits: readonly BlockEdit[],
	): Promise<Uint8Array> {
		const worldGen = this.worldGen;
		if (!worldGen) {
			return new Uint8Array(CHUNK_VOLUME);
		}

		// Decompression cache shared across this relight pass. Aliased buffers
		// (raw-stored chunks) are used read-only; freshly decompressed pooled
		// ones are tracked and returned to the pool afterwards.
		const denseCache = new Map<number, Uint8Array | Uint16Array | null>();
		const releasable: Uint8Array[] = [];

		try {
			const denseOf = async (
				nx: number,
				ny: number,
				nz: number,
			): Promise<Uint8Array | Uint16Array | null> => {
				const nKey = packChunkKeyFast(nx, ny, nz);
				const cached = denseCache.get(nKey);
				if (cached !== undefined) return cached;

				const stored = await this.readChunkInternal(nx, ny, nz);
				let dense: Uint8Array | Uint16Array | null = null;
				if (stored) {
					dense = decompressBlocks({
						data: stored.blocks,
						palette: stored.palette,
						isUniform: stored.isUniform,
						uniformBlockId: stored.uniformBlockId,
					});
					// Track only fresh pooled buffers — aliased buffers belong
					// to the live chunk cache and must never be recycled.
					if (dense !== stored.blocks && dense instanceof Uint8Array) {
						releasable.push(dense);
					}
				}

				denseCache.set(nKey, dense);
				return dense;
			};

			const lightOf = async (
				nx: number,
				ny: number,
				nz: number,
			): Promise<Uint8Array | null> => {
				const stored = await this.readChunkInternal(nx, ny, nz);
				const light = stored?.light;
				return light && light.length === CHUNK_VOLUME ? light : null;
			};

			// Border-seed arrays for (tx,ty,tz): the six face neighbors' light.
			const bordersOf = async (
				tx: number,
				ty: number,
				tz: number,
				overrideFace: number,
				overrideLight: Uint8Array | null,
			): Promise<(Uint8Array | null)[]> => {
				const faces: (Uint8Array | null)[] = [];
				for (let f = 0; f < 6; f++) {
					if (f === overrideFace) {
						faces.push(overrideLight);
						continue;
					}
					const [dx, dy, dz] = FACE_NORMALS[f];
					faces.push(await lightOf(tx + dx, ty + dy, tz + dz));
				}
				return faces;
			};

			// Local edit bounding box for the neighbor relevance gate.
			let minLx = 32,
				maxLx = -1,
				minLy = 32,
				maxLy = -1,
				minLz = 32,
				maxLz = -1;
			for (let i = 0; i < edits.length; i++) {
				const e = edits[i];
				const lx = e.x - cx * CHUNK_SIZE;
				const ly = e.y - cy * CHUNK_SIZE;
				const lz = e.z - cz * CHUNK_SIZE;
				if (lx < minLx) minLx = lx;
				if (lx > maxLx) maxLx = lx;
				if (ly < minLy) minLy = ly;
				if (ly > maxLy) maxLy = ly;
				if (lz < minLz) minLz = lz;
				if (lz > maxLz) maxLz = lz;
			}

			// Relight the edited chunk itself.
			const centerMask = await this.computeSunlightMask(
				cx,
				cy,
				cz,
				denseCache,
				releasable,
			);
			const centerBorders = await bordersOf(cx, cy, cz, -1, null);
			const centerLight = await worldGen.relightChunk(
				cx,
				cy,
				cz,
				buildRelightInput(editedBlocks),
				centerMask,
				centerBorders,
			);

			// Relight reachable neighbors with the edited chunk's NEW light
			// seeding the shared face. Light travels at most 15 steps, so an
			// edit influences a neighbor only when it sits within 15 blocks of
			// the shared plane.
			const MAX_REACH = 15;
			for (let face = 0; face < 6; face++) {
				const [dx, dy, dz] = FACE_NORMALS[face];

				// Relevance gate per face plane.
				if (face === 0 && maxLx < CHUNK_SIZE - MAX_REACH) continue;
				if (face === 1 && minLx > MAX_REACH - 1) continue;
				if (face === 2 && maxLy < CHUNK_SIZE - MAX_REACH) continue;
				if (face === 3 && minLy > MAX_REACH - 1) continue;
				if (face === 4 && maxLz < CHUNK_SIZE - MAX_REACH) continue;
				if (face === 5 && minLz > MAX_REACH - 1) continue;

				const nx = cx + dx;
				const ny = cy + dy;
				const nz = cz + dz;

				const stored = await this.readChunkInternal(nx, ny, nz);
				if (!stored) continue;

				const dense = await denseOf(nx, ny, nz);
				if (!dense) continue;

				const mask = await this.computeSunlightMask(
					nx,
					ny,
					nz,
					denseCache,
					releasable,
				);
				// From the neighbor's perspective, the edited chunk sits at
				// the opposite face.
				const borders = await bordersOf(nx, ny, nz, face ^ 1, centerLight);

				const relit = await worldGen.relightChunk(
					nx,
					ny,
					nz,
					buildRelightInput(dense),
					mask,
					borders,
				);

				// Persist only when the neighbor's light actually changed.
				const oldLight = stored.light;
				let changed = true;
				if (oldLight && oldLight.length === CHUNK_VOLUME) {
					changed = false;
					for (let i = 0; i < CHUNK_VOLUME; i++) {
						if (oldLight[i] !== relit[i]) {
							changed = true;
							break;
						}
					}
				}

				if (changed) {
					const baseVersion = stored.version > 0 ? stored.version : 1;
					await this.writeChunkUnlocked({
						chunkX: nx,
						chunkY: ny,
						chunkZ: nz,
						blocks: stored.blocks,
						light: relit,
						palette: stored.palette,
						isUniform: stored.isUniform,
						uniformBlockId: stored.uniformBlockId,
						version: baseVersion + 1,
					});

					if (DEBUG_ENABLED) {
						debugLog(
							`[ServerWorldStorage] neighbor relight ${nx},${ny},${nz} ` +
								`(edit at ${cx},${cy},${cz})`,
						);
					}
				}
			}

			return centerLight;
		} finally {
			for (const buf of releasable) {
				releaseDecompBuffer(buf);
			}
		}
	}

	/**
	 * Derive the per-column skylight mask for a chunk from the stored chunks
	 * above it: a column is sunlit only while every cell above it (up to a
	 * bounded walk) is transparent and does not filter full sunlight.
	 *
	 * Output uses the LightGenerator convention: 1 = column receives full
	 * incoming skylight at its top, 0 = blocked.
	 */
	private async computeSunlightMask(
		cx: number,
		cy: number,
		cz: number,
		denseCache: Map<number, Uint8Array | Uint16Array | null>,
		releasable: Uint8Array[],
	): Promise<Uint8Array> {
		const CS = CHUNK_SIZE;
		const CSSQ = CS * CS;
		const blocked = new Uint8Array(CSSQ); // 1 = a blocking cell found above
		let pending: number[] = [];
		for (let i = 0; i < CSSQ; i++) pending.push(i);

		const MAX_WALK = 16; // chunks above — well past the build ceiling

		await ensureClosedFaceMaskLUT();

		for (let step = 1; step <= MAX_WALK && pending.length > 0; step++) {
			const sy = cy + step;
			const key = packChunkKeyFast(cx, sy, cz);

			let dense = denseCache.get(key);
			if (dense === undefined) {
				const stored = await this.readChunkInternal(cx, sy, cz);

				// Nothing stored above → open sky for every remaining column.
				if (!stored) break;

				dense = decompressBlocks({
					data: stored.blocks,
					palette: stored.palette,
					isUniform: stored.isUniform,
					uniformBlockId: stored.uniformBlockId,
				});
				// Track fresh pooled buffers for release; aliased buffers
				// belong to the live chunk cache.
				if (dense !== stored.blocks && dense instanceof Uint8Array) {
					releasable.push(dense);
				}
				denseCache.set(key, dense);
			}

			// Cache entries are only populated with real arrays on this path;
			// a null would mean "no stored chunk", which broke out above.
			if (!dense) break;

			const stillPending: number[] = [];
			for (let p = 0; p < pending.length; p++) {
				const col = pending[p];
				const lx = col & (CS - 1);
				const lz = col >>> CHUNK_SHIFT;

				let isBlocked = false;
				for (let y = CS - 1; y >= 0; y--) {
					const packed = dense[lx + (y << CHUNK_SHIFT) + (lz << 10)];
					const id = unpackBlockId(packed);

					// Sun passes straight through a cell only if it is open at
					// BOTH its top and bottom face (shape-aware: a slab stops
					// the vertical column at its closed underside), and does
					// not filter full sunlight.
					const lut = LightGenerator.getClosedFaceMaskLUT();
					const passesVertically = lut
						? (lut[packed & 0xffff] & (FACE_PY | FACE_NY)) === 0
						: LightGenerator.isBlockTransparent(id);

					if (
						!passesVertically ||
						LightGenerator.blockFiltersFullSunlight(id)
					) {
						isBlocked = true;
						break;
					}
				}

				if (isBlocked) blocked[col] = 1;
				else stillPending.push(col);
			}

			pending = stillPending;
		}

		const mask = new Uint8Array(CSSQ);
		for (let i = 0; i < CSSQ; i++) {
			mask[i] = blocked[i] === 0 ? 1 : 0;
		}
		return mask;
	}

	private queueChunkMutation(
		key: number,
		operation: () => Promise<void>,
	): Promise<void> {
		const previous = this.chunkMutationQueues.get(key) ?? Promise.resolve();
		const current = previous.then(operation, operation);

		this.chunkMutationQueues.set(key, current);

		void current
			.finally(() => {
				if (this.chunkMutationQueues.get(key) === current) {
					this.chunkMutationQueues.delete(key);
				}
			})
			.catch(() => {});

		return current;
	}

	private lruDetach(node: CacheNode): void {
		const prev = node.prev;
		const next = node.next;

		if (prev) prev.next = next;
		else this.cacheHead = next;

		if (next) next.prev = prev;
		else this.cacheTail = prev;

		node.prev = null;
		node.next = null;
	}

	private lruPushFront(node: CacheNode): void {
		const head = this.cacheHead;

		node.prev = null;
		node.next = head;

		if (head) head.prev = node;
		else this.cacheTail = node;

		this.cacheHead = node;
	}

	private lruTouch(node: CacheNode): void {
		if (this.cacheHead === node) return;

		this.lruDetach(node);
		this.lruPushFront(node);
	}

	/**
	 * Update the live player positions used to pin near-player chunks in the
	 * cache. Called every room tick after player positions are collected.
	 * With no players, eviction falls back to plain LRU.
	 */
	setPlayerPositions(positions: ReadonlyArray<{ x: number; z: number }>): void {
		const target = this.playerPositions;
		target.length = 0;
		for (let i = 0; i < positions.length; i++) {
			const p = positions[i];
			target.push({ x: p.x, z: p.z });
		}
	}

	/**
	 * Pick a chunk to evict. Walks the LRU from the tail and returns the first
	 * node outside the protected radius of every player; falls back to the LRU
	 * tail when no non-protected node is found in the scan window (or there are
	 * no players). This keeps the near-player surface chunks the mob sim
	 * samples resident even while the client streams its large LOD shell.
	 */
	private findEvictCandidate(): CacheNode | null {
		const players = this.playerPositions;
		if (players.length === 0) return this.cacheTail;

		// Walk the whole list: the client streams nearest-first, so the
		// protected near-player chunks sit at the LRU tail and an early-exit
		// window would never reach the evictable far chunks at the head.
		let node = this.cacheTail;
		while (node) {
			const coords = unpackChunkKeyFast(node.key);
			const x = coords[0] * CHUNK_SIZE + (CHUNK_SIZE >> 1);
			const z = coords[2] * CHUNK_SIZE + (CHUNK_SIZE >> 1);

			let isProtected = false;
			for (let i = 0; i < players.length; i++) {
				const dx = x - players[i].x;
				const dz = z - players[i].z;
				if (dx * dx + dz * dz <= PLAYER_PROTECTED_RADIUS_SQ) {
					isProtected = true;
					break;
				}
			}

			if (!isProtected) return node;
			node = node.prev;
		}

		return this.cacheTail;
	}

	private addToCache(key: number, data: StoredChunkData): void {
		if (this.maxCacheSize <= 0) return;

		const existing = this.chunkCache.get(key);
		if (existing) {
			existing.data = data;
			existing.denseBlocks = null;
			this.lruTouch(existing);
			return;
		}

		if (this.chunkCache.size >= this.maxCacheSize) {
			const evict = this.findEvictCandidate();
			if (evict) {
				this.lruDetach(evict);
				this.chunkCache.delete(evict.key);

				// Help GC release any lazily materialized dense buffer promptly.
				evict.denseBlocks = null;
			}
		}

		const node: CacheNode = {
			key,
			data,
			denseBlocks: null,
			prev: null,
			next: null,
		};

		this.lruPushFront(node);
		this.chunkCache.set(key, node);
	}
	clearCache(): void {
		let node = this.cacheHead;
		while (node) {
			node.denseBlocks = null;
			node = node.next;
		}

		this.chunkCache.clear();
		this.cacheHead = null;
		this.cacheTail = null;
	}

	get cachedChunkCount(): number {
		return this.chunkCache.size;
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return;

		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;

			void this.flush().catch((error) => {
				console.error("[ServerWorldStorage] Scheduled flush failed:", error);

				if (!this.disposing && !this.disposed && this.dirtyChunks.size > 0) {
					this.scheduleFlush();
				}
			});
		}, FLUSH_DELAY_MS);
	}

	public flush(): Promise<void> {
		this.flushRequested = true;

		if (!this.flushPromise) {
			this.flushPromise = this.runFlushLoop().finally(() => {
				this.flushPromise = null;
			});
		}

		return this.flushPromise;
	}

	private async runFlushLoop(): Promise<void> {
		while (this.flushRequested || this.dirtyChunks.size > 0) {
			this.flushRequested = false;

			if (this.dirtyChunks.size === 0) continue;

			const flushing = this.dirtyChunks;
			this.dirtyChunks = new Set<number>();

			try {
				await this.store.flush();
			} catch (error) {
				for (const key of flushing) {
					this.dirtyChunks.add(key);
				}

				throw error;
			}
		}
	}

	get pendingWrites(): number {
		return this.dirtyChunks.size;
	}

	async savePlayerPosition(
		playerId: string,
		x: number,
		y: number,
		z: number,
		yaw: number,
		pitch: number,
	): Promise<void> {
		this.assertActive();

		if (
			!Number.isFinite(x) ||
			!Number.isFinite(y) ||
			!Number.isFinite(z) ||
			!Number.isFinite(yaw) ||
			!Number.isFinite(pitch)
		) {
			throw new TypeError("Cannot persist non-finite player position");
		}

		await this.store.setMeta(
			`player:${playerId}`,
			JSON.stringify({ x, y, z, yaw, pitch }),
		);
	}

	async loadPlayerPosition(
		playerId: string,
	): Promise<StoredPlayerPosition | null> {
		this.assertActive();

		const data = await this.store.getMeta(`player:${playerId}`);
		if (!data) return null;

		try {
			const parsed: unknown = JSON.parse(data);
			return this.isStoredPlayerPosition(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	/** Persist the world's default spawn point, generated once at creation. */
	async saveWorldSpawn(spawn: {
		x: number;
		y: number;
		z: number;
		yaw: number;
		pitch: number;
	}): Promise<void> {
		this.assertActive();
		await this.store.setMeta("spawn", JSON.stringify(spawn));
	}

	/**
	 * Load the world's default spawn point, or null if it has not been
	 * generated yet.
	 */
	async loadWorldSpawn(): Promise<{
		x: number;
		y: number;
		z: number;
		yaw: number;
		pitch: number;
	} | null> {
		this.assertActive();

		const data = await this.store.getMeta("spawn");
		if (!data) return null;

		try {
			const p = JSON.parse(data) as {
				x: number;
				y: number;
				z: number;
				yaw?: number;
				pitch?: number;
			};

			if (
				typeof p.x === "number" &&
				typeof p.y === "number" &&
				typeof p.z === "number"
			) {
				return {
					x: p.x,
					y: p.y,
					z: p.z,
					yaw: p.yaw ?? 0,
					pitch: p.pitch ?? 0,
				};
			}

			return null;
		} catch {
			return null;
		}
	}

	private isStoredPlayerPosition(
		value: unknown,
	): value is StoredPlayerPosition {
		if (typeof value !== "object" || value === null) return false;

		const p = value as Partial<StoredPlayerPosition>;
		return (
			Number.isFinite(p.x) &&
			Number.isFinite(p.y) &&
			Number.isFinite(p.z) &&
			Number.isFinite(p.yaw) &&
			Number.isFinite(p.pitch)
		);
	}

	/**
	 * Persist the mobs occupying a chunk column (x/z level). Stored durably
	 * under a per-column meta key and loaded back when the column is loaded
	 * near a player. Mobs that are persisted are not active, so they do not
	 * count toward the mob caps.
	 */
	async saveChunkMobs(
		cx: number,
		cz: number,
		mobs: PersistedMob[],
	): Promise<void> {
		this.assertActive();
		await this.store.setMeta(`mobcol:${cx}:${cz}`, JSON.stringify(mobs));
	}

	/** Load the mobs persisted for a chunk column (empty array if none). */
	async loadChunkMobs(cx: number, cz: number): Promise<PersistedMob[]> {
		this.assertActive();

		const data = await this.store.getMeta(`mobcol:${cx}:${cz}`);
		if (!data) return [];

		try {
			const parsed: unknown = JSON.parse(data);
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(isPersistedMob);
		} catch {
			return [];
		}
	}
}

function isPersistedMob(value: unknown): value is PersistedMob {
	if (typeof value !== "object" || value === null) return false;

	const m = value as Partial<PersistedMob>;
	return (
		typeof m.id === "number" &&
		typeof m.typeId === "number" &&
		Number.isFinite(m.x) &&
		Number.isFinite(m.y) &&
		Number.isFinite(m.z) &&
		typeof m.yaw === "number" &&
		typeof m.headingTimer === "number" &&
		typeof m.stuckTimer === "number" &&
		typeof m.fleeing === "boolean" &&
		Array.isArray(m.path) &&
		typeof m.pathIndex === "number" &&
		typeof m.pathTimer === "number" &&
		(m.egg === undefined || typeof m.egg === "boolean") &&
		(m.hp === undefined || (typeof m.hp === "number" && Number.isFinite(m.hp)))
	);
}
