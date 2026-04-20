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

export class ChunkPersistenceCoordinator {
	private flushPromise: Promise<void> | null = null;
	private pendingFlushRequested = false; // Bug 1 fix: track queued flush

	private entityFlushPromise: Promise<void> | null = null;
	private pendingEntityFlushRequested = false; // Bug 3 fix: track queued entity flush

	private readonly lastPersistedEntityChunkIds = new Set<bigint>();

	// Scratch storage — only safe to use BEFORE the first await in a flush
	private readonly _modifiedChunksScratch: Chunk[] = [];
	private readonly _candidateChunkIdsScratch: bigint[] = [];
	private readonly _seenChunkIdsScratch = new Set<bigint>();

	public constructor(
		private readonly adapter: ChunkPersistenceCoordinatorAdapter,
	) {}

	public async flushModifiedChunks(
		maxChunks: number = this.getChunkSaveBatchSize(),
	): Promise<void> {
		if (this.flushPromise) {
			// Bug 1 fix: a flush is in-flight — mark that we need another pass
			// so dirty chunks modified during this flush are not silently dropped.
			this.pendingFlushRequested = true;
			return this.flushPromise;
		}

		// Run flush passes until no more are queued
		do {
			this.pendingFlushRequested = false;
			this.flushPromise = this.flushModifiedChunksInternal(maxChunks);

			try {
				await this.flushPromise;
			} finally {
				this.flushPromise = null;
			}
		} while (this.pendingFlushRequested);
	}

	public async flushChunkBoundEntities(
		maxChunks: number = this.getChunkEntitySaveBatchSize(),
	): Promise<void> {
		if (this.entityFlushPromise) {
			// Bug 3 fix: same queued-flush pattern
			this.pendingEntityFlushRequested = true;
			return this.entityFlushPromise;
		}

		do {
			this.pendingEntityFlushRequested = false;
			this.entityFlushPromise = this.flushChunkBoundEntitiesInternal(maxChunks);

			try {
				await this.entityFlushPromise;
			} finally {
				this.entityFlushPromise = null;
			}
		} while (this.pendingEntityFlushRequested);
	}

	public getLastPersistedEntityChunkIds(): ReadonlySet<bigint> {
		return this.lastPersistedEntityChunkIds;
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

	private async flushModifiedChunksInternal(maxChunks: number): Promise<void> {
		const scratch = this._modifiedChunksScratch;
		scratch.length = 0;

		const limit = Math.max(0, maxChunks);
		if (limit === 0) return;

		for (const chunk of this.adapter.getModifiedChunks()) {
			if (
				!chunk.isModified &&
				!chunk.isLODMeshCacheDirty &&
				!chunk.isLightDirty
			)
				continue;

			scratch.push(chunk);
			if (scratch.length >= limit) break;
		}

		if (scratch.length === 0) return;

		// Bug 2 fix: snapshot into a new array before yielding.
		// The scratch array must not be passed across an await boundary
		// because a re-entrant flush would clear it mid-save.
		const chunksToSave = scratch.slice();
		scratch.length = 0;

		await WorldStorage.saveChunks(chunksToSave);
		this.adapter.onChunksFlushed?.(chunksToSave);
	}

	private async flushChunkBoundEntitiesInternal(
		maxChunks: number,
	): Promise<void> {
		const limit = Math.max(0, maxChunks);
		if (limit === 0) return;

		const payloadsByChunk = this.adapter.getChunkEntityPayloads();

		const scratch = this._candidateChunkIdsScratch;
		scratch.length = 0;

		const seen = this._seenChunkIdsScratch;
		seen.clear();

		for (const chunkId of payloadsByChunk.keys()) {
			if (seen.has(chunkId)) continue;
			seen.add(chunkId);
			scratch.push(chunkId);
			if (scratch.length >= limit) break;
		}

		if (scratch.length < limit) {
			for (const chunkId of this.lastPersistedEntityChunkIds) {
				if (seen.has(chunkId)) continue;
				seen.add(chunkId);
				scratch.push(chunkId);
				if (scratch.length >= limit) break;
			}
		}

		if (scratch.length === 0) return;

		// Bug 4 fix: snapshot before the first await so the scratch arrays
		// cannot be stomped by a re-entrant flush mid-loop.
		const candidateChunkIds = scratch.slice();
		scratch.length = 0;
		seen.clear();

		for (let i = 0; i < candidateChunkIds.length; i++) {
			const chunkId = candidateChunkIds[i];
			const payload = payloadsByChunk.get(chunkId) ?? [];

			await WorldStorage.saveChunkEntities(chunkId, payload);

			if (payload.length > 0) {
				this.lastPersistedEntityChunkIds.add(chunkId);
			} else {
				this.lastPersistedEntityChunkIds.delete(chunkId);
			}
		}

		this.adapter.onChunkEntitiesFlushed?.(candidateChunkIds);
	}
}
