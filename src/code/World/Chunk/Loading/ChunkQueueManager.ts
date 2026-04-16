import { SettingParams } from "../../SettingParams";
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

export class ChunkQueueManager {
	private readonly loadQueue: Chunk[] = [];
	private readonly loadQueueSet = new Set<bigint>();
	private readonly unloadQueueSet = new Set<Chunk>();

	public constructor(private readonly adapter: ChunkQueueManagerAdapter = {}) {}

	public getLoadBatchSize(): number {
		return Math.max(
			1,
			this.adapter.getLoadBatchSize?.() ?? SettingParams.CHUNK_LOAD_BATCH_LIMIT,
		);
	}

	public getUnloadBatchSize(): number {
		return Math.max(
			1,
			this.adapter.getUnloadBatchSize?.() ??
				SettingParams.CHUNK_UNLOAD_BATCH_LIMIT,
		);
	}

	public getLoadQueueLength(): number {
		return this.loadQueue.length;
	}

	public getUnloadQueueLength(): number {
		return this.unloadQueueSet.size;
	}

	public hasPendingLoads(): boolean {
		return this.loadQueue.length > 0;
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
		const take = Math.max(0, Math.min(maxChunks, this.loadQueue.length));
		if (take === 0) {
			return {
				chunks: [],
				hasMore: this.loadQueue.length > 0,
			};
		}

		const chunks = this.loadQueue.splice(0, take);
		for (const chunk of chunks) {
			this.loadQueueSet.delete(chunk.id);
		}

		this.refreshQueueDebugSnapshot();

		return {
			chunks,
			hasMore: this.loadQueue.length > 0,
		};
	}

	public dequeueUnloadBatch(
		maxChunks: number = this.getUnloadBatchSize(),
	): ChunkQueueBatch {
		const chunks: Chunk[] = [];
		if (maxChunks <= 0 || this.unloadQueueSet.size === 0) {
			return {
				chunks,
				hasMore: this.unloadQueueSet.size > 0,
			};
		}

		const iterator = this.unloadQueueSet.values();
		while (chunks.length < maxChunks) {
			const next = iterator.next();
			if (next.done) break;

			const chunk = next.value;
			this.unloadQueueSet.delete(chunk);
			chunks.push(chunk);
		}

		this.refreshQueueDebugSnapshot();

		return {
			chunks,
			hasMore: this.unloadQueueSet.size > 0,
		};
	}

	public removeChunk(chunk: Chunk): void {
		if (this.loadQueueSet.delete(chunk.id)) {
			const index = this.loadQueue.findIndex((c) => c.id === chunk.id);
			if (index >= 0) {
				this.loadQueue.splice(index, 1);
			}
		}

		this.unloadQueueSet.delete(chunk);
		this.refreshQueueDebugSnapshot();
	}

	public clear(): void {
		this.loadQueue.length = 0;
		this.loadQueueSet.clear();
		this.unloadQueueSet.clear();
		this.refreshQueueDebugSnapshot();
	}

	public snapshot(): {
		loadQueue: readonly Chunk[];
		unloadQueue: readonly Chunk[];
	} {
		return {
			loadQueue: [...this.loadQueue],
			unloadQueue: [...this.unloadQueueSet],
		};
	}

	/**
	 * Equivalent extraction target for refreshQueueDebugSnapshot(...).
	 */
	public refreshQueueDebugSnapshot(): void {
		this.adapter.debug?.refreshQueueSnapshot({
			loadQueueLength: this.loadQueue.length,
			unloadQueueLength: this.unloadQueueSet.size,
			pendingChunkEntityReloadCount:
				this.adapter.getPendingChunkEntityReloadCount?.(),
			registeredChunkEntityCount:
				this.adapter.getRegisteredChunkEntityCount?.(),
		});
	}
}
