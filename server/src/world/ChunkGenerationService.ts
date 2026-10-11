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
}

function createOwnedBatchEntry(entry: UniqueBatchEntry): OwnedBatchEntry {
	let resolve!: (value: ChunkData) => void;
	let reject!: (reason?: unknown) => void;

	const promise = new Promise<ChunkData>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return {
		key: entry.key,
		chunkX: entry.chunkX,
		chunkY: entry.chunkY,
		chunkZ: entry.chunkZ,
		promise,
		resolve,
		reject,
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
	 * Every value is removed after settlement, provided it still owns its key.
	 */
	private readonly dedupMap = new Map<number, Promise<ChunkData>>();

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
			return existing;
		}

		const generation = this.generateAndPersist(
			chunkX,
			chunkY,
			chunkZ,
			priority,
		);

		this.dedupMap.set(key, generation);

		/*
		 * Using then(success, failure) creates one derived promise instead of
		 * the finally().catch() chain, which created two.
		 */
		const removeDedupEntry = (): void => {
			if (this.dedupMap.get(key) === generation) {
				this.dedupMap.delete(key);
			}
		};

		void generation.then(removeDedupEntry, removeDedupEntry);

		return generation;
	}

	private async generateAndPersist(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		priority: TaskPriority,
	): Promise<ChunkData> {
		await this.ensurePool();

		const raw = await this.pool.dispatch(chunkX, chunkY, chunkZ, priority);

		const data = toChunkData(chunkX, chunkY, chunkZ, raw);

		/*
		 * PERSISTENCE IS OFF THE DELIVERY CRITICAL PATH.
		 *
		 * This used to `await this.persistChunk(data)` before returning, which
		 * put a full storage round-trip (serialize 32-98 KB, enqueue, LevelDB
		 * batch commit) inside the time-to-first-byte for every chunk the client
		 * is waiting on. Storage is not the throughput bottleneck, so paying for
		 * it before responding only added latency to every chunk.
		 *
		 * Fire-and-forget is safe because the dedupMap entry for this key is
		 * owned by the returned promise and removed on settlement, so a
		 * concurrent request cannot slip past the write. A failure is logged and
		 * the chunk is simply regenerated on next request — losing a cached copy
		 * is strictly better than making the player wait for it.
		 */
		this.schedulePersist(data);

		return data;
	}

	private schedulePersist(data: ChunkData): void {
		const storage = this.storage;

		if (storage === null) {
			return;
		}

		/*
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
		this.persistQueue.push(data);
		this.drainPersistQueue();
	}

	private readonly persistQueue: ChunkData[] = [];
	private persistWriters = 0;
	private static readonly PERSIST_CONCURRENCY = 2;

	private drainPersistQueue(): void {
		while (
			this.persistWriters < ChunkGenerationService.PERSIST_CONCURRENCY &&
			this.persistQueue.length > 0
		) {
			const data = this.persistQueue.shift()!;
			const storage = this.storage;

			if (storage === null) {
				continue;
			}

			this.persistWriters++;

			void storage
				.writeChunk(data)
				.catch((error: unknown) => {
					console.warn(
						`[ChunkGeneration] background persist failed for ` +
							`${data.chunkX},${data.chunkY},${data.chunkZ}:`,
						error,
					);
				})
				.finally(() => {
					this.persistWriters--;
					this.drainPersistQueue();
				});
		}
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
				promises[uniqueIndex] = existing;
				continue;
			}

			const ownedEntry = createOwnedBatchEntry(entry);

			promises[uniqueIndex] = ownedEntry.promise;
			owned.push(ownedEntry);
			this.dedupMap.set(ownedEntry.key, ownedEntry.promise);
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
			 * Safe because the dedupMap entry for each key is owned by that
			 * entry's promise and removed on settlement: a concurrent request
			 * cannot slip past the write, and a failed write degrades to
			 * regenerating the chunk rather than to dropping it.
			 */
			this.schedulePersistBatch(chunks);

			for (let index = 0; index < ownedCount; index++) {
				owned[index].resolve(chunks[index]);
			}
		} catch (error: unknown) {
			/*
			 * Reject every owned promise so no batch caller remains pending.
			 */
			for (let index = 0; index < ownedCount; index++) {
				owned[index].reject(error);
			}
		} finally {
			/*
			 * Remove only keys still owned by this dispatch.
			 */
			for (let index = 0; index < ownedCount; index++) {
				const entry = owned[index];

				if (this.dedupMap.get(entry.key) === entry.promise) {
					this.dedupMap.delete(entry.key);
				}
			}
		}
	}

	/*
	 * Batch persistence shares the same bounded writer budget as single chunks.
	 *
	 * schedulePersistBatch deliberately funnels into the SAME queue rather than
	 * calling persistChunks directly: persistChunks has its own concurrency of 8,
	 * which combined with the single-chunk writers meant up to 10 concurrent
	 * serialize+compress operations competing with generation for CPU. One shared
	 * budget keeps the total bounded regardless of which path enqueued the work.
	 */
	private schedulePersistBatch(chunks: readonly ChunkData[]): void {
		if (this.storage === null) {
			return;
		}

		for (let i = 0; i < chunks.length; i++) {
			this.persistQueue.push(chunks[i]);
		}

		this.drainPersistQueue();
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
	}
}
