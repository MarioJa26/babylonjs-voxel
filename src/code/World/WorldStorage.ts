import { Chunk } from "./Chunk/Chunk";
import { MeshData } from "./Chunk/DataStructures/MeshData";
import { getCurrentLodCacheVersion } from "./Chunk/LOD/LodCacheVersion";
import { GlobalValues } from "./GlobalValues";

export type SavedChunkData = {
  blocks: Uint8Array | Uint16Array | null;
  palette?: Uint16Array | null;
  uniformBlockId?: number;
  isUniform?: boolean;
  light_array?: Uint8Array;
  opaqueMesh?: MeshData;
  transparentMesh?: MeshData;
  lodMeshes?: Record<
    number,
    {
      opaque?: MeshData | null;
      transparent?: MeshData | null;
    }
  >;
  lodCacheVersion?: string;
  compressed?: boolean;
};

export type LoadChunkOptions = {
  includeVoxelData?: boolean;
};

export type SavedChunkEntityData = {
  type: string;
  payload: unknown;
};

const DB_NAME = "VoxelWorldDB";
const DB_VERSION = 2;
const CHUNK_STORE_NAME = "chunks";
const CHUNK_ENTITY_STORE_NAME = "chunk_entities";

type PersistenceLane = "critical" | "background";

type PersistenceJob = {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

type PreparedFullChunkSave = {
  id: string;
  chunk: Chunk;
  data: {
    id: string;
    blocks: Uint8Array | null;
    palette: Uint16Array | null;
    uniformBlockId: number;
    isUniform: boolean;
    light_array: Uint8Array | null;
    opaqueMesh: MeshData | null;
    transparentMesh: MeshData | null;
    lodMeshes: SavedChunkData["lodMeshes"];
    lodCacheVersion: string;
    compressed: true;
  };
};

type PreparedLodOnlySave = {
  id: string;
  chunk: Chunk;
  opaqueMesh: MeshData | null;
  transparentMesh: MeshData | null;
  lodMeshes: SavedChunkData["lodMeshes"];
  lodCacheVersion: string;
};

export class WorldStorage {
  private static db: IDBDatabase;
  private static initPromise: Promise<void> | null = null;
  private static pendingChunkSaves = new Map<string, Promise<void>>();
  private static persistenceQueues: Record<PersistenceLane, PersistenceJob[]> = {
    critical: [],
    background: [],
  };
  private static isProcessingPersistenceQueues = false;
  private static pendingLodInvalidationChunkIds = new Set<string>();

  private static async ensureInitialized(): Promise<boolean> {
    if (this.db) {
      return true;
    }

    try {
      await this.initialize();
      return !!this.db;
    } catch (error) {
      console.warn("WorldStorage initialization failed.", error);
      return false;
    }
  }

  private static trackPendingChunkSaves(
    chunkIds: string[],
    savePromise: Promise<void>,
  ): Promise<void> {
    const uniqueChunkIds = Array.from(new Set(chunkIds));
    const trackedPromise = savePromise.finally(() => {
      for (const id of uniqueChunkIds) {
        if (this.pendingChunkSaves.get(id) === trackedPromise) {
          this.pendingChunkSaves.delete(id);
        }
      }
    });

    for (const id of uniqueChunkIds) {
      this.pendingChunkSaves.set(id, trackedPromise);
    }

    return trackedPromise;
  }

  private static async awaitPendingChunkSaves(
    chunkIds: string[],
  ): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const id of new Set(chunkIds)) {
      const savePromise = this.pendingChunkSaves.get(id);
      if (savePromise) {
        pending.push(savePromise);
      }
    }

    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  }

  private static enqueuePersistenceJob(
    lane: PersistenceLane,
    chunkIds: string[],
    run: () => Promise<void>,
  ): Promise<void> {
    const savePromise = new Promise<void>((resolve, reject) => {
      this.persistenceQueues[lane].push({
        run,
        resolve,
        reject,
      });
      this.processPersistenceQueues();
    });

    return this.trackPendingChunkSaves(chunkIds, savePromise);
  }

  private static processPersistenceQueues(): void {
    if (this.isProcessingPersistenceQueues) {
      return;
    }
    this.isProcessingPersistenceQueues = true;

    const run = async () => {
      while (true) {
        const job =
          this.persistenceQueues.critical.shift() ??
          this.persistenceQueues.background.shift();
        if (!job) {
          break;
        }
        try {
          await job.run();
          job.resolve();
        } catch (error) {
          job.reject(error);
        }
      }

      this.isProcessingPersistenceQueues = false;
      if (
        this.persistenceQueues.critical.length > 0 ||
        this.persistenceQueues.background.length > 0
      ) {
        this.processPersistenceQueues();
      }
    };

    void run();
  }

  private static async persistPreparedFullChunks(
    prepared: PreparedFullChunkSave[],
  ): Promise<void> {
    if (prepared.length === 0) return;

    const transaction = this.db.transaction(CHUNK_STORE_NAME, "readwrite");
    const store = transaction.objectStore(CHUNK_STORE_NAME);
    for (const entry of prepared) {
      store.put(entry.data);
    }

    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => {
        for (const entry of prepared) {
          entry.chunk.isModified = false;
          entry.chunk.isLODMeshCacheDirty = false;
        }
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  private static async persistPreparedLodOnlyChunks(
    prepared: PreparedLodOnlySave[],
  ): Promise<void> {
    if (prepared.length === 0) return;

    const transaction = this.db.transaction(CHUNK_STORE_NAME, "readwrite");
    const store = transaction.objectStore(CHUNK_STORE_NAME);
    const updatedChunkRefs = new Set<Chunk>();

    for (const entry of prepared) {
      const getRequest = store.get(entry.id);
      getRequest.onsuccess = () => {
        const existing = getRequest.result;
        if (!existing) {
          // If we only have LOD delta but no base record yet, escalate to a
          // full save on the next persistence pass.
          entry.chunk.isModified = true;
          return;
        }

        existing.opaqueMesh = entry.opaqueMesh;
        existing.transparentMesh = entry.transparentMesh;
        existing.lodMeshes = entry.lodMeshes;
        existing.lodCacheVersion = entry.lodCacheVersion;
        store.put(existing);
        updatedChunkRefs.add(entry.chunk);
      };
    }

    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => {
        for (const chunk of updatedChunkRefs) {
          if (!chunk.isModified) {
            chunk.isLODMeshCacheDirty = false;
          }
        }
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  private static async persistLodCacheInvalidation(
    chunkId: string,
    targetVersion: string,
  ): Promise<void> {
    const transaction = this.db.transaction(CHUNK_STORE_NAME, "readwrite");
    const store = transaction.objectStore(CHUNK_STORE_NAME);
    const request = store.get(chunkId);

    request.onsuccess = () => {
      const existing = request.result;
      if (!existing) return;
      if (existing.lodCacheVersion === targetVersion) return;
      existing.lodMeshes = undefined;
      existing.lodCacheVersion = targetVersion;
      store.put(existing);
    };

    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  private static applyLodCacheVersionPolicy(
    chunkId: string,
    data: SavedChunkData,
  ): SavedChunkData {
    const currentVersion = getCurrentLodCacheVersion();
    if (data.lodCacheVersion === currentVersion) {
      return data;
    }

    // Invalidate only coarse LOD cache payloads; keep voxel data and base mesh.
    data.lodMeshes = undefined;
    this.scheduleLodCacheInvalidation(chunkId, currentVersion);
    return data;
  }

  private static scheduleLodCacheInvalidation(
    chunkId: string,
    targetVersion: string,
  ): void {
    if (this.pendingLodInvalidationChunkIds.has(chunkId)) {
      return;
    }
    this.pendingLodInvalidationChunkIds.add(chunkId);

    const jobPromise = this.enqueuePersistenceJob(
      "background",
      [chunkId],
      async () => {
        await this.persistLodCacheInvalidation(chunkId, targetVersion);
      },
    );

    void jobPromise.finally(() => {
      this.pendingLodInvalidationChunkIds.delete(chunkId);
    });
  }

  public static initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error("IndexedDB error:", request.error);
        reject(new Error("Failed to open IndexedDB."));
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log("IndexedDB initialized successfully.");
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
          db.createObjectStore(CHUNK_STORE_NAME, { keyPath: "id" });
          console.log(`Object store '${CHUNK_STORE_NAME}' created.`);
        }
        if (!db.objectStoreNames.contains(CHUNK_ENTITY_STORE_NAME)) {
          db.createObjectStore(CHUNK_ENTITY_STORE_NAME, { keyPath: "chunkId" });
          console.log(`Object store '${CHUNK_ENTITY_STORE_NAME}' created.`);
        }
      };
    });

    return this.initPromise;
  }

  public static async saveChunk(chunk: Chunk): Promise<void> {
    await this.saveChunks([chunk]);
  }

  public static async saveChunks(chunks: Chunk[]): Promise<void> {
    if (GlobalValues.DISABLE_CHUNK_SAVING) {
      // Saving is disabled for testing, do nothing.
      return Promise.resolve();
    }

    const savableChunks = chunks.filter(
      (c) => (c.isModified || c.isLODMeshCacheDirty) && !c.isPersistent,
    );

    if (savableChunks.length === 0) {
      return Promise.resolve();
    }
    if (!(await this.ensureInitialized())) {
      return Promise.resolve();
    }

    const fullSaveChunks = savableChunks.filter((chunk) => chunk.isModified);
    const lodOnlyChunks = savableChunks.filter(
      (chunk) => !chunk.isModified && chunk.isLODMeshCacheDirty,
    );

    const lanePromises: Promise<void>[] = [];

    if (fullSaveChunks.length > 0) {
      // Capture & compress up-front to freeze data before async lane execution.
      const preparedFull = await Promise.all(
        fullSaveChunks.map(async (chunk): Promise<PreparedFullChunkSave> => {
          const blocks = chunk.block_array;
          const light = chunk.light_array;
          const id = chunk.id.toString();

          return {
            id,
            chunk,
            data: {
              id,
              blocks: blocks ? await this.compress(blocks) : null,
              palette: chunk.palette,
              uniformBlockId: chunk.uniformBlockId,
              isUniform: chunk.isUniform,
              light_array: light ? await this.compress(light) : null,
              opaqueMesh: chunk.opaqueMeshData ?? null,
              transparentMesh: chunk.transparentMeshData ?? null,
              lodMeshes: chunk.getSerializableLODMeshCache(),
              lodCacheVersion: getCurrentLodCacheVersion(),
              compressed: true,
            },
          };
        }),
      );

      lanePromises.push(
        this.enqueuePersistenceJob(
          "critical",
          preparedFull.map((entry) => entry.id),
          async () => {
            await this.persistPreparedFullChunks(preparedFull);
          },
        ),
      );
    }

    if (lodOnlyChunks.length > 0) {
      const preparedLodOnly: PreparedLodOnlySave[] = lodOnlyChunks.map(
        (chunk) => ({
          id: chunk.id.toString(),
          chunk,
          opaqueMesh: chunk.opaqueMeshData ?? null,
          transparentMesh: chunk.transparentMeshData ?? null,
          lodMeshes: chunk.getSerializableLODMeshCache(),
          lodCacheVersion: getCurrentLodCacheVersion(),
        }),
      );

      lanePromises.push(
        this.enqueuePersistenceJob(
          "background",
          preparedLodOnly.map((entry) => entry.id),
          async () => {
            await this.persistPreparedLodOnlyChunks(preparedLodOnly);
          },
        ),
      );
    }

    await Promise.all(lanePromises);
  }

  public static async saveAllModifiedChunks(): Promise<void> {
    const modifiedChunks: Chunk[] = [];
    for (const chunk of Chunk.chunkInstances.values()) {
      if ((chunk.isModified || chunk.isLODMeshCacheDirty) && !chunk.isPersistent) {
        modifiedChunks.push(chunk);
      }
    }

    if (modifiedChunks.length > 0) {
      await this.saveChunks(modifiedChunks);
    }
  }

  public static async saveChunkEntities(
    chunkId: bigint,
    entities: SavedChunkEntityData[],
  ): Promise<void> {
    if (GlobalValues.DISABLE_CHUNK_SAVING) {
      return;
    }
    if (!(await this.ensureInitialized())) {
      return;
    }

    const chunkIdKey = chunkId.toString();
    const transaction = this.db.transaction(
      CHUNK_ENTITY_STORE_NAME,
      "readwrite",
    );
    const store = transaction.objectStore(CHUNK_ENTITY_STORE_NAME);

    if (entities.length === 0) {
      store.delete(chunkIdKey);
    } else {
      store.put({
        chunkId: chunkIdKey,
        entities,
      });
    }

    const savePromise = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });

    return this.trackPendingChunkSaves([chunkIdKey], savePromise);
  }

  public static async loadChunkEntities(
    chunkId: bigint,
  ): Promise<SavedChunkEntityData[]> {
    if (GlobalValues.DISABLE_CHUNK_LOADING) {
      return [];
    }
    if (!(await this.ensureInitialized())) {
      return [];
    }

    const chunkIdKey = chunkId.toString();
    await this.awaitPendingChunkSaves([chunkIdKey]);
    const transaction = this.db.transaction(
      CHUNK_ENTITY_STORE_NAME,
      "readonly",
    );
    const store = transaction.objectStore(CHUNK_ENTITY_STORE_NAME);
    const request = store.get(chunkIdKey);

    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const entities = request.result?.entities as
          | SavedChunkEntityData[]
          | undefined;
        resolve(Array.isArray(entities) ? entities : []);
      };
      request.onerror = () => reject(request.error);
    });
  }

  public static async clearWorldData(): Promise<void> {
    if (this.db) {
      this.db.close();
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);

      request.onsuccess = () => {
        console.log("World data cleared.");
        resolve();
      };

      request.onerror = () => {
        console.error("Failed to clear world data:", request.error);
        reject(request.error);
      };

      request.onblocked = () => {
        console.warn("Delete database blocked.");
      };
    });
  }

  public static async loadChunk(
    chunkId: bigint,
    options?: LoadChunkOptions,
  ): Promise<SavedChunkData | null> {
    if (GlobalValues.DISABLE_CHUNK_LOADING) {
      // Loading is disabled for testing, do nothing.
      return Promise.resolve(null);
    }
    if (!(await this.ensureInitialized())) {
      console.warn("DB not initialized, cannot load chunk.");
      return null;
    }
    await this.awaitPendingChunkSaves([chunkId.toString()]);
    const transaction = this.db.transaction(CHUNK_STORE_NAME, "readonly");
    const store = transaction.objectStore(CHUNK_STORE_NAME);
    // The key is stored as a string, so we must use a string to retrieve it.
    const request = store.get(chunkId.toString());

    return new Promise((resolve, reject) => {
      request.onsuccess = async () => {
        if (request.result) {
          const data = request.result;
          const chunkIdKey = chunkId.toString();
          const includeVoxelData = options?.includeVoxelData ?? true;
          if (data.compressed && includeVoxelData) {
            if (data.blocks) data.blocks = await this.decompress(data.blocks);
            if (data.light_array)
              data.light_array = (await this.decompress(
                data.light_array,
              )) as Uint8Array;
          } else if (!includeVoxelData) {
            data.blocks = null;
            data.palette = null;
            data.isUniform = undefined;
            data.uniformBlockId = undefined;
            data.light_array = undefined;
          }
          resolve(this.applyLodCacheVersionPolicy(chunkIdKey, data));
        } else {
          resolve(null); // Chunk not found
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  public static async loadChunks(
    chunkIds: bigint[],
    options?: LoadChunkOptions,
  ): Promise<Map<bigint, SavedChunkData>> {
    const loadedChunks = new Map<bigint, SavedChunkData>();
    if (GlobalValues.DISABLE_CHUNK_LOADING) {
      // Loading is disabled for testing, do nothing.
      return loadedChunks;
    }
    if (chunkIds.length === 0) {
      return loadedChunks;
    }
    if (!(await this.ensureInitialized())) {
      return loadedChunks;
    }
    await this.awaitPendingChunkSaves(chunkIds.map((id) => id.toString()));

    const transaction = this.db.transaction(CHUNK_STORE_NAME, "readonly");
    const store = transaction.objectStore(CHUNK_STORE_NAME);

    const promises = chunkIds.map((chunkId) => {
      return new Promise<void>((resolve, reject) => {
        const request = store.get(chunkId.toString());
        request.onsuccess = async () => {
          if (request.result) {
            const data = request.result;
            const chunkIdKey = chunkId.toString();
            const includeVoxelData = options?.includeVoxelData ?? true;
            if (data.compressed && includeVoxelData) {
              if (data.blocks) data.blocks = await this.decompress(data.blocks);
              if (data.light_array)
                data.light_array = (await this.decompress(
                  data.light_array,
                )) as Uint8Array;
            } else if (!includeVoxelData) {
              data.blocks = null;
              data.palette = null;
              data.isUniform = undefined;
              data.uniformBlockId = undefined;
              data.light_array = undefined;
            }
            loadedChunks.set(
              chunkId,
              this.applyLodCacheVersionPolicy(chunkIdKey, data),
            );
          }
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    });
    await Promise.all(promises);

    return loadedChunks;
  }

  private static async compress(
    data: Uint8Array | Uint16Array,
  ): Promise<Uint8Array> {
    const inputBytes = new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
    // Create a copy to ensure we are not using SharedArrayBuffer which Blob doesn't like
    const copy = new Uint8Array(inputBytes.length);
    copy.set(inputBytes);
    const stream = new Blob([copy])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  private static async decompress(
    data: Uint8Array,
  ): Promise<Uint8Array | Uint16Array> {
    const readableStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    }).pipeThrough(new DecompressionStream("gzip"));

    const buffer = await new Response(readableStream).arrayBuffer();
    // Convert to SharedArrayBuffer to ensure zero-copy sharing with workers later
    const sharedBuffer = new SharedArrayBuffer(buffer.byteLength);
    new Uint8Array(sharedBuffer).set(new Uint8Array(buffer));

    if (sharedBuffer.byteLength === Chunk.SIZE3 * 2) {
      return new Uint16Array(sharedBuffer);
    }
    return new Uint8Array(sharedBuffer);
  }
}
