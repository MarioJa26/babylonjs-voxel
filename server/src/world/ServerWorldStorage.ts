/**
 * ServerWorldStorage — LevelDB-backed chunk storage for the server.
 *
 * Stores full chunk data (blocks + light) using the same VoxelSerializer
 * blob format as singleplayer. On startup, the server checks stored chunks
 * first before generating new ones — terrain persists across restarts.
 *
 * Optimizations:
 * - In-memory LRU cache of deserialized chunks (hash precomputed once).
 *   Repeated requests hit the cache: no disk I/O, no deserialize, no hash.
 * - applyBlockEdits() applies world-coord block edits to a stored chunk
 *   so player changes persist to disk (replaces the old flat edit-log).
 *
 * Replaces the old flat JSON edit-log approach. Block edits are now saved
 * as full chunk snapshots, so changing the server.properties seed requires
 * manually deleting the world folder (server-data/worlds/<name>/db/).
 */

import { hashChunk } from "@/code/Network/protocol/encoder.ts";
import { packChunkKeyFast } from "@/code/World/Storage/ChunkKey.ts";
import { LevelDbChunkStore } from "@/code/World/Storage/LevelDbChunkStore";
import {
	deserializeVoxelData,
	serializeVoxelData,
} from "@/code/World/Storage/VoxelSerializer";
import {
	CHUNK_VOLUME,
	compressBlocks,
	decompressBlocks,
} from "./ChunkCompression.ts";

export interface StoredChunkData {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	blocks: Uint8Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
	hash: number;
}

export interface BlockEdit {
	x: number;
	y: number;
	z: number;
	blockId: number;
}

const DEFAULT_CACHE_SIZE = 1024;

export class ServerWorldStorage {
	private store: LevelDbChunkStore;
	// Keyed by packChunkKey(cx,cy,cz) — internal to this class only, so it's
	// safe to use the packed numeric key here regardless of what key format
	// LevelDbChunkStore uses internally (see readChunks() below, which keeps
	// that boundary on the original string format on purpose).
	private dirtyChunks = new Set<number>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushPending = false;
	private seed: string;

	// LRU cache of finalized chunk data (hash precomputed). Keyed by packed
	// coord. Map iteration order is insertion order, so a cache *hit* now
	// deletes+re-inserts the entry to move it to the "most recent" end —
	// previously this only ever appended on miss and evicted from the front,
	// which is FIFO behavior, not LRU, despite the name/comment.
	private readonly chunkCache = new Map<number, StoredChunkData>();
	private readonly maxCacheSize: number;

	constructor(
		worldName: string,
		seed: string,
		basePath = "./server-data",
		maxCacheSize = DEFAULT_CACHE_SIZE,
	) {
		this.seed = seed;
		this.store = new LevelDbChunkStore(worldName, basePath);
		this.maxCacheSize = maxCacheSize;
	}

	async init(): Promise<void> {
		await this.store.open();
		await this.store.setMeta("seed", this.seed);
		await this.store.setMeta("version", "1");
	}

	async dispose(): Promise<void> {
		await this.store.close();
		this.chunkCache.clear();
	}

	/**
	 * Read a chunk from storage. Returns null if not found (needs generation).
	 * Serves from the in-memory cache when available — no disk or deserialize.
	 */
	async readChunk(
		cx: number,
		cy: number,
		cz: number,
	): Promise<StoredChunkData | null> {
		const key = packChunkKeyFast(cx, cy, cz);

		const cached = this.chunkCache.get(key);
		if (cached) {
			this.promoteInCache(key, cached);
			return cached;
		}

		const blob = await this.store.readChunk(cx, cy, cz);
		if (!blob) return null;

		const data = this.parseBlob(cx, cy, cz, blob);
		this.addToCache(key, data);
		return data;
	}

	/**
	 * Read many chunks in parallel (bulk disk path). Returns a map of
	 * packChunkKey(cx,cy,cz) → chunk for those that exist.
	 *
	 * Disk reads are parallel via Promise.all. Deserialization is also
	 * parallelized — each blob is parsed in its own microtask so the main
	 * thread is not blocked for the entire batch.
	 */
	async readChunks(
		coords: Array<{ cx: number; cy: number; cz: number }>,
	): Promise<Map<number, StoredChunkData>> {
		const results = new Map<number, StoredChunkData>();
		const missCoords: typeof coords = [];

		for (const { cx, cy, cz } of coords) {
			const key = packChunkKeyFast(cx, cy, cz);
			const cached = this.chunkCache.get(key);
			if (cached) {
				this.promoteInCache(key, cached);
				results.set(key, cached);
			} else {
				missCoords.push({ cx, cy, cz });
			}
		}

		if (missCoords.length > 0) {
			// NOTE: `found` is returned by LevelDbChunkStore and keyed with
			// its own internal "cx,cy,cz" string convention — that's a
			// different module we don't control, so the lookup below
			// intentionally keeps building that exact string rather than
			// switching to packChunkKey (which is only valid for the local
			// chunkCache/results maps in this file).
			const found = await this.store.readChunks(missCoords);

			// Parse all blobs concurrently — each parseBlob runs in its own
			// microtask so the main thread stays responsive during large batches.
			const parsePromises: Promise<void>[] = [];
			for (const { cx, cy, cz } of missCoords) {
				const storeKey = `${cx},${cy},${cz}`;
				const blob = found.get(storeKey);
				if (!blob) continue;
				const key = packChunkKeyFast(cx, cy, cz);
				parsePromises.push(
					Promise.resolve().then(() => {
						const data = this.parseBlob(cx, cy, cz, blob);
						this.addToCache(key, data);
						results.set(key, data);
					}),
				);
			}
			await Promise.all(parsePromises);
		}

		return results;
	}

	private parseBlob(
		cx: number,
		cy: number,
		cz: number,
		blob: Uint8Array,
	): StoredChunkData {
		const deserialized = deserializeVoxelData(blob);
		const rawBlocks = deserialized.blocks;
		const blocksU8 =
			rawBlocks instanceof Uint8Array
				? rawBlocks
				: rawBlocks
					? new Uint8Array(
							rawBlocks.buffer,
							rawBlocks.byteOffset,
							rawBlocks.byteLength,
						)
					: new Uint8Array(0);
		const light = deserialized.lightArray ?? new Uint8Array(0);
		const palette = deserialized.palette
			? Array.from(deserialized.palette)
			: undefined;
		return {
			chunkX: cx,
			chunkY: cy,
			chunkZ: cz,
			blocks: blocksU8,
			light,
			palette,
			isUniform: deserialized.isUniform ?? false,
			uniformBlockId: deserialized.uniformBlockId ?? 0,
			hash: hashChunk(blocksU8, light, palette),
		};
	}

	/**
	 * Write a chunk to storage (debounced) and keep it in the in-memory cache.
	 * Call flush() to persist immediately.
	 */
	writeChunk(data: StoredChunkData): void {
		const key = packChunkKeyFast(data.chunkX, data.chunkY, data.chunkZ);
		this.addToCache(key, data);

		// Don't pre-compress — LevelDB compresses with Snappy internally.
		const blob = serializeVoxelData(
			data.blocks,
			data.palette ? Uint16Array.from(data.palette) : null,
			data.isUniform,
			data.uniformBlockId,
			data.light,
			false,
		);
		this.store.writeChunk(data.chunkX, data.chunkY, data.chunkZ, blob);

		this.dirtyChunks.add(key);
		this.scheduleFlush();
	}

	/**
	 * Apply world-coord block edits to a stored chunk and write it back.
	 * Resolves the chunk from the cache or disk, decompresses, applies the
	 * edits (last write wins per voxel), re-compresses and re-serializes.
	 * Chunks that don't exist in storage (never generated) are ignored.
	 */
	async applyBlockEdits(
		cx: number,
		cy: number,
		cz: number,
		edits: BlockEdit[],
	): Promise<void> {
		if (edits.length === 0) return;

		const existing = await this.readChunk(cx, cy, cz);
		if (!existing) return;

		let blocks = decompressBlocks({
			data: existing.blocks,
			palette: existing.palette,
			isUniform: existing.isUniform,
			uniformBlockId: existing.uniformBlockId,
		});
		// Raw chunks view the blob buffer (shared with the store's blob cache) —
		// never mutate in place; copy first.
		if (blocks === existing.blocks) {
			blocks = new Uint8Array(blocks);
		}

		for (const edit of edits) {
			// 32 is a power of two, so a mask (&31) gives the same
			// non-negative local coordinate as ((x % 32) + 32) % 32 for both
			// positive and negative inputs, in one op instead of three.
			const lx = edit.x & 31;
			const ly = edit.y & 31;
			const lz = edit.z & 31;
			const idx = lx + (ly << 5) + (lz << 10);
			if (idx < 0 || idx >= CHUNK_VOLUME) continue;
			blocks[idx] = edit.blockId;
		}

		const compressed = compressBlocks(blocks);
		const hash = hashChunk(compressed.data, existing.light, compressed.palette);

		this.writeChunk({
			chunkX: cx,
			chunkY: cy,
			chunkZ: cz,
			blocks: compressed.data,
			light: existing.light,
			palette: compressed.palette,
			isUniform: compressed.isUniform,
			uniformBlockId: compressed.uniformBlockId,
			hash,
		});
	}

	/** Move an existing cache entry to the most-recently-used position. */
	private promoteInCache(key: number, data: StoredChunkData): void {
		this.chunkCache.delete(key);
		this.chunkCache.set(key, data);
	}

	private addToCache(key: number, data: StoredChunkData): void {
		if (
			this.chunkCache.size >= this.maxCacheSize &&
			!this.chunkCache.has(key)
		) {
			const firstKey = this.chunkCache.keys().next().value;
			if (firstKey !== undefined) {
				this.chunkCache.delete(firstKey);
			}
		}
		this.chunkCache.set(key, data);
	}

	/** Evict a chunk from the in-memory cache (e.g. seed change). */
	clearCache(): void {
		this.chunkCache.clear();
	}

	get cachedChunkCount(): number {
		return this.chunkCache.size;
	}

	private scheduleFlush(): void {
		if (this.flushPending) return;
		this.flushPending = true;
		this.flushTimer = setTimeout(() => {
			void this.doFlush();
		}, 500);
	}

	private async doFlush(): Promise<void> {
		this.flushPending = false;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.dirtyChunks.clear();
		await this.store.flush();
	}

	/**
	 * Immediately flush all pending writes.
	 */
	async flush(): Promise<void> {
		await this.doFlush();
	}

	get pendingWrites(): number {
		return this.dirtyChunks.size;
	}

	// ── Player position persistence ──────────────────────────────────────

	async savePlayerPosition(
		sessionId: string,
		x: number,
		y: number,
		z: number,
		yaw: number,
		pitch: number,
	): Promise<void> {
		const data = JSON.stringify({ x, y, z, yaw, pitch });
		await this.store.setMeta(`player:${sessionId}`, data);
	}

	async loadPlayerPosition(sessionId: string): Promise<{
		x: number;
		y: number;
		z: number;
		yaw: number;
		pitch: number;
	} | null> {
		const data = await this.store.getMeta(`player:${sessionId}`);
		if (!data) return null;
		try {
			return JSON.parse(data);
		} catch {
			return null;
		}
	}
}
