import { Chunk } from "../Chunk";
import { WorldStorage, type SavedChunkEntityData } from "../../WorldStorage";

/**
 * Loader used to recreate a runtime entity from persisted payload.
 * This matches the shape already implied by ChunkLoadingSystem:
 *   Map<string, (payload: unknown, chunk: Chunk) => void>
 */
export type ChunkEntityLoader = (payload: unknown, chunk: Chunk) => void;

/**
 * Adapter layer so this registry does not need to know your exact runtime
 * entity shape yet. You wire these three functions from ChunkLoadingSystem.
 */
export interface ChunkBoundEntityAdapter<TEntity> {
  /**
   * Return the owning chunk id for the runtime entity.
   * Return null if the entity is not currently bound to a chunk.
   */
  getChunkId(entity: TEntity): bigint | null;

  /**
   * Serialize the entity into WorldStorage's SavedChunkEntityData shape.
   * Return null if this entity should not be persisted.
   */
  serialize(entity: TEntity): SavedChunkEntityData | null;

  /**
   * Dispose / detach the runtime entity when its chunk unloads.
   * Can be sync or async.
   */
  dispose(entity: TEntity): void | Promise<void>;
}

/**
 * Keeps all chunk-bound entity responsibilities in one place:
 * - register runtime entities
 * - register entity loaders
 * - save entities when chunk unloads
 * - restore entities when chunk loads
 * - retain unresolved payloads when no loader exists yet
 */
export class ChunkEntityRegistry<TEntity> {
  private readonly entities = new Map<symbol, TEntity>();
  private readonly pendingReloads = new Map<bigint, SavedChunkEntityData[]>();
  private readonly loaders = new Map<string, ChunkEntityLoader>();

  private restoringChunkEntities = false;
  private chunkLoadedHookInstalled = false;
  private previousChunkLoadedHook: ((chunk: Chunk) => void) | null = null;

  public constructor(
    private readonly adapter: ChunkBoundEntityAdapter<TEntity>,
  ) {}

  public registerLoader(type: string, loader: ChunkEntityLoader): void {
    this.loaders.set(type, loader);
  }

  public registerEntity(entity: TEntity): symbol {
    const handle = Symbol("chunk-bound-entity");
    this.entities.set(handle, entity);
    return handle;
  }

  public unregisterEntity(handle: symbol | undefined): void {
    if (!handle) return;
    this.entities.delete(handle);
  }

  /**
   * Install a single hook so entities are restored whenever Chunk.onChunkLoaded fires.
   * This preserves any previously assigned hook instead of clobbering it.
   */
  public ensureChunkLoadedHook(): void {
    if (this.chunkLoadedHookInstalled) return;

    this.previousChunkLoadedHook = Chunk.onChunkLoaded ?? null;

    Chunk.onChunkLoaded = (chunk: Chunk) => {
      try {
        this.previousChunkLoadedHook?.(chunk);
      } finally {
        void this.restoreEntitiesForChunk(chunk);
      }
    };

    this.chunkLoadedHookInstalled = true;
  }

  /**
   * Save + dispose runtime entities that belong to a chunk.
   * Any payloads are also cached in-memory so a same-session reload does not
   * need to wait for IndexedDB round-tripping.
   */
  public async unloadEntitiesForChunk(chunk: Chunk): Promise<void> {
    const serialized: SavedChunkEntityData[] = [];
    const handlesToDelete: symbol[] = [];

    for (const [handle, entity] of this.entities) {
      const entityChunkId = this.adapter.getChunkId(entity);
      if (entityChunkId !== chunk.id) continue;

      handlesToDelete.push(handle);

      const data = this.adapter.serialize(entity);
      if (data) {
        serialized.push(data);
      }

      await this.adapter.dispose(entity);
    }

    for (const handle of handlesToDelete) {
      this.entities.delete(handle);
    }

    if (serialized.length > 0) {
      this.pendingReloads.set(chunk.id, serialized);
      await WorldStorage.saveChunkEntities(chunk.id, serialized);
    } else {
      this.pendingReloads.delete(chunk.id);
      await WorldStorage.saveChunkEntities(chunk.id, []);
    }
  }

  /**
   * Restore any persisted entities for a chunk.
   * Priority:
   *   1) pending in-memory payloads from this session
   *   2) persisted payloads from WorldStorage
   *
   * Any payloads with no registered loader are kept so they can be retried later.
   */
  public async restoreEntitiesForChunk(chunk: Chunk): Promise<void> {
    if (this.restoringChunkEntities) return;

    this.restoringChunkEntities = true;
    try {
      const inMemory = this.pendingReloads.get(chunk.id);
      const serializedEntities =
        inMemory ?? (await WorldStorage.loadChunkEntities(chunk.id));

      if (!serializedEntities || serializedEntities.length === 0) {
        this.pendingReloads.delete(chunk.id);
        return;
      }

      const unresolved = this.spawnSerializedEntities(
        serializedEntities,
        chunk,
      );

      if (unresolved.length > 0) {
        this.pendingReloads.set(chunk.id, unresolved);
      } else {
        this.pendingReloads.delete(chunk.id);
      }
    } finally {
      this.restoringChunkEntities = false;
    }
  }

  /**
   * Attempt to spawn all serialized entities for a chunk.
   * Returns any payloads that could not be spawned because no loader was registered.
   */
  public spawnSerializedEntities(
    serializedEntities: SavedChunkEntityData[],
    chunk: Chunk,
  ): SavedChunkEntityData[] {
    const unresolved: SavedChunkEntityData[] = [];

    for (const entry of serializedEntities) {
      const loader = this.loaders.get(entry.type);
      if (!loader) {
        unresolved.push(entry);
        continue;
      }

      try {
        loader(entry.payload, chunk);
      } catch (error) {
        console.error(
          `[ChunkEntityRegistry] Failed to restore entity of type "${entry.type}" for chunk ${chunk.id.toString()}:`,
          error,
        );
        unresolved.push(entry);
      }
    }

    return unresolved;
  }

  /**
   * Optional helper if you want to flush all currently registered entities in batches later.
   */
  public getRegisteredEntities(): ReadonlyMap<symbol, TEntity> {
    return this.entities;
  }

  /**
   * Optional helper for debug UI / chunk-loading stats.
   */
  public getPendingReloadCount(): number {
    let total = 0;
    for (const entries of this.pendingReloads.values()) {
      total += entries.length;
    }
    return total;
  }

  /**
   * Optional helper for debug UI / chunk-loading stats.
   */
  public getRegisteredEntityCount(): number {
    return this.entities.size;
  }
}
