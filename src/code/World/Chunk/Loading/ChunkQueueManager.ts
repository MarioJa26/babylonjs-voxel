import { SETTING_PARAMS } from "../../SETTINGS_PARAMS";
import type { Chunk } from "../Chunk";
import type { ChunkLoadingDebug } from "./ChunkLoadingDebug";

export interface ChunkQueueManagerAdapter {
	/**
	 * Override load batch size if needed.
	 */
	getLoadBatchSize?(): number;

	/**
	 * Override unload batch size if needed.
	 */
	getUnloadBatchSize?(): number;

	/**
	 * Called when a chunk is newly enqueued for load.
	 */
	onChunkQueuedForLoad?(chunk: Chunk): void;

	/**
	 * Called when a chunk is newly enqueued for unload.
	 */
	onChunkQueuedForUnload?(chunk: Chunk): void;

	/**
	 * Optional debug sink.
	 */
	debug?: ChunkLoadingDebug;

	/**
	 * Optional entity registry counts for debug snapshots.
	 */
	getPendingChunkEntityReloadCount?(): number;
	getRegisteredChunkEntityCount?(): number;
}

export interface ChunkQueueBatch {
	chunks: Chunk[];
	hasMore: boolean;
}

function normalizeBatchSize(maxChunks: number, queueLength: number): number {
	if (maxChunks <= 0 || Number.isNaN(maxChunks) || queueLength <= 0) {
		return 0;
	}

	return Math.min(Math.trunc(maxChunks), queueLength);
}

export class ChunkQueueManager {
	private readonly loadQueue: Array<Chunk | undefined> = [];
	private loadQueueHead = 0;
	private loadQueueHoleCount = 0;

	private readonly loadQueueSet = new Set<bigint>();
	private readonly unloadQueueSet = new Set<Chunk>();

	public constructor(private readonly adapter: ChunkQueueManagerAdapter = {}) {}

	public getLoadBatchSize(): number {
		return Math.max(
			1,
			this.adapter.getLoadBatchSize?.() ??
				SETTING_PARAMS.CHUNK_LOAD_BATCH_LIMIT,
		);
	}

	public getUnloadBatchSize(): number {
		return Math.max(
			1,
			this.adapter.getUnloadBatchSize?.() ??
				SETTING_PARAMS.CHUNK_UNLOAD_BATCH_LIMIT,
		);
	}

	public getLoadQueueLength(): number {
		return this.loadQueue.length - this.loadQueueHead;
	}

	public getUnloadQueueLength(): number {
		return this.unloadQueueSet.size;
	}

	public hasPendingLoads(): boolean {
		return this.loadQueueSet.size > 0;
	}

	public hasPendingUnloads(): boolean {
		return this.unloadQueueSet.size > 0;
	}

	public hasPendingWork(): boolean {
		return this.hasPendingLoads() || this.hasPendingUnloads();
	}

	/**
	 * Equivalent extraction target for ensureChunkQueuedForLoad(...).
	 */
	public ensureChunkQueuedForLoad(chunk: Chunk): boolean {
		if (this.loadQueueSet.has(chunk.id)) {
			return false;
		}

		this.loadQueue.push(chunk);
		this.loadQueueSet.add(chunk.id);

		// If a chunk is scheduled for load again, cancel pending unload.
		this.unloadQueueSet.delete(chunk);

		this.adapter.onChunkQueuedForLoad?.(chunk);
		this.refreshQueueDebugSnapshot();
		return true;
	}

	public queueChunkForUnload(chunk: Chunk): boolean {
		// Don't unload a chunk still pending load.
		if (this.loadQueueSet.has(chunk.id)) {
			return false;
		}

		const before = this.unloadQueueSet.size;
		this.unloadQueueSet.add(chunk);

		const added = this.unloadQueueSet.size !== before;
		if (added) {
			this.adapter.onChunkQueuedForUnload?.(chunk);
			this.refreshQueueDebugSnapshot();
		}

		return added;
	}

	public dequeueLoadBatch(
		maxChunks: number = this.getLoadBatchSize(),
	): ChunkQueueBatch {
		const queueLength = this.loadQueueSet.size;
		const take = normalizeBatchSize(maxChunks, queueLength);

		if (take === 0) {
			return {
				chunks: [],
				hasMore: queueLength > 0,
			};
		}

		const chunks = new Array<Chunk>(take);
		let writeIndex = 0;

		while (writeIndex < take && this.loadQueueHead < this.loadQueue.length) {
			const readIndex = this.loadQueueHead++;
			const chunk = this.loadQueue[readIndex];

			// Release the reference immediately instead of waiting for compaction.
			this.loadQueue[readIndex] = undefined;

			if (chunk === undefined) {
				continue;
			}

			// delete(...) also protects against stale queue entries if a chunk was removed
			// by id but the exact object reference was not found in the sparse array.
			if (!this.loadQueueSet.delete(chunk.id)) {
				continue;
			}

			chunks[writeIndex++] = chunk;
		}

		if (writeIndex !== take) {
			chunks.length = writeIndex;
		}

		this.compactLoadQueueIfUseful();
		this.refreshQueueDebugSnapshot();

		return {
			chunks,
			hasMore: this.loadQueueSet.size > 0,
		};
	}

	public dequeueUnloadBatch(
		maxChunks: number = this.getUnloadBatchSize(),
	): ChunkQueueBatch {
		const queueLength = this.unloadQueueSet.size;
		const take = normalizeBatchSize(maxChunks, queueLength);

		if (take === 0) {
			return {
				chunks: [],
				hasMore: queueLength > 0,
			};
		}

		const chunks = new Array<Chunk>(take);
		const iterator = this.unloadQueueSet.values();

		let writeIndex = 0;
		while (writeIndex < take) {
			const next = iterator.next();
			if (next.done) {
				break;
			}

			const chunk = next.value;
			this.unloadQueueSet.delete(chunk);
			chunks[writeIndex++] = chunk;
		}

		if (writeIndex !== take) {
			chunks.length = writeIndex;
		}

		this.refreshQueueDebugSnapshot();

		return {
			chunks,
			hasMore: this.unloadQueueSet.size > 0,
		};
	}

	public removeChunk(chunk: Chunk): void {
		if (this.loadQueueSet.delete(chunk.id)) {
			for (let i = this.loadQueueHead; i < this.loadQueue.length; i++) {
				const queuedChunk = this.loadQueue[i];

				if (queuedChunk !== undefined && queuedChunk.id === chunk.id) {
					this.loadQueue[i] = undefined;
					this.loadQueueHoleCount++;
					break;
				}
			}

			this.compactLoadQueueIfUseful();
		}

		this.unloadQueueSet.delete(chunk);
		this.refreshQueueDebugSnapshot();
	}

	public clear(): void {
		this.loadQueue.length = 0;
		this.loadQueueHead = 0;
		this.loadQueueHoleCount = 0;
		this.loadQueueSet.clear();
		this.unloadQueueSet.clear();
		this.refreshQueueDebugSnapshot();
	}

	public snapshot(): {
		loadQueue: readonly Chunk[];
		unloadQueue: readonly Chunk[];
	} {
		// Compact first so callers get the same reference-style behavior as before:
		// loadQueue is an internal array containing only pending chunks.
		this.compactLoadQueue();

		return {
			loadQueue: this.loadQueue as Chunk[],
			unloadQueue: [...this.unloadQueueSet],
		};
	}

	/**
	 * Equivalent extraction target for refreshQueueDebugSnapshot(...).
	 */
	public refreshQueueDebugSnapshot(): void {
		const debug = this.adapter.debug;
		if (!debug) {
			return;
		}

		debug.refreshQueueSnapshot({
			loadQueueLength: this.loadQueueSet.size,
			unloadQueueLength: this.unloadQueueSet.size,
			pendingChunkEntityReloadCount:
				this.adapter.getPendingChunkEntityReloadCount?.(),
			registeredChunkEntityCount:
				this.adapter.getRegisteredChunkEntityCount?.(),
		});
	}

	private compactLoadQueueIfUseful(): void {
		const head = this.loadQueueHead;
		const holes = this.loadQueueHoleCount;

		if (head === 0 && holes === 0) {
			return;
		}

		const activeSlots = this.loadQueue.length - head;

		// Fully reset once everything has been consumed or removed.
		if (this.loadQueueSet.size === 0) {
			this.loadQueue.length = 0;
			this.loadQueueHead = 0;
			this.loadQueueHoleCount = 0;
			return;
		}

		// Avoid retaining many consumed slots, but do not compact every small dequeue.
		if (head >= 64 && head * 2 >= this.loadQueue.length) {
			this.compactLoadQueue();
			return;
		}

		// Also compact when many active slots are holes from removeChunk(...).
		if (holes >= 64 && holes * 2 >= activeSlots) {
			this.compactLoadQueue();
		}
	}

	private compactLoadQueue(): void {
		const head = this.loadQueueHead;

		if (head === 0 && this.loadQueueHoleCount === 0) {
			return;
		}

		let writeIndex = 0;

		for (let readIndex = head; readIndex < this.loadQueue.length; readIndex++) {
			const chunk = this.loadQueue[readIndex];

			if (chunk !== undefined && this.loadQueueSet.has(chunk.id)) {
				this.loadQueue[writeIndex++] = chunk;
			}
		}

		this.loadQueue.length = writeIndex;
		this.loadQueueHead = 0;
		this.loadQueueHoleCount = 0;
	}
}
