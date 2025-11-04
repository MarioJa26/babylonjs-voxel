import { Chunk } from "./Chunk/Chunk";

export class World {
  private static chunks = new Map<string, Chunk>();
  private static worldInstance: World;

  constructor() {
    World.worldInstance = this;
    this.initChunks();
  }

  private initChunks() {
    const renderDistance = 4; // in chunks
    for (let x = -renderDistance; x < renderDistance; x++) {
      for (let z = -renderDistance; z < renderDistance; z++) {
        // For now, we only create the base layer of chunks (y=0)
        // and the one above it (y=1) to allow for tall terrain.
        new Chunk(x, 0, z);
        new Chunk(x, 1, z);
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
