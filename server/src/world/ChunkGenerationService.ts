/**
 * ChunkGenerationService — server-side terrain generation.
 *
 * Uses a worker thread pool for parallel chunk generation, request
 * deduplication to avoid duplicate work, and batch dispatch for efficiency.
 *
 * After generation, chunks are persisted to LevelDB storage so they can be
 * served from disk on subsequent requests (no regeneration needed).
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
	version: number;
}

interface ChunkCoord {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
}

interface RawChunkResult {
	blocks: Uint8Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
}

/** One unique coordinate inside a batch, mapping to every output slot it fills. */
interface UniqueBatchEntry extends ChunkCoord {
	key: number;
	outputIndices: number[];
}

interface OwnedBatchEntry {
	entry: UniqueBatchEntry;
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

	return { entry, promise, resolve, reject };
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

export class ChunkGenerationService {
	private readonly pool = new ChunkWorkerPool();

	private seed = "default";
	private wasmEnabled = true;
	private initialized = false;
	private terminating = false;

	private initPromise: Promise<void> | null = null;
	private storage: ServerWorldStorage | null = null;

	// Keyed by packChunkKeyFast(cx, cy, cz).
	// Every entry is settled and removed once its work finishes.
	private readonly dedupMap = new Map<number, Promise<ChunkData>>();

	/**
	 * Configure the terrain seed. Immutable after initialization has started:
	 * workers created for seed A would otherwise keep generating seed-A terrain
	 * and saving it into storage after a seed change.
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

		const existing = this.initPromise;
		if (existing) return existing;

		const init = this.pool.initialize(this.seed, this.wasmEnabled);
		this.initPromise = init;

		void init.then(
			() => {
				this.initialized = true;
			},
			() => {
				// Do not cache a permanent failure. The next request retries.
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

		void promise
			.finally(() => {
				// Delete only if this promise still owns the key.
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
		const data = toChunkData(chunkX, chunkY, chunkZ, raw);

		// Persist before returning and before the dedup entry is removed.
		await this.persistChunk(data);
		return data;
	}

	/**
	 * Generate a batch of chunks. Deduplicates repeated coordinates within the
	 * batch and against in-flight single/batch generations, preserves input
	 * ordering, and rejects every waiter if any owned generation fails.
	 */
	async generateChunksBatch(
		coords: readonly ChunkCoord[],
	): Promise<ChunkData[]> {
		const coordCount = coords.length;
		if (coordCount === 0) return [];

		const results = new Array<ChunkData>(coordCount);
		const localUnique = new Map<number, UniqueBatchEntry>();

		// Deduplicate within this batch while retaining every original output slot.
		for (let i = 0; i < coordCount; i++) {
			const coord = coords[i];
			const key = packChunkKeyFast(coord.chunkX, coord.chunkY, coord.chunkZ);
			const existing = localUnique.get(key);

			if (existing) {
				existing.outputIndices.push(i);
				continue;
			}

			localUnique.set(key, {
				key,
				chunkX: coord.chunkX,
				chunkY: coord.chunkY,
				chunkZ: coord.chunkZ,
				outputIndices: [i],
			});
		}

		const uniqueCount = localUnique.size;
		const waiters = new Array<Promise<void>>(uniqueCount);
		const owned: OwnedBatchEntry[] = [];

		let waiterIndex = 0;

		for (const entry of localUnique.values()) {
			let promise = this.dedupMap.get(entry.key);

			if (!promise) {
				const ownedEntry = createOwnedBatchEntry(entry);
				promise = ownedEntry.promise;

				// Register before any await so overlapping requests reuse this work.
				this.dedupMap.set(entry.key, promise);
				owned.push(ownedEntry);
			}

			waiters[waiterIndex++] = promise.then((data) => {
				const outputIndices = entry.outputIndices;
				for (let i = 0; i < outputIndices.length; i++) {
					results[outputIndices[i]] = data;
				}
			});
		}

		if (owned.length > 0) {
			// Sort by column, then Y, so dispatchAll sends column-coherent batches.
			owned.sort((a, b) => {
				const ax = a.entry.chunkX;
				const bx = b.entry.chunkX;
				if (ax !== bx) return ax - bx;

				const az = a.entry.chunkZ;
				const bz = b.entry.chunkZ;
				if (az !== bz) return az - bz;

				return a.entry.chunkY - b.entry.chunkY;
			});

			void this.dispatchOwnedBatch(owned);
		}

		await Promise.all(waiters);
		return results;
	}

	private async dispatchOwnedBatch(owned: OwnedBatchEntry[]): Promise<void> {
		try {
			await this.ensurePool();

			const ownedCount = owned.length;
			const request = new Array<ChunkCoord>(ownedCount);

			for (let i = 0; i < ownedCount; i++) {
				const entry = owned[i].entry;
				request[i] = {
					chunkX: entry.chunkX,
					chunkY: entry.chunkY,
					chunkZ: entry.chunkZ,
				};
			}

			const rawResults = await this.pool.dispatchAll(request);

			if (rawResults.length !== ownedCount) {
				throw new Error(
					`Worker batch result length mismatch: expected ${ownedCount}, received ${rawResults.length}`,
				);
			}

			const chunks = new Array<ChunkData>(ownedCount);

			for (let i = 0; i < ownedCount; i++) {
				const entry = owned[i].entry;
				chunks[i] = toChunkData(
					entry.chunkX,
					entry.chunkY,
					entry.chunkZ,
					rawResults[i],
				);
			}

			// Persist before resolving so storage catches up while dedup entries
			// still block duplicate generation.
			await this.persistChunks(chunks);

			for (let i = 0; i < ownedCount; i++) {
				owned[i].resolve(chunks[i]);
			}
		} catch (error) {
			// Reject every waiter. No permanently pending promises.
			for (let i = 0; i < owned.length; i++) {
				owned[i].reject(error);
			}
		} finally {
			// Remove every entry this batch registered, ownership-checked.
			for (let i = 0; i < owned.length; i++) {
				const ownedEntry = owned[i];
				if (this.dedupMap.get(ownedEntry.entry.key) === ownedEntry.promise) {
					this.dedupMap.delete(ownedEntry.entry.key);
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
		const chunkCount = chunks.length;
		if (chunkCount === 0) return;

		const workerCount = Math.min(concurrency, chunkCount);
		let next = 0;

		const tasks = new Array<Promise<void>>(workerCount);

		for (let worker = 0; worker < workerCount; worker++) {
			tasks[worker] = (async () => {
				for (;;) {
					const index = next++;
					if (index >= chunkCount) return;
					await this.persistChunk(chunks[index]);
				}
			})();
		}

		await Promise.all(tasks);
	}

	async relightChunk(
		cx: number,
		cy: number,
		cz: number,
		blocks: Uint8Array,
	): Promise<Uint8Array> {
		await this.ensurePool();
		return this.pool.postRelight(cx, cy, cz, blocks);
	}

	async terminate(): Promise<void> {
		if (this.terminating) return;
		this.terminating = true;

		try {
			// The pool settles every queued/in-flight task with a rejection, so
			// in-flight generation promises and their waiters settle instead of hanging.
			await this.pool.terminate();
		} finally {
			this.dedupMap.clear();
			this.initPromise = null;
			this.initialized = false;
		}
	}
}
