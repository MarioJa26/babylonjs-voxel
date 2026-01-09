import { Chunk } from "./Chunk/Chunk";
import { MeshData } from "./Chunk/DataStructures/MeshData";
import { GlobalValues } from "./GlobalValues";
import { SettingParams } from "./SettingParams";

export type SavedChunkData = {
  blocks: Uint8Array;
  light_array?: Uint8Array;
  opaqueMesh?: MeshData;
  waterMesh?: MeshData;
  glassMesh?: MeshData;
};

const DB_NAME = "VoxelWorldDB";
const DB_VERSION = 1;
const CHUNK_STORE_NAME = "chunks";

export class WorldStorage {
  private static db: IDBDatabase;
  private static initPromise: Promise<void> | null = null;

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
      };
    });

    return this.initPromise;
  }

  public static async saveChunk(chunk: Chunk): Promise<void> {
    if (GlobalValues.DISABLE_CHUNK_SAVING) {
      // Saving is disabled for testing, do nothing.
      return;
    }
    if (!chunk.isModified) {
      return;
    }
    if (!this.db) {
      console.warn("DB not initialized, cannot save chunk.");
      return;
    }
    const transaction = this.db.transaction(CHUNK_STORE_NAME, "readwrite");
    const store = transaction.objectStore(CHUNK_STORE_NAME);
    // IndexedDB does not support bigint as a key, so we convert it to a string.
    store.put({
      id: chunk.id.toString(),
      blocks: chunk.block_array,
      light_array: chunk.light_array,
      opaqueMesh: chunk.opaqueMeshData,
      waterMesh: chunk.waterMeshData,
      glassMesh: chunk.glassMeshData,
    });

    chunk.isModified = false; // Mark as saved

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  public static saveChunks(chunks: Chunk[]): Promise<void> {
    if (GlobalValues.DISABLE_CHUNK_SAVING) {
      // Saving is disabled for testing, do nothing.
      return Promise.resolve();
    }
    const modifiedChunks = chunks.filter((c) => c.isModified);
    if (!this.db || modifiedChunks.length === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(CHUNK_STORE_NAME, "readwrite");
      const store = transaction.objectStore(CHUNK_STORE_NAME);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        console.error("Batch save transaction error:", transaction.error);
        reject(transaction.error);
      };

      for (const chunk of modifiedChunks) {
        // IndexedDB does not support bigint as a key, so we convert it to a string.
        store.put({
          id: chunk.id.toString(),
          blocks: chunk.block_array,
          light_array: chunk.light_array,
          opaqueMesh: chunk.opaqueMeshData,
          waterMesh: chunk.waterMeshData,
          glassMesh: chunk.glassMeshData,
        });
        chunk.isModified = false; // Mark as saved
      }
    });
  }

  public static async loadChunk(
    chunkId: bigint
  ): Promise<SavedChunkData | null> {
    if (GlobalValues.DISABLE_CHUNK_LOADING) {
      // Loading is disabled for testing, do nothing.
      return Promise.resolve(null);
    }
    if (!this.db) {
      console.warn("DB not initialized, cannot load chunk.");
      return null;
    }
    const transaction = this.db.transaction(CHUNK_STORE_NAME, "readonly");
    const store = transaction.objectStore(CHUNK_STORE_NAME);
    // The key is stored as a string, so we must use a string to retrieve it.
    const request = store.get(chunkId.toString());

    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        if (request.result) {
          resolve({
            blocks: request.result.blocks,
            light_array: request.result.light_array,
            opaqueMesh: request.result.opaqueMesh,
            waterMesh: request.result.waterMesh,
            glassMesh: request.result.glassMesh,
          });
        } else {
          resolve(null); // Chunk not found
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  public static async loadChunks(
    chunkIds: bigint[]
  ): Promise<Map<bigint, SavedChunkData>> {
    const loadedChunks = new Map<bigint, SavedChunkData>();
    if (GlobalValues.DISABLE_CHUNK_LOADING) {
      // Loading is disabled for testing, do nothing.
      return loadedChunks;
    }
    if (!this.db || chunkIds.length === 0) {
      return loadedChunks;
    }

    const BATCH_SIZE = SettingParams.RENDER_DISTANCE;
    for (let i = 0; i < chunkIds.length; i += BATCH_SIZE) {
      const batchIds = chunkIds.slice(i, i + BATCH_SIZE);
      const transaction = this.db.transaction(CHUNK_STORE_NAME, "readonly");
      const store = transaction.objectStore(CHUNK_STORE_NAME);

      const promises = batchIds.map((chunkId) => {
        return new Promise<void>((resolve, reject) => {
          const request = store.get(chunkId.toString());
          request.onsuccess = () => {
            if (request.result) {
              loadedChunks.set(chunkId, request.result);
            }
            resolve();
          };
          request.onerror = () => reject(request.error);
        });
      });
      await Promise.all(promises);
    }
    return loadedChunks;
  }
}
