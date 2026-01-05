import { Mesh } from "@babylonjs/core";
import { ChunkWorkerPool } from "./ChunkWorkerPool";
import { MeshData } from "./MeshData";
import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";

export class Chunk {
  public static readonly SIZE = GenerationParams.CHUNK_SIZE;
  public static readonly SIZE2 = Chunk.SIZE * Chunk.SIZE;
  public static readonly SIZE3 = Chunk.SIZE * Chunk.SIZE * Chunk.SIZE;
  public static readonly chunkInstances = new Map<bigint, Chunk>();
  public isModified = false;

  public isDirty = false;
  public isLoaded = true;
  public readonly id: bigint;
  private remeshTimeout: number | null = null;

  block_array: Uint8Array;

  #chunkY: number;
  #chunkX: number;
  #chunkZ: number;
  public mesh: Mesh | null = null;
  public waterMesh: Mesh | null = null;
  public glassMesh: Mesh | null = null;
  public opaqueMeshData: MeshData | null = null;
  public waterMeshData: MeshData | null = null;
  public glassMeshData: MeshData | null = null;

  constructor(chunkX: number, chunkY: number, chunkZ: number) {
    this.#chunkX = chunkX;
    this.#chunkY = chunkY;
    this.#chunkZ = chunkZ;
    this.id = Chunk.packCoords(chunkX, chunkY, chunkZ);
    this.block_array = new Uint8Array(Chunk.SIZE ** 3);
    this.block_array.fill(0);
    Chunk.chunkInstances.set(this.id, this);
  }

  public populate(block_array: Uint8Array, scheduleRemesh = true): void {
    this.block_array = block_array;
    if (scheduleRemesh) {
      this.scheduleRemesh();
      this.getNeighbor(-1, 0, 0)?.scheduleRemesh();
      this.getNeighbor(0, 0, -1)?.scheduleRemesh();
      this.getNeighbor(0, -1, 0)?.scheduleRemesh();
    }
  }

  public getBlock(localX: number, localY: number, localZ: number): number {
    return this.block_array[
      localX + localY * Chunk.SIZE + localZ * Chunk.SIZE2
    ];
  }

  public setBlock(
    localX: number,
    localY: number,
    localZ: number,
    blockId: number
  ): void {
    const index = localX + localY * Chunk.SIZE + localZ * Chunk.SIZE2;
    if (index < 0 || index >= this.block_array.length) return; // Out of bounds check
    this.block_array[index] = blockId;

    this.isModified = true;
    this.scheduleRemesh();

    // If the block is on a boundary, the neighbor chunk must also be remeshed.
    if (localX === 0) {
      this.getNeighbor(-1, 0, 0)?.scheduleRemesh();
    } else if (localX === Chunk.SIZE - 1) {
      this.getNeighbor(1, 0, 0)?.scheduleRemesh();
    }
    if (localY === 0) {
      this.getNeighbor(0, -1, 0)?.scheduleRemesh();
    } else if (localY === Chunk.SIZE - 1) {
      this.getNeighbor(0, 1, 0)?.scheduleRemesh();
    }
    if (localZ === 0) {
      this.getNeighbor(0, 0, -1)?.scheduleRemesh();
    } else if (localZ === Chunk.SIZE - 1) {
      this.getNeighbor(0, 0, 1)?.scheduleRemesh();
    }
  }

  public deleteBlock(localX: number, localY: number, localZ: number): void {
    const index = localX + localY * Chunk.SIZE + localZ * Chunk.SIZE2;
    if (this.block_array[index] === 0) return; // Already air

    this.block_array[index] = 0;

    this.isModified = true;
    this.scheduleRemesh();

    // If the block is on a boundary, the neighbor chunk must also be remeshed.
    if (localX === 0) {
      this.getNeighbor(-1, 0, 0)?.scheduleRemesh();
    } else if (localX === Chunk.SIZE - 1) {
      this.getNeighbor(1, 0, 0)?.scheduleRemesh();
    }
    if (localY === 0) {
      this.getNeighbor(0, -1, 0)?.scheduleRemesh();
    } else if (localY === Chunk.SIZE - 1) {
      this.getNeighbor(0, 1, 0)?.scheduleRemesh();
    }
    if (localZ === 0) {
      this.getNeighbor(0, 0, -1)?.scheduleRemesh();
    } else if (localZ === Chunk.SIZE - 1) {
      this.getNeighbor(0, 0, 1)?.scheduleRemesh();
    }
  }

  public scheduleRemesh(): void {
    this.isDirty = true;
    if (this.remeshTimeout !== null) {
      return;
    }

    this.remeshTimeout = setTimeout(() => {
      const pool = ChunkWorkerPool.getInstance();
      pool.scheduleRemesh(this);
      this.isDirty = false;
      this.remeshTimeout = null;
    }, 0);
  }

  get chunkX(): number {
    return this.#chunkX;
  }
  get chunkY(): number {
    return this.#chunkY;
  }
  get chunkZ(): number {
    return this.#chunkZ;
  }

  public getNeighbor(dx: number, dy: number, dz: number): Chunk | undefined {
    const nx = this.chunkX + dx;
    const ny = this.chunkY + dy;
    const nz = this.chunkZ + dz;
    return Chunk.getChunk(nx, ny, nz);
  }

  public static getChunk(
    chunkX: number,
    chunkY: number,
    chunkZ: number
  ): Chunk | undefined {
    const key = Chunk.packCoords(chunkX, chunkY, chunkZ);
    return Chunk.chunkInstances.get(key);
  }

  // --- Coordinate Packing for BigInt Keys ---
  private static readonly BITS = 21n; // 21 bits allows for coordinates up to ~1 million
  private static readonly MASK = (1n << this.BITS) - 1n;
  private static readonly Y_SHIFT = this.BITS;
  private static readonly Z_SHIFT = this.BITS * 2n;

  public static packCoords(x: number, y: number, z: number): bigint {
    const xBig = BigInt(x) & this.MASK;
    const yBig = (BigInt(y) & this.MASK) << this.Y_SHIFT;
    const zBig = (BigInt(z) & this.MASK) << this.Z_SHIFT;
    return xBig | yBig | zBig;
  }

  public dispose(): void {
    this.mesh?.dispose();
    this.waterMesh?.dispose();
    this.glassMesh?.dispose();
    this.mesh = null;
    this.waterMesh = null;
    this.glassMesh = null;
    this.opaqueMeshData = null;
    this.waterMeshData = null;
    this.glassMeshData = null;
  }
}
