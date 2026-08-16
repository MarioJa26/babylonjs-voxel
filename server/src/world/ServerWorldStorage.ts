/**
 * ServerWorldStorage — LevelDB-backed chunk storage for the server.
 *
 * Stores full chunk data using the same VoxelSerializer blob format as
 * singleplayer. On startup, stored chunks are checked before generation so
 * terrain persists across restarts.
 */

import { DEBUG_ENABLED, debugLog } from "@/code/Lib/debugLog";
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
	releaseDecompBuffer,
} from "./ChunkCompression.ts";
import type { ChunkGenerationService } from "./ChunkGenerationService.ts";

export interface StoredChunkData {
	readonly chunkX: number;
	readonly chunkY: number;
	readonly chunkZ: number;
	readonly blocks: Uint8Array;
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

const DEFAULT_CACHE_SIZE = 1024;
const DEFAULT_BLOB_CACHE_SIZE = 128;

const CHUNK_SIZE = 32;
const CHUNK_SHIFT = 5;
const WATER_BLOCK_ID = 30;
const FLUSH_DELAY_MS = 500;

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

/** Validates that every palette entry is an integer block id in [0, 255]. */
function isValidPalette(palette: number[] | Uint16Array): boolean {
	for (let i = 0; i < palette.length; i++) {
		const id = palette[i];
		if (!Number.isInteger(id) || id < 0 || id > 255) return false;
	}
	return true;
}

function isValidBlockId(id: number): boolean {
	return Number.isInteger(id) && id >= 0 && id <= 255;
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
					const id = blocks[columnBase + (localY << CHUNK_SHIFT)];
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
	 * For raw (uncompressed) chunks the stored buffer itself is returned
	 * (no copy); for uniform/palette chunks a pooled or fresh buffer is
	 * materialized. The caller must not retain the result across ticks and
	 * must not mutate it.
	 *
	 * Chunks near players are virtually always cached — the client just
	 * requested them — so the mob sim stays fully synchronous and cheap.
	 */
	getCachedChunkBlocks(cx: number, cy: number, cz: number): Uint8Array | null {
		if (this.disposing || this.disposed) return null;

		const node = this.chunkCache.get(packChunkKeyFast(cx, cy, cz));
		if (!node) return null;

		const c = node.data;
		if (c.isUniform) {
			const out = new Uint8Array(CHUNK_VOLUME);
			out.fill(c.uniformBlockId);
			return out;
		}

		return decompressBlocks({
			data: c.blocks,
			palette: c.palette,
			isUniform: c.isUniform,
			uniformBlockId: c.uniformBlockId,
		});
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

		const blocks =
			value.blocks instanceof Uint8Array
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

		if (!isValidBlockId(uniformBlockId)) {
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
		}

		const decomp = decompressBlocks({
			data: existing.blocks,
			palette: existing.palette,
			isUniform: existing.isUniform,
			uniformBlockId: existing.uniformBlockId,
		});

		try {
			const blocks =
				decomp === existing.blocks ? new Uint8Array(decomp) : decomp;

			for (let i = 0; i < edits.length; i++) {
				const edit = edits[i];
				const idx =
					edit.x -
					cx32 +
					((edit.y - cy32) << CHUNK_SHIFT) +
					((edit.z - cz32) << 10);

				blocks[idx] = edit.blockId;
			}

			const compressed = compressBlocks(blocks);

			if (compressed.data === blocks) {
				compressed.data = new Uint8Array(blocks);
			}

			let newLight = existing.light;
			if (this.worldGen) {
				const relit = await this.worldGen.relightChunk(cx, cy, cz, blocks);
				const existingLight = existing.light;

				for (let i = 0; i < relit.length; i++) {
					relit[i] = (relit[i] & 0x0f) | (existingLight[i] & 0xf0);
				}

				newLight = relit;
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
			this.lruTouch(existing);
			return;
		}

		if (this.chunkCache.size >= this.maxCacheSize) {
			const evict = this.findEvictCandidate();
			if (evict) {
				this.lruDetach(evict);
				this.chunkCache.delete(evict.key);
			}
		}

		const node: CacheNode = { key, data, prev: null, next: null };
		this.lruPushFront(node);
		this.chunkCache.set(key, node);
	}

	clearCache(): void {
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
}
