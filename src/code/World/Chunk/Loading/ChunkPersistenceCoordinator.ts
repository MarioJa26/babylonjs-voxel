import { SettingParams } from "../../SettingParams";
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
	private entityFlushPromise: Promise<void> | null = null;
	private readonly lastPersistedEntityChunkIds = new Set<bigint>();

	// Reusable scratch storage
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
			return this.flushPromise;
		}

		this.flushPromise = this.flushModifiedChunksInternal(maxChunks);

		try {
			await this.flushPromise;
		} finally {
			this.flushPromise = null;
		}
	}

	public async flushChunkBoundEntities(
		maxChunks: number = this.getChunkEntitySaveBatchSize(),
	): Promise<void> {
		if (this.entityFlushPromise) {
			return this.entityFlushPromise;
		}

		this.entityFlushPromise = this.flushChunkBoundEntitiesInternal(maxChunks);

		try {
			await this.entityFlushPromise;
		} finally {
			this.entityFlushPromise = null;
		}
	}

	public getLastPersistedEntityChunkIds(): ReadonlySet<bigint> {
		return this.lastPersistedEntityChunkIds;
	}

	private getChunkSaveBatchSize(): number {
		return Math.max(
			1,
			this.adapter.getChunkSaveBatchSize?.() ??
				SettingParams.CHUNK_UNLOAD_BATCH_LIMIT,
		);
	}

	private getChunkEntitySaveBatchSize(): number {
		return Math.max(
			1,
			this.adapter.getChunkEntitySaveBatchSize?.() ??
				SettingParams.CHUNK_UNLOAD_BATCH_LIMIT,
		);
	}

	private async flushModifiedChunksInternal(maxChunks: number): Promise<void> {
		const out = this._modifiedChunksScratch;
		out.length = 0;

		const limit = Math.max(0, maxChunks);
		if (limit === 0) {
			return;
		}

		for (const chunk of this.adapter.getModifiedChunks()) {
			// Persist both voxel edits (isModified) and derived mesh cache deltas
			// (isLODMeshCacheDirty). Border meshes are often generated after terrain
			// generation once neighbors become available, so they would never be
			// persisted if we only flushed isModified chunks.
			if (!chunk.isModified && !chunk.isLODMeshCacheDirty) continue;

			out.push(chunk);
			if (out.length >= limit) {
				break;
			}
		}

		if (out.length === 0) {
			return;
		}

		await WorldStorage.saveChunks(out);
		this.adapter.onChunksFlushed?.(out);
	}

	private async flushChunkBoundEntitiesInternal(
		maxChunks: number,
	): Promise<void> {
		const limit = Math.max(0, maxChunks);
		if (limit === 0) {
			return;
		}

		const payloadsByChunk = this.adapter.getChunkEntityPayloads();

		const candidateChunkIds = this._candidateChunkIdsScratch;
		candidateChunkIds.length = 0;

		const seen = this._seenChunkIdsScratch;
		seen.clear();

		for (const chunkId of payloadsByChunk.keys()) {
			if (seen.has(chunkId)) continue;

			seen.add(chunkId);
			candidateChunkIds.push(chunkId);

			if (candidateChunkIds.length >= limit) {
				break;
			}
		}

		if (candidateChunkIds.length < limit) {
			for (const chunkId of this.lastPersistedEntityChunkIds) {
				if (seen.has(chunkId)) continue;

				seen.add(chunkId);
				candidateChunkIds.push(chunkId);

				if (candidateChunkIds.length >= limit) {
					break;
				}
			}
		}

		if (candidateChunkIds.length === 0) {
			return;
		}

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
