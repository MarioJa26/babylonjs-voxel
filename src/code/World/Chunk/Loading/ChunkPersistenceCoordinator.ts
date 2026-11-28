import { SETTING_PARAMS } from "../../SETTINGS_PARAMS";
import { type SavedChunkEntityData, WorldStorage } from "../../WorldStorage";
import type { Chunk } from "../Chunk";

export interface ChunkPersistenceCoordinatorAdapter {
	getModifiedChunks(): Iterable<Chunk>;
	getChunkEntityPayloads(): ReadonlyMap<bigint, SavedChunkEntityData[]>;

	getChunkSaveBatchSize?(): number;
	getChunkEntitySaveBatchSize?(): number;

	onChunksFlushed?(chunks: readonly Chunk[]): void;
	onChunkEntitiesFlushed?(chunkIds: readonly bigint[]): void;
}

function normalizeFlushLimit(maxChunks: number): number {
	if (maxChunks <= 0 || Number.isNaN(maxChunks)) {
		return 0;
	}

	return Math.trunc(maxChunks);
}

export class ChunkPersistenceCoordinator {
	private flushPromise: Promise<void> | null = null;
	private pendingFlushRequested = false;

	private entityFlushPromise: Promise<void> | null = null;
	private pendingEntityFlushRequested = false;

	private readonly lastPersistedEntityChunkIds = new Set<bigint>();

	// Scratch storage. Only use before the first await in each flush pass.
	private readonly modifiedChunksScratch: Chunk[] = [];
	private readonly candidateChunkIdsScratch: bigint[] = [];
	private readonly batchItemsScratch: { chunkId: bigint; entities: import("../../WorldStorage").SavedChunkEntityData[] }[] = [];

	public constructor(
		private readonly adapter: ChunkPersistenceCoordinatorAdapter,
	) {}

	public flushModifiedChunks(
		maxChunks: number = this.getChunkSaveBatchSize(),
	): Promise<void> {
		if (this.flushPromise) {
			this.pendingFlushRequested = true;
			return this.flushPromise;
		}

		this.flushPromise = this.drainModifiedChunkFlushes(maxChunks);
		return this.flushPromise;
	}

	public flushChunkBoundEntities(
		maxChunks: number = this.getChunkEntitySaveBatchSize(),
	): Promise<void> {
		if (this.entityFlushPromise) {
			this.pendingEntityFlushRequested = true;
			return this.entityFlushPromise;
		}

		this.entityFlushPromise = this.drainChunkBoundEntityFlushes(maxChunks);
		return this.entityFlushPromise;
	}

	private getChunkSaveBatchSize(): number {
		return Math.max(
			1,
			this.adapter.getChunkSaveBatchSize?.() ??
				SETTING_PARAMS.CHUNK_UNLOAD_BATCH_LIMIT,
		);
	}

	private getChunkEntitySaveBatchSize(): number {
		return Math.max(
			1,
			this.adapter.getChunkEntitySaveBatchSize?.() ??
				SETTING_PARAMS.CHUNK_UNLOAD_BATCH_LIMIT,
		);
	}

	private async drainModifiedChunkFlushes(maxChunks: number): Promise<void> {
		try {
			do {
				this.pendingFlushRequested = false;
				await this.flushModifiedChunksInternal(maxChunks);
			} while (this.pendingFlushRequested);
		} finally {
			this.flushPromise = null;
		}
	}

	private async drainChunkBoundEntityFlushes(maxChunks: number): Promise<void> {
		try {
			do {
				this.pendingEntityFlushRequested = false;
				await this.flushChunkBoundEntitiesInternal(maxChunks);
			} while (this.pendingEntityFlushRequested);
		} finally {
			this.entityFlushPromise = null;
		}
	}

	private async flushModifiedChunksInternal(maxChunks: number): Promise<void> {
		const limit = normalizeFlushLimit(maxChunks);
		if (limit === 0) {
			return;
		}

		const scratch = this.modifiedChunksScratch;
		scratch.length = 0;

		for (const chunk of this.adapter.getModifiedChunks()) {
			if (!chunk.isModified && !chunk.isLightDirty) {
				// lazy prune stale entries (B7)
				continue;
			}

			scratch.push(chunk);

			if (scratch.length >= limit) {
				break;
			}
		}

		if (scratch.length === 0) {
			return;
		}

		// Snapshot before await. The scratch array must never cross an await boundary.
		const chunksToSave = scratch.slice();
		scratch.length = 0;

		await WorldStorage.saveChunks(chunksToSave);

		this.adapter.onChunksFlushed?.(chunksToSave);
	}

	private async flushChunkBoundEntitiesInternal(
		maxChunks: number,
	): Promise<void> {
		const limit = normalizeFlushLimit(maxChunks);
		if (limit === 0) {
			return;
		}

		const payloadsByChunk = this.adapter.getChunkEntityPayloads();
		const scratch = this.candidateChunkIdsScratch;
		scratch.length = 0;

		// Map keys are already unique, so no seen Set is needed for this pass.
		for (const chunkId of payloadsByChunk.keys()) {
			scratch.push(chunkId);

			if (scratch.length >= limit) {
				break;
			}
		}

		if (scratch.length < limit && this.lastPersistedEntityChunkIds.size > 0) {
			for (const chunkId of this.lastPersistedEntityChunkIds) {
				// Avoid duplicate candidate ids already covered by the current payload map.
				if (payloadsByChunk.has(chunkId)) {
					continue;
				}

				scratch.push(chunkId);

				if (scratch.length >= limit) {
					break;
				}
			}
		}

		if (scratch.length === 0) {
			return;
		}

		// Snapshot before the first await so re-entrant flush requests cannot stomp scratch.
		const candidateChunkIds = scratch.slice();
		scratch.length = 0;

		const items = this.batchItemsScratch;
		items.length = 0;
		for (let i = 0; i < candidateChunkIds.length; i++) {
			const chunkId = candidateChunkIds[i];
			items.push({ chunkId, entities: payloadsByChunk.get(chunkId) ?? [] });
		}

		await WorldStorage.saveChunkEntitiesBatch(items);

		for (let i = 0; i < items.length; i++) {
			if (items[i].entities.length > 0) this.lastPersistedEntityChunkIds.add(items[i].chunkId);
			else this.lastPersistedEntityChunkIds.delete(items[i].chunkId);
		}
		items.length = 0;

		this.adapter.onChunkEntitiesFlushed?.(candidateChunkIds);
	}
}
