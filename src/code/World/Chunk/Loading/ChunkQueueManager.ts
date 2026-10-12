import { SETTING_PARAMS } from "../../SETTINGS_PARAMS";
import type { Chunk } from "../Chunk";
import type { ChunkLoadingDebug } from "./ChunkLoadingDebug";

export interface ChunkQueueManagerAdapter {
	/** Override load batch size if needed. */
	getLoadBatchSize?(): number;

	/** Override unload batch size if needed. */
	getUnloadBatchSize?(): number;

	/** Called when a chunk is newly enqueued for load. */
	onChunkQueuedForLoad?(chunk: Chunk): void;

	/** Called when a chunk is newly enqueued for unload. */
	onChunkQueuedForUnload?(chunk: Chunk): void;

	/** Optional debug sink. */
	debug?: ChunkLoadingDebug;

	/** Optional entity registry counts for debug snapshots. */
	getPendingChunkEntityReloadCount?(): number;
	getRegisteredChunkEntityCount?(): number;
}

export interface ChunkQueueBatch {
	chunks: Chunk[];
	hasMore: boolean;
}

function normalizeBatchSize(maxChunks: number, queueLength: number): number {
	if (queueLength <= 0 || maxChunks <= 0 || !Number.isFinite(maxChunks)) {
		return 0;
	}

	const truncated = Math.trunc(maxChunks);

	return truncated < queueLength ? truncated : queueLength;
}

export class ChunkQueueManager {
	/**
	 * Sparse FIFO load queue.
	 *
	 * Consumed and explicitly removed entries become undefined until periodic
	 * compaction. This makes dequeue and arbitrary removal O(1) in the normal
	 * case.
	 */
	private readonly loadQueue: Array<Chunk | undefined> = [];
	private loadQueueHead = 0;

	/**
	 * Number of undefined slots at or after loadQueueHead.
	 *
	 * Holes before the head are already consumed and are not included. Keeping
	 * this accurate prevents stale hole counts from triggering unnecessary
	 * compactions after dequeue has passed removed entries.
	 */
	private loadQueueHoleCount = 0;

	/**
	 * Chunk ID to physical loadQueue slot.
	 *
	 * This is also the authoritative set of live load requests, so its size is
	 * the logical queue length.
	 */
	private readonly loadQueueSlots = new Map<bigint, number>();

	private readonly unloadQueueSet = new Set<Chunk>();

	public constructor(private readonly adapter: ChunkQueueManagerAdapter = {}) {}

	public getLoadBatchSize(): number {
		const configured =
			this.adapter.getLoadBatchSize?.() ??
			SETTING_PARAMS.CHUNK_LOAD_BATCH_LIMIT;

		return configured > 1 && Number.isFinite(configured)
			? Math.trunc(configured)
			: 1;
	}

	public getUnloadBatchSize(): number {
		const configured =
			this.adapter.getUnloadBatchSize?.() ??
			SETTING_PARAMS.CHUNK_UNLOAD_BATCH_LIMIT;

		return configured > 1 && Number.isFinite(configured)
			? Math.trunc(configured)
			: 1;
	}

	/**
	 * Logical number of chunks waiting to load.
	 *
	 * The previous physical-array calculation included undefined holes.
	 */
	public getLoadQueueLength(): number {
		return this.loadQueueSlots.size;
	}

	public getUnloadQueueLength(): number {
		return this.unloadQueueSet.size;
	}

	public hasPendingLoads(): boolean {
		return this.loadQueueSlots.size !== 0;
	}

	public hasPendingUnloads(): boolean {
		return this.unloadQueueSet.size !== 0;
	}

	public hasPendingWork(): boolean {
		return this.loadQueueSlots.size !== 0 || this.unloadQueueSet.size !== 0;
	}

	/**
	 * Enqueue a chunk for loading unless it is already pending.
	 *
	 * A new load request cancels any pending unload for the same chunk.
	 */
	public ensureChunkQueuedForLoad(chunk: Chunk): boolean {
		const slots = this.loadQueueSlots;
		const id = chunk.id;

		if (slots.has(id)) {
			return false;
		}

		const queue = this.loadQueue;

		slots.set(id, queue.length);
		queue.push(chunk);

		this.unloadQueueSet.delete(chunk);

		this.adapter.onChunkQueuedForLoad?.(chunk);
		this.refreshQueueDebugSnapshot();

		return true;
	}

	/**
	 * Enqueue a chunk for unloading unless it is still waiting to load.
	 */
	public queueChunkForUnload(chunk: Chunk): boolean {
		if (this.loadQueueSlots.has(chunk.id)) {
			return false;
		}

		const unloads = this.unloadQueueSet;

		if (unloads.has(chunk)) {
			return false;
		}

		unloads.add(chunk);

		this.adapter.onChunkQueuedForUnload?.(chunk);
		this.refreshQueueDebugSnapshot();

		return true;
	}

	public dequeueLoadBatch(
		maxChunks: number = this.getLoadBatchSize(),
	): ChunkQueueBatch {
		const slots = this.loadQueueSlots;
		const queueLength = slots.size;
		const take = normalizeBatchSize(maxChunks, queueLength);

		if (take === 0) {
			return {
				chunks: [],
				hasMore: queueLength !== 0,
			};
		}

		const queue = this.loadQueue;
		const queueEnd = queue.length;
		const chunks = new Array<Chunk>(take);

		let head = this.loadQueueHead;
		let holes = this.loadQueueHoleCount;
		let writeIndex = 0;

		/*
		 * Cache head and hole count locally. Large batches otherwise perform
		 * repeated class-field reads and writes for every physical queue slot.
		 */
		while (writeIndex < take && head < queueEnd) {
			const readIndex = head++;
			const chunk = queue[readIndex];

			// Release the strong reference as soon as the slot is consumed.
			queue[readIndex] = undefined;

			if (chunk === undefined) {
				/*
				 * This was an active-region hole created by removeChunk().
				 * It is no longer part of the remaining sparse queue.
				 */
				if (holes > 0) {
					holes--;
				}

				continue;
			}

			/*
			 * Identity-check the slot before deleting. This protects a newer
			 * request for the same ID if bookkeeping drift ever leaves a stale
			 * physical queue entry behind.
			 */
			if (slots.get(chunk.id) !== readIndex) {
				continue;
			}

			slots.delete(chunk.id);
			chunks[writeIndex++] = chunk;
		}

		this.loadQueueHead = head;
		this.loadQueueHoleCount = holes;

		if (writeIndex !== take) {
			chunks.length = writeIndex;
		}

		this.compactLoadQueueIfUseful();
		this.refreshQueueDebugSnapshot();

		return {
			chunks,
			hasMore: slots.size !== 0,
		};
	}

	public dequeueUnloadBatch(
		maxChunks: number = this.getUnloadBatchSize(),
	): ChunkQueueBatch {
		const unloads = this.unloadQueueSet;
		const queueLength = unloads.size;
		const take = normalizeBatchSize(maxChunks, queueLength);

		if (take === 0) {
			return {
				chunks: [],
				hasMore: queueLength !== 0,
			};
		}

		const chunks = new Array<Chunk>(take);
		const iterator = unloads.values();

		let writeIndex = 0;

		while (writeIndex < take) {
			const next = iterator.next();

			if (next.done) {
				break;
			}

			const chunk = next.value;

			/*
			 * Deleting the current Set entry during iteration is defined and
			 * does not invalidate the iterator.
			 */
			unloads.delete(chunk);
			chunks[writeIndex++] = chunk;
		}

		if (writeIndex !== take) {
			chunks.length = writeIndex;
		}

		this.refreshQueueDebugSnapshot();

		return {
			chunks,
			hasMore: unloads.size !== 0,
		};
	}

	/**
	 * Remove a chunk from either queue.
	 */
	public removeChunk(chunk: Chunk): void {
		const id = chunk.id;
		const slots = this.loadQueueSlots;
		const unloads = this.unloadQueueSet;

		let changed = false;

		const slot = slots.get(id);

		if (slot !== undefined) {
			slots.delete(id);
			changed = true;

			const queue = this.loadQueue;
			const queuedChunk = queue[slot];

			if (
				slot >= this.loadQueueHead &&
				queuedChunk !== undefined &&
				queuedChunk.id === id
			) {
				queue[slot] = undefined;
				this.loadQueueHoleCount++;
			} else {
				/*
				 * Defensive fallback for bookkeeping drift. This is not expected
				 * in normal operation and remains outside the O(1) fast path.
				 */
				for (let i = this.loadQueueHead; i < queue.length; i++) {
					const candidate = queue[i];

					if (candidate !== undefined && candidate.id === id) {
						queue[i] = undefined;
						this.loadQueueHoleCount++;
						break;
					}
				}
			}

			this.compactLoadQueueIfUseful();
		}

		if (unloads.delete(chunk)) {
			changed = true;
		}

		if (changed) {
			this.refreshQueueDebugSnapshot();
		}
	}

	public clear(): void {
		const hadWork =
			this.loadQueueSlots.size !== 0 ||
			this.unloadQueueSet.size !== 0 ||
			this.loadQueue.length !== 0;

		this.loadQueue.length = 0;
		this.loadQueueHead = 0;
		this.loadQueueHoleCount = 0;

		this.loadQueueSlots.clear();
		this.unloadQueueSet.clear();

		if (hadWork) {
			this.refreshQueueDebugSnapshot();
		}
	}

	public snapshot(): {
		loadQueue: readonly Chunk[];
		unloadQueue: readonly Chunk[];
	} {
		/*
		 * Preserve the existing reference-style loadQueue snapshot. After
		 * compaction the internal array contains only live Chunk entries.
		 *
		 * Callers must treat the returned readonly array as immutable.
		 */
		this.compactLoadQueue();

		return {
			loadQueue: this.loadQueue as Chunk[],
			unloadQueue: Array.from(this.unloadQueueSet),
		};
	}

	/**
	 * Refresh optional queue diagnostics.
	 */
	public refreshQueueDebugSnapshot(): void {
		const adapter = this.adapter;
		const debug = adapter.debug;

		if (debug === undefined) {
			return;
		}

		debug.refreshQueueSnapshot({
			loadQueueLength: this.loadQueueSlots.size,
			unloadQueueLength: this.unloadQueueSet.size,
			pendingChunkEntityReloadCount:
				adapter.getPendingChunkEntityReloadCount?.(),
			registeredChunkEntityCount: adapter.getRegisteredChunkEntityCount?.(),
		});
	}

	/**
	 * Compact only when the sparse prefix or active-region holes are large
	 * enough to justify a linear pass.
	 */
	private compactLoadQueueIfUseful(): void {
		const slots = this.loadQueueSlots;

		if (slots.size === 0) {
			this.resetLoadQueue();
			return;
		}

		const head = this.loadQueueHead;
		const holes = this.loadQueueHoleCount;

		if (head === 0 && holes === 0) {
			return;
		}

		const queueLength = this.loadQueue.length;

		/*
		 * Remove a large consumed prefix once it occupies at least half of the
		 * physical array.
		 */
		if (head >= 64 && head * 2 >= queueLength) {
			this.compactLoadQueue();
			return;
		}

		/*
		 * The active physical region includes both live entries and holes.
		 * Compact once holes are substantial and occupy at least half of it.
		 */
		const activePhysicalSlots = queueLength - head;

		if (holes >= 64 && holes * 2 >= activePhysicalSlots) {
			this.compactLoadQueue();
		}
	}

	/**
	 * Rebuild the physical load queue from its live entries and refresh every
	 * ID-to-slot mapping.
	 */
	private compactLoadQueue(): void {
		const queue = this.loadQueue;
		const slots = this.loadQueueSlots;
		const head = this.loadQueueHead;

		if (slots.size === 0) {
			this.resetLoadQueue();
			return;
		}

		if (head === 0 && this.loadQueueHoleCount === 0) {
			return;
		}

		let writeIndex = 0;

		for (let readIndex = head; readIndex < queue.length; readIndex++) {
			const chunk = queue[readIndex];

			if (chunk === undefined) {
				continue;
			}

			/*
			 * Require the mapping to point to this exact physical slot. A plain
			 * has() check could retain an obsolete entry if a newer slot for the
			 * same ID had replaced it.
			 */
			if (slots.get(chunk.id) !== readIndex) {
				continue;
			}

			queue[writeIndex] = chunk;
			slots.set(chunk.id, writeIndex);
			writeIndex++;
		}

		queue.length = writeIndex;
		this.loadQueueHead = 0;
		this.loadQueueHoleCount = 0;
	}

	private resetLoadQueue(): void {
		this.loadQueue.length = 0;
		this.loadQueueHead = 0;
		this.loadQueueHoleCount = 0;
		this.loadQueueSlots.clear();
	}
}
