import { Chunk } from "./Chunk/Chunk";
import { ChunkWorkerPool } from "./Chunk/ChunkWorkerPool";

export class World {
  private static chunks = new Map<string, Chunk>();
  private static lastCenterChunk: { x: number; y: number; z: number } | null =
    null;

  constructor() {
    // Create an initial small area around origin. World.updateChunksAround will
    // keep chunks centered on the player during runtime.
    this.initChunks();
  }

  private initChunks() {
    //World.updateChunksAround(0, 0, 0);
  }

  /**
   * Ensure chunks exist around the provided world position.
   * Only creates chunks when the player's chunk coordinate moves to a new chunk.
   * Optionally removes chunks that are outside the radius.
   */
  public static updateChunksAround(
    worldX: number,
    worldY: number,
    worldZ: number,
    renderDistance = 8,
    verticalRadius = 3
  ) {
    const centerX = this.worldToChunkCoord(worldX);
    const centerY = this.worldToChunkCoord(worldY);
    const centerZ = this.worldToChunkCoord(worldZ);

    // avoid repeating work if still in same center chunk
    if (
      this.lastCenterChunk &&
      this.lastCenterChunk.x === centerX &&
      this.lastCenterChunk.y === centerY &&
      this.lastCenterChunk.z === centerZ
    ) {
      return;
    }
    this.lastCenterChunk = { x: centerX, y: centerY, z: centerZ };

    for (let x = centerX - renderDistance; x <= centerX + renderDistance; x++) {
      for (
        let z = centerZ - renderDistance;
        z <= centerZ + renderDistance;
        z++
      ) {
        for (
          let y = centerY - verticalRadius;
          y <= centerY + verticalRadius;
          y++
        ) {
          if (y <= 1) continue; // skip negative Y chunks for now
          const key = `${x},${y},${z}`;
          if (!this.chunks.has(key)) {
            console.log(`Creating chunk at ${key}`);
            const newChunk = new Chunk(x, y, z);
            // Request terrain data from the worker for the new chunk.
            ChunkWorkerPool.getInstance().scheduleTerrainGeneration(newChunk);
          }
        }
      }
    }

    // optional: remove chunks far outside the radius to free memory
    const removeRadius = renderDistance + 2;
    for (const key of Array.from(this.chunks.keys())) {
      const [cx, cy, cz] = key.split(",").map((n) => parseInt(n, 10));
      if (
        Math.abs(cx - centerX) > removeRadius ||
        Math.abs(cz - centerZ) > removeRadius ||
        Math.abs(cy - centerY) > verticalRadius + 2
      ) {
        const chunk = this.chunks.get(key);
        if (chunk) {
          chunk.mesh?.dispose();
          chunk.transparentMesh?.dispose();
        }
        this.chunks.delete(key);
      }
    }
  }

  public static addChunk(chunk: Chunk) {
    this.chunks.set(`${chunk.chunkX},${chunk.chunkY},${chunk.chunkZ}`, chunk);
  }

  public static getChunk(
    chunkX: number,
    chunkY: number,
    chunkZ: number
  ): Chunk | undefined {
    return this.chunks.get(`${chunkX},${chunkY},${chunkZ}`);
  }

  public static deleteBlock(worldX: number, worldY: number, worldZ: number) {
    const chunkX = this.worldToChunkCoord(worldX);
    const chunkY = this.worldToChunkCoord(worldY);
    const chunkZ = this.worldToChunkCoord(worldZ);

    const chunk = this.getChunk(chunkX, chunkY, chunkZ);
    if (!chunk) return;

    const localX = this.worldToBlockCoord(worldX);
    const localY = this.worldToBlockCoord(worldY);
    const localZ = this.worldToBlockCoord(worldZ);

    chunk.deleteBlock(localX, localY, localZ);
  }

  public static setBlock(
    worldX: number,
    worldY: number,
    worldZ: number,
    blockId: number
  ) {
    const chunkX = this.worldToChunkCoord(worldX);
    const chunkY = this.worldToChunkCoord(worldY);
    const chunkZ = this.worldToChunkCoord(worldZ);

    const chunk = this.getChunk(chunkX, chunkY, chunkZ);
    if (!chunk) return;

    const localX = this.worldToBlockCoord(worldX);
    const localY = this.worldToBlockCoord(worldY);
    const localZ = this.worldToBlockCoord(worldZ);

    chunk.setBlock(localX, localY, localZ, blockId);
  }

  public static getBlockByWorldCoords(
    worldX: number,
    worldY: number,
    worldZ: number
  ): number {
    const chunkX = this.worldToChunkCoord(worldX);
    const chunkY = this.worldToChunkCoord(worldY);
    const chunkZ = this.worldToChunkCoord(worldZ);

    const chunk = this.getChunk(chunkX, chunkY, chunkZ);
    if (!chunk) return 0;

    const localX = this.worldToBlockCoord(worldX);
    const localY = this.worldToBlockCoord(worldY);
    const localZ = this.worldToBlockCoord(worldZ);

    return chunk.getBlock(localX, localY, localZ);
  }

  /**
   * Converts world coordinates to chunk coordinates.
   * @param value The world coordinate value (e.g., player's x position).
   * @returns The corresponding chunk coordinate.
   */
  public static worldToChunkCoord(value: number): number {
    return Math.floor(value / Chunk.SIZE);
  }

  /**
   * Converts world coordinates to local block coordinates within a chunk.
   * @param value The world coordinate value.
   * @returns The local block coordinate (0-63).
   */
  public static worldToBlockCoord(value: number): number {
    return ((Math.floor(value) % Chunk.SIZE) + Chunk.SIZE) % Chunk.SIZE;
  }
}
