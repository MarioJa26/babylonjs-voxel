import { Chunk } from "./Chunk/Chunk";
import { MeshData } from "./Chunk/DataStructures/MeshData";
import { GlobalValues } from "./GlobalValues";
import { SettingParams } from "./SettingParams";

export type SavedChunkData = {
  blocks: Uint8Array | Uint16Array | null;
  palette?: number[] | null;
  uniformBlockId?: number;
  isUniform?: boolean;
  light_array?: Uint8Array;
  opaqueMesh?: MeshData;
  waterMesh?: MeshData;
  glassMesh?: MeshData;
  compressed?: boolean;
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

    const blocks = chunk.block_array;
    const light = chunk.light_array;

    // Capture state synchronously before await to prevent race conditions with chunk disposal
    const id = chunk.id.toString();
    const palette = chunk.palette;
    const uniformBlockId = chunk.uniformBlockId;
    const isUniform = chunk.isUniform;
    const opaqueMesh = chunk.opaqueMeshData;
    const waterMesh = chunk.waterMeshData;
    const glassMesh = chunk.glassMeshData;

    const compressedBlocks = blocks ? await this.compress(blocks) : null;
    const compressedLight = light ? await this.compress(light) : null;

    const transaction = this.db.transaction(CHUNK_STORE_NAME, "readwrite");
    const store = transaction.objectStore(CHUNK_STORE_NAME);
    // IndexedDB does not support bigint as a key, so we convert it to a string.

    store.put({
      id,
      blocks: compressedBlocks,
      palette,
      uniformBlockId,
      isUniform,
      light_array: compressedLight,
      opaqueMesh,
      waterMesh,
      glassMesh,
      compressed: true,
    });

    chunk.isModified = false; // Mark as saved

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  public static async saveChunks(chunks: Chunk[]): Promise<void> {
    if (GlobalValues.DISABLE_CHUNK_SAVING) {
      // Saving is disabled for testing, do nothing.
      return Promise.resolve();
    }
    const modifiedChunks = chunks.filter((c) => c.isModified);
    if (!this.db || modifiedChunks.length === 0) {
      return Promise.resolve();
    }

    // Pre-compress data in parallel
    const preparedData = await Promise.all(
      modifiedChunks.map(async (chunk) => {
        const blocks = chunk.block_array;
        const light = chunk.light_array;

        // Capture state synchronously before await to prevent race conditions with chunk disposal
        const id = chunk.id.toString();
        const palette = chunk.palette;
        const uniformBlockId = chunk.uniformBlockId;
        const isUniform = chunk.isUniform;
        const opaqueMesh = chunk.opaqueMeshData;
        const waterMesh = chunk.waterMeshData;
        const glassMesh = chunk.glassMeshData;

        return {
          id,
          blocks: blocks ? await this.compress(blocks) : null,
          palette,
          uniformBlockId,
          isUniform,
          light_array: light ? await this.compress(light) : null,
          opaqueMesh,
          waterMesh,
          glassMesh,
          compressed: true,
        };
      }),
    );

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(CHUNK_STORE_NAME, "readwrite");
      const store = transaction.objectStore(CHUNK_STORE_NAME);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        console.error("Batch save transaction error:", transaction.error);
        reject(transaction.error);
      };

      for (const data of preparedData) {
        store.put(data);
      }
      for (const chunk of modifiedChunks) {
        chunk.isModified = false; // Mark as saved
      }
    });
  }

  public static async loadChunk(
    chunkId: bigint,
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
      request.onsuccess = async () => {
        if (request.result) {
          const data = request.result;
          if (data.compressed) {
            if (data.blocks) data.blocks = await this.decompress(data.blocks);
            if (data.light_array)
              data.light_array = (await this.decompress(
                data.light_array,
              )) as Uint8Array;
          }
          resolve(data);
        } else {
          resolve(null); // Chunk not found
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  public static async loadChunks(
    chunkIds: bigint[],
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
          request.onsuccess = async () => {
            if (request.result) {
              const data = request.result;
              if (data.compressed) {
                if (data.blocks)
                  data.blocks = await this.decompress(data.blocks);
                if (data.light_array)
                  data.light_array = (await this.decompress(
                    data.light_array,
                  )) as Uint8Array;
              }
              loadedChunks.set(chunkId, data);
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
    const stream = new Blob([data])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    if (buffer.byteLength === Chunk.SIZE3 * 2) {
      return new Uint16Array(buffer);
    }
    return new Uint8Array(buffer);
  }
}
