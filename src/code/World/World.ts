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
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    renderDistance = SettingParams.RENDER_DISTANCE,
    verticalRadius = SettingParams.VERTICAL_RENDER_DISTANCE
  ) {
    const chunksToLoad: { x: number; y: number; z: number; distSq: number }[] =
      [];

    // 1. Collect all potential chunk coordinates and their distances
    for (let y = chunkY - verticalRadius; y <= chunkY + verticalRadius; y++) {
      if (y < 0 || y >= SettingParams.MAX_CHUNK_HEIGHT) continue;
      for (let x = chunkX - renderDistance; x <= chunkX + renderDistance; x++) {
        for (
          let z = chunkZ - renderDistance;
          z <= chunkZ + renderDistance;
          z++
        ) {
          const key = Chunk.packCoords(x, y, z);
          if (Chunk.chunkInstances.has(key)) continue;

          const dx = x - chunkX;
          const dz = z - chunkZ;
          const distSq = dx * dx + dz * dz + y;
          chunksToLoad.push({ x, y, z, distSq });
        }
      }
    }

    // 2. Sort chunks by distance (nearest first)
    chunksToLoad.sort((a, b) => a.distSq - b.distSq);

    // 3. Enqueue chunks for generation in the new, sorted order
    for (const { x, y, z } of chunksToLoad) {
      const newChunk = new Chunk(x, y, z);
      ChunkWorkerPool.getInstance().scheduleTerrainGeneration(newChunk);
    }

    // optional: remove chunks far outside the radius to free memory
    const removeRadius =
      renderDistance + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER;
    for (const chunk of Chunk.chunkInstances.values()) {
      const { chunkX: cx, chunkY: cy, chunkZ: cz } = chunk;
      if (
        Math.abs(cx - chunkX) > removeRadius ||
        Math.abs(cz - chunkZ) > removeRadius ||
        Math.abs(cy - chunkY) >
          verticalRadius + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER
      ) {
        if (chunk) {
          chunk.dispose();
          chunk.isLoaded = false;
          Chunk.chunkInstances.delete(chunk.id);
        }
      }
    }
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
