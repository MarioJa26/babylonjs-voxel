/**
 * ChunkGenerationService — server-side terrain generation.
 *
 * Uses a worker thread pool for parallel chunk generation, request
 * deduplication to avoid duplicate work, and batch dispatch for efficiency.
 *
 * After generation, chunks are persisted to LevelDB storage so they can be
 * served from disk on subsequent requests (no regeneration needed).
 *
 * Failure semantics:
 * - A failing generation rejects every waiter (single and batch) — no
 *   permanently pending promises.
 * - Every dedupMap entry owned by a failed batch is removed in a finally
 *   block, so later requests retry instead of hanging.
 * - Seed/wasm configuration is immutable once initialization has started —
 *   changing the seed mid-flight could mix terrains from two worlds.
 * - Initialization failure is not cached: the next request retries.
 */

import { packChunkKeyFast } from "@/code/World/Storage/ChunkKey.ts";
import { ChunkWorkerPool } from "../workers/ChunkWorkerPool.ts";
import type { ServerWorldStorage } from "./ServerWorldStorage.ts";

export interface ChunkData {
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

interface ChunkCoord {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
}

/** One unique coordinate inside a batch, mapping to every output slot it fills. */
interface UniqueBatchEntry extends ChunkCoord {
	key: number;
	outputIndices: number[];
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason?: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;

	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve, reject };
}

export class ChunkGenerationService {
	private readonly pool = new ChunkWorkerPool();

	private seed = "default";
	private wasmEnabled = true;
	private initialized = false;
	private terminating = false;

	private initPromise: Promise<void> | null = null;
	private storage: ServerWorldStorage | null = null;

	// Keyed by packChunkKey(cx,cy,cz) — a single number instead of the
	// template-literal string this used to build ("cx,cy,cz") on every
	// generate/dedup check. Purely internal to this map, no external coupling.
	// Every entry is settled (resolved or rejected) and removed once its work
	// finishes — nothing is ever left pending forever.
	private readonly dedupMap = new Map<number, Promise<ChunkData>>();

	/**
	 * Configure the terrain seed. Immutable after initialization has started:
	 * workers created for seed A would otherwise keep generating seed-A
	 * terrain (and saving it into storage) after a seed change.
	 */
	setSeed(seed: string, wasmEnabled = true): void {
		if (this.initialized || this.initPromise) {
			throw new Error(
				"Chunk generation configuration cannot change after initialization has started",
			);
		}

		this.seed = seed;
		this.wasmEnabled = wasmEnabled;
	}

	/**
	 * Attach a storage backend. After generation, chunks are saved here.
	 */
	setStorage(storage: ServerWorldStorage | null): void {
		this.storage = storage;
	}

	private ensurePool(): Promise<void> {
		if (this.terminating) {
			return Promise.reject(
				new Error("Chunk generation service is terminating"),
			);
		}

		if (this.initPromise) return this.initPromise;

		const init = this.pool.initialize(this.seed, this.wasmEnabled);
		this.initPromise = init;

		init.then(
			() => {
				this.initialized = true;
			},
			() => {
				// Don't cache a permanent failure — reset so the next request
				// can retry initialization. The rejection itself is delivered
				// to current callers through `init`; this handler consumes the
				// child promise so it never becomes an unhandled rejection.
				this.initPromise = null;
				this.initialized = false;
			},
		);

		return init;
	}

	generateChunk(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): Promise<ChunkData> {
		const key = packChunkKeyFast(chunkX, chunkY, chunkZ);

		const existing = this.dedupMap.get(key);
		if (existing) return existing;

		const promise = this.generateAndPersist(chunkX, chunkY, chunkZ);
		this.dedupMap.set(key, promise);

		// finally() returns a new promise that rejects when the original
		// rejects — consume it so an ignored cleanup can't surface as an
		// unhandled rejection.
		void promise
			.finally(() => {
				// Delete only if this promise still owns the key (a batch may
				// have registered a newer promise for the same key).
				if (this.dedupMap.get(key) === promise) {
					this.dedupMap.delete(key);
				}
			})
			.catch(() => {
				// The original promise carries the rejection to its callers.
			});

		return promise;
	}

	private async generateAndPersist(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): Promise<ChunkData> {
		await this.ensurePool();

		const raw = await this.pool.dispatch(chunkX, chunkY, chunkZ);

		const data: ChunkData = {
			chunkX,
			chunkY,
			chunkZ,
			blocks: raw.blocks,
			light: raw.light,
			palette: raw.palette,
			isUniform: raw.isUniform,
			uniformBlockId: raw.uniformBlockId,
			hash: raw.hash,
		};

		// Persist before returning (and before the dedup entry is removed) so
		// a concurrent request for the same chunk never regenerates it.
		await this.persistChunk(data);
		return data;
	}

	/**
	 * Generate a batch of chunks. Deduplicates repeated coordinates within
	 * the batch AND against in-flight single/batch generations, preserves
	 * input ordering (duplicate slots included), and rejects every waiter if
	 * any part of the batch fails.
	 */
	async generateChunksBatch(
		coords: readonly ChunkCoord[],
	): Promise<ChunkData[]> {
		if (coords.length === 0) return [];

		await this.ensurePool();

		const results = new Array<ChunkData>(coords.length);
		const localUnique = new Map<number, UniqueBatchEntry>();

		// First deduplicate within this batch while retaining every original
		// output position.
		for (let i = 0; i < coords.length; i++) {
			const coord = coords[i];
			const key = packChunkKeyFast(coord.chunkX, coord.chunkY, coord.chunkZ);

			const entry = localUnique.get(key);
			if (entry) {
				entry.outputIndices.push(i);
			} else {
				localUnique.set(key, {
					key,
					chunkX: coord.chunkX,
					chunkY: coord.chunkY,
					chunkZ: coord.chunkZ,
					outputIndices: [i],
				});
			}
		}

		const waiters: Promise<void>[] = [];
		const owned: Array<{
			entry: UniqueBatchEntry;
			deferred: Deferred<ChunkData>;
		}> = [];

		for (const entry of localUnique.values()) {
			let promise = this.dedupMap.get(entry.key);

			if (!promise) {
				const deferred = createDeferred<ChunkData>();
				promise = deferred.promise;

				// Register BEFORE dispatching so overlapping batches reuse
				// this in-flight work.
				this.dedupMap.set(entry.key, promise);
				owned.push({ entry, deferred });
			}

			waiters.push(
				promise.then((data) => {
					for (const index of entry.outputIndices) {
						results[index] = data;
					}
				}),
			);
		}

		if (owned.length > 0) {
			void this.dispatchOwnedBatch(owned);
		}

		await Promise.all(waiters);
		return results;
	}

	private async dispatchOwnedBatch(
		owned: Array<{
			entry: UniqueBatchEntry;
			deferred: Deferred<ChunkData>;
		}>,
	): Promise<void> {
		try {
			// dispatchAll preserves input ordering (contiguous groups per
			// worker, flattened in the same order).
			const rawResults = await this.pool.dispatchAll(
				owned.map(({ entry }) => ({
					chunkX: entry.chunkX,
					chunkY: entry.chunkY,
					chunkZ: entry.chunkZ,
				})),
			);

			if (rawResults.length !== owned.length) {
				throw new Error(
					`Worker batch result length mismatch: expected ${owned.length}, received ${rawResults.length}`,
				);
			}

			const chunks = new Array<ChunkData>(owned.length);
			for (let i = 0; i < owned.length; i++) {
				const { entry } = owned[i];
				const raw = rawResults[i];
				chunks[i] = {
					chunkX: entry.chunkX,
					chunkY: entry.chunkY,
					chunkZ: entry.chunkZ,
					blocks: raw.blocks,
					light: raw.light,
					palette: raw.palette,
					isUniform: raw.isUniform,
					uniformBlockId: raw.uniformBlockId,
					hash: raw.hash,
				};
			}

			// Persist before resolving so storage catches up while the dedup
			// entries still block duplicate generation.
			await this.persistChunks(chunks);

			for (let i = 0; i < owned.length; i++) {
				owned[i].deferred.resolve(chunks[i]);
			}
		} catch (error) {
			// Reject every waiter — no permanently pending promises.
			for (const { deferred } of owned) {
				deferred.reject(error);
			}
		} finally {
			// Remove every entry this batch registered (ownership-checked).
			for (const { entry, deferred } of owned) {
				if (this.dedupMap.get(entry.key) === deferred.promise) {
					this.dedupMap.delete(entry.key);
				}
			}
		}
	}

	private async persistChunk(data: ChunkData): Promise<void> {
		const storage = this.storage;
		if (!storage) return;

		await storage.writeChunk(data);
	}

	/** Persist a batch with bounded write concurrency. */
	private async persistChunks(
		chunks: readonly ChunkData[],
		concurrency = 8,
	): Promise<void> {
		if (chunks.length === 0) return;

		let next = 0;
		const workers = Math.min(concurrency, chunks.length);

		await Promise.all(
			Array.from({ length: workers }, async () => {
				for (;;) {
					const index = next++;
					if (index >= chunks.length) return;
					await this.persistChunk(chunks[index]);
				}
			}),
		);
	}

	async terminate(): Promise<void> {
		if (this.terminating) return;
		this.terminating = true;

		try {
			// The pool settles every queued/in-flight task with a rejection,
			// so in-flight generation promises (and their waiters) settle
			// instead of hanging.
			await this.pool.terminate();
		} finally {
			this.dedupMap.clear();
			this.initPromise = null;
			this.initialized = false;
		}
	}
}
