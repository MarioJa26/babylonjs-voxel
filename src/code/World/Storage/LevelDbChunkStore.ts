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

export class LevelDbChunkStore {
	private db: any = null;
	private readonly dbPath: string;
	private batch: any = null;
	private batchCount = 0;
	private readonly maxBatchSize = 64;
	private opened = false;

	// LRU read cache — insertion order == access order. On hit, delete+re-set
	// to move to most-recent end. On full, evict from .keys().next() (LRU).
	private readonly cache = new Map<string, Uint8Array>();
	private readonly maxCacheSize: number;

	constructor(worldName: string, basePath: string, maxCacheSize = 1024) {
		this.dbPath =
			typeof window !== "undefined"
				? `b102:worlds:${worldName}`
				: `${basePath}/worlds/${worldName}/db`;
		this.maxCacheSize = Math.max(0, Math.trunc(maxCacheSize));
	}

	async open(): Promise<void> {
		if (this.opened) return;

		if (typeof window !== "undefined") {
			await this.openBrowser();
		} else {
			await this.openNode();
		}

		this.opened = true;
	}

	private async openBrowser(): Promise<void> {
		console.log(`[LevelDb] Opening IndexedDB: ${this.dbPath}`);
		this.db = new IndexedDbStore(this.dbPath);
		await this.db.open();
		console.log(`[LevelDb] IndexedDB opened successfully`);
	}

	private async openNode(): Promise<void> {
		const { Level } = await import("level");
		const { existsSync, mkdirSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const absPath = resolve(process.cwd(), this.dbPath);
		if (!existsSync(absPath)) {
			mkdirSync(absPath, { recursive: true });
		}
		this.db = new Level(absPath, {
			valueEncoding: "buffer",
			keyEncoding: "utf8",
		});
		await this.db.open();
	}

	async close(): Promise<void> {
		await this.flush();
		if (this.db) {
			if (typeof window !== "undefined") {
				await new Promise<void>((resolve) => {
					this.db.close(() => resolve());
				});
			} else {
				await this.db.close();
			}
			this.db = null;
		}
		this.cache.clear();
		this.opened = false;
	}

	async readChunk(
		cx: number,
		cy: number,
		cz: number,
	): Promise<Uint8Array | null> {
		const key = chunkKey(cx, cy, cz);

		const cached = this.cache.get(key);
		if (cached) {
			this.cache.delete(key);
			this.cache.set(key, cached);
			return cached;
		}

		if (!this.db) return null;

		const value = await this._get(key);
		if (!value) return null;

		const data = value instanceof Uint8Array ? value : new Uint8Array(value);
		this.addToCache(key, data);
		return data;
	}

	async readChunks(
		coords: Array<{ cx: number; cy: number; cz: number; key?: string }>,
	): Promise<Map<string, Uint8Array>> {
		const results = new Map<string, Uint8Array>();
		// Single array: one promise per cache miss instead of a `misses`
		// array of {cx,cy,cz,key} objects (only `key` is ever used) plus a
		// second promises array built from it.
		const pending: Array<Promise<void>> = [];

		for (const { cx, cy, cz, key } of coords) {
			const k = key ?? chunkKey(cx, cy, cz);
			const cached = this.cache.get(k);
			if (cached) {
				this.cache.delete(k);
				this.cache.set(k, cached);
				results.set(k, cached);
			} else {
				pending.push(
					this._get(k).then((value) => {
						if (value) {
							const data =
								value instanceof Uint8Array ? value : new Uint8Array(value);
							this.addToCache(k, data);
							results.set(k, data);
						}
					}),
				);
			}
		}

		if (pending.length > 0) {
			await Promise.all(pending);
		}

		return results;
	}

	writeChunk(cx: number, cy: number, cz: number, data: Uint8Array): void {
		if (!this.db) return;
		const key = chunkKey(cx, cy, cz);

		this.addToCache(key, data);

		if (!this.batch) {
			this.batch = this.db.batch();
			this.batchCount = 0;
		}
		this.batch.put(key, data);
		this.batchCount++;

		if (this.batchCount >= this.maxBatchSize) {
			const pending = this.batch;
			this.batch = null;
			this.batchCount = 0;
			void pending.write();
		}
	}

	async flush(): Promise<void> {
		if (this.batch && this.batchCount > 0) {
			const pending = this.batch;
			this.batch = null;
			this.batchCount = 0;
			await pending.write();
		}
	}

	async setMeta(key: string, value: string): Promise<void> {
		if (!this.db) return;
		await this._put(`\x01${key}`, value);
	}

	async getMeta(key: string): Promise<string | null> {
		if (!this.db) return null;
		const value = await this._get(`\x01${key}`);
		return value != null ? String(value) : null;
	}

	async hasChunk(cx: number, cy: number, cz: number): Promise<boolean> {
		const key = chunkKey(cx, cy, cz);
		if (this.cache.has(key)) return true;
		if (!this.db) return false;
		const value = await this._get(key);
		return value != null;
	}

	private async _get(key: string): Promise<any> {
		if (typeof window !== "undefined") {
			// Browser: IndexedDbStore uses promises
			try {
				const value = await (this.db as any).get(key);
				return value ?? null;
			} catch (err) {
				console.warn(`[LevelDb] _get failed for ${key}:`, err);
				return null;
			}
		}
		// Node.js: level uses promises
		return this.db.get(key).catch(() => null);
	}

	private async _put(key: string, value: any): Promise<void> {
		if (typeof window !== "undefined") {
			await new Promise<void>((resolve, reject) => {
				this.db.put(key, value, (err: Error | null) => {
					if (err) reject(err);
					else resolve();
				});
			});
		} else {
			await this.db.put(key, value);
		}
	}

	private addToCache(key: string, data: Uint8Array): void {
		if (this.cache.has(key)) {
			this.cache.delete(key);
		} else if (this.cache.size >= this.maxCacheSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}
		this.cache.set(key, data);
	}

	get cachedEntryCount(): number {
		return this.cache.size;
	}

	get isReady(): boolean {
		return this.db !== null;
	}
}

/**
 * Minimal IndexedDB-backed key-value store for the browser.
 * Replaces level-js (which has problematic Node.js dependencies).
 * API matches what LevelDbChunkStore needs: get, put, batch, open, close.
 */
class IndexedDbStore {
	private db: IDBDatabase | null = null;
	private readonly dbName: string;
	private readonly storeName = "chunks";

	constructor(dbName: string) {
		this.dbName = dbName;
	}

	async open(): Promise<void> {
		if (this.db) return;
		this.db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(this.dbName, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(this.storeName)) {
					db.createObjectStore(this.storeName);
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	async close(): Promise<void> {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}

	async get(key: string): Promise<Uint8Array | undefined> {
		if (!this.db) throw new Error("IndexedDbStore not open");
		return new Promise<Uint8Array | undefined>((resolve, reject) => {
			const tx = this.db!.transaction(this.storeName, "readonly");
			const store = tx.objectStore(this.storeName);
			const req = store.get(key);
			req.onsuccess = () => {
				const value = req.result;
				if (value instanceof Uint8Array) {
					resolve(value);
				} else if (value instanceof ArrayBuffer) {
					resolve(new Uint8Array(value));
				} else {
					resolve(undefined);
				}
			};
			req.onerror = () => reject(req.error);
		});
	}

	async put(key: string, value: Uint8Array | string): Promise<void> {
		if (!this.db) throw new Error("IndexedDbStore not open");
		await new Promise<void>((resolve, reject) => {
			const tx = this.db!.transaction(this.storeName, "readwrite");
			const store = tx.objectStore(this.storeName);
			const req = store.put(value, key);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	}

	batch(): IndexedDbBatch {
		return new IndexedDbBatch(this.db!, this.storeName);
	}
}

class IndexedDbBatch {
	private ops: Array<{ key: string; value: Uint8Array | string }> = [];

	constructor(
		private db: IDBDatabase,
		private storeName: string,
	) {}

	put(key: string, value: Uint8Array | string): void {
		this.ops.push({ key, value });
	}

	async write(): Promise<void> {
		if (this.ops.length === 0) return;
		const ops = this.ops;
		this.ops = [];
		await new Promise<void>((resolve, reject) => {
			const tx = this.db.transaction(this.storeName, "readwrite");
			const store = tx.objectStore(this.storeName);
			for (const { key, value } of ops) {
				store.put(value, key);
			}
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	}
}
