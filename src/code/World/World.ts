import { Chunk } from "./Chunk/Chunk";
import { ChunkWorkerPool } from "./Chunk/ChunkWorkerPool";
import { SettingParams } from "./SettingParams";

export class World {
  constructor() {
    World.updateChunksAround(0, 0, 0, 2);
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
    renderDistance = SettingParams.RENDER_DISTANCE,
    verticalRadius = SettingParams.VERTICAL_RENDER_DISTANCE
  ) {
    const centerX = this.worldToChunkCoord(worldX);
    const centerY = this.worldToChunkCoord(worldY);
    const centerZ = this.worldToChunkCoord(worldZ);

    const chunksToLoad: { x: number; y: number; z: number }[] = [];

    // 1. Collect all potential chunk coordinates and their distances
    for (let y = centerY - verticalRadius; y <= centerY + verticalRadius; y++) {
      if (y < 0 || y >= SettingParams.MAX_CHUNK_HEIGHT) continue;
      for (
        let x = centerX - renderDistance;
        x <= centerX + renderDistance;
        x++
      ) {
        for (
          let z = centerZ - renderDistance;
          z <= centerZ + renderDistance;
          z++
        ) {
          const key = `${x},${y},${z}`;
          if (Chunk.chunkInstances.has(key)) continue;
          chunksToLoad.push({ x, y, z });
        }
      }
    }

    // 3. Enqueue chunks for generation in the sorted order
    for (const { x, y, z } of chunksToLoad) {
      const newChunk = new Chunk(x, y, z);
      ChunkWorkerPool.getInstance().scheduleTerrainGeneration(newChunk);
    }

    // optional: remove chunks far outside the radius to free memory
    const removeRadius =
      renderDistance + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER;
    for (const key of Array.from(Chunk.chunkInstances.keys())) {
      const [cx, cy, cz] = key.split(",").map((n) => parseInt(n, 10));
      if (
        Math.abs(cx - centerX) > removeRadius ||
        Math.abs(cz - centerZ) > removeRadius ||
        Math.abs(cy - centerY) >
          verticalRadius + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER
      ) {
        const chunk = Chunk.chunkInstances.get(key);
        if (chunk) {
          chunk.dispose();
          chunk.isLoaded = false;
        }
        Chunk.chunkInstances.delete(key);
      }
    }
  }

  public static addChunk(chunk: Chunk) {
    Chunk.chunkInstances.set(chunk.id, chunk);
  }

  public static deleteBlock(worldX: number, worldY: number, worldZ: number) {
    const chunkX = this.worldToChunkCoord(worldX);
    const chunkY = this.worldToChunkCoord(worldY);
    const chunkZ = this.worldToChunkCoord(worldZ);

    const chunk = Chunk.getChunk(chunkX, chunkY, chunkZ);
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

    const chunk = Chunk.getChunk(chunkX, chunkY, chunkZ);
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

    const chunk = Chunk.getChunk(chunkX, chunkY, chunkZ);
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
