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
 * - A single write pump: every public write call enqueues one job into a
 *   FIFO queue; the pump assembles up to 64 operations per storage
 *   transaction, coalescing nearby jobs (2 ms window) so bursts of
 *   individual writes share one transaction.
 * - Batched reads for cache misses (readChunks/hasChunks), on both backends
 * - LevelDB handles compression (Snappy), no manual gzip
 * - Simple string keys for debugging
 *
 * Write ordering invariants:
 * - At most one storage transaction is active at a time (the pump).
 * - A public promise resolves/rejects only after the transactions
 *   containing its operations have settled — never fire-and-forget.
 * - Cache entries become durable-visible only after commit; puts publish
 *   to the memory cache post-commit, while deletes tombstone immediately.
 * - flush() is a FIFO success barrier; clear() is a FIFO ordering barrier.
 * - Reads never enter the write queue.
 */
export function chunkKey(cx: number, cy: number, cz: number): string {
	return cx + "," + cy + "," + cz;
}

export interface ChunkCoord {
	cx: number;
	cy: number;
	cz: number;
	key?: string;
}

export interface ChunkReadCoord extends ChunkCoord {
	id?: bigint;
}

export interface ChunkWrite {
	cx: number;
	cy: number;
	cz: number;
	blob: Uint8Array;
	key?: string;
}

/**
 * Storage contract used by WorldStorage. `readChunk` returns undefined for a
 * missing chunk; batch variants return maps/sets keyed by the chunk key
 * ("cx,cy,cz") so callers can pre-compute keys once.
 *
 * Blob mutability contract for writeChunk/writeChunks:
 * The caller must not mutate `blob` after passing it to the store. This lets
 * the store and its read cache reuse the caller's Uint8Array instead of
 * making defensive copies. packChunkBlob / serializeVoxelData always produce
 * fresh, isolated buffers, so all callers in this codebase already satisfy it.
 */
export interface ChunkStorage {
	open(): Promise<void>;
	close?(): Promise<void>;

	readChunk(cx: number, cy: number, cz: number): Promise<Uint8Array | undefined>;
	readChunks(coords: readonly ChunkCoord[]): Promise<Map<string, Uint8Array>>;

	hasChunk(cx: number, cy: number, cz: number): Promise<boolean>;
	hasChunks(coords: readonly ChunkCoord[]): Promise<Set<string>>;

	writeChunk(cx: number, cy: number, cz: number, blob: Uint8Array): Promise<void>;
	writeChunks(writes: readonly ChunkWrite[]): Promise<void>;

	setMetaBytes(key: string, value: Uint8Array): Promise<void>;
	getMetaBytes(key: string): Promise<Uint8Array | undefined>;
	deleteMeta(key: string): Promise<void>;

	flush(): Promise<void>;
	clear(): Promise<void>;

	readonly isReady: boolean;
}

export enum WriteOperationKind {
	Put,
	Delete,
}

export type WriteOperation =
	| {
			kind: WriteOperationKind.Put;
			key: string;
			value: Uint8Array | string;
	  }
	| {
			kind: WriteOperationKind.Delete;
			key: string;
	  };

type WriteJob = {
	operations: WriteOperation[];
	nextOperation: number;
	resolve: () => void;
	reject: (error: Error) => void;
	settled: boolean;
	cancelled: boolean;
};

enum QueueEntryKind {
	Write = "write",
	Barrier = "barrier",
	Clear = "clear",
}

type QueueEntry =
	| {
			kind: QueueEntryKind.Write;
			job: WriteJob;
	  }
	| {
			kind: QueueEntryKind.Barrier;
			resolve: () => void;
			reject: (error: Error) => void;
	  }
	| {
			kind: QueueEntryKind.Clear;
			resolve: () => void;
			reject: (error: Error) => void;
			discardPendingWrites: boolean;
			metaGeneration: number;
	  };

type PendingMeta = {
	value: string | Uint8Array | null;
	generation: number;
};

// Only used to upgrade legacy string-valued meta (e.g. entities persisted by
// older versions) to bytes on read; everything new writes raw bytes.
const metaTextEncoder = new TextEncoder();

/** Thrown when queued writes are discarded by a reconnect clear(). */
export class CacheResetError extends Error {
	readonly code = "CACHE_RESET" as const;

	constructor(message = "Chunk cache was reset") {
		super(message);
		this.name = "CacheResetError";
	}
}

/** instanceof is unreliable across realms; check the error code instead. */
export function isCacheResetError(error: unknown): error is CacheResetError {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as { code?: unknown }).code === "CACHE_RESET"
	);
}

export class LevelDbChunkStore implements ChunkStorage {
	private db: any = null;
	private readonly isBrowser = typeof window !== "undefined";
	private readonly dbPath: string;
	private opened = false;
	private openPromise: Promise<void> | null = null;
	private closing = false;
	private closePromise: Promise<void> | null = null;

	// -------------------------------------------------------------------
	// Write pump state
	// -------------------------------------------------------------------
	private readonly writeQueue: QueueEntry[] = [];
	private writeQueueHead = 0;
	private writePumpRunning = false;
	private pumpPromise: Promise<void> | null = null;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingBarrierError: Error | null = null;
	// Browser only: force-flushes pending writes when the tab is hidden,
	// since background-tab timer throttling can clamp the coalescing timer
	// to ~1000ms and delay persistence of writes queued before backgrounding.
	private visibilityHandler: (() => void) | null = null;

	// Cache storage. `cache` is the lookup map; `touched` is the
	// second-chance ("CLOCK") bit set — a cache *hit* just adds the key to
	// this Set (O(1), no Map mutation of `cache` itself). `order` is a ring
	// of the keys currently in the cache (scan order for the clock hand),
	// and `orderIndex` maps each key to its slot in `order` so deletes are
	// O(1) via swap-remove. `hand` is a *persistent* CLOCK hand: it is not
	// reset to the front on every eviction, so a run of hot (frequently
	// re-touched) oldest entries is only walked past once — true
	// amortized-O(1) second-chance eviction. This approximates LRU —
	// chunks that keep getting re-read (spawn area, wherever players
	// linger) survive — without paying a full delete+reinsert reorder on
	// every read, which matters because reads (chunk streaming as players
	// move) vastly outnumber writes (edits/saves) against this cache.
	private readonly cache = new Map<string, Uint8Array>();
	private readonly touched = new Set<string>();
	private readonly order: string[] = [];
	private readonly orderIndex = new Map<string, number>();
	private hand = 0;
	private readonly maxCacheSize: number;

	// Deletes are queued (up to 2 ms or behind a transaction), so a memory
	// eviction alone is not enough: a concurrent read could rehydrate the
	// old blob from storage before the delete commits. pendingDeletes is
	// the tombstone that keeps deleted keys unreadable until the delete
	// commits (or a later put for the same key commits).
	private readonly pendingDeletes = new Set<string>();

	// Meta writes go through the same write queue as chunk data so version /
	// position updates cannot race a clear() or an in-flight chunk batch.
	// pendingMeta shadows unflushed values (with per-write generations) so
	// a getMeta right after a setMeta still sees the fresh value, and so a
	// clear() can drop pre-clear shadows without erasing post-clear ones.
	private readonly pendingMeta = new Map<string, PendingMeta>();
	private metaGeneration = 0;
	// Platform-specialized once per instance.
	private readonly _hasMany: (keys: string[]) => Promise<Set<string>>;

	private static readonly MAX_TRANSACTION_OPS = 256;
	private static readonly COALESCE_MS = 2;

	constructor(worldName: string, basePath: string, maxCacheSize = 2048) {
		this.dbPath = this.isBrowser
			? `b102:worlds:${worldName}`
			: `${basePath}/worlds/${worldName}/db`;

		this.maxCacheSize = Math.max(0, Math.trunc(maxCacheSize));

		this._hasMany = this.isBrowser ? this._hasManyBrowser : this._hasManyNode;
	}

	private readonly preparedJobsScratch: WriteJob[] = new Array(
		LevelDbChunkStore.MAX_TRANSACTION_OPS,
	);
	private readonly preparedOpsScratch: WriteOperation[] = new Array(
		LevelDbChunkStore.MAX_TRANSACTION_OPS,
	);

	// -------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------

	async open(): Promise<void> {
		if (this.opened) return;
		if (this.openPromise !== null) return this.openPromise;

		const promise = this.openInternal();
		this.openPromise = promise;

		try {
			await promise;
			this.opened = true;
		} catch (error) {
			this.db = null;
			this.opened = false;
			throw error;
		} finally {
			// Always clear so a failed open can be retried.
			if (this.openPromise === promise) {
				this.openPromise = null;
			}
		}
	}

	private async openInternal(): Promise<void> {
		if (this.isBrowser) {
			await this.openBrowser();
		} else {
			await this.openNode();
		}
	}

	private async openBrowser(): Promise<void> {
		console.log(`[LevelDb] Opening IndexedDB: ${this.dbPath}`);
		this.db = new IndexedDbStore(this.dbPath);
		await this.db.open();
		console.log(`[LevelDb] IndexedDB opened successfully`);

		// Background-tab timer throttling can clamp the 2ms coalescing timer
		// to ~1000ms, so writes queued right before a tab is backgrounded
		// could sit unflushed for up to a second. Force a flush on hide so
		// pending persistence isn't delayed by the throttled timer.
		this.visibilityHandler = () => {
			if (
				typeof document !== "undefined" &&
				document.visibilityState === "hidden"
			) {
				this.forceWritePump();
			}
		};
		if (typeof document !== "undefined") {
			document.addEventListener("visibilitychange", this.visibilityHandler);
		}
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

	/**
	 * Block new writes, drain the write pump, then close the backend.
	 * Uses a dedicated shared promise so concurrent close() calls (and
	 * callers of flush()) never confuse queue drainage with a complete
	 * close. Reopening the same instance is supported.
	 */
	close(): Promise<void> {
		if (this.closePromise !== null) return this.closePromise;

		this.closing = true;
		const promise = this.closeInternal().finally(() => {
			this.closePromise = null;
		});
		this.closePromise = promise;
		return this.closePromise;
	}

	private async closeInternal(): Promise<void> {
		this.cancelFlushTimer();
		try {
			// Internal drain, not the public flush(): closing already
			// rejects new jobs, and a barrier append would be pointless.
			await this.drainWritePump();
			if (this.db) {
				await this.db.close();
				this.db = null;
			}
			this.cache.clear();
			this.touched.clear();
			this.pendingMeta.clear();
			this.pendingDeletes.clear();
			this.order.length = 0;
			this.orderIndex.clear();
			this.hand = 0;
			if (this.visibilityHandler !== null) {
				if (typeof document !== "undefined") {
					document.removeEventListener(
						"visibilitychange",
						this.visibilityHandler,
					);
				}
				this.visibilityHandler = null;
			}
			this.opened = false;
		} finally {
			this.closing = false;
		}
	}

	// -------------------------------------------------------------------
	// Reads — concurrent, never enter the write queue
	// -------------------------------------------------------------------

	async readChunk(
		cx: number,
		cy: number,
		cz: number,
		key?: string,
	): Promise<Uint8Array | undefined> {
		const k = key ?? chunkKey(cx, cy, cz);
		const pendingDeletes = this.pendingDeletes;

		if (pendingDeletes.has(k)) return undefined;

		const cached = this.cache.get(k);
		if (cached !== undefined) {
			this.touched.add(k);
			return cached;
		}

		const db = this.db;
		if (!db) return undefined;

		const value = await db.get(k);

		if (value == null || pendingDeletes.has(k)) return undefined;

		const data = value instanceof Uint8Array ? value : new Uint8Array(value);
		this.addToCache(k, data);
		return data;
	}

	async readChunks(
		coords: readonly ChunkCoord[],
	): Promise<Map<string, Uint8Array>> {
		const results = new Map<string, Uint8Array>();
		const misses: string[] = [];

		const pendingDeletes = this.pendingDeletes;
		const cache = this.cache;
		const touched = this.touched;

		let missSeen: Set<string> | null = null;

		for (let i = 0, len = coords.length; i < len; i++) {
			const coord = coords[i];
			const k = coord.key ?? chunkKey(coord.cx, coord.cy, coord.cz);

			if (pendingDeletes.has(k)) continue;

			const cached = cache.get(k);
			if (cached !== undefined) {
				touched.add(k);
				results.set(k, cached);
				continue;
			}

			// Dedupe only storage misses, preserving final Map semantics.
			if (misses.length !== 0) {
				if (missSeen === null) {
					missSeen = new Set(misses);
				}

				if (missSeen.has(k)) {
					continue;
				}

				missSeen.add(k);
			}

			misses.push(k);
		}

		if (misses.length === 0 || !this.db) {
			return results;
		}

		const found = await this._getMany(misses);

		for (const [k, data] of found) {
			if (pendingDeletes.has(k)) continue;

			this.addToCache(k, data);
			results.set(k, data);
		}

		return results;
	}

	async hasChunk(
		cx: number,
		cy: number,
		cz: number,
		key?: string,
	): Promise<boolean> {
		const k = key ?? chunkKey(cx, cy, cz);
		const pendingDeletes = this.pendingDeletes;

		if (pendingDeletes.has(k)) return false;

		if (this.cache.has(k)) {
			this.touched.add(k);
			return true;
		}

		if (!this.db) return false;

		const value = await this.db.get(k);
		return value != null && !pendingDeletes.has(k);
	}

	async hasChunks(
		coords: readonly ChunkCoord[],
	): Promise<Set<string>> {
		const result = new Set<string>();
		const misses: string[] = [];

		const pendingDeletes = this.pendingDeletes;
		const cache = this.cache;
		const touched = this.touched;

		let missSeen: Set<string> | null = null;

		for (let i = 0, len = coords.length; i < len; i++) {
			const coord = coords[i];
			const k = coord.key ?? chunkKey(coord.cx, coord.cy, coord.cz);

			if (pendingDeletes.has(k)) continue;

			if (cache.has(k)) {
				touched.add(k);
				result.add(k);
				continue;
			}

			if (misses.length !== 0) {
				if (missSeen === null) {
					missSeen = new Set(misses);
				}

				if (missSeen.has(k)) {
					continue;
				}

				missSeen.add(k);
			}

			misses.push(k);
		}

		if (misses.length === 0 || !this.db) {
			return result;
		}

		const found = await this._hasMany(misses);

		for (const k of found) {
			if (!pendingDeletes.has(k)) {
				result.add(k);
			}
		}

		return result;
	}

	async getMeta(key: string): Promise<string | null> {
		const storageKey = `\x01${key}`;
		const pending = this.pendingMeta.get(storageKey);
		if (pending !== undefined) {
			if (pending.value === null) return null;
			return pending.value instanceof Uint8Array ? null : pending.value;
		}
		if (!this.db) return null;
		const value = await this.db.get(storageKey);
		if (value == null) return null;
		return value instanceof Uint8Array ? null : String(value);
	}

	async getMetaBytes(key: string): Promise<Uint8Array | undefined> {
		const storageKey = `\x01${key}`;
		const pending = this.pendingMeta.get(storageKey);
		if (pending !== undefined) {
			if (pending.value === null) return undefined;
			return pending.value instanceof Uint8Array
				? pending.value
				: metaTextEncoder.encode(pending.value);
		}
		if (!this.db) return undefined;
		const value = await this.db.get(storageKey);
		if (value == null) return undefined;
		return value instanceof Uint8Array
			? value
			: metaTextEncoder.encode(String(value));
	}

	// -------------------------------------------------------------------
	// Public write APIs — one promise per call, queued for the pump
	// -------------------------------------------------------------------

	writeChunk(
		cx: number,
		cy: number,
		cz: number,
		data: Uint8Array,
		key?: string,
	): Promise<void> {
		const k = key ?? chunkKey(cx, cy, cz);
		return this.enqueueWriteJob([
			{
				kind: WriteOperationKind.Put,
				key: k,
				value: data,
			},
		]);
	}

	/** Bulk write: one queued job, shared transactions, key built once per write. */
	writeChunks(writes: readonly ChunkWrite[]): Promise<void> {
		const len = writes.length;
		if (len === 0) return Promise.resolve();

		const operations = new Array<WriteOperation>(len);

		for (let i = 0; i < len; i++) {
			const write = writes[i];

			operations[i] = {
				kind: WriteOperationKind.Put,
				key: write.key ?? chunkKey(write.cx, write.cy, write.cz),
				value: write.blob,
			};
		}

		return this.enqueueWriteJob(operations);
	}

	deleteChunk(cx: number, cy: number, cz: number, key?: string): Promise<void> {
		const k = key ?? chunkKey(cx, cy, cz);

		// Immediately prevent the corrupt or invalid entry from being
		// returned through the memory cache or rehydrated from storage.
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}
		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}

		this.pendingDeletes.add(k);
		this.cache.delete(k);
		this.touched.delete(k);
		this.removeFromOrder(k);

		return this.enqueueWriteJob([{ kind: WriteOperationKind.Delete, key: k }]);
	}

	/** Bulk eviction: one job, tombstoned immediately, shared transactions. */
	deleteChunks(
		coords: readonly ChunkCoord[],
	): Promise<void> {
		const len = coords.length;
		if (len === 0) return Promise.resolve();

		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}

		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}

		const operations = new Array<WriteOperation>(len);
		const pendingDeletes = this.pendingDeletes;
		const cache = this.cache;
		const touched = this.touched;

		for (let i = 0; i < len; i++) {
			const coordinate = coords[i];
			const key =
				coordinate.key ?? chunkKey(coordinate.cx, coordinate.cy, coordinate.cz);

			pendingDeletes.add(key);
			cache.delete(key);
			touched.delete(key);
			this.removeFromOrder(key);

			operations[i] = { kind: WriteOperationKind.Delete, key };
		}

		return this.enqueueWriteJobUnchecked(operations);
	}

	/**
	 * Success barrier: resolves when every job queued before it has
	 * committed or rejected; rejects when the first failure before it
	 * failed (success-barrier semantics). Writes called after flush() are
	 * appended behind the barrier and are not part of it.
	 */
	flush(): Promise<void> {
		if (
			this.writeQueueHead >= this.writeQueue.length &&
			!this.writePumpRunning
		) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			this.writeQueue.push({ kind: QueueEntryKind.Barrier, resolve, reject });
			this.forceWritePump();
		});
	}

	/**
	 * Ordering barrier. With discardPendingWrites: queued pre-clear write
	 * jobs are rejected with CacheResetError and skipped; the active
	 * transaction (if any) is allowed to settle, then the database and
	 * memory caches are wiped; post-clear jobs execute afterwards.
	 */
	clear(options: { discardPendingWrites?: boolean } = {}): Promise<void> {
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}

		const discardPendingWrites = options.discardPendingWrites === true;
		this.cancelFlushTimer();

		return new Promise<void>((resolve, reject) => {
			// Boundary before appending the clear command: entries submitted
			// after this method returns are placed after the clear command.
			const clearIndex = this.writeQueue.length;

			if (discardPendingWrites) {
				const resetError = new CacheResetError();
				for (let i = this.writeQueueHead; i < clearIndex; i++) {
					const entry = this.writeQueue[i];
					if (entry.kind !== QueueEntryKind.Write) continue;
					const job = entry.job;
					// The active transaction may already contain some of this
					// job's operations; those settle, then clear removes them.
					job.cancelled = true;
					this.rejectJob(job, resetError);
				}
				// Barriers queued before the clear must observe the reset as a
				// failure (they cover cancelled work); the clear consumes it.
				this.pendingBarrierError ??= resetError;
			}

			this.writeQueue.push({
				kind: QueueEntryKind.Clear,
				resolve,
				reject,
				discardPendingWrites,
				metaGeneration: this.metaGeneration,
			});

			this.forceWritePump();
		});
	}

	/**
	 * Meta writes share the chunk write queue so they order against clear()
	 * and coalesce into the same transactions. The shadow value is set only
	 * after the open/closing preconditions pass, and cleaned up by the
	 * job's own completion (generation-guarded so a later setMeta for the
	 * same key is never erased by an earlier completion).
	 */
	setMeta(key: string, value: string): Promise<void> {
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}
		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}

		const storageKey = `\x01${key}`;
		const generation = ++this.metaGeneration;

		this.pendingMeta.set(storageKey, { value, generation });

		const promise = this.enqueueWriteJobUnchecked([
			{ kind: WriteOperationKind.Put, key: storageKey, value },
		]);

		return promise.finally(() => {
			const current = this.pendingMeta.get(storageKey);
			if (current?.generation === generation) {
				this.pendingMeta.delete(storageKey);
			}
		});
	}

	/**
	 * Binary meta write (e.g. serialized chunk entities): same write queue,
	 * same coalescing, no string round-trip. The shadow value is the raw
	 * Uint8Array so getMetaBytes sees the fresh value before the commit.
	 */
	setMetaBytes(key: string, value: Uint8Array): Promise<void> {
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}
		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}

		const storageKey = `\x01${key}`;
		const generation = ++this.metaGeneration;

		this.pendingMeta.set(storageKey, { value, generation });

		const promise = this.enqueueWriteJobUnchecked([
			{ kind: WriteOperationKind.Put, key: storageKey, value },
		]);

		return promise.finally(() => {
			const current = this.pendingMeta.get(storageKey);
			if (current?.generation === generation) {
				this.pendingMeta.delete(storageKey);
			}
		});
	}

	/**
	 * Meta delete (e.g. clearing a chunk's entity list): serialized through
	 * the same write queue as chunk writes and other meta writes. The key is
	 * shadowed as deleted immediately so getMeta/getMetaBytes stop returning
	 * the old value before the delete commits; the shadow is generation-
	 * guarded so a later write for the same key is never erased by this
	 * completion.
	 */
	deleteMeta(key: string): Promise<void> {
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}
		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}

		const storageKey = `\x01${key}`;
		const generation = ++this.metaGeneration;

		this.pendingMeta.set(storageKey, { value: null, generation });

		const promise = this.enqueueWriteJobUnchecked([
			{ kind: WriteOperationKind.Delete, key: storageKey },
		]);

		return promise.finally(() => {
			const current = this.pendingMeta.get(storageKey);
			if (current?.generation === generation) {
				this.pendingMeta.delete(storageKey);
			}
		});
	}

	// -------------------------------------------------------------------
	// Queue insertion
	// -------------------------------------------------------------------

	private enqueueWriteJob(operations: WriteOperation[]): Promise<void> {
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}
		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}
		return this.enqueueWriteJobUnchecked(operations);
	}

	private enqueueWriteJobUnchecked(
		operations: WriteOperation[],
	): Promise<void> {
		const promise = new Promise<void>((resolve, reject) => {
			this.writeQueue.push({
				kind: QueueEntryKind.Write,
				job: {
					operations,
					nextOperation: 0,
					resolve,
					reject,
					settled: false,
					cancelled: false,
				},
			});
		});
		this.scheduleWritePump();
		return promise;
	}

	// -------------------------------------------------------------------
	// Write pump
	// -------------------------------------------------------------------

	/**
	 * Coalescing policy: run immediately when a hard boundary (barrier /
	 * clear) is at the head or 64 operations are already available;
	 * otherwise drain after a short window so bursts of individual calls
	 * share one transaction.
	 */
	private scheduleWritePump(): void {
		if (this.writePumpRunning) return;

		const head = this.writeQueue[this.writeQueueHead];
		if (
			head?.kind === QueueEntryKind.Barrier ||
			head?.kind === QueueEntryKind.Clear ||
			this.countAvailableOperations() >= LevelDbChunkStore.MAX_TRANSACTION_OPS
		) {
			this.cancelFlushTimer();
			this.startWritePump();
			return;
		}

		if (this.flushTimer !== null) return;

		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.startWritePump();
		}, LevelDbChunkStore.COALESCE_MS);
	}

	private forceWritePump(): void {
		this.cancelFlushTimer();
		this.startWritePump();
	}

	/**
	 * Starts the pump if it is not already running. Expected failures are
	 * handled inside the pump; this catch only surfaces invariant bugs.
	 */
	private startWritePump(): void {
		if (this.writePumpRunning) return;

		const pump = this.runWritePump();
		this.pumpPromise = pump;
		void pump.catch((error) => {
			console.error("[LevelDb] write pump failed unexpectedly:", error);
		});
	}

	private async runWritePump(): Promise<void> {
		if (this.writePumpRunning) return;
		this.writePumpRunning = true;
		this.cancelFlushTimer();

		try {
			while (this.writeQueueHead < this.writeQueue.length) {
				this.skipCancelledEntries();
				if (this.writeQueueHead >= this.writeQueue.length) break;

				const entry = this.writeQueue[this.writeQueueHead];
				if (entry.kind === QueueEntryKind.Barrier) {
					this.processBarrier(entry);
					continue;
				}
				if (entry.kind === QueueEntryKind.Clear) {
					await this.processClear(entry);
					continue;
				}
				await this.commitNextTransaction();
			}
		} finally {
			this.writePumpRunning = false;
			this.pumpPromise = null;
			if (this.writeQueueHead === this.writeQueue.length) {
				this.writeQueue.length = 0;
				this.writeQueueHead = 0;
			} else {
				this.compactWriteQueue();
				if (!this.closing) {
					this.scheduleWritePump();
				}
			}
		}
	}

	/**
	 * Counts operations available before the next hard boundary, skipping
	 * cancelled jobs. Used to decide between an immediate and a delayed
	 * pump run; never counts across a barrier/clear.
	 */
	private countAvailableOperations(
		limit = LevelDbChunkStore.MAX_TRANSACTION_OPS,
	): number {
		let count = 0;
		for (
			let i = this.writeQueueHead;
			i < this.writeQueue.length && count < limit;
			i++
		) {
			const entry = this.writeQueue[i];
			if (
				entry.kind === QueueEntryKind.Barrier ||
				entry.kind === QueueEntryKind.Clear
			)
				break;
			const job = entry.job;
			if (job.cancelled) continue;
			count += job.operations.length - job.nextOperation;
		}
		return count;
	}

	/** Advances the head past cancelled jobs without writing them. */
	private skipCancelledEntries(): void {
		while (this.writeQueueHead < this.writeQueue.length) {
			const entry = this.writeQueue[this.writeQueueHead];
			if (entry.kind !== QueueEntryKind.Write || !entry.job.cancelled) return;
			entry.job.nextOperation = entry.job.operations.length;
			this.writeQueueHead++;
		}
	}

	private compactWriteQueue(): void {
		if (
			this.writeQueueHead === 0 ||
			this.writeQueueHead < this.writeQueue.length >>> 1
		) {
			return;
		}
		this.writeQueue.copyWithin(0, this.writeQueueHead);
		this.writeQueue.length -= this.writeQueueHead;
		this.writeQueueHead = 0;
	}

	private async drainWritePump(): Promise<void> {
		this.startWritePump();
		if (this.pumpPromise !== null) {
			await this.pumpPromise;
		}
	}

	/**
	 * Assembles one transaction from the jobs at the head of the queue:
	 * at most 64 operations, never crossing a barrier/clear, consuming
	 * each job's operations contiguously so the parallel `preparedJobs` /
	 * `preparedOps` arrays hold job references (safe even if the queue is
	 * compacted later). Cursors are advanced optimistically before commit;
	 * on failure every affected job is cancelled and its cursor moved to
	 * the end, so no rollback is needed. Never mutates the queue structure
	 * while awaiting.
	 */
	private async commitNextTransaction(): Promise<void> {
		const db = this.db;

		if (!db) {
			this.rejectRemainingJobs(new Error("LevelDbChunkStore is not open"));
			return;
		}

		const maxOps = LevelDbChunkStore.MAX_TRANSACTION_OPS;
		const batch = db.batch();

		const preparedJobs = this.preparedJobsScratch;
		const preparedOps = this.preparedOpsScratch;

		let preparedCount = 0;
		let operationCount = 0;
		let queueIndex = this.writeQueueHead;
		const queue = this.writeQueue;

		while (queueIndex < queue.length && operationCount < maxOps) {
			const entry = queue[queueIndex];

			if (entry.kind !== QueueEntryKind.Write) {
				break;
			}

			const job = entry.job;

			if (job.cancelled) {
				queueIndex++;
				continue;
			}

			const operations = job.operations;

			while (job.nextOperation < operations.length && operationCount < maxOps) {
				const operation = operations[job.nextOperation];

				if (operation.kind === WriteOperationKind.Put) {
					batch.put(operation.key, operation.value);
				} else {
					batch.del(operation.key);
				}

				preparedJobs[preparedCount] = job;
				preparedOps[preparedCount] = operation;
				preparedCount++;
				job.nextOperation++;
				operationCount++;
			}

			if (job.nextOperation === operations.length) {
				queueIndex++;
			} else {
				break;
			}
		}

		if (operationCount === 0) {
			this.settleFinishedJobs();
			return;
		}

		try {
			await batch.write();
		} catch (error) {
			const commitError =
				error instanceof Error ? error : new Error(String(error));

			this.rejectAffectedJobs(preparedJobs, preparedCount, commitError);
			this.clearPreparedScratch(preparedCount);
			this.skipCancelledEntries();
			return;
		}

		this.publishCommittedOperations(preparedJobs, preparedOps, preparedCount);
		this.clearPreparedScratch(preparedCount);

		this.skipCancelledEntries();
		this.settleFinishedJobs();
	}
	private clearPreparedScratch(count: number): void {
		const jobs = this.preparedJobsScratch;
		const ops = this.preparedOpsScratch;

		for (let i = 0; i < count; i++) {
			jobs[i] = undefined as unknown as WriteJob;
			ops[i] = undefined as unknown as WriteOperation;
		}
	}

	private processBarrier(entry: {
		resolve: () => void;
		reject: (error: Error) => void;
	}): void {
		const error = this.pendingBarrierError;
		this.pendingBarrierError = null;
		this.writeQueueHead++;
		if (error !== null) {
			entry.reject(error);
		} else {
			entry.resolve();
		}
	}

	private async processClear(entry: {
		resolve: () => void;
		reject: (error: Error) => void;
		metaGeneration: number;
	}): Promise<void> {
		const db = this.db;

		this.clearMetaShadowsThrough(entry.metaGeneration);
		this.pendingDeletes.clear();
		this.cache.clear();
		this.touched.clear();
		this.order.length = 0;
		this.orderIndex.clear();
		this.hand = 0;
		this.writeQueueHead++;

		if (!db) {
			this.pendingBarrierError = null;
			entry.resolve();
			this.skipCancelledEntries();
			return;
		}

		try {
			await db.clear();

			this.pendingBarrierError = null;
			entry.resolve();
		} catch (error) {
			const clearError =
				error instanceof Error ? error : new Error(String(error));

			this.pendingBarrierError ??= clearError;
			entry.reject(clearError);
		}

		this.skipCancelledEntries();
	}

	/**
	 * Publishes committed operations to the durable read cache — only
	 * after the transaction commits, and only for jobs that were not
	 * cancelled by a reconnect clear.
	 */
	private publishCommittedOperations(
		preparedJobs: readonly WriteJob[],
		preparedOps: readonly WriteOperation[],
		preparedCount: number,
	): void {
		const pendingDeletes = this.pendingDeletes;
		const cache = this.cache;
		const touched = this.touched;

		for (let i = 0; i < preparedCount; i++) {
			const job = preparedJobs[i];

			if (job.cancelled) {
				continue;
			}

			const operation = preparedOps[i];
			const key = operation.key;

			if (operation.kind === WriteOperationKind.Put) {
				if (operation.value instanceof Uint8Array) {
					pendingDeletes.delete(key);
					this.addToCache(key, operation.value);
				}
			} else {
				pendingDeletes.delete(key);
				cache.delete(key);
				touched.delete(key);
				this.removeFromOrder(key);
			}
		}
	}

	/** Resolves the contiguous run of fully-consumed jobs at the head. */
	private settleFinishedJobs(): void {
		while (this.writeQueueHead < this.writeQueue.length) {
			const entry = this.writeQueue[this.writeQueueHead];
			if (entry.kind !== QueueEntryKind.Write) break;
			const job = entry.job;
			if (job.nextOperation !== job.operations.length) break;
			this.writeQueueHead++;
			this.resolveJob(job);
		}
	}

	/**
	 * On a failed transaction, every job it touched is cancelled in full —
	 * remaining operations are never retried — and rejected exactly once.
	 * Operations are prepared in queue order, so each job occupies one
	 * contiguous range in `prepared` and the previous-job check deduplicates.
	 */
	private rejectAffectedJobs(
		preparedJobs: readonly WriteJob[],
		preparedCount: number,
		error: Error,
	): void {
		let previousJob: WriteJob | undefined;

		for (let i = 0; i < preparedCount; i++) {
			const job = preparedJobs[i];

			if (job === previousJob) {
				continue;
			}

			previousJob = job;
			job.cancelled = true;
			job.nextOperation = job.operations.length;
			this.rejectJob(job, error);
		}

		this.pendingBarrierError ??= error;
	}

	/** Defensive: store closed underneath the pump — settle everything. */
	private rejectRemainingJobs(error: Error): void {
		while (this.writeQueueHead < this.writeQueue.length) {
			const entry = this.writeQueue[this.writeQueueHead];
			this.writeQueueHead++;
			if (entry.kind === QueueEntryKind.Write) {
				entry.job.cancelled = true;
				entry.job.nextOperation = entry.job.operations.length;
				this.rejectJob(entry.job, error);
			} else {
				entry.reject(error);
			}
		}
		this.pendingBarrierError ??= error;
	}

	private resolveJob(job: WriteJob): void {
		if (job.settled) return;
		job.settled = true;
		job.resolve();
	}

	private rejectJob(job: WriteJob, error: Error): void {
		if (job.settled) return;
		job.settled = true;
		job.reject(error);
	}

	/**
	 * Drops metadata shadows written before the given generation. Post-clear
	 * setMeta calls have higher generations and survive.
	 */
	private clearMetaShadowsThrough(generation: number): void {
		for (const [key, pending] of this.pendingMeta) {
			if (pending.generation <= generation) {
				this.pendingMeta.delete(key);
			}
		}
	}

	private cancelFlushTimer(): void {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}

	// -------------------------------------------------------------------
	// Backend primitives
	// -------------------------------------------------------------------

	private readonly _hasManyBrowser = async (
		keys: string[],
	): Promise<Set<string>> => {
		const db = this.db as IndexedDbStore | null;
		if (!db) return new Set<string>();

		// Browser path stays optimal: IndexedDbStore.has() uses getKey(),
		// so it checks existence without reading chunk blobs.
		return db.has(keys);
	};

	private readonly _hasManyNode = async (
		keys: string[],
	): Promise<Set<string>> => {
		const db = this.db;
		const result = new Set<string>();

		if (!db) return result;

		// Node level has no keys-only batch read here, so getMany() is still used.
		// We only check nullishness and avoid Uint8Array construction.
		const values: Array<unknown> = await db.getMany(keys);

		for (let i = 0, len = keys.length; i < len; i++) {
			if (values[i] != null) {
				result.add(keys[i]);
			}
		}

		return result;
	};

	/**
	 * Batch read for cache misses. Browser: one IndexedDB transaction via
	 * getMany. Node: level's getMany (single batch read). Keeps results in
	 * input order; missing keys are simply absent from the map.
	 */
	private async _getMany(keys: string[]): Promise<Map<string, Uint8Array>> {
		const results = new Map<string, Uint8Array>();
		const len = keys.length;
		const db = this.db;

		if (len === 0 || !db) {
			return results;
		}

		try {
			const values: Array<unknown> = await db.getMany(keys);

			for (let i = 0; i < len; i++) {
				const value = values[i];

				if (value == null) {
					continue;
				}

				results.set(
					keys[i],
					value instanceof Uint8Array
						? value
						: new Uint8Array(value as ArrayBuffer),
				);
			}
		} catch (err) {
			console.warn(`[LevelDb] _getMany failed for ${len} keys:`, err);
		}

		return results;
	}

	private addToCache(key: string, data: Uint8Array): void {
		const maxCacheSize = this.maxCacheSize;
		if (maxCacheSize === 0) return;

		const cache = this.cache;

		if (cache.get(key) !== undefined) {
			cache.set(key, data);
			this.touched.add(key);
			return;
		}

		if (cache.size >= maxCacheSize) {
			this.evictOne();
		}

		cache.set(key, data);

		const order = this.order;
		order.push(key);
		this.orderIndex.set(key, order.length - 1);
	}

	/**
	 * Second-chance (CLOCK) eviction with a *persistent* hand. The hand
	 * starts at `this.hand` (not the front of the cache) and advances
	 * around the `order` ring; an entry whose `touched` bit is set gets
	 * one more life (bit cleared, hand advances) instead of being evicted.
	 * Because the hand is not reset between evictions, a run of hot
	 * (frequently re-touched) entries is only walked past once — true
	 * amortized-O(1) second-chance eviction. Stale slots (keys removed by
	 * an explicit delete while the hand was elsewhere) are skipped and
	 * dropped from the ring as the hand passes them.
	 */
	private evictOne(): void {
		const cache = this.cache;
		const touched = this.touched;
		const order = this.order;
		const n = order.length;

		if (n === 0) return;

		let scanned = 0;
		while (scanned < n) {
			if (this.hand >= order.length) this.hand = 0;
			const key = order[this.hand];

			// Stale slot: an explicit delete removed it from `cache` but
			// the hand hadn't reached it yet. Drop it and keep scanning.
			if (!cache.has(key)) {
				this.removeFromOrder(key);
				scanned++;
				continue;
			}

			if (touched.delete(key)) {
				// Second chance: clear the bit, advance the hand.
				this.hand = (this.hand + 1) % order.length;
				scanned++;
				continue;
			}

			// Cold entry: evict it. swap-remove keeps `hand` pointing at
			// the next live entry.
			cache.delete(key);
			this.removeFromOrder(key);
			return;
		}

		// Every entry got a second chance on the first pass; force-evict
		// the one at the hand (all bits are now clear).
		if (order.length > 0) {
			const key = order[this.hand];
			cache.delete(key);
			this.removeFromOrder(key);
		}
	}

	/** O(1) removal of a key from the `order` ring via swap-remove. */
	private removeFromOrder(key: string): void {
		const idx = this.orderIndex.get(key);
		if (idx === undefined) return;

		const order = this.order;
		const last = order.length - 1;

		if (idx !== last) {
			const moved = order[last];
			order[idx] = moved;
			this.orderIndex.set(moved, idx);
		}

		order.pop();
		this.orderIndex.delete(key);

		if (this.hand >= order.length) this.hand = 0;
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

	async get(key: string): Promise<Uint8Array | string | undefined> {
		if (!this.db) throw new Error("IndexedDbStore not open");

		return new Promise<Uint8Array | string | undefined>((resolve, reject) => {
			const tx = this.db!.transaction(this.storeName, "readonly");
			const store = tx.objectStore(this.storeName);
			const req = store.get(key);

			req.onsuccess = () => {
				const value = req.result;

				if (value instanceof Uint8Array) {
					resolve(value);
				} else if (value instanceof ArrayBuffer) {
					resolve(new Uint8Array(value));
				} else if (typeof value === "string") {
					resolve(value);
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

			const fail = () => {
				reject(tx.error ?? new Error("IndexedDB put failed"));
			};

			tx.oncomplete = () => resolve();
			tx.onerror = fail;
			tx.onabort = fail;

			store.put(value, key);
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

			const fail = () => {
				reject(tx.error ?? new Error("IndexedDB clear failed"));
			};

			tx.oncomplete = () => resolve();
			tx.onerror = fail;
			tx.onabort = fail;

			store.clear();
		});
	}

	/**
	 * Existence check for many keys in one readonly transaction. Resolves as
	 * soon as every request settled; any request error rejects exactly once.
	 */
	async has(keys: string[]): Promise<Set<string>> {
		if (!this.db) throw new Error("IndexedDbStore not open");

		const n = keys.length;
		if (n === 0) return new Set<string>();

		return new Promise<Set<string>>((resolve, reject) => {
			const found = new Set<string>();
			const tx = this.db!.transaction(this.storeName, "readonly");
			const store = tx.objectStore(this.storeName);

			let settled = false;
			let pending = n;

			const fail = () => {
				if (settled) return;
				settled = true;
				reject(tx.error);
			};

			tx.onerror = fail;
			tx.onabort = fail;

			for (let i = 0; i < n; i++) {
				const key = keys[i];
				const req = store.count(key);

				req.onsuccess = () => {
					if (req.result > 0) found.add(key);

					if (--pending === 0 && !settled) {
						settled = true;
						resolve(found);
					}
				};

				req.onerror = fail;
			}
		});
	}

	/**
	 * Read many keys in one readonly transaction, results in input order.
	 * Missing keys map to undefined. Resolves as soon as every request
	 * settled; any request error rejects exactly once.
	 */
	async getMany(keys: string[]): Promise<Array<Uint8Array | undefined>> {
		if (!this.db) throw new Error("IndexedDbStore not open");

		const n = keys.length;
		if (n === 0) return [];

		return new Promise<Array<Uint8Array | undefined>>((resolve, reject) => {
			const results: Array<Uint8Array | undefined> = new Array(n);
			const tx = this.db!.transaction(this.storeName, "readonly");
			const store = tx.objectStore(this.storeName);

			let settled = false;
			let pending = n;

			const fail = () => {
				if (settled) return;
				settled = true;
				reject(tx.error);
			};

			tx.onerror = fail;
			tx.onabort = fail;

			for (let i = 0; i < n; i++) {
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

					if (--pending === 0 && !settled) {
						settled = true;
						resolve(results);
					}
				};

				req.onerror = fail;
			}
		});
	}
}

class IndexedDbBatch {
	private ops: Array<
		| { type: "put"; key: string; value: Uint8Array | string }
		| { type: "delete"; key: string }
	> = [];

	constructor(
		private readonly db: IDBDatabase,
		private readonly storeName: string,
	) {}

	put(key: string, value: Uint8Array | string): this {
		this.ops.push({ type: "put", key, value });
		return this;
	}

	del(key: string): this {
		this.ops.push({ type: "delete", key });
		return this;
	}

	/** Alias for `del`, matching the level Batch API used by the write pump. */
	delete(key: string): this {
		return this.del(key);
	}

	/** Commits every queued op in exactly one readwrite transaction. */
	async write(): Promise<void> {
		const ops = this.ops;
		const n = ops.length;

		if (n === 0) return;

		await new Promise<void>((resolve, reject) => {
			const tx = this.db.transaction(this.storeName, "readwrite");
			const store = tx.objectStore(this.storeName);

			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);

			for (let i = 0; i < n; i++) {
				const op = ops[i];

				if (op.type === "put") {
					store.put(op.value, op.key);
				} else {
					store.delete(op.key);
				}
			}
		});

		this.ops.length = 0;
	}
}
