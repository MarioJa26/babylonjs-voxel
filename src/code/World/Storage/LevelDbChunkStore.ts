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
 * - Approximate-LRU read cache (avoids disk/IDB I/O for recently accessed
 *   chunks) via second-chance/CLOCK eviction — see the `cache`/`touched`
 *   fields below for why this isn't a plain delete+re-set LRU.
 * - Batched writes (amortizes I/O cost)
 * - Batched reads for cache misses (readChunks/hasChunks), on both backends
 * - LevelDB handles compression (Snappy), no manual gzip
 * - Simple string keys for debugging
 *
 * Write ordering: every write (chunk blob or meta) goes through a single
 * serialized promise chain (`writeTail`). No transaction is ever started
 * fire-and-forget — when a chained write operation resolves, every
 * transaction it started has settled. This guarantees deterministic
 * write ordering and makes clear() race-free (a clear queued after a
 * write can never be undone by a late transaction).
 */
function chunkKey(cx: number, cy: number, cz: number): string {
	return `${cx},${cy},${cz}`;
}

export interface ChunkWrite {
	cx: number;
	cy: number;
	cz: number;
	blob: Uint8Array;
}

export class LevelDbChunkStore {
	private db: any = null;
	private readonly dbPath: string;
	private batch: any = null;
	private batchCount = 0;
	private opened = false;
	private openPromise: Promise<void> | null = null;

	// Single serialized write chain. Every public write method queues its
	// operation here; operations run strictly one after another, so no two
	// operations can ever touch `batch`/`pendingMeta` concurrently.
	private writeTail: Promise<void> = Promise.resolve();

	// Cache storage: Map insertion order is the FIFO base ordering.
	// `touched` is a second-chance ("CLOCK") bit set — a cache *hit* just
	// adds the key to this Set (O(1), no Map mutation of `cache` itself).
	// On eviction we walk from the oldest entry in `cache` and give any
	// touched entry one more life (clearing its bit) instead of evicting
	// it, then check the next-oldest. This approximates LRU — chunks that
	// keep getting re-read (spawn area, wherever players linger) survive —
	// without paying a full delete+reinsert reorder on every read, which
	// matters because reads (chunk streaming as players move) vastly
	// outnumber writes (edits/saves) against this cache.
	private readonly cache = new Map<string, Uint8Array>();
	private readonly touched = new Set<string>();
	private readonly maxCacheSize: number;
	private static readonly DEFAULT_BATCH_SIZE = 64;

	// Meta writes go through the same write chain as chunk data so version /
	// position updates cannot race a clear() or an in-flight chunk batch.
	// pendingMeta shadows unflushed values (counted per in-flight write) so a
	// getMeta right after a setMeta still sees the fresh value.
	private readonly pendingMeta = new Map<string, number>();

	constructor(worldName: string, basePath: string, maxCacheSize = 128) {
		this.dbPath =
			typeof window !== "undefined"
				? `b102:worlds:${worldName}`
				: `${basePath}/worlds/${worldName}/db`;
		this.maxCacheSize = Math.max(0, Math.trunc(maxCacheSize));
	}

	async open(): Promise<void> {
		if (this.opened) return;
		if (this.openPromise) return this.openPromise;

		const promise = (async () => {
			if (typeof window !== "undefined") {
				await this.openBrowser();
			} else {
				await this.openNode();
			}
			this.opened = true;
		})();
		this.openPromise = promise;
		await promise;
		this.openPromise = null;
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
		this.touched.clear();
		this.pendingMeta.clear();
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
			this.touched.add(key);
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
		const misses: string[] = [];

		for (const { cx, cy, cz, key } of coords) {
			const k = key ?? chunkKey(cx, cy, cz);
			const cached = this.cache.get(k);
			if (cached) {
				this.touched.add(k);
				results.set(k, cached);
			} else {
				misses.push(k);
			}
		}

		if (misses.length > 0) {
			// Single batched read (one IndexedDB transaction / one level
			// getMany) for all cache misses instead of N independent gets.
			const found = await this._getMany(misses);
			for (const [k, data] of found) {
				this.addToCache(k, data);
				results.set(k, data);
			}
		}

		return results;
	}

	/**
	 * Queue an operation on the single write chain. Only these public
	 * methods may call this — everything that runs inside `operation` must
	 * be an `*Unsafe` primitive, never a public queued method (a public
	 * method called from inside the chain would enqueue behind itself and
	 * deadlock).
	 *
	 * The caller observes its own operation's failure (`result` rejects),
	 * while the internal tail recovers so later operations still run.
	 * Synchronous throws from `operation` are converted into a rejection
	 * by `.then(operation)`.
	 */
	private enqueueExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.writeTail.then(operation);
		this.writeTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	writeChunk(
		cx: number,
		cy: number,
		cz: number,
		data: Uint8Array,
	): Promise<void> {
		return this.enqueueExclusive(() => this.writeChunkUnsafe(cx, cy, cz, data));
	}

	/** Bulk write of a network batch: queued, one final flush at the end. */
	writeChunks(writes: readonly ChunkWrite[]): Promise<void> {
		return this.enqueueExclusive(() => this.writeChunksUnsafe(writes));
	}

	async flush(): Promise<void> {
		return this.enqueueExclusive(() => this.flushUnsafe());
	}

	async setMeta(key: string, value: string): Promise<void> {
		return this.enqueueExclusive(() => this.setMetaUnsafe(key, value));
	}

	async clear(): Promise<void> {
		return this.enqueueExclusive(() => this.clearUnsafe());
	}

	// ---------------------------------------------------------------------
	// Unsafe primitives — may only run while the write chain is held. Never
	// call a public queued method from inside these.
	// ---------------------------------------------------------------------

	/**
	 * Invariant: when a chained write operation resolves, every transaction
	 * it started has settled. The threshold commit below is awaited (never
	 * fired fire-and-forget) so a later clear() can never be undone by a
	 * late transaction.
	 */
	private async batchPutUnsafe(
		key: string,
		value: Uint8Array | string,
	): Promise<void> {
		if (!this.db) return;
		if (!this.batch) {
			this.batch = this.db.batch();
			this.batchCount = 0;
		}
		this.batch.put(key, value);
		this.batchCount++;
		if (this.batchCount >= LevelDbChunkStore.DEFAULT_BATCH_SIZE) {
			await this.flushUnsafe();
		}
	}

	private async flushUnsafe(): Promise<void> {
		if (!this.batch || this.batchCount === 0) return;
		const pending = this.batch;
		this.batch = null;
		this.batchCount = 0;
		await pending.write();
	}

	private async writeChunkUnsafe(
		cx: number,
		cy: number,
		cz: number,
		data: Uint8Array,
	): Promise<void> {
		if (!this.db) return;
		const key = chunkKey(cx, cy, cz);
		this.addToCache(key, data);
		await this.batchPutUnsafe(key, data);
	}

	private async writeChunksUnsafe(
		writes: readonly ChunkWrite[],
	): Promise<void> {
		for (let i = 0; i < writes.length; i++) {
			const write = writes[i];
			const key = chunkKey(write.cx, write.cy, write.cz);
			this.addToCache(key, write.blob);
			await this.batchPutUnsafe(key, write.blob);
		}
		await this.flushUnsafe();
	}

	/**
	 * Metadata writes run inside the chain (so they order against clear())
	 * but through their own transaction — they are deliberately NOT coupled
	 * to the 64-put chunk flush policy. Meta writes are rare, so one
	 * transaction each is fine.
	 */
	private async setMetaUnsafe(key: string, value: string): Promise<void> {
		if (!this.db) return;
		const k = `\x01${key}`;
		this.pendingMeta.set(k, (this.pendingMeta.get(k) ?? 0) + 1);
		try {
			await this.db.batch().put(k, value).write();
		} finally {
			this.releasePendingMetaKey(k);
		}
	}

	private async clearUnsafe(): Promise<void> {
		this.cache.clear();
		this.touched.clear();
		this.pendingMeta.clear();
		this.batch = null;
		this.batchCount = 0;
		if (!this.db) return;
		if (typeof window !== "undefined") {
			await (this.db as IndexedDbStore).clear();
		} else {
			await this.db.clear();
		}
	}

	private releasePendingMetaKey(k: string): void {
		const count = this.pendingMeta.get(k) ?? 0;
		if (count <= 1) {
			this.pendingMeta.delete(k);
		} else {
			this.pendingMeta.set(k, count - 1);
		}
	}

	async getMeta(key: string): Promise<string | null> {
		if (!this.db) return null;
		const k = `\x01${key}`;
		if (this.pendingMeta.has(k)) return String(this.pendingMeta.get(k));
		const value = await this._get(k);
		return value != null ? String(value) : null;
	}

	async hasChunk(cx: number, cy: number, cz: number): Promise<boolean> {
		const key = chunkKey(cx, cy, cz);
		if (this.cache.has(key)) return true;
		if (!this.db) return false;
		const value = await this._get(key);
		return value != null;
	}

	async hasChunks(
		coords: Array<{ cx: number; cy: number; cz: number; key?: string }>,
	): Promise<Set<string>> {
		const result = new Set<string>();
		const misses: string[] = [];
		for (const { cx, cy, cz, key } of coords) {
			const k = key ?? chunkKey(cx, cy, cz);
			if (this.cache.has(k)) {
				result.add(k);
			} else {
				misses.push(k);
			}
		}
		if (misses.length === 0 || !this.db) return result;
		if (typeof window !== "undefined") {
			const found = await (this.db as IndexedDbStore).has(misses);
			for (const k of found) result.add(k);
		} else {
			// Reuse the same batched primitive readChunks relies on, instead
			// of fanning out into N independent level.get() calls (each its
			// own promise + catch) for what is really one existence probe.
			const found = await this._getMany(misses);
			for (const k of found.keys()) result.add(k);
		}
		return result;
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

	/**
	 * Batch read for cache misses. Browser: one IndexedDB transaction via
	 * getMany. Node: level's getMany (single batch read). Keeps results in
	 * input order; missing keys are simply absent from the map.
	 */
	private async _getMany(keys: string[]): Promise<Map<string, Uint8Array>> {
		const results = new Map<string, Uint8Array>();
		if (keys.length === 0 || !this.db) return results;
		try {
			let values: Array<any>;
			if (typeof window !== "undefined") {
				values = await (this.db as IndexedDbStore).getMany(keys);
			} else {
				values = await this.db.getMany(keys);
			}
			for (let i = 0; i < keys.length; i++) {
				const value = values[i];
				if (value != null) {
					const data =
						value instanceof Uint8Array
							? value
							: new Uint8Array(value as ArrayBuffer);
					results.set(keys[i], data);
				}
			}
		} catch (err) {
			console.warn(`[LevelDb] _getMany failed for ${keys.length} keys:`, err);
		}
		return results;
	}

	private addToCache(key: string, data: Uint8Array): void {
		if (this.cache.has(key)) {
			// Entry already in cache — update the data and mark it touched
			// (protects it from the next second-chance sweep) without
			// paying for a delete+reinsert into the ordered Map.
			this.cache.set(key, data);
			this.touched.add(key);
			return;
		}
		if (this.cache.size >= this.maxCacheSize) {
			this.evictOne();
		}
		this.cache.set(key, data);
	}

	/**
	 * Second-chance (CLOCK) eviction. Walks from the FIFO-oldest entry in
	 * `cache`; if it's been touched (read or rewritten) since it was
	 * cached, give it one more life — clear the bit, check the next-oldest
	 * — instead of evicting it outright.
	 */
	private evictOne(): void {
		for (const key of this.cache.keys()) {
			if (this.touched.delete(key)) continue;
			this.cache.delete(key);
			return;
		}
		// Every entry in the cache was touched during this sweep — evict
		// the oldest anyway so inserts always make forward progress.
		const oldest = this.cache.keys().next().value;
		if (oldest !== undefined) {
			this.touched.delete(oldest);
			this.cache.delete(oldest);
		}
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

	async clear(): Promise<void> {
		if (!this.db) return;
		await new Promise<void>((resolve, reject) => {
			const tx = this.db!.transaction(this.storeName, "readwrite");
			const store = tx.objectStore(this.storeName);
			const req = store.clear();
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	}

	async has(keys: string[]): Promise<Set<string>> {
		if (!this.db) throw new Error("IndexedDbStore not open");
		if (keys.length === 0) return new Set();
		return new Promise<Set<string>>((resolve, reject) => {
			const found = new Set<string>();
			const tx = this.db!.transaction(this.storeName, "readonly");
			const store = tx.objectStore(this.storeName);
			let pending = keys.length;
			for (const key of keys) {
				const req = store.count(key);
				req.onsuccess = () => {
					if (req.result > 0) found.add(key);
					if (--pending === 0) resolve(found);
				};
				req.onerror = () => reject(req.error);
			}
		});
	}

	/**
	 * Batch read: one readonly transaction for N keys instead of N
	 * transactions (each store.get opens its own). Results are positionally
	 * aligned with `keys` — undefined for missing keys.
	 */
	async getMany(keys: string[]): Promise<Array<Uint8Array | undefined>> {
		if (!this.db) throw new Error("IndexedDbStore not open");
		if (keys.length === 0) return [];
		return new Promise<Array<Uint8Array | undefined>>((resolve, reject) => {
			const results: Array<Uint8Array | undefined> = new Array(keys.length);
			const tx = this.db!.transaction(this.storeName, "readonly");
			const store = tx.objectStore(this.storeName);
			let pending = keys.length;
			for (let i = 0; i < keys.length; i++) {
				const req = store.get(keys[i]);
				req.onsuccess = () => {
					const value = req.result;
					if (value instanceof Uint8Array) {
						results[i] = value;
					} else if (value instanceof ArrayBuffer) {
						results[i] = new Uint8Array(value);
					} else {
						results[i] = undefined;
					}
					if (--pending === 0) resolve(results);
				};
				req.onerror = () => reject(req.error);
			}
		});
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
