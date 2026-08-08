/**
 * LevelDbChunkStore — Unified LevelDB storage for browser and server.
 *
 * Uses the `level` package which auto-detects the environment:
 * - Node.js: native LevelDB (fast, file-based)
 * - Browser: level-js (IndexedDB-backed)
 *
 * Same API, same serialization, same code path. The only difference is
 * the backend — LevelDB on disk vs IndexedDB in the browser.
 *
 * Optimizations:
 * - LRU read cache (avoids disk/IDB I/O for recently accessed chunks)
 * - Batched writes (amortizes I/O cost)
 * - LevelDB handles compression (Snappy), no manual gzip
 * - Simple string keys for debugging
 */
function chunkKey(cx: number, cy: number, cz: number): string {
	return `${cx},${cy},${cz}`;
}

export interface CachedChunk {
	data: Uint8Array;
	timestamp: number;
}

export class LevelDbChunkStore {
	private db: any = null;
	private readonly dbPath: string;
	private batch: any = null;
	private batchCount = 0;
	private readonly maxBatchSize = 64;
	private opened = false;

	// LRU read cache
	private readonly cache = new Map<string, CachedChunk>();
	private readonly maxCacheSize = 1024;
	private cacheHits = 0;
	private cacheMisses = 0;

	constructor(worldName: string, basePath: string) {
		// In browser, basePath is ignored (IndexedDB uses a name)
		// In Node, basePath is the filesystem path
		this.dbPath =
			typeof window !== "undefined"
				? `b102:worlds:${worldName}`
				: `${basePath}/worlds/${worldName}/db`;
	}

	async open(): Promise<void> {
		if (this.opened) return;

		const { Level } = await import("level");

		if (typeof window !== "undefined") {
			// Browser: level-js uses IndexedDB
			this.db = new Level(this.dbPath, {
				valueEncoding: "buffer",
				keyEncoding: "utf8",
				compression: true,
			});
		} else {
			// Node.js: native LevelDB
			const { existsSync, mkdirSync } = await import("node:fs");
			const { resolve } = await import("node:path");
			const absPath = resolve(process.cwd(), this.dbPath);
			if (!existsSync(absPath)) {
				mkdirSync(absPath, { recursive: true });
			}
			this.db = new Level(absPath, {
				valueEncoding: "buffer",
				keyEncoding: "utf8",
				compression: true,
			});
		}

		await this.db.open();
		this.opened = true;
	}

	async close(): Promise<void> {
		await this.flush();
		if (this.db) {
			await this.db.close();
			this.db = null;
		}
		this.cache.clear();
		this.opened = false;
	}

	/**
	 * Read a chunk from the database (with LRU cache).
	 * Returns the serialized blob, or null if not found.
	 */
	async readChunk(
		cx: number,
		cy: number,
		cz: number,
	): Promise<Uint8Array | null> {
		const key = chunkKey(cx, cy, cz);

		// Check cache first
		const cached = this.cache.get(key);
		if (cached) {
			this.cacheHits++;
			cached.timestamp = Date.now();
			return cached.data;
		}
		this.cacheMisses++;

		if (!this.db) return null;
		try {
			const value = await this.db.get(key);
			if (!value) return null;
			const data =
				value instanceof Uint8Array
					? value
					: new Uint8Array(value as ArrayBuffer);

			// Add to cache
			this.addToCache(key, data);

			return data;
		} catch {
			return null;
		}
	}

	/**
	 * Read multiple chunks in parallel (efficient batch).
	 */
	async readChunks(
		coords: Array<{ cx: number; cy: number; cz: number }>,
	): Promise<Map<string, Uint8Array>> {
		const results = new Map<string, Uint8Array>();

		// Check cache first, collect misses
		const misses: Array<{ cx: number; cy: number; cz: number; key: string }> =
			[];
		for (const { cx, cy, cz } of coords) {
			const key = chunkKey(cx, cy, cz);
			const cached = this.cache.get(key);
			if (cached) {
				this.cacheHits++;
				cached.timestamp = Date.now();
				results.set(key, cached.data);
			} else {
				this.cacheMisses++;
				misses.push({ cx, cy, cz, key });
			}
		}

		// Fetch misses from DB in parallel
		if (misses.length > 0 && this.db) {
			const promises = misses.map(async ({ key }) => {
				try {
					const value = await this.db.get(key);
					if (value) {
						const data =
							value instanceof Uint8Array
								? value
								: new Uint8Array(value as ArrayBuffer);
						this.addToCache(key, data);
						results.set(key, data);
					}
				} catch {
					// not found
				}
			});
			await Promise.all(promises);
		}

		return results;
	}

	/**
	 * Write a chunk to the database (batched for efficiency).
	 * Call flush() to ensure all pending writes are persisted.
	 */
	writeChunk(cx: number, cy: number, cz: number, data: Uint8Array): void {
		if (!this.db) return;
		const key = chunkKey(cx, cy, cz);

		// Update cache
		this.addToCache(key, data);

		// Add to write batch
		if (!this.batch) {
			this.batch = this.db.batch();
			this.batchCount = 0;
		}
		this.batch.put(key, Buffer.from(data));
		this.batchCount++;

		if (this.batchCount >= this.maxBatchSize) {
			const pending = this.batch;
			this.batch = null;
			this.batchCount = 0;
			void pending.write();
		}
	}

	/**
	 * Flush all pending writes to the database.
	 */
	async flush(): Promise<void> {
		if (this.batch && this.batchCount > 0) {
			const pending = this.batch;
			this.batch = null;
			this.batchCount = 0;
			await pending.write();
		}
	}

	/**
	 * Store metadata (seed, version, etc.)
	 */
	async setMeta(key: string, value: string): Promise<void> {
		if (!this.db) return;
		await this.db.put(`\x01${key}`, value);
	}

	/**
	 * Read metadata. Returns null if not found.
	 */
	async getMeta(key: string): Promise<string | null> {
		if (!this.db) return null;
		try {
			const value = await this.db.get(`\x01${key}`);
			return value != null ? String(value) : null;
		} catch {
			return null;
		}
	}

	/**
	 * Check if a chunk exists (cache-first).
	 */
	async hasChunk(cx: number, cy: number, cz: number): Promise<boolean> {
		const key = chunkKey(cx, cy, cz);
		if (this.cache.has(key)) return true;
		if (!this.db) return false;
		try {
			await this.db.get(key);
			return true;
		} catch {
			return false;
		}
	}

	private addToCache(key: string, data: Uint8Array): void {
		// Evict oldest if at capacity
		if (this.cache.size >= this.maxCacheSize && !this.cache.has(key)) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}
		this.cache.set(key, { data, timestamp: Date.now() });
	}

	get cacheHitRate(): number {
		const total = this.cacheHits + this.cacheMisses;
		return total > 0 ? this.cacheHits / total : 0;
	}

	get cachedEntryCount(): number {
		return this.cache.size;
	}

	get isReady(): boolean {
		return this.db !== null;
	}
}
