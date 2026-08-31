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
import { ChunkWorkerPool } from "../workers/ChunkWorkerPool.ts";
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
 * outputIndices contains every position in the caller's input occupied by this
 * coordinate, preserving duplicates and original ordering.
 */
interface UniqueBatchEntry extends ChunkCoord {
	key: number;
	outputIndices: number[];
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
		outputIndices: entry.outputIndices,
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
	 */
	setSeed(seed: string, wasmEnabled = true): void {
		if (this.initialized || this.initPromise !== null) {
			throw new Error(
				"Chunk generation configuration cannot change after initialization has started",
			);
		}

		this.seed = seed;
		this.wasmEnabled = wasmEnabled;
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

		const initialization = this.pool.initialize(this.seed, this.wasmEnabled);

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
	 */
	generateChunk(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): Promise<ChunkData> {
		const key = packChunkKeyFast(chunkX, chunkY, chunkZ);
		const existing = this.dedupMap.get(key);

		if (existing !== undefined) {
			return existing;
		}

		const generation = this.generateAndPersist(chunkX, chunkY, chunkZ);

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
	): Promise<ChunkData> {
		await this.ensurePool();

		const raw = await this.pool.dispatch(chunkX, chunkY, chunkZ);

		const data = toChunkData(chunkX, chunkY, chunkZ, raw);

		/*
		 * Persistence completes before the caller receives the chunk and before
		 * the owning dedup entry is removed.
		 */
		await this.persistChunk(data);

		return data;
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
	): Promise<ChunkData[]> {
		const coordinateCount = coords.length;

		if (coordinateCount === 0) {
			return [];
		}

		const uniqueByKey = new Map<number, UniqueBatchEntry>();
		const uniqueEntries: UniqueBatchEntry[] = [];

		/*
		 * Deduplicate locally while recording every output position.
		 *
		 * uniqueEntries avoids a later Array.from(uniqueByKey.values())
		 * allocation and provides stable index alignment with promises.
		 */
		for (let index = 0; index < coordinateCount; index++) {
			const coordinate = coords[index];

			const key = packChunkKeyFast(
				coordinate.chunkX,
				coordinate.chunkY,
				coordinate.chunkZ,
			);

			const existing = uniqueByKey.get(key);

			if (existing !== undefined) {
				existing.outputIndices.push(index);
				continue;
			}

			const entry: UniqueBatchEntry = {
				key,
				chunkX: coordinate.chunkX,
				chunkY: coordinate.chunkY,
				chunkZ: coordinate.chunkZ,
				outputIndices: [index],
			};

			uniqueByKey.set(key, entry);
			uniqueEntries.push(entry);
		}

		const uniqueCount = uniqueEntries.length;
		const promises = new Array<Promise<ChunkData>>(uniqueCount);
		const owned: OwnedBatchEntry[] = [];

		/*
		 * Register every newly owned promise synchronously before the first
		 * await. Overlapping requests can therefore reuse this work.
		 */
		for (let index = 0; index < uniqueCount; index++) {
			const entry = uniqueEntries[index];
			const existing = this.dedupMap.get(entry.key);

			if (existing !== undefined) {
				promises[index] = existing;
				continue;
			}

			const ownedEntry = createOwnedBatchEntry(entry);

			promises[index] = ownedEntry.promise;
			owned.push(ownedEntry);
			this.dedupMap.set(ownedEntry.key, ownedEntry.promise);
		}

		if (owned.length !== 0) {
			/*
			 * Sort only entries generated by this batch. Entries already in
			 * flight do not participate in this dispatch.
			 */
			owned.sort(compareOwnedEntries);

			/*
			 * dispatchOwnedBatch catches generation and persistence failures,
			 * rejects all owned deferred promises, and removes their dedup keys.
			 */
			void this.dispatchOwnedBatch(owned);
		}

		/*
		 * Await the original ChunkData promises directly. The previous version
		 * allocated one closure and one Promise<void> per unique entry merely
		 * to scatter each individual result.
		 */
		const uniqueResults = await Promise.all(promises);
		const results = new Array<ChunkData>(coordinateCount);

		/*
		 * Scatter after all work completes. Duplicate positions reference the
		 * same ChunkData object, matching the previous behavior.
		 */
		for (let uniqueIndex = 0; uniqueIndex < uniqueCount; uniqueIndex++) {
			const data = uniqueResults[uniqueIndex];
			const outputIndices = uniqueEntries[uniqueIndex].outputIndices;

			for (let i = 0; i < outputIndices.length; i++) {
				results[outputIndices[i]] = data;
			}
		}

		return results;
	}

	/**
	 * Generate, persist, and settle every chunk owned by one batch.
	 */
	private async dispatchOwnedBatch(owned: OwnedBatchEntry[]): Promise<void> {
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
			const rawResults = await this.pool.dispatchAll(owned);

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
			 * Keep dedup entries active until storage catches up.
			 */
			await this.persistChunks(chunks);

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

	private persistChunk(data: ChunkData): Promise<void> {
		const storage = this.storage;

		if (storage === null) {
			return Promise.resolve();
		}

		return storage.writeChunk(data);
	}

	/**
	 * Persist a batch with bounded write concurrency.
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

		try {
			/*
			 * Pool termination rejects queued and in-flight work, allowing all
			 * deferred batch promises and single-generation promises to settle.
			 */
			await this.pool.terminate();
		} finally {
			this.dedupMap.clear();
			this.initPromise = null;
			this.initialized = false;
		}
	}
}
