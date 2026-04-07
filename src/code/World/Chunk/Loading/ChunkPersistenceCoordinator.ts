import { Chunk } from "../Chunk";
import { WorldStorage, type SavedChunkEntityData } from "../../WorldStorage";
import { SettingParams } from "../../SettingParams";

export interface ChunkPersistenceCoordinatorAdapter {
  /**
   * Return all currently modified chunks that may need persistence.
   */
  getModifiedChunks(): Iterable<Chunk>;

  /**
   * Return the current serialized entity payloads grouped by chunk id.
   * Chunks that previously had entities but now do not will still be flushed
   * as empty arrays by this coordinator.
   */
  getChunkEntityPayloads(): ReadonlyMap<bigint, SavedChunkEntityData[]>;

  /**
   * Optional batch size overrides.
   */
  getChunkSaveBatchSize?(): number;
  getChunkEntitySaveBatchSize?(): number;

  /**
   * Optional lifecycle hooks.
   */
  onChunksFlushed?(chunks: readonly Chunk[]): void;
  onChunkEntitiesFlushed?(chunkIds: readonly bigint[]): void;
}

export class ChunkPersistenceCoordinator {
  private flushPromise: Promise<void> | null = null;
  private entityFlushPromise: Promise<void> | null = null;
  private readonly lastPersistedEntityChunkIds = new Set<bigint>();

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
    const modifiedChunks = [...this.adapter.getModifiedChunks()]
      .filter((chunk) => chunk.isModified)
      .slice(0, Math.max(0, maxChunks));

    if (modifiedChunks.length === 0) {
      return;
    }

    await WorldStorage.saveChunks(modifiedChunks);
    this.adapter.onChunksFlushed?.(modifiedChunks);
  }

  private async flushChunkBoundEntitiesInternal(
    maxChunks: number,
  ): Promise<void> {
    const payloadsByChunk = this.adapter.getChunkEntityPayloads();

    const candidateChunkIds: bigint[] = [];
    const seen = new Set<bigint>();

    for (const chunkId of payloadsByChunk.keys()) {
      if (seen.has(chunkId)) continue;
      seen.add(chunkId);
      candidateChunkIds.push(chunkId);
    }

    for (const chunkId of this.lastPersistedEntityChunkIds) {
      if (seen.has(chunkId)) continue;
      seen.add(chunkId);
      candidateChunkIds.push(chunkId);
    }

    const chunkIdsToFlush = candidateChunkIds.slice(0, Math.max(0, maxChunks));
    if (chunkIdsToFlush.length === 0) {
      return;
    }

    await Promise.all(
      chunkIdsToFlush.map(async (chunkId) => {
        const payload = payloadsByChunk.get(chunkId) ?? [];
        await WorldStorage.saveChunkEntities(chunkId, payload);

        if (payload.length > 0) {
          this.lastPersistedEntityChunkIds.add(chunkId);
        } else {
          this.lastPersistedEntityChunkIds.delete(chunkId);
        }
      }),
    );

    this.adapter.onChunkEntitiesFlushed?.(chunkIdsToFlush);
  }
}
