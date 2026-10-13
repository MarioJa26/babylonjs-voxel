/**
 * ChunkGenerationService — server-side terrain generation.
 *
 * Uses a worker thread pool for parallel chunk generation, request
 * deduplication to avoid duplicate work, and batch dispatch for efficiency.
 *
 * After generation, chunks are persisted to LevelDB storage so they can be
 * served from disk on subsequent requests.
 */

import { packChunkKeyFast } from "@/code/World/Storage/ChunkKey.ts";
import {
	ChunkWorkerPool,
	TaskPriority,
} from "../workers/ChunkWorkerPool.ts";
import type { ServerWorldStorage } from "./ServerWorldStorage.ts";

export interface ChunkData {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	blocks: Uint8Array | Uint16Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
	version: number;
}

interface ChunkCoord {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
}

interface RawChunkResult {
	blocks: Uint8Array | Uint16Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
}

/**
 * One unique coordinate in a batch.
 *
 * Duplicate output positions are recorded once per input index in the
 * batch-wide inputToUniqueIndex table rather than by a per-entry array, so
 * this stays a flat coordinate record.
 */
interface UniqueBatchEntry extends ChunkCoord {
	key: number;
}

/**
 * A batch entry whose generation is owned by the current batch.
 *
 * Keeping the deferred fields directly on the entry avoids allocating a
 * separate wrapper containing both the entry and its promise controls.
 */
interface OwnedBatchEntry extends UniqueBatchEntry {
	promise: Promise<ChunkData>;
	resolve(value: ChunkData): void;
	reject(reason?: unknown): void;
	/**
	 * The dedup entry registered for this chunk.
	 *
	 * Its `persisted` field starts as NEVER_SETTLED and is replaced with the
	 * real write settlement once the batch has been scheduled. That ordering is
	 * deliberate: between registration and scheduling there is no write that
	 * could release the entry, so a premature release would reopen the
	 * duplicate-generation window this dedup map exists to close.
	 */
	dedup: DedupEntry;
}

/**
 * A promise that never settles, used as a placeholder before the real write
 * settlement is known. A release handler attached to it never fires, which is
 * exactly the required behaviour: do not release until a write exists.
 */
const NEVER_SETTLED = new Promise<void>(() => {});

function createOwnedBatchEntry(entry: UniqueBatchEntry): OwnedBatchEntry {
	let resolve!: (value: ChunkData) => void;
	let reject!: (reason?: unknown) => void;

	const promise = new Promise<ChunkData>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	const dedup: DedupEntry = { chunk: promise, persisted: NEVER_SETTLED };

	return {
		key: entry.key,
		chunkX: entry.chunkX,
		chunkY: entry.chunkY,
		chunkZ: entry.chunkZ,
		promise,
		resolve,
		reject,
		dedup,
	};
}

function toChunkData(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	raw: RawChunkResult,
): ChunkData {
	return {
		chunkX,
		chunkY,
		chunkZ,
		blocks: raw.blocks,
		light: raw.light,
		palette: raw.palette,
		isUniform: raw.isUniform,
		uniformBlockId: raw.uniformBlockId,
		version: 1,
	};
}

function compareOwnedEntries(
	left: OwnedBatchEntry,
	right: OwnedBatchEntry,
): number {
	const xDifference = left.chunkX - right.chunkX;
	if (xDifference !== 0) {
		return xDifference;
	}

	const zDifference = left.chunkZ - right.chunkZ;
	if (zDifference !== 0) {
		return zDifference;
	}

	return left.chunkY - right.chunkY;
}

/**
 * One in-flight generation, plus the write that follows it.
 *
 * `chunk` is what callers await. `persisted` settles only after the background
 * write completes, which is what the dedup entry's lifetime is keyed to — see
 * generateChunk for why releasing on `chunk` alone was wrong.
 */
type DedupEntry = {
	chunk: Promise<ChunkData>;
	persisted: Promise<void>;
};

/**
 * One queued background write.
 *
 * The entry owns the settlement signal so the queue can both hand a promise to
 * `generateChunk` (which keeps the dedup entry open) and answer a later lookup
 * for the same chunk with the same handle. `settle()` is idempotent because a
 * discarded entry (storage removed) and a written one can both be reached.
 */
type PersistQueueEntry = {
	data: ChunkData;
	settled: Promise<void>;
	settle: () => void;
};

function createPersistQueueEntry(data: ChunkData): PersistQueueEntry {
	let settle: () => void = () => {};

	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});

	return { data, settled, settle };
}

export class ChunkGenerationService {
	private readonly pool = new ChunkWorkerPool();

	private seed = "default";
	private wasmEnabled = true;
	private poolSizeOverride = 0;
	private initialized = false;
	private terminating = false;

	private initPromise: Promise<void> | null = null;
	private storage: ServerWorldStorage | null = null;

	/**
	 * Keyed by packChunkKeyFast(chunkX, chunkY, chunkZ).
	 *
	 * Every value is removed once its background WRITE settles, provided it
	 * still owns its key.
	 */
	private readonly dedupMap = new Map<number, DedupEntry>();

	/**
	 * Configure terrain generation before initialization starts.
	 *
	 * `poolSizeOverride` > 0 pins the worker thread count. 0 sizes it from
	 * detected PHYSICAL cores (see workers/PhysicalCores.ts) — never from
	 * `cpus().length`, which reports hardware threads and oversubscribes every
	 * SMT machine.
	 */
	setSeed(seed: string, wasmEnabled = true, poolSizeOverride = 0): void {
		if (this.initialized || this.initPromise !== null) {
			throw new Error(
				"Chunk generation configuration cannot change after initialization has started",
			);
		}

		this.seed = seed;
		this.wasmEnabled = wasmEnabled;
		this.poolSizeOverride = poolSizeOverride;
	}

	/**
	 * Attach or remove the storage backend used after generation.
	 */
	setStorage(storage: ServerWorldStorage | null): void {
		this.storage = storage;
	}

	/**
	 * Initialize the worker pool once, retrying after initialization failures.
	 */
	private ensurePool(): Promise<void> {
		if (this.terminating) {
			return Promise.reject(
				new Error("Chunk generation service is terminating"),
			);
		}

		const existing = this.initPromise;
		if (existing !== null) {
			return existing;
		}

		const initialization = this.pool.initialize(
			this.seed,
			this.wasmEnabled,
			this.poolSizeOverride,
		);

		this.initPromise = initialization;

		/*
		 * One derived promise is unavoidable here because initialization state
		 * must be updated after settlement. Both branches handle settlement, so
		 * the derived promise cannot become an unhandled rejection.
		 */
		void initialization.then(
			() => {
				if (this.initPromise === initialization) {
					this.initialized = true;
				}
			},
			() => {
				/*
				 * Do not cache a permanent failure. Clear only if this promise
				 * still owns the initialization slot.
				 */
				if (this.initPromise === initialization) {
					this.initPromise = null;
					this.initialized = false;
				}
			},
		);

		return initialization;
	}

	/**
	 * Generate one chunk, sharing any generation already in progress for the
	 * same packed coordinate key.
	 *
	 * `priority` selects the worker-queue tier. Interactive (default) means a
	 * player is waiting for this chunk right now; Background is for spawn
	 * prewarm, which must never delay a player.
	 */
	generateChunk(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		priority: TaskPriority = TaskPriority.Interactive,
	): Promise<ChunkData> {
		const key = packChunkKeyFast(chunkX, chunkY, chunkZ);
		const existing = this.dedupMap.get(key);

		if (existing !== undefined) {
			return existing.chunk;
		}

		const dataPromise = this.generateChunkData(
			chunkX,
			chunkY,
			chunkZ,
			priority,
		);

		/*
		 * The dedup entry is held until the BACKGROUND WRITE settles, not until
		 * generation settles.
		 *
		 * Releasing it on generation settlement closed the dedup window while the
		 * write was still only QUEUED. With PERSIST_CONCURRENCY = 2, a burst of
		 * more than two chunks leaves the rest sitting in persistQueue, so any
		 * client that re-requested one of those coordinates in that window got a
		 * fresh full worker dispatch instead of the result already in hand — and
		 * the duplicate write then raced the original for the same key.
		 *
		 * Chaining persistence OFF delivery, and the dedup release off
		 * persistence, keeps delivery off the write's critical path while closing
		 * the window at exactly the right moment.
		 */
		const entry: DedupEntry = {
			chunk: dataPromise,
			persisted: dataPromise.then(
				(data) => this.schedulePersist(data),
				// Generation failed, so nothing was queued. Release immediately.
				() => Promise.resolve(),
			),
		};

		this.dedupMap.set(key, entry);

		const releaseDedupEntry = (): void => {
			if (this.dedupMap.get(key) === entry) {
				this.dedupMap.delete(key);
			}
		};

		void entry.persisted.then(releaseDedupEntry, releaseDedupEntry);

		return entry.chunk;
	}

	private async generateChunkData(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		priority: TaskPriority,
	): Promise<ChunkData> {
		await this.ensurePool();

		const raw = await this.pool.dispatch(chunkX, chunkY, chunkZ, priority);

		return toChunkData(chunkX, chunkY, chunkZ, raw);
	}

	/**
	 * Add one generated chunk to bounded background persistence.
	 *
	 * Background writes must stay BOUNDED.
	 *
	 * Delivery no longer waits on persistence, which means writes now run
	 * concurrently with generation and with each other. Unbounded, a cold
	 * join launches one serialize+compress per chunk with nothing holding
	 * it back — and since writeChunkUnlocked now compresses, that is real
	 * CPU (deflate over 32-98 KB) on the same box as the generation workers
	 * and the game client. An unbounded write firehout starves exactly the
	 * work that makes chunks appear.
	 *
	 * A small FIFO with a fixed number of concurrent writers bounds both
	 * memory and CPU while keeping writes strictly behind the chunks the
	 * client is actually waiting for.
	 *
	 * Returns a promise that settles with the write. Callers use it to keep a
	 * dedup entry alive for the write's lifetime; delivery ignores it.
	 */
	private schedulePersist(data: ChunkData): Promise<void> {
		if (this.terminating || this.storage === null) {
			/*
			 * No write will happen, so resolve immediately rather than leaving a
			 * dedup entry pinned to a settlement that never arrives. The chunk is
			 * simply not cached; the next request regenerates it.
			 */
			return Promise.resolve();
		}

		const entry = createPersistQueueEntry(data);
		this.persistQueue.push(entry);
		this.drainPersistQueue();
		return entry.settled;
	}

	/**
	 * Add one generated chunk to bounded background persistence.
	 *
	 * Background writes must stay BOUNDED.
	 *
	 * Delivery no longer waits on persistence, which means writes now run
	 * concurrently with generation and with each other. Unbounded, a cold
	 * join launches one serialize+compress per chunk with nothing holding
	 * it back — and since writeChunkUnlocked now compresses, that is real
	 * CPU (deflate over 32-98 KB) on the same box as the generation workers
	 * and the game client. An unbounded write firehout starves exactly the
	 * work that makes chunks appear.
	 *
	 * A small FIFO with a fixed number of concurrent writers bounds both
	 * memory and CPU while keeping writes strictly behind the chunks the
	 * client is actually waiting for.
	 */

	/**
	 * Background persistence queue entry.
	 *
	 * `settle` is the promise handed back to generateChunk so it can hold the
	 * dedup entry open until the write finishes, and `settled` is that promise
	 * itself, for callers that arrive later and need the same handle.
	 */
	private readonly persistQueue: PersistQueueEntry[] = [];
	private persistQueueHead = 0;
	private persistWriters = 0;

	private static readonly PERSIST_CONCURRENCY = 2;

	/**
	 * Resolvers waiting for the persistence pipeline to become idle.
	 */
	private persistIdleWaiters: Array<() => void> = [];

	private hasQueuedPersists(): boolean {
		return this.persistQueueHead < this.persistQueue.length;
	}

	/**
	 * Release callers waiting for all queued and active persistence work to finish.
	 */
	private notifyPersistIdle(): void {
		if (
			this.hasQueuedPersists() ||
			this.persistWriters !== 0 ||
			this.persistIdleWaiters.length === 0
		) {
			return;
		}

		/*
		 * The queue is fully consumed. Reset it here rather than retaining references
		 * to every previously persisted chunk through the consumed array prefix.
		 */
		this.persistQueue.length = 0;
		this.persistQueueHead = 0;

		const waiters = this.persistIdleWaiters;
		this.persistIdleWaiters = [];

		for (let i = 0; i < waiters.length; i++) {
			waiters[i]();
		}
	}

	/**
	 * Resolve once all queued and active persistence work has finished.
	 */
	private awaitPersistIdle(): Promise<void> {
		if (!this.hasQueuedPersists() && this.persistWriters === 0) {
			/*
			 * Release consumed entries even when there are no registered waiters.
			 * This prevents an idle service from retaining the entire processed
			 * queue until another persistence burst arrives.
			 */
			this.persistQueue.length = 0;
			this.persistQueueHead = 0;

			return Promise.resolve();
		}

		return new Promise<void>((resolve) => {
			this.persistIdleWaiters.push(resolve);
		});
	}

	/**
	 * Submit queued persistence work while respecting the global writer limit.
	 *
	 * Queue removal is O(1). Each completion re-enters this method to claim the next
	 * item, keeping no more than PERSIST_CONCURRENCY storage writes active.
	 */
	private drainPersistQueue(): void {
		const queue = this.persistQueue;
		const maxWriters = ChunkGenerationService.PERSIST_CONCURRENCY;

		while (
			this.persistWriters < maxWriters &&
			this.persistQueueHead < queue.length
		) {
			const entry = queue[this.persistQueueHead++]!;
			const data = entry.data;

			/*
			 * Read storage when the item is dispatched, preserving the previous
			 * behavior when setStorage() replaces or removes the backend after the
			 * chunk was queued.
			 */
			const storage = this.storage;

			if (storage === null) {
				entry.settle();
				continue;
			}

			this.persistWriters++;

			void storage.writeChunk(data).then(
				() => {
					entry.settle();
					this.onPersistSettled();
				},
				(error: unknown) => {
					/*
					 * Losing a cached copy is harmless — the chunk is regenerated
					 * on the next request. Losing it to a storage that is already
					 * closing is the expected shape of shutdown, not a fault, so
					 * it gets one line instead of a stack trace per chunk.
					 */
					const storageClosed =
						error instanceof Error &&
						error.message.includes("closing or closed");

					if (storageClosed) {
						console.warn(
							`[ChunkGeneration] dropped background persist for ` +
								`${data.chunkX},${data.chunkY},${data.chunkZ}: ` +
								`storage closed`,
						);
					} else {
						console.warn(
							`[ChunkGeneration] background persist failed for ` +
								`${data.chunkX},${data.chunkY},${data.chunkZ}:`,
							error,
						);
					}

					entry.settle();
					this.onPersistSettled();
				},
			);
		}

		/*
		 * If queued entries were discarded because storage became unavailable, the
		 * loop may reach idle without starting a promise whose completion would
		 * otherwise perform this notification.
		 */
		this.notifyPersistIdle();
	}

	/**
	 * Shared completion path for successful and failed background writes.
	 */
	private onPersistSettled(): void {
		this.persistWriters--;
		this.compactPersistQueue();
		this.drainPersistQueue();
	}

	/**
	 * Release the consumed prefix so completed ChunkData objects do not stay
	 * strongly referenced during long-running generation sessions.
	 *
	 * Each entry holds a decoded chunk (32-98 KB of typed arrays), so a consumed
	 * prefix is not free memory — it is the dominant retention in a long
	 * session. Dropping the reference is O(1) per slot and runs on every
	 * completion; the expensive array compaction below is separate and remains
	 * amortized.
	 */
	private compactPersistQueue(): void {
		const head = this.persistQueueHead;
		const queue = this.persistQueue;

		/*
		 * Null the consumed slots first. `queue.length = 0` below handles the
		 * fully-drained case, and `copyWithin` handles the partial case, but
		 * between the write finishing and either of those running, the prefix is
		 * still live. ChunkData holds decoded block and light arrays, so those
		 * are the largest single allocations the service makes.
		 */
		for (let i = 0; i < head; i++) {
			queue[i] = undefined as unknown as PersistQueueEntry;
		}

		if (head === queue.length) {
			queue.length = 0;
			this.persistQueueHead = 0;
			return;
		}

		/*
		 * Compact only after a substantial consumed prefix exists and it represents
		 * at least half the array. This keeps total copy work amortized O(n).
		 */
		if (head < 1024 || head * 2 < queue.length) {
			return;
		}

		queue.copyWithin(0, head);
		queue.length -= head;
		this.persistQueueHead = 0;
	}

	/**
	 * Generate a batch of chunks.
	 *
	 * This deduplicates:
	 * - repeated coordinates within the input
	 * - coordinates already being generated by another single request
	 * - coordinates already owned by another batch
	 *
	 * Results retain the exact order and duplicate positions of the input.
	 */
	async generateChunksBatch(
		coords: readonly ChunkCoord[],
		priority: TaskPriority = TaskPriority.Interactive,
	): Promise<ChunkData[]> {
		const coordinateCount = coords.length;

		if (coordinateCount === 0) {
			return [];
		}

		const uniqueIndexByKey = new Map<number, number>();
		const uniqueEntries: UniqueBatchEntry[] = [];

		/*
		 * Maps each input position to its entry in uniqueEntries. One dense
		 * typed array replaces the per-entry outputIndices arrays, which
		 * allocated one array plus a boxed number per duplicate.
		 *
		 * Uint32 covers far more entries than a practical batch request.
		 */
		const inputToUniqueIndex = new Uint32Array(coordinateCount);

		/*
		 * Store the unique-entry index rather than the entry object so that
		 * duplicate handling is a direct integer assignment.
		 */
		for (let inputIndex = 0; inputIndex < coordinateCount; inputIndex++) {
			const coordinate = coords[inputIndex];

			const key = packChunkKeyFast(
				coordinate.chunkX,
				coordinate.chunkY,
				coordinate.chunkZ,
			);

			const existingUniqueIndex = uniqueIndexByKey.get(key);

			if (existingUniqueIndex !== undefined) {
				inputToUniqueIndex[inputIndex] = existingUniqueIndex;
				continue;
			}

			const uniqueIndex = uniqueEntries.length;

			uniqueIndexByKey.set(key, uniqueIndex);
			inputToUniqueIndex[inputIndex] = uniqueIndex;

			uniqueEntries.push({
				key,
				chunkX: coordinate.chunkX,
				chunkY: coordinate.chunkY,
				chunkZ: coordinate.chunkZ,
			});
		}

		const uniqueCount = uniqueEntries.length;
		const promises = new Array<Promise<ChunkData>>(uniqueCount);
		const owned: OwnedBatchEntry[] = [];

		/*
		 * Register every newly owned promise synchronously before the first
		 * await. Overlapping requests can therefore reuse this work.
		 */
		for (let uniqueIndex = 0; uniqueIndex < uniqueCount; uniqueIndex++) {
			const entry = uniqueEntries[uniqueIndex];
			const existing = this.dedupMap.get(entry.key);

			if (existing !== undefined) {
				promises[uniqueIndex] = existing.chunk;
				continue;
			}

			const ownedEntry = createOwnedBatchEntry(entry);

			promises[uniqueIndex] = ownedEntry.promise;
			owned.push(ownedEntry);
			this.dedupMap.set(ownedEntry.key, ownedEntry.dedup);
		}

		if (owned.length !== 0) {
			/*
			 * Sort only entries generated by this batch. Entries already in
			 * flight do not participate in this dispatch.
			 *
			 * promises stays aligned with uniqueEntries because each entry
			 * carries its own resolve function, so reordering owned cannot
			 * misalign any result.
			 */
			owned.sort(compareOwnedEntries);

			/*
			 * dispatchOwnedBatch catches generation and persistence failures,
			 * rejects all owned deferred promises, and removes their dedup keys.
			 */
			void this.dispatchOwnedBatch(owned, priority);
		}

		/*
		 * Await the original ChunkData promises directly. The previous version
		 * allocated one closure and one Promise<void> per unique entry merely
		 * to scatter each individual result.
		 */
		const uniqueResults = await Promise.all(promises);
		const results = new Array<ChunkData>(coordinateCount);

		/*
		 * Scatter in one linear pass over the input. Duplicate positions read
		 * the same unique slot, so they reference the identical ChunkData
		 * object.
		 */
		for (let inputIndex = 0; inputIndex < coordinateCount; inputIndex++) {
			results[inputIndex] = uniqueResults[inputToUniqueIndex[inputIndex]];
		}

		return results;
	}

	/**
	 * Generate, persist, and settle every chunk owned by one batch.
	 */
	private async dispatchOwnedBatch(
		owned: OwnedBatchEntry[],
		priority: TaskPriority,
	): Promise<void> {
		const ownedCount = owned.length;

		try {
			await this.ensurePool();

			/*
			 * OwnedBatchEntry structurally contains ChunkCoord, so it can be
			 * passed directly. ChunkWorkerPool.dispatchAll() snapshots each
			 * coordinate before queuing worker work.
			 *
			 * This avoids allocating one additional coordinate object per
			 * owned chunk.
			 */
			const rawResults = await this.pool.dispatchAll(owned, priority);

			if (rawResults.length !== ownedCount) {
				throw new Error(
					`Worker batch result length mismatch: expected ${ownedCount}, received ${rawResults.length}`,
				);
			}

			const chunks = new Array<ChunkData>(ownedCount);

			for (let index = 0; index < ownedCount; index++) {
				const entry = owned[index];

				chunks[index] = toChunkData(
					entry.chunkX,
					entry.chunkY,
					entry.chunkZ,
					rawResults[index],
				);
			}

			/*
			 * PERSISTENCE IS OFF THE DELIVERY CRITICAL PATH.
			 *
			 * This used to `await this.persistChunks(chunks)` before resolving
			 * any owned promise, so the caller — and therefore the client — paid
			 * a full storage round-trip for the entire batch before a single
			 * chunk could be sent. Storage is not the throughput bottleneck, and
			 * the client already streams sub-batches as they complete, so paying
			 * it up front only added latency to everything.
			 *
			 * Safe because the dedupMap entry for each key is held open until
			 * that chunk's background write settles — see generateChunk. A
			 * concurrent request inside that window joins this batch's entry
			 * instead of dispatching a second worker, and a failed write
			 * degrades to regenerating the chunk rather than to dropping it.
			 */
			const settlements = this.schedulePersistBatch(chunks);

			for (let index = 0; index < ownedCount; index++) {
				owned[index].resolve(chunks[index]);
			}

			/*
			 * Release each dedup entry when THAT chunk's write settles, not when
			 * the batch resolves. A batch of 32 against PERSIST_CONCURRENCY = 2
			 * means the tail sits in persistQueue for many frames; releasing all
			 * entries at delivery time would reopen exactly the duplicate-
			 * generation window that generateChunk now closes.
			 */
			for (let index = 0; index < ownedCount; index++) {
				const entry = owned[index];
				if (!entry) continue;

				const settlement = settlements[index] ?? Promise.resolve();
				entry.dedup.persisted = settlement;

				const releaseDedupEntry = (): void => {
					if (this.dedupMap.get(entry.key) === entry.dedup) {
						this.dedupMap.delete(entry.key);
					}
				};

				void settlement.then(releaseDedupEntry, releaseDedupEntry);
			}
		} catch (error: unknown) {
			/*
			 * Reject every owned promise so no batch caller remains pending.
			 */
			for (let index = 0; index < ownedCount; index++) {
				owned[index].reject(error);
			}

			// A throw before schedulePersistBatch means nothing was queued, so
			// these entries are safe to release now.
			for (let index = 0; index < ownedCount; index++) {
				const entry = owned[index];

				if (this.dedupMap.get(entry.key) === entry.dedup) {
					this.dedupMap.delete(entry.key);
				}
			}
		}
	}

	/**
	 * Add a generated batch to the same bounded persistence pipeline used by
	 * single-chunk generation.
	 *
	 * schedulePersistBatch deliberately funnels into the SAME queue rather than
	 * calling persistChunks directly: persistChunks has its own concurrency of 8,
	 * which combined with the single-chunk writers meant up to 10 concurrent
	 * serialize+compress operations competing with generation for CPU. One shared
	 * budget keeps the total bounded regardless of which path enqueued the work.
	 *
	 * Returns one settlement promise per chunk, in order, so the caller can hold
	 * each chunk's dedup entry open until its own write lands.
	 */
	private schedulePersistBatch(chunks: readonly ChunkData[]): Promise<void>[] {
		if (
			this.terminating ||
			this.storage === null ||
			chunks.length === 0
		) {
			return chunks.map(() => Promise.resolve());
		}

		const queue = this.persistQueue;
		const settlements: Promise<void>[] = new Array(chunks.length);

		for (let i = 0; i < chunks.length; i++) {
			const entry = createPersistQueueEntry(chunks[i]!);
			queue.push(entry);
			settlements[i] = entry.settled;
		}

		this.drainPersistQueue();

		return settlements;
	}

	private persistChunk(data: ChunkData): Promise<void> {
		const storage = this.storage;

		if (storage === null) {
			return Promise.resolve();
		}

		return storage.writeChunk(data);
	}

	/**
	 * Persist a batch with bounded write concurrency.
	 *
	 * RETAINED, not used by the generation path: persistQueue + drainPersistQueue
	 * own all generation writes now, because they are fire-and-forget and
	 * therefore need one shared concurrency bound. Callers that must AWAIT a
	 * batch write (world-save paths) still use this.
	 */
	private async persistChunks(
		chunks: readonly ChunkData[],
		concurrency = 8,
	): Promise<void> {
		const chunkCount = chunks.length;

		if (chunkCount === 0) {
			return;
		}

		const storage = this.storage;

		/*
		 * Check storage once for the whole batch instead of once per chunk.
		 * This also preserves the original snapshot-like behavior after batch
		 * persistence begins.
		 */
		if (storage === null) {
			return;
		}

		const writerCount = Math.min(concurrency, chunkCount);

		let nextIndex = 0;

		/**
		 * The shared counter is safe because JavaScript executes synchronously
		 * until each await. Every writer claims an index before yielding.
		 */
		const writeNext = async (): Promise<void> => {
			for (;;) {
				const index = nextIndex++;

				if (index >= chunkCount) {
					return;
				}

				await storage.writeChunk(chunks[index]);
			}
		};

		/*
		 * Allocate one promise per active writer, capped by concurrency, rather
		 * than one persistence promise per chunk.
		 */
		const writers = new Array<Promise<void>>(writerCount);

		for (let index = 0; index < writerCount; index++) {
			writers[index] = writeNext();
		}

		await Promise.all(writers);
	}

	async relightChunk(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		blocks: Uint8Array | Uint16Array,
		topSunlightMask?: Uint8Array,
		neighborLight?: ReadonlyArray<Uint8Array | null>,
	): Promise<Uint8Array> {
		await this.ensurePool();

		return this.pool.postRelight(
			chunkX,
			chunkY,
			chunkZ,
			blocks,
			topSunlightMask,
			neighborLight,
		);
	}

	async terminate(): Promise<void> {
		if (this.terminating) {
			return;
		}

		this.terminating = true;
		const activeGenerations = Array.from(this.dedupMap.values());

		try {
			/*
			 * Pool termination rejects queued and in-flight work, allowing all
			 * deferred batch promises and single-generation promises to settle.
			 */
			await this.pool.terminate();
			await Promise.allSettled(activeGenerations);
		} finally {
			this.dedupMap.clear();
			this.initPromise = null;
			this.initialized = false;
		}

		/*
		 * Background writes are fire-and-forget, so terminating the pool does
		 * NOT quiesce them. schedulePersist refuses new work once terminating
		 * is set, but the queue can still hold chunks enqueued earlier, and every
		 * in-flight writer re-enters drainPersistQueue as it settles — which
		 * would submit MORE writes after the caller has moved on to
		 * worldStorage.dispose().
		 *
		 * Draining here keeps that ordering intact: every background write is
		 * handed to a still-active storage before terminate() resolves, so
		 * dispose() sees the full mutation set instead of racing it.
		 */
		this.drainPersistQueue();
		await this.awaitPersistIdle();
	}
}
