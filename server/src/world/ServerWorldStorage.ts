/**
 * ServerWorldStorage — LevelDB-backed chunk storage for the server.
 *
 * Stores full chunk data (blocks + light) using the same VoxelSerializer
 * blob format as singleplayer. On startup, the server checks stored chunks
 * first before generating new ones — terrain persists across restarts.
 *
 * Optimizations:
 * - In-memory LRU cache of deserialized chunks (hash precomputed once),
 *   backed by an intrusive doubly-linked list. Touching an entry on a
 *   cache hit is a pointer relink (no hashing); eviction pops the tail
 *   directly (no iterator allocation). This avoids the delete+re-insert
 *   churn a plain Map-based LRU incurs on every hit, which otherwise
 *   costs two hash operations per touch and lets V8's backing store grow
 *   past its logical size before it compacts.
 * - applyBlockEdits() applies world-coord block edits to a stored chunk
 *   so player changes persist to disk (replaces the old flat edit-log).
 *
 * Safety:
 * - Per-chunk mutation queue serializes all writes to the same chunk.
 * - Flush operations are serialized; dirty state is preserved on failure.
 * - Disposal rejects new operations, waits for in-flight mutations, then flushes.
 * - Seed metadata is validated on init, not overwritten.
 * - readChunks() allocates a fresh result Map per call so concurrent
 *   in-flight calls never share (and corrupt) each other's results.
 */

import { debugLog } from "@/code/Lib/debugLog";
import { hashChunk } from "@/code/Network/protocol/encoder.ts";
import { packChunkKeyFast } from "@/code/World/Storage/ChunkKey.ts";
import { LevelDbChunkStore } from "@/code/World/Storage/LevelDbChunkStore";
import {
	deserializeVoxelData,
	serializeVoxelData,
} from "@/code/World/Storage/VoxelSerializer";
import { compressBlocks, decompressBlocks } from "./ChunkCompression.ts";
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
	readonly hash: number;
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

const DEFAULT_CACHE_SIZE = 1024;
// The blob cache in LevelDbChunkStore is redundant with this class's parsed
// cache (same chunks, both in memory). A small cap keeps the double-cached
// footprint low — serialized blobs are cheap to re-read from LevelDB.
const DEFAULT_BLOB_CACHE_SIZE = 128;

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

export class ServerWorldStorage {
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

	// LRU cache: Map gives O(1) key lookup, the intrusive doubly-linked
	// list gives O(1) touch/evict without ever deleting+re-inserting into
	// the Map on a cache hit.
	private readonly chunkCache = new Map<number, CacheNode>();
	private cacheHead: CacheNode | null = null; // most recently used
	private cacheTail: CacheNode | null = null; // least recently used
	private readonly maxCacheSize: number;
	// Scratch for writeChunkUnlocked: serializeVoxelData copies palette
	// bytes synchronously, so one reused buffer is safe for all writers.
	private readonly paletteScratch = new Uint16Array(256);
	// Free list for readChunks() missCoords entry objects. Each call pops its
	// own entries (exclusive ownership per call) and returns them in a
	// finally, so concurrent readChunks() calls can never observe each
	// other's entries. The pool is bounded by peak concurrent misses (≤128
	// per request).
	private readonly missCoordPool: Array<{
		cx: number;
		cy: number;
		cz: number;
		cacheKey: number;
		key: string;
	}> = [];

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
				for (const result of results) {
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

		const key = packChunkKeyFast(cx, cy, cz);
		const node = this.chunkCache.get(key);
		if (node) {
			this.lruTouch(node);
			return node.data;
		}

		const pending = this.pendingReads.get(key);
		if (pending) return pending;

		const promise = this.readChunkFromStore(key, cx, cy, cz);
		this.pendingReads.set(key, promise);

		void promise.then(
			() => {
				if (this.pendingReads.get(key) === promise) {
					this.pendingReads.delete(key);
				}
			},
			() => {
				if (this.pendingReads.get(key) === promise) {
					this.pendingReads.delete(key);
				}
			},
		);

		return promise;
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

		const data = await this.parseBlob(cx, cy, cz, blob);
		this.addToCache(key, data);
		return data;
	}

	async readChunks(
		coords: Array<{ cx: number; cy: number; cz: number }>,
	): Promise<Map<number, StoredChunkData>> {
		this.assertActive();

		// Allocated fresh per call: sharing a single reused Map across
		// concurrent readChunks() calls would let one caller's clear()
		// wipe out another in-flight caller's results.
		const results = new Map<number, StoredChunkData>();
		const missCoords: Array<{
			cx: number;
			cy: number;
			cz: number;
			cacheKey: number;
			key: string;
		}> = [];

		try {
			for (const { cx, cy, cz } of coords) {
				const cacheKey = packChunkKeyFast(cx, cy, cz);
				const node = this.chunkCache.get(cacheKey);
				if (node) {
					this.lruTouch(node);
					results.set(cacheKey, node.data);
				} else {
					// key is passed through to LevelDbChunkStore.readChunks,
					// which skips recomputing the identical template string.
					// Entries come from the pool (owned exclusively by this
					// call) instead of a fresh object per miss.
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
			}

			if (missCoords.length > 0) {
				// missCoords already has {cx, cy, cz, key} on every element, so
				// it can be passed straight through — no need to .map() it into
				// a second throwaway array first, and the precomputed key
				// strings are reused instead of rebuilt.
				const found = await this.store.readChunks(missCoords);

				let parsedSinceYield = 0;
				for (const { cacheKey, key, cx, cy, cz } of missCoords) {
					const blob = found.get(key);
					if (!blob) continue;

					const node = this.chunkCache.get(cacheKey);
					if (node) {
						this.lruTouch(node);
						results.set(cacheKey, node.data);
						continue;
					}

					const data = await this.parseBlob(cx, cy, cz, blob);
					this.addToCache(cacheKey, data);
					results.set(cacheKey, data);

					if (++parsedSinceYield >= 16) {
						parsedSinceYield = 0;
						await yieldToEventLoop();
					}
				}
			}

			return results;
		} finally {
			// Return every entry to the pool. Runs on success, failure, and
			// disposal alike; each entry is rewritten on the next acquire.
			for (let i = missCoords.length - 1; i >= 0; i--) {
				this.missCoordPool.push(missCoords[i]);
			}
		}
	}

	private async parseBlob(
		cx: number,
		cy: number,
		cz: number,
		blob: Uint8Array,
	): Promise<StoredChunkData> {
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

		const palette: number[] | undefined = value.palette
			? Array.from(value.palette)
			: undefined;

		const isUniform = value.isUniform ?? false;
		const uniformBlockId = value.uniformBlockId ?? 0;

		if (
			!Number.isInteger(uniformBlockId) ||
			uniformBlockId < 0 ||
			uniformBlockId > 255
		) {
			throw new Error(`Chunk ${cx},${cy},${cz} has invalid uniform block ID`);
		}

		if (palette && !isValidPalette(palette)) {
			throw new Error(`Chunk ${cx},${cy},${cz} has an invalid palette`);
		}

		const version = value.version ?? 0;

		return {
			chunkX: cx,
			chunkY: cy,
			chunkZ: cz,
			blocks,
			light,
			palette,
			isUniform,
			uniformBlockId,
			hash: hashChunk(blocks, light, palette),
			version,
		};
	}

	async writeChunk(data: StoredChunkData): Promise<void> {
		this.assertActive();

		const key = packChunkKeyFast(data.chunkX, data.chunkY, data.chunkZ);
		return this.queueChunkMutation(key, () => this.writeChunkUnlocked(data));
	}

	private async writeChunkUnlocked(data: StoredChunkData): Promise<void> {
		const key = packChunkKeyFast(data.chunkX, data.chunkY, data.chunkZ);

		let paletteArr: Uint16Array | null = null;
		if (data.palette) {
			const scratch = this.paletteScratch;
			for (let i = 0; i < data.palette.length; i++) {
				scratch[i] = data.palette[i];
			}
			paletteArr = scratch.subarray(0, data.palette.length);
		}

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
		edits: readonly BlockEdit[],
	): Promise<void> {
		if (edits.length === 0) return;
		this.assertActive();

		const key = packChunkKeyFast(cx, cy, cz);
		return this.queueChunkMutation(key, () =>
			this.applyBlockEditsUnlocked(cx, cy, cz, edits),
		);
	}

	private async applyBlockEditsUnlocked(
		cx: number,
		cy: number,
		cz: number,
		edits: readonly BlockEdit[],
	): Promise<void> {
		const existing = await this.readChunk(cx, cy, cz);
		if (!existing) return;

		const cx32 = cx << 5;
		const cy32 = cy << 5;
		const cz32 = cz << 5;

		// Validate every edit before mutating anything, so a bad edit
		// can't leave the decompressed block array half-applied.
		for (let i = 0; i < edits.length; i++) {
			const edit = edits[i];
			if (
				edit.x < cx32 ||
				edit.x >= cx32 + 32 ||
				edit.y < cy32 ||
				edit.y >= cy32 + 32 ||
				edit.z < cz32 ||
				edit.z >= cz32 + 32
			) {
				throw new Error(
					`Edit for (${edit.x},${edit.y},${edit.z}) ` +
						`is outside chunk (${cx},${cy},${cz})`,
				);
			}
		}

		let blocks = decompressBlocks({
			data: existing.blocks,
			palette: existing.palette,
			isUniform: existing.isUniform,
			uniformBlockId: existing.uniformBlockId,
		});
		if (blocks === existing.blocks) {
			blocks = new Uint8Array(blocks);
		}

		for (let i = 0; i < edits.length; i++) {
			const edit = edits[i];
			const idx =
				edit.x - cx32 + ((edit.y - cy32) << 5) + ((edit.z - cz32) << 10);
			blocks[idx] = edit.blockId;
		}

		const compressed = compressBlocks(blocks);

		// Recalculate light from scratch so emission sources (torches, etc.)
		// placed by players propagate correctly to all clients.
		let newLight = existing.light;
		if (this.worldGen) {
			newLight = await this.worldGen.relightChunk(cx, cy, cz, blocks);
		}

		const hash = hashChunk(compressed.data, newLight, compressed.palette);
		const baseVersion = existing.version > 0 ? existing.version : 1;
		const newVersion = baseVersion + 1;
		debugLog(
			`[ServerWorldStorage] applyBlockEdits ${cx},${cy},${cz}: version ${existing.version} (base ${baseVersion}) -> ${newVersion}`,
		);

		await this.writeChunkUnlocked({
			chunkX: cx,
			chunkY: cy,
			chunkZ: cz,
			blocks: compressed.data,
			light: newLight,
			palette: compressed.palette,
			isUniform: compressed.isUniform,
			uniformBlockId: compressed.uniformBlockId,
			hash,
			version: newVersion,
		});
	}

	private queueChunkMutation(
		key: number,
		operation: () => Promise<void>,
	): Promise<void> {
		const previous = this.chunkMutationQueues.get(key) ?? Promise.resolve();
		// operation() ignores its argument, so it can be used directly as
		// both the fulfilled and rejected handler — no extra wrapper
		// closures allocated per mutation.
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

	// --- LRU cache helpers -------------------------------------------------

	private lruDetach(node: CacheNode): void {
		const { prev, next } = node;
		if (prev) prev.next = next;
		else this.cacheHead = next;
		if (next) next.prev = prev;
		else this.cacheTail = prev;
		node.prev = null;
		node.next = null;
	}

	private lruPushFront(node: CacheNode): void {
		node.prev = null;
		node.next = this.cacheHead;
		if (this.cacheHead) this.cacheHead.prev = node;
		this.cacheHead = node;
		if (!this.cacheTail) this.cacheTail = node;
	}

	private lruTouch(node: CacheNode): void {
		if (this.cacheHead === node) return;
		this.lruDetach(node);
		this.lruPushFront(node);
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
			const evict = this.cacheTail;
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

	// -------------------------------------------------------------------

	private scheduleFlush(): void {
		if (this.flushTimer) return;

		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flush().catch((error) => {
				console.error("[ServerWorldStorage] Scheduled flush failed:", error);
			});
		}, 500);
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

		const data = JSON.stringify({ x, y, z, yaw, pitch });
		await this.store.setMeta(`player:${playerId}`, data);
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
