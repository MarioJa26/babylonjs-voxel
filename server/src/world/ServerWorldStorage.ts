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
 * Safety:
 * - Per-chunk mutation queue serializes all writes to the same chunk.
 * - Flush operations are serialized; dirty state is preserved on failure.
 * - Disposal rejects new operations, waits for in-flight mutations, then flushes.
 * - Seed metadata is validated on init, not overwritten.
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
	readonly chunkX: number;
	readonly chunkY: number;
	readonly chunkZ: number;
	readonly blocks: Uint8Array;
	readonly light: Uint8Array;
	readonly palette?: readonly number[];
	readonly isUniform: boolean;
	readonly uniformBlockId: number;
	readonly hash: number;
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

const DEFAULT_CACHE_SIZE = 1024;

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

export class ServerWorldStorage {
	private store: LevelDbChunkStore;
	private dirtyChunks = new Set<number>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushPromise: Promise<void> | null = null;
	private flushRequested = false;
	private seed: string;

	private readonly chunkMutationQueues = new Map<number, Promise<void>>();

	private disposing = false;
	private disposed = false;

	private readonly pendingReads = new Map<
		number,
		Promise<StoredChunkData | null>
	>();

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
			throw new Error(
				`Unsupported world storage version: ${version}`,
			);
		}

		await this.store.flush();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		if (this.disposing) {
			throw new Error(
				"ServerWorldStorage disposal already in progress",
			);
		}

		this.disposing = true;

		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}

		try {
			while (this.chunkMutationQueues.size > 0) {
				const mutations = Array.from(
					this.chunkMutationQueues.values(),
				);
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
			this.chunkCache.clear();
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
		const cached = this.chunkCache.get(key);
		if (cached) {
			this.promoteInCache(key, cached);
			return cached;
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

		const newerCached = this.chunkCache.get(key);
		if (newerCached) {
			this.promoteInCache(key, newerCached);
			return newerCached;
		}

		const data = this.parseBlob(cx, cy, cz, blob);
		this.addToCache(key, data);
		return data;
	}

	async readChunks(
		coords: Array<{ cx: number; cy: number; cz: number }>,
	): Promise<Map<number, StoredChunkData>> {
		this.assertActive();

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
			const found = await this.store.readChunks(missCoords);

			let parsedSinceYield = 0;
			for (const { cx, cy, cz } of missCoords) {
				const storeKey = `${cx},${cy},${cz}`;
				const blob = found.get(storeKey);
				if (!blob) continue;

				const key = packChunkKeyFast(cx, cy, cz);
				const cached = this.chunkCache.get(key);
				if (cached) {
					results.set(key, cached);
					continue;
				}

				const data = this.parseBlob(cx, cy, cz, blob);
				this.addToCache(key, data);
				results.set(key, data);

				if (++parsedSinceYield >= 16) {
					parsedSinceYield = 0;
					await yieldToEventLoop();
				}
			}
		}

		return results;
	}

	private parseBlob(
		cx: number,
		cy: number,
		cz: number,
		blob: Uint8Array,
	): StoredChunkData {
		const value = deserializeVoxelData(blob);

		if (!value.blocks) {
			throw new Error(
				`Chunk ${cx},${cy},${cz} has no block data`,
			);
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

		const palette = value.palette
			? Array.from(value.palette)
			: undefined;

		const isUniform = value.isUniform ?? false;
		const uniformBlockId = value.uniformBlockId ?? 0;

		if (
			!Number.isInteger(uniformBlockId) ||
			uniformBlockId < 0 ||
			uniformBlockId > 255
		) {
			throw new Error(
				`Chunk ${cx},${cy},${cz} has invalid uniform block ID`,
			);
		}

		if (
			palette?.some(
				(id) => !Number.isInteger(id) || id < 0 || id > 255,
			)
		) {
			throw new Error(
				`Chunk ${cx},${cy},${cz} has an invalid palette`,
			);
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
			hash: hashChunk(blocks, light, palette),
		};
	}

	async writeChunk(data: StoredChunkData): Promise<void> {
		this.assertActive();

		const key = packChunkKeyFast(
			data.chunkX,
			data.chunkY,
			data.chunkZ,
		);
		return this.queueChunkMutation(key, () =>
			this.writeChunkUnlocked(data),
		);
	}

	private async writeChunkUnlocked(data: StoredChunkData): Promise<void> {
		const key = packChunkKeyFast(
			data.chunkX,
			data.chunkY,
			data.chunkZ,
		);

		const blob = serializeVoxelData(
			data.blocks,
			data.palette ? Uint16Array.from(data.palette) : null,
			data.isUniform,
			data.uniformBlockId,
			data.light,
			false,
		);

		await this.store.writeChunk(
			data.chunkX,
			data.chunkY,
			data.chunkZ,
			blob,
		);

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

		for (const edit of edits) {
			const expectedCx = Math.floor(edit.x / 32);
			const expectedCy = Math.floor(edit.y / 32);
			const expectedCz = Math.floor(edit.z / 32);
			if (
				expectedCx !== cx ||
				expectedCy !== cy ||
				expectedCz !== cz
			) {
				throw new Error(
					`Edit for (${edit.x},${edit.y},${edit.z}) ` +
						`targets chunk (${expectedCx},${expectedCy},${expectedCz}), ` +
						`not (${cx},${cy},${cz})`,
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

		for (const edit of edits) {
			const lx = edit.x & 31;
			const ly = edit.y & 31;
			const lz = edit.z & 31;
			const idx = lx + (ly << 5) + (lz << 10);
			if (idx < 0 || idx >= CHUNK_VOLUME) continue;
			blocks[idx] = edit.blockId;
		}

		const compressed = compressBlocks(blocks);
		const hash = hashChunk(
			compressed.data,
			existing.light,
			compressed.palette,
		);

		await this.writeChunkUnlocked({
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

	private queueChunkMutation(
		key: number,
		operation: () => Promise<void>,
	): Promise<void> {
		const previous =
			this.chunkMutationQueues.get(key) ?? Promise.resolve();
		const current = previous.then(
			() => operation(),
			() => operation(),
		);
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

	private promoteInCache(key: number, data: StoredChunkData): void {
		this.chunkCache.delete(key);
		this.chunkCache.set(key, data);
	}

	private addToCache(key: number, data: StoredChunkData): void {
		if (this.maxCacheSize <= 0) return;

		if (this.chunkCache.has(key)) {
			this.chunkCache.delete(key);
		} else if (this.chunkCache.size >= this.maxCacheSize) {
			const firstKey = this.chunkCache.keys().next().value;
			if (firstKey !== undefined) {
				this.chunkCache.delete(firstKey);
			}
		}
		this.chunkCache.set(key, data);
	}

	clearCache(): void {
		this.chunkCache.clear();
	}

	get cachedChunkCount(): number {
		return this.chunkCache.size;
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return;

		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flush().catch((error) => {
				console.error(
					"[ServerWorldStorage] Scheduled flush failed:",
					error,
				);
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
			throw new TypeError(
				"Cannot persist non-finite player position",
			);
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
