import { Chunk } from "./Chunk/Chunk";

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
    if (!this.db) {
      console.warn("DB not initialized, cannot save chunk.");
      return;
    }
    const transaction = this.db.transaction(CHUNK_STORE_NAME, "readwrite");
    const store = transaction.objectStore(CHUNK_STORE_NAME);
    // IndexedDB does not support bigint as a key, so we convert it to a string.
    store.put({ id: chunk.id.toString(), blocks: chunk.block_array });

    chunk.isModified = false; // Mark as saved

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  public static async saveChunks(chunks: Chunk[]): Promise<void> {
    if (!this.db || chunks.length === 0) {
      return;
    }

    const transaction = this.db.transaction(CHUNK_STORE_NAME, "readwrite");
    const store = transaction.objectStore(CHUNK_STORE_NAME);

    transaction.onerror = () => {
      console.error("Batch save transaction error:", transaction.error);
    };

    for (const chunk of chunks) {
      if (chunk.isModified) {
        // IndexedDB does not support bigint as a key, so we convert it to a string.
        store.put({ id: chunk.id.toString(), blocks: chunk.block_array });
        chunk.isModified = false; // Mark as saved
      }
    }
  }

  public static async loadChunk(chunkId: bigint): Promise<Uint8Array | null> {
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
          resolve(request.result.blocks);
        } else {
          resolve(null); // Chunk not found
        }
      };
      request.onerror = () => reject(request.error);
    });
  }
}
