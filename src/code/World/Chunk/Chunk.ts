import { Mesh } from "@babylonjs/core";
import { ChunkWorkerPool } from "./ChunkWorkerPool";
import { MeshData } from "./MeshData";
import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";
import { TerrainHeightMap } from "../Generation/TerrainHeightMap";

type LightNode = {
  chunk: Chunk;
  x: number;
  y: number;
  z: number;
  level: number;
};

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

  light_array: Uint8Array;

  constructor(chunkX: number, chunkY: number, chunkZ: number) {
    this.#chunkX = chunkX;
    this.#chunkY = chunkY;
    this.#chunkZ = chunkZ;
    this.id = Chunk.packCoords(chunkX, chunkY, chunkZ);
    this.block_array = new Uint8Array(Chunk.SIZE ** 3);
    this.block_array.fill(0);
    this.light_array = new Uint8Array(Chunk.SIZE ** 3);
    this.light_array.fill(0);
    Chunk.chunkInstances.set(this.id, this);
  }

  // Define blocks that emit light (Block ID -> Light Level)
  public static readonly LIGHT_EMISSION: Record<number, number> = {
    10: 15, // Example: Lava
    11: 15, // Example: Glowstone
  };

  public static getLightEmission(blockId: number): number {
    return Chunk.LIGHT_EMISSION[blockId] || 0;
  }

  public populate(
    block_array: Uint8Array,
    light_array?: Uint8Array,
    scheduleRemesh = true
  ): void {
    this.block_array = block_array;
    if (light_array) {
      this.light_array = light_array;
    } else {
      this.initializeSunlight();
    }
    if (scheduleRemesh) {
      this.scheduleRemesh();
      this.getNeighbor(-1, 0, 0)?.scheduleRemesh();
      this.getNeighbor(0, 0, -1)?.scheduleRemesh();
      this.getNeighbor(0, -1, 0)?.scheduleRemesh();
    }
  }
  public initializeSunlight() {
    const queue: LightNode[] = [];
    const { CHUNK_SIZE } = GenerationParams;

    for (let x = 0; x < CHUNK_SIZE; x++) {
      const worldX = this.#chunkX * CHUNK_SIZE + x;
      for (let z = 0; z < CHUNK_SIZE; z++) {
        const worldZ = this.#chunkZ * CHUNK_SIZE + z;

        const biome = TerrainHeightMap.getBiome(worldX, worldZ);
        const terrainHeight = TerrainHeightMap.getFinalTerrainHeight(
          worldX,
          worldZ,
          biome
        );

        for (let y = 0; y < CHUNK_SIZE; y++) {
          const worldY = this.#chunkY * CHUNK_SIZE + y;

          if (worldY > terrainHeight) {
            const idx = x + y * CHUNK_SIZE + z * Chunk.SIZE2;
            const blockId = this.block_array[idx];
            if (blockId === 0) {
              this.light_array[idx] = 15;
              queue.push({ chunk: this, x, y, z, level: 15 });
            }
          }
        }
      }
    }
    this.propagateLight(queue);
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
    if (index < 0 || index >= this.block_array.length) return;

    const oldBlockId = this.block_array[index];
    if (oldBlockId === blockId) return;

    const oldLight = this.getLight(localX, localY, localZ);

    this.block_array[index] = blockId;

    if (oldLight > 0) {
      this.removeLight(localX, localY, localZ);
    } else if (this.isTransparent(blockId)) {
      this.updateLightFromNeighbors(localX, localY, localZ);
    }

    const emission = Chunk.getLightEmission(blockId);
    if (emission > 0) {
      this.addLight(localX, localY, localZ, emission);
    }

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
    this.setBlock(localX, localY, localZ, 0);
  }

  public getLight(localX: number, localY: number, localZ: number): number {
    return this.light_array[
      localX + localY * Chunk.SIZE + localZ * Chunk.SIZE2
    ];
  }

  public setLight(x: number, y: number, z: number, level: number) {
    const idx = x + y * Chunk.SIZE + z * Chunk.SIZE2;
    if (this.light_array[idx] !== level) {
      this.light_array[idx] = level;
      this.isModified = true;
      this.scheduleRemesh();
    }
  }

  /**
   * Propagates light from a queue of light sources.
   */

  public propagateLight(queue: LightNode[]): void {
    while (queue.length > 0) {
      const { chunk, x, y, z, level } = queue.shift()!;

      const neighbors = [
        [x + 1, y, z],
        [x - 1, y, z],
        [x, y + 1, z],
        [x, y - 1, z],
        [x, y, z + 1],
        [x, y, z - 1],
      ];

      for (const [nx, ny, nz] of neighbors) {
        let targetChunk: Chunk | undefined = chunk;
        let tx = nx;
        let ty = ny;
        let tz = nz;

        // Handle chunk boundaries
        if (nx < 0) {
          targetChunk = targetChunk.getNeighbor(-1, 0, 0);
          tx = Chunk.SIZE - 1;
        } else if (nx >= Chunk.SIZE) {
          targetChunk = targetChunk.getNeighbor(1, 0, 0);
          tx = 0;
        }

        if (targetChunk && (ny < 0 || ny >= Chunk.SIZE)) {
          if (ny < 0) {
            targetChunk = targetChunk.getNeighbor(0, -1, 0);
            ty = Chunk.SIZE - 1;
          } else {
            targetChunk = targetChunk.getNeighbor(0, 1, 0);
            ty = 0;
          }
        }

        if (targetChunk && (nz < 0 || nz >= Chunk.SIZE)) {
          if (nz < 0) {
            targetChunk = targetChunk.getNeighbor(0, 0, -1);
            tz = Chunk.SIZE - 1;
          } else {
            targetChunk = targetChunk.getNeighbor(0, 0, 1);
            tz = 0;
          }
        }

        if (targetChunk) {
          const blockId = targetChunk.getBlock(tx, ty, tz);
          if (targetChunk.isTransparent(blockId)) {
            if (targetChunk.getLight(tx, ty, tz) < level - 1) {
              targetChunk.setLight(tx, ty, tz, level - 1);
              queue.push({
                chunk: targetChunk,
                x: tx,
                y: ty,
                z: tz,
                level: level - 1,
              });
            }
          }
        }
      }
    }
  }

  public updateLightFromNeighbors(x: number, y: number, z: number) {
    const queue: LightNode[] = [];
    const neighbors = [
      [x + 1, y, z],
      [x - 1, y, z],
      [x, y + 1, z],
      [x, y - 1, z],
      [x, y, z + 1],
      [x, y, z - 1],
    ];

    for (const [nx, ny, nz] of neighbors) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      let targetChunk: Chunk | undefined = this;
      let tx = nx;
      let ty = ny;
      let tz = nz;

      // Handle chunk boundaries
      if (nx < 0) {
        targetChunk = targetChunk.getNeighbor(-1, 0, 0);
        tx = Chunk.SIZE - 1;
      } else if (nx >= Chunk.SIZE) {
        targetChunk = targetChunk.getNeighbor(1, 0, 0);
        tx = 0;
      }

      if (targetChunk && (ny < 0 || ny >= Chunk.SIZE)) {
        if (ny < 0) {
          targetChunk = targetChunk.getNeighbor(0, -1, 0);
          ty = Chunk.SIZE - 1;
        } else {
          targetChunk = targetChunk.getNeighbor(0, 1, 0);
          ty = 0;
        }
      }

      if (targetChunk && (nz < 0 || nz >= Chunk.SIZE)) {
        if (nz < 0) {
          targetChunk = targetChunk.getNeighbor(0, 0, -1);
          tz = Chunk.SIZE - 1;
        } else {
          targetChunk = targetChunk.getNeighbor(0, 0, 1);
          tz = 0;
        }
      }

      if (targetChunk) {
        const level = targetChunk.getLight(tx, ty, tz);
        if (level > 0) {
          queue.push({
            chunk: targetChunk,
            x: tx,
            y: ty,
            z: tz,
            level: level,
          });
        }
      }
    }

    if (queue.length > 0) {
      this.propagateLight(queue);
    }
  }

  private isTransparent(blockId: number): boolean {
    // 0: Air, 30: Water, 60: Glass, 61: Glass
    return blockId === 0 || blockId === 30 || blockId === 60 || blockId === 61;
  }
  public addLight(x: number, y: number, z: number, level: number) {
    this.setLight(x, y, z, level);
    this.propagateLight([{ chunk: this, x, y, z, level }]);
  }

  public removeLight(x: number, y: number, z: number) {
    const val = this.getLight(x, y, z);
    if (val === 0) return;

    const queue: LightNode[] = [];
    const propagateQueue: LightNode[] = [];

    queue.push({ chunk: this, x, y, z, level: val });
    this.setLight(x, y, z, 0);

    while (queue.length > 0) {
      const { chunk, x, y, z, level } = queue.shift()!;

      const neighbors = [
        [x + 1, y, z],
        [x - 1, y, z],
        [x, y + 1, z],
        [x, y - 1, z],
        [x, y, z + 1],
        [x, y, z - 1],
      ];

      for (const [nx, ny, nz] of neighbors) {
        let targetChunk: Chunk | undefined = chunk;
        let tx = nx;
        let ty = ny;
        let tz = nz;

        // Handle chunk boundaries
        if (nx < 0) {
          targetChunk = targetChunk.getNeighbor(-1, 0, 0);
          tx = Chunk.SIZE - 1;
        } else if (nx >= Chunk.SIZE) {
          targetChunk = targetChunk.getNeighbor(1, 0, 0);
          tx = 0;
        }

        if (targetChunk && (ny < 0 || ny >= Chunk.SIZE)) {
          if (ny < 0) {
            targetChunk = targetChunk.getNeighbor(0, -1, 0);
            ty = Chunk.SIZE - 1;
          } else {
            targetChunk = targetChunk.getNeighbor(0, 1, 0);
            ty = 0;
          }
        }

        if (targetChunk && (nz < 0 || nz >= Chunk.SIZE)) {
          if (nz < 0) {
            targetChunk = targetChunk.getNeighbor(0, 0, -1);
            tz = Chunk.SIZE - 1;
          } else {
            targetChunk = targetChunk.getNeighbor(0, 0, 1);
            tz = 0;
          }
        }

        if (targetChunk) {
          const neighborLight = targetChunk.getLight(tx, ty, tz);
          if (neighborLight !== 0 && neighborLight < level) {
            targetChunk.setLight(tx, ty, tz, 0);
            queue.push({
              chunk: targetChunk,
              x: tx,
              y: ty,
              z: tz,
              level: neighborLight,
            });
          } else if (neighborLight >= level) {
            propagateQueue.push({
              chunk: targetChunk,
              x: tx,
              y: ty,
              z: tz,
              level: neighborLight,
            });
          }
        }
      }
    }

    this.propagateLight(propagateQueue);
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
