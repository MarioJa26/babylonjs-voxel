import { Mesh } from "@babylonjs/core";
import { ChunkWorkerPool } from "./ChunkWorkerPool";
import { World } from "../World";

export class Chunk {
  public static readonly SIZE = 32;
  public static readonly SIZE2 = Chunk.SIZE * Chunk.SIZE;
  public static readonly SIZE3 = Chunk.SIZE * Chunk.SIZE * Chunk.SIZE;

  public static readonly chunkInstances = new Map<string, Chunk>();
  private static nextId = 0;

  public isDirty = false;
  public readonly id: string;
  private remeshTimeout: number | null = null;

  block_array: Uint8Array;

  #chunkY: number;
  #chunkX: number;
  #chunkZ: number;
  public mesh: Mesh | null = null;
  public transparentMesh: Mesh | null = null;

  constructor(chunkX: number, chunkY: number, chunkZ: number) {
    this.#chunkX = chunkX;
    this.#chunkY = chunkY;
    this.#chunkZ = chunkZ;
    this.id = (Chunk.nextId++).toString();

    World.addChunk(this); // Add this chunk to the world's map
    Chunk.chunkInstances.set(this.id, this); // Keep this for worker pool backward compatibility

    this.block_array = new Uint8Array(Chunk.SIZE3);
    this.block_array.fill(0);
  }

  /**
   * Populates the chunk with block data and schedules remeshing for itself and neighbors.
   * This is called when terrain generation for this chunk is complete.
   * @param block_array The block data from the worker.
   */
  public populate(block_array: Uint8Array): void {
    this.block_array = block_array;
    this.scheduleRemesh();
    this.getNeighbors().forEach((neighbor) => {
      neighbor.scheduleRemesh();
    });
  }

  /**
   * Gets a block ID using LOCAL chunk coordinates (0-15).
   */
  public getBlock(localX: number, localY: number, localZ: number): number {
    return this.block_array[
      localX + localY * Chunk.SIZE + localZ * Chunk.SIZE2
    ];
  }

  /**
   * Sets a block using LOCAL chunk coordinates (0-15).
   * This is called by the World class.
   */
  public setBlock(
    localX: number,
    localY: number,
    localZ: number,
    blockId: number
  ): void {
    const index = localX + localY * Chunk.SIZE + localZ * Chunk.SIZE2;
    if (index < 0 || index >= this.block_array.length) return; // Out of bounds check
    this.block_array[index] = blockId;

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

  /**
   * Deletes a block using LOCAL chunk coordinates (0-15).
   * This is called by the World class.
   */
  public deleteBlock(localX: number, localY: number, localZ: number): void {
    const index = localX + localY * Chunk.SIZE + localZ * Chunk.SIZE2;
    if (this.block_array[index] === 0) return; // Already air

    this.block_array[index] = 0;

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

    // Defer the remesh to the next available moment in the event loop.
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
    return World.getChunk(nx, ny, nz);
  }

  public getNeighbors(): Chunk[] {
    return [
      this.getNeighbor(1, 0, 0),
      this.getNeighbor(-1, 0, 0),
      this.getNeighbor(0, 1, 0),
      this.getNeighbor(0, -1, 0),
      this.getNeighbor(0, 0, 1),
      this.getNeighbor(0, 0, -1),
    ].filter((c): c is Chunk => c !== undefined);
  }
}
