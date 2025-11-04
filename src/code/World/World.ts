import { Chunk } from "./Chunk/Chunk";
import { DIRS } from "./Texture/DIRS";

export class World {
  public static worldInstance: World;

  public static chunks = new Map<string, Chunk>();

  public static readonly CHUNK_SIZE = 64;

  constructor() {
    this.initChunks();
  }

  private initChunks(): void {
    const size = 3;
    const start = -1;
    for (let x = start; x < size; x++) {
      for (let y = start; y < size; y++) {
        for (let z = start; z < size; z++) {
          const chunk = new Chunk(x, y, z);
          World.chunks.set(World.getChunkKey(x, y, z), chunk);
        }
      }
    }
  }

  public static instance(): World {
    if (!this.worldInstance) {
      this.worldInstance = new World();
    }

    return this.worldInstance;
  }

  /**
   * Generates the string key for the chunk map.
   */
  private static getChunkKey(cx: number, cy: number, cz: number): string {
    return `${cx},${cy},${cz}`;
  }

  public static getGlobalBlockKey(cx: number, cy: number, cz: number): string {
    return `${cx},${cy},${cz}`;
  }

  /**
   * Converts a world coordinate to its parent chunk coordinate.
   */
  public static worldToChunkCoord(worldPos: number): number {
    return Math.floor(worldPos / this.CHUNK_SIZE);
  }

  /**
   * Converts a world coordinate to its local coordinate within a chunk.
   */
  public static worldToLocalCoord(worldPos: number): number {
    return ((worldPos % this.CHUNK_SIZE) + this.CHUNK_SIZE) % this.CHUNK_SIZE;
  }

  /**
   * Gets the chunk at a specific chunk coordinate.
   * Optionally creates a new one if it doesn't exist.
   */
  public getChunk(
    cx: number,
    cy: number,
    cz: number,
    createIfMissing = false
  ): Chunk | null {
    const key = World.getChunkKey(cx, cy, cz);

    if (World.chunks.has(key)) {
      return World.chunks.get(key) ?? null;
    }

    if (createIfMissing) {
      const newChunk = new Chunk(cx, cy, cz);
      World.chunks.set(key, newChunk);
      return newChunk;
    }

    return null;
  }

  public getChunkFloat(
    cx: number,
    cy: number,
    cz: number,
    createIfMissing = false
  ): Chunk | null {
    return this.getChunk(
      Math.round(cx),
      Math.round(cy),
      Math.round(cz),
      createIfMissing
    );
  }

  /**
   * The "good access" function you're looking for!
   * Gets a block ID from anywhere in the world.
   */
  public getBlockId(worldX: number, worldY: number, worldZ: number): number {
    const cx = World.worldToChunkCoord(worldX);
    const cy = World.worldToChunkCoord(worldY);
    const cz = World.worldToChunkCoord(worldZ);

    const lx = World.worldToLocalCoord(worldX);
    const ly = World.worldToLocalCoord(worldY);
    const lz = World.worldToLocalCoord(worldZ);

    const chunk = this.getChunk(cx, cy, cz);
    if (!chunk) {
      return 0; // 0 = Air (or "empty space")
    }

    return chunk.getBlock(lx, ly, lz);
  }

  public setBlock(
    worldX: number,
    worldY: number,
    worldZ: number,
    blockId: number
  ) {
    const cx = World.worldToChunkCoord(worldX);
    const cy = World.worldToChunkCoord(worldY);
    const cz = World.worldToChunkCoord(worldZ);

    const lx = World.worldToLocalCoord(worldX);
    const ly = World.worldToLocalCoord(worldY);
    const lz = World.worldToLocalCoord(worldZ);

    const chunk = this.getChunk(cx, cy, cz, false);
    if (!chunk) return;
    chunk.setBlock(lx, ly, lz, blockId);
    this.checkNeighbors(worldX, worldY, worldZ);
  }

  public deleteBlock(worldX: number, worldY: number, worldZ: number) {
    const cx = World.worldToChunkCoord(worldX);
    const cy = World.worldToChunkCoord(worldY);
    const cz = World.worldToChunkCoord(worldZ);

    const lx = World.worldToLocalCoord(worldX);
    const ly = World.worldToLocalCoord(worldY);
    const lz = World.worldToLocalCoord(worldZ);

    const chunk = this.getChunk(cx, cy, cz, false);
    if (!chunk) return;
    chunk.deleteBlock(lx, ly, lz);
    this.checkNeighbors(worldX, worldY, worldZ);
  }

  public checkNeighbors(worldX: number, worldY: number, worldZ: number): void {
    const currentChunk = this.getChunk(
      World.worldToChunkCoord(worldX),
      World.worldToChunkCoord(worldY),
      World.worldToChunkCoord(worldZ)
    );

    for (let i = 0; i < DIRS.length; i++) {
      const dir = DIRS[i].dir;
      const neighborX = worldX + dir[0];
      const neighborY = worldY + dir[1];
      const neighborZ = worldZ + dir[2];

      const neighborChunk = this.getChunk(
        World.worldToChunkCoord(neighborX),
        World.worldToChunkCoord(neighborY),
        World.worldToChunkCoord(neighborZ)
      );

      if (neighborChunk && neighborChunk !== currentChunk) {
        neighborChunk.scheduleRemesh();
      }
    }
  }

  /**
   * Checks if a specific face of a block is occluded by an adjacent block.
   * @param worldX The world X coordinate of the block to check.
   * @param worldY The world Y coordinate of the block to check.
   * @param worldZ The world Z coordinate of the block to check.
   * @param direction A vector representing the face direction (e.g., [1, 0, 0] for East).
   * @returns `true` if the face is occluded (should be hidden), `false` otherwise.
   */
  public isFaceOccluded(
    worldX: number,
    worldY: number,
    worldZ: number,
    direction: [number, number, number]
  ): boolean {
    const neighborX = worldX + direction[0];
    const neighborY = worldY + direction[1];
    const neighborZ = worldZ + direction[2];

    // Get the block ID of the neighbor
    const neighborBlockId = this.getBlockId(neighborX, neighborY, neighborZ);

    // A face is occluded if the neighboring block is not air (ID > 0).
    // You could add more complex logic here for transparent blocks like glass.
    return neighborBlockId > 0;
  }
}
