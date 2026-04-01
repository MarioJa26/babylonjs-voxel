// FarTileStorage.ts

export interface TileId {
  lod: number; // 0 = finest far LOD, larger = coarser
  regionX: number;
  regionZ: number;
  regionY?: number; // optional vertical tiling for future use
}

export interface FarTileSurfaceSummary {
  minHeight: number;
  maxHeight: number;
  averageHeight: number;

  dominantBlockId: number;
  dominantWaterBlockId?: number;
  waterCoverage?: number; // 0..255, approximate %
}

export interface FarTileLightSummary {
  skyLightAverage: number; // 0..15
  blockLightAverage: number; // 0..15
  packedLight?: Uint8Array;
}

export type CompressionType = "none" | "gzip";

export interface FarTileMeshBlob {
  opaque: Uint8Array | null;
  transparent: Uint8Array | null;
  compression?: CompressionType;
}

export interface FarTileRecord {
  id: TileId;
  surface: FarTileSurfaceSummary;
  light?: FarTileLightSummary;
  mesh?: FarTileMeshBlob | null;
  version: number;
}

// --- internal helpers ---

const FAR_TILE_DB_NAME = "VoxelFarTilesDB";
const FAR_TILE_DB_VERSION = 1;
const FAR_TILE_STORE_NAME = "far_tiles";

function packTileId(id: TileId): string {
  const { lod, regionX, regionZ, regionY } = id;
  if (regionY == null) {
    return `${lod}:${regionX}:${regionZ}`;
  }
  return `${lod}:${regionX}:${regionY}:${regionZ}`;
}

function unpackTileId(key: string): TileId {
  const parts = key.split(":").map((v) => parseInt(v, 10));
  if (parts.length === 3) {
    const [lod, regionX, regionZ] = parts;
    return { lod, regionX, regionZ };
  }
  if (parts.length === 4) {
    const [lod, regionX, regionY, regionZ] = parts;
    return { lod, regionX, regionZ, regionY };
  }
  throw new Error(`Invalid tile key: ${key}`);
}

export class FarTileStorage {
  private static db: IDBDatabase | null = null;
  private static initPromise: Promise<void> | null = null;

  public static initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(FAR_TILE_DB_NAME, FAR_TILE_DB_VERSION);

      request.onerror = () => {
        console.error("FarTileStorage IndexedDB error:", request.error);
        reject(new Error("Failed to open VoxelFarTilesDB."));
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log("FarTileStorage initialized successfully.");
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(FAR_TILE_STORE_NAME)) {
          db.createObjectStore(FAR_TILE_STORE_NAME, { keyPath: "id" });
          console.log(`Object store '${FAR_TILE_STORE_NAME}' created.`);
        }
      };
    });

    return this.initPromise;
  }

  private static async ensureInitialized(): Promise<boolean> {
    if (this.db) return true;
    try {
      await this.initialize();
      return !!this.db;
    } catch (error) {
      console.warn("FarTileStorage initialization failed.", error);
      return false;
    }
  }

  // ---- public API ----

  public static async saveTile(record: FarTileRecord): Promise<void> {
    if (!(await this.ensureInitialized()) || !this.db) return;

    const id = packTileId(record.id);
    const tx = this.db.transaction(FAR_TILE_STORE_NAME, "readwrite");
    const store = tx.objectStore(FAR_TILE_STORE_NAME);

    const dataToStore = {
      id,
      lod: record.id.lod,
      regionX: record.id.regionX,
      regionZ: record.id.regionZ,
      regionY: record.id.regionY ?? null,
      surface: record.surface,
      light: record.light ?? null,
      mesh: record.mesh ?? null,
      version: record.version,
    };

    store.put(dataToStore);

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  public static async saveTiles(records: FarTileRecord[]): Promise<void> {
    if (records.length === 0) return;
    if (!(await this.ensureInitialized()) || !this.db) return;

    const tx = this.db.transaction(FAR_TILE_STORE_NAME, "readwrite");
    const store = tx.objectStore(FAR_TILE_STORE_NAME);

    for (const record of records) {
      const id = packTileId(record.id);
      const dataToStore = {
        id,
        lod: record.id.lod,
        regionX: record.id.regionX,
        regionZ: record.id.regionZ,
        regionY: record.id.regionY ?? null,
        surface: record.surface,
        light: record.light ?? null,
        mesh: record.mesh ?? null,
        version: record.version,
      };
      store.put(dataToStore);
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  public static async loadTile(id: TileId): Promise<FarTileRecord | null> {
    if (!(await this.ensureInitialized()) || !this.db) return null;

    const key = packTileId(id);
    const tx = this.db.transaction(FAR_TILE_STORE_NAME, "readonly");
    const store = tx.objectStore(FAR_TILE_STORE_NAME);
    const request = store.get(key);

    return new Promise<FarTileRecord | null>((resolve, reject) => {
      request.onsuccess = () => {
        const result = request.result as
          | (Omit<FarTileRecord, "id"> & { id: string })
          | undefined;
        if (!result) {
          resolve(null);
          return;
        }
        resolve({
          id: unpackTileId(result.id),
          surface: result.surface,
          light: result.light ?? undefined,
          mesh: result.mesh ?? undefined,
          version: result.version,
        });
      };
      request.onerror = () => reject(request.error);
    });
  }

  public static async loadTilesInRegion(
    lod: number,
    minRegionX: number,
    maxRegionX: number,
    minRegionZ: number,
    maxRegionZ: number,
  ): Promise<FarTileRecord[]> {
    const out: FarTileRecord[] = [];
    if (!(await this.ensureInitialized()) || !this.db) return out;

    const tx = this.db.transaction(FAR_TILE_STORE_NAME, "readonly");
    const store = tx.objectStore(FAR_TILE_STORE_NAME);
    const request = store.openCursor();

    return new Promise<FarTileRecord[]>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(out);
          return;
        }

        const row = cursor.value as any;
        if (
          row.lod === lod &&
          row.regionX >= minRegionX &&
          row.regionX <= maxRegionX &&
          row.regionZ >= minRegionZ &&
          row.regionZ <= maxRegionZ
        ) {
          out.push({
            id: unpackTileId(row.id),
            surface: row.surface,
            light: row.light ?? undefined,
            mesh: row.mesh ?? undefined,
            version: row.version,
          });
        }

        cursor.continue();
      };

      request.onerror = () => reject(request.error);
    });
  }

  public static async deleteTile(id: TileId): Promise<void> {
    if (!(await this.ensureInitialized()) || !this.db) return;

    const key = packTileId(id);
    const tx = this.db.transaction(FAR_TILE_STORE_NAME, "readwrite");
    const store = tx.objectStore(FAR_TILE_STORE_NAME);
    store.delete(key);

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  public static async clearAllTiles(): Promise<void> {
    if (!(await this.ensureInitialized()) || !this.db) return;

    const tx = this.db.transaction(FAR_TILE_STORE_NAME, "readwrite");
    const store = tx.objectStore(FAR_TILE_STORE_NAME);
    store.clear();

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
