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
function chunkKey(cx: number, cy: number, cz: number): string {
	return `${cx},${cy},${cz}`;
}

export interface ChunkWrite {
	cx: number;
	cy: number;
	cz: number;
	blob: Uint8Array;
}

export type WriteOperation =
	| {
			kind: "put";
			key: string;
			value: Uint8Array | string;
	  }
	| {
			kind: "delete";
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

type QueueEntry =
	| {
			kind: "write";
			job: WriteJob;
	  }
	| {
			kind: "barrier";
			resolve: () => void;
			reject: (error: Error) => void;
	  }
	| {
			kind: "clear";
			resolve: () => void;
			reject: (error: Error) => void;
			discardPendingWrites: boolean;
			metaGeneration: number;
	  };

type PreparedOperation = {
	job: WriteJob;
	operation: WriteOperation;
};

type PendingMeta = {
	value: string;
	generation: number;
};

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

export class LevelDbChunkStore {
	private db: any = null;
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

	private static readonly MAX_TRANSACTION_OPS = 64;
	private static readonly COALESCE_MS = 2;

	constructor(worldName: string, basePath: string, maxCacheSize = 128) {
		this.dbPath =
			typeof window !== "undefined"
				? `b102:worlds:${worldName}`
				: `${basePath}/worlds/${worldName}/db`;
		this.maxCacheSize = Math.max(0, Math.trunc(maxCacheSize));
	}

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
		if (typeof window !== "undefined") {
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
	): Promise<Uint8Array | null> {
		const key = chunkKey(cx, cy, cz);

		if (this.pendingDeletes.has(key)) return null;

		const cached = this.cache.get(key);
		if (cached !== undefined) {
			this.touched.add(key);
			return cached;
		}

		if (!this.db) return null;

		const value = await this._get(key);
		// The delete may have been enqueued while the storage read was
		// awaiting — never republish the old value.
		if (value == null || this.pendingDeletes.has(key)) return null;

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
			if (this.pendingDeletes.has(k)) continue;
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
				if (this.pendingDeletes.has(k)) continue;
				this.addToCache(k, data);
				results.set(k, data);
			}
		}

		return results;
	}

	async hasChunk(cx: number, cy: number, cz: number): Promise<boolean> {
		const key = chunkKey(cx, cy, cz);
		if (this.pendingDeletes.has(key)) return false;
		if (this.cache.has(key)) return true;
		if (!this.db) return false;
		const value = await this._get(key);
		return value != null && !this.pendingDeletes.has(key);
	}

	async hasChunks(
		coords: Array<{ cx: number; cy: number; cz: number; key?: string }>,
	): Promise<Set<string>> {
		const result = new Set<string>();
		const misses: string[] = [];
		for (const { cx, cy, cz, key } of coords) {
			const k = key ?? chunkKey(cx, cy, cz);
			if (this.pendingDeletes.has(k)) continue;
			if (this.cache.has(k)) {
				result.add(k);
			} else {
				misses.push(k);
			}
		}
		if (misses.length === 0 || !this.db) return result;
		if (typeof window !== "undefined") {
			const found = await (this.db as IndexedDbStore).has(misses);
			for (const k of found) {
				if (!this.pendingDeletes.has(k)) result.add(k);
			}
		} else {
			// Reuse the same batched primitive readChunks relies on, instead
			// of fanning out into N independent level.get() calls (each its
			// own promise + catch) for what is really one existence probe.
			const found = await this._getMany(misses);
			for (const k of found.keys()) {
				if (!this.pendingDeletes.has(k)) result.add(k);
			}
		}
		return result;
	}

	async getMeta(key: string): Promise<string | null> {
		const storageKey = `\x01${key}`;
		const pending = this.pendingMeta.get(storageKey);
		if (pending !== undefined) return pending.value;
		if (!this.db) return null;
		const value = await this._get(storageKey);
		return value == null ? null : String(value);
	}

	// -------------------------------------------------------------------
	// Public write APIs — one promise per call, queued for the pump
	// -------------------------------------------------------------------

	writeChunk(
		cx: number,
		cy: number,
		cz: number,
		data: Uint8Array,
	): Promise<void> {
		return this.enqueueWriteJob([
			{
				kind: "put",
				key: chunkKey(cx, cy, cz),
				value: data,
			},
		]);
	}

	/** Bulk write of a network batch: one job, shared transactions. */
	writeChunks(writes: readonly ChunkWrite[]): Promise<void> {
		if (writes.length === 0) return Promise.resolve();

		const operations = new Array<WriteOperation>(writes.length);
		for (let i = 0; i < writes.length; i++) {
			const write = writes[i];
			operations[i] = {
				kind: "put",
				key: chunkKey(write.cx, write.cy, write.cz),
				value: write.blob,
			};
		}

		return this.enqueueWriteJob(operations);
	}

	deleteChunk(cx: number, cy: number, cz: number): Promise<void> {
		const key = chunkKey(cx, cy, cz);

		// Immediately prevent the corrupt or invalid entry from being
		// returned through the memory cache or rehydrated from storage.
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}
		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}

		this.pendingDeletes.add(key);
		this.cache.delete(key);
		this.touched.delete(key);

		return this.enqueueWriteJob([{ kind: "delete", key }]);
	}

	/** Bulk eviction: one job, tombstoned immediately, shared transactions. */
	deleteChunks(
		coords: readonly { cx: number; cy: number; cz: number }[],
	): Promise<void> {
		if (coords.length === 0) return Promise.resolve();
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}
		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}

		const operations = new Array<WriteOperation>(coords.length);
		for (let i = 0; i < coords.length; i++) {
			const coordinate = coords[i];
			const key = chunkKey(coordinate.cx, coordinate.cy, coordinate.cz);
			this.pendingDeletes.add(key);
			this.cache.delete(key);
			this.touched.delete(key);
			operations[i] = { kind: "delete", key };
		}

		return this.enqueueWriteJob(operations);
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
			this.writeQueue.push({ kind: "barrier", resolve, reject });
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
					if (entry.kind !== "write") continue;
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
				kind: "clear",
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
			{ kind: "put", key: storageKey, value },
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
				kind: "write",
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
			head?.kind === "barrier" ||
			head?.kind === "clear" ||
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
				if (entry.kind === "barrier") {
					this.processBarrier(entry);
					continue;
				}
				if (entry.kind === "clear") {
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
			if (entry.kind === "barrier" || entry.kind === "clear") break;
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
			if (entry.kind !== "write" || !entry.job.cancelled) return;
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
	 * each job's operations contiguously so `prepared` holds job
	 * references (safe even if the queue is compacted later). Cursors are
	 * advanced optimistically before commit; on failure every affected job
	 * is cancelled and its cursor moved to the end, so no rollback is
	 * needed. Never mutates the queue structure while awaiting.
	 */
	private async commitNextTransaction(): Promise<void> {
		const db = this.db;
		if (!db) {
			this.rejectRemainingJobs(new Error("LevelDbChunkStore is not open"));
			return;
		}

		const batch = db.batch();
		const prepared = new Array<PreparedOperation>(
			LevelDbChunkStore.MAX_TRANSACTION_OPS,
		);
		let preparedCount = 0;
		let operationCount = 0;
		let queueIndex = this.writeQueueHead;

		while (
			queueIndex < this.writeQueue.length &&
			operationCount < LevelDbChunkStore.MAX_TRANSACTION_OPS
		) {
			const entry = this.writeQueue[queueIndex];
			if (entry.kind !== "write") break;
			const job = entry.job;
			if (job.cancelled) {
				queueIndex++;
				continue;
			}

			while (
				job.nextOperation < job.operations.length &&
				operationCount < LevelDbChunkStore.MAX_TRANSACTION_OPS
			) {
				const operation = job.operations[job.nextOperation];
				if (operation.kind === "put") {
					batch.put(operation.key, operation.value);
				} else {
					batch.del(operation.key);
				}
				prepared[preparedCount++] = { job, operation };
				job.nextOperation++;
				operationCount++;
			}

			if (job.nextOperation === job.operations.length) {
				queueIndex++;
			} else {
				break;
			}
		}

		prepared.length = preparedCount;

		if (operationCount === 0) {
			this.settleFinishedJobs();
			return;
		}

		try {
			await batch.write();
		} catch (error) {
			const commitError =
				error instanceof Error ? error : new Error(String(error));
			(globalThis as any).__dbg?.(
				"commitNextTransaction caught:",
				commitError.message,
			);
			this.rejectAffectedJobs(prepared, commitError);
			this.skipCancelledEntries();
			(globalThis as any).__dbg?.(
				"pump head after catch:",
				this.writeQueueHead,
				"/",
				this.writeQueue.length,
			);
			return;
		}

		this.publishCommittedOperations(prepared);
		this.skipCancelledEntries();
		this.settleFinishedJobs();
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

		// Clear pre-clear metadata shadows and memory caches before the
		// database wipe so no stale value is visible while it runs.
		this.clearMetaShadowsThrough(entry.metaGeneration);
		this.pendingDeletes.clear();
		this.cache.clear();
		this.touched.clear();
		this.writeQueueHead++;

		if (!db) {
			this.pendingBarrierError = null;
			entry.resolve();
			this.skipCancelledEntries();
			return;
		}

		try {
			if (typeof window !== "undefined") {
				await (db as IndexedDbStore).clear();
			} else {
				await db.clear();
			}
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
		prepared: readonly PreparedOperation[],
	): void {
		for (let i = 0; i < prepared.length; i++) {
			const { job, operation } = prepared[i];
			if (job.cancelled) continue;
			if (operation.kind === "put") {
				if (operation.value instanceof Uint8Array) {
					// A later successful put clears the tombstone so a newly
					// fetched valid chunk can recover a tombstoned key.
					this.pendingDeletes.delete(operation.key);
					this.addToCache(operation.key, operation.value);
				}
			} else {
				this.pendingDeletes.delete(operation.key);
				this.cache.delete(operation.key);
				this.touched.delete(operation.key);
			}
		}
	}

	/** Resolves the contiguous run of fully-consumed jobs at the head. */
	private settleFinishedJobs(): void {
		while (this.writeQueueHead < this.writeQueue.length) {
			const entry = this.writeQueue[this.writeQueueHead];
			if (entry.kind !== "write") break;
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
		prepared: readonly PreparedOperation[],
		error: Error,
	): void {
		let previousJob: WriteJob | undefined;
		for (let i = 0; i < prepared.length; i++) {
			const job = prepared[i].job;
			if (job === previousJob) continue;
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
			if (entry.kind === "write") {
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
		if (this.maxCacheSize === 0) return;
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
					// Metadata values are stored as strings.
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
	private ops: Array<{ key: string; value: Uint8Array | string | null }> = [];

	constructor(
		private db: IDBDatabase,
		private storeName: string,
	) {}

	put(key: string, value: Uint8Array | string): void {
		this.ops.push({ key, value });
	}

	del(key: string): void {
		this.ops.push({ key, value: null });
	}

	/**
	 * One readwrite transaction for all queued operations. Resolves only
	 * on tx.oncomplete (the commit boundary), rejects on error/abort; no
	 * per-request success handlers.
	 */
	async write(): Promise<void> {
		if (this.ops.length === 0) return;
		const ops = this.ops;
		this.ops = [];
		await new Promise<void>((resolve, reject) => {
			const tx = this.db.transaction(this.storeName, "readwrite");
			const store = tx.objectStore(this.storeName);
			for (let i = 0; i < ops.length; i++) {
				const operation = ops[i];
				if (operation.value === null) {
					store.delete(operation.key);
				} else {
					store.put(operation.value, operation.key);
				}
			}
			tx.oncomplete = () => resolve();
			const fail = () => {
				reject(tx.error ?? new Error("IndexedDB transaction failed"));
			};
			tx.onerror = fail;
			tx.onabort = fail;
		});
	}
}
