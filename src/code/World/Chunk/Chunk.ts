import { Mesh } from "@babylonjs/core";
import { ChunkMesher } from "./ChunckMesher";

export class Chunk {
  public static readonly SIZE = 64;
  public static readonly SIZE2 = Chunk.SIZE * Chunk.SIZE;
  public static readonly SIZE3 = Chunk.SIZE * Chunk.SIZE * Chunk.SIZE;
  public static readonly chunkInstances: Chunk[] = [];

  public isDirty = false;
  private remeshTimeout: number | null = null;

  block_array: Uint8Array;

  #chunkY: number;
  #chunkX: number;
  #chunkZ: number;
  public mesh: Mesh | null = null;

  constructor(chunkX: number, chunkY: number, chunkZ: number) {
    this.#chunkX = chunkX;
    this.#chunkY = chunkY;
    this.#chunkZ = chunkZ;

    Chunk.chunkInstances.push(this);

    this.block_array = new Uint8Array(Chunk.SIZE3);
    this.block_array.fill(0);

    if (this.#chunkY === 0)
      for (let x = 0; x < Chunk.SIZE; x++) {
        for (let z = 0; z < Chunk.SIZE; z++) {
          const terrainHeight = this.#getTerrainHeight(x, z);
          this.#genTerrainColumn(x, z, terrainHeight);

          // Use a deterministic function based on world coordinates for tree placement
          const worldX = this.#chunkX * Chunk.SIZE + x;
          const worldZ = this.#chunkZ * Chunk.SIZE + z;
          const treeNoise = (Math.sin(worldX / 12) + Math.cos(worldZ / 12)) / 2;

          // Place a tree if the noise value is within a certain threshold
          if (treeNoise > 0.992) {
            this.#genTree(x, terrainHeight, z);
          }
        }
      }
  }

  #genTree(localX: number, localY: number, localZ: number): void {
    const treeHeight = 15;
    // Place the trunk
    for (let i = 1; i <= treeHeight; i++) {
      this.setBlock(localX, localY + i, localZ, 10);
    }

    // Place leaves
    const radius = 5;
    for (let y = localY + treeHeight; y <= localY + treeHeight + radius; y++) {
      for (let x = localX - radius; x <= localX + radius; x++) {
        for (let z = localZ - radius; z <= localZ + radius; z++) {
          const dist =
            (x - localX) ** 2 +
            (z - localZ) ** 2 +
            ((y - (localY + treeHeight)) * 0.5) ** 2;
          if (dist < radius ** 2) {
            this.setBlock(x, y, z, 2);
          }
        }
      }
    }
  }

  #getTerrainHeight(localX: number, localZ: number): number {
    const worldX = this.#chunkX * Chunk.SIZE + localX;
    const worldZ = this.#chunkZ * Chunk.SIZE + localZ;
    return Math.floor(
      10 + Math.sin(worldX / 32) * 5 + Math.cos(worldZ / 32) * 5
    );
  }

  #genTerrainColumn(localX: number, localZ: number, height: number): void {
    for (let y = 0; y < height; y++) {
      this.setBlock(localX, y, localZ, 1);
    }
    // Place a grass block on top
    if (height > 3) this.setBlock(localX, height, localZ, 15);
    else this.setBlock(localX, height, localZ, 3);
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
    if (this.block_array[index] !== 0) {
      console.log(
        "Block already exists ",
        "blockId:",
        this.block_array[index],
        "index:",
        index
      );
      return;
    }

    this.block_array[index] = blockId;
    this.scheduleRemesh();
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
  }

  public scheduleRemesh(): void {
    this.isDirty = true;
    if (this.remeshTimeout !== null) {
      return;
    }

    // Defer the remesh to the next available moment in the event loop.
    this.remeshTimeout = setTimeout(() => {
      ChunkMesher.build(this);
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
}
