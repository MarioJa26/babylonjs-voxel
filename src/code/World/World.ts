import { Chunk } from "./Chunk/Chunk";
import { ChunkWorkerPool } from "./Chunk/ChunkWorkerPool";
import { GenerationParams } from "./Generation/GenerationParams";
import { TerrainHeightMap } from "./Generation/TerrainHeightMap";
import { SettingParams } from "./SettingParams";

export class World {
  private static chunks = new Map<string, Chunk>();
  private static lastCenterChunk: { x: number; y: number; z: number } | null =
    null;

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

    const chunksToLoad: { x: number; y: number; z: number; distSq: number }[] =
      [];

    // 1. Collect all potential chunk coordinates and their distances
    let distSq = 0;
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
          if (y < 0) continue; // skip negative Y chunks

          // Optimization: Skip generating chunks that are entirely below the surface
          const chunkWorldY = y * GenerationParams.CHUNK_SIZE;
          const chunkWorldX = x * GenerationParams.CHUNK_SIZE;
          const chunkWorldZ = z * GenerationParams.CHUNK_SIZE;
          const biome = TerrainHeightMap.getBiome(chunkWorldX, chunkWorldZ);
          const terrainHeightAtChunkCenter =
            TerrainHeightMap.getFinalTerrainHeight(
              chunkWorldX,
              chunkWorldZ,
              biome
            );

          // Optimization: Skip chunks that are entirely above the terrain surface.
          if (
            chunkWorldY >
            terrainHeightAtChunkCenter +
              GenerationParams.CHUNK_SIZE *
                SettingParams.VERTICAL_CHUNK_CULLING_FACTOR
          ) {
            if (chunkWorldY > GenerationParams.SEA_LEVEL) continue;
          }

          // Optimization: Skip chunks that are deep underground.
          if (
            chunkWorldY <
            terrainHeightAtChunkCenter -
              GenerationParams.CHUNK_SIZE *
                SettingParams.VERTICAL_CHUNK_CULLING_FACTOR
          ) {
            continue;
          }
          const key = `${x},${y},${z}`;
          if (this.chunks.has(key)) continue; // Already loaded

          const dx = x - centerX;
          const dy = y - centerY;
          const dz = z - centerZ;

          distSq = dx * dx + dy * dy + dz * dz;

          chunksToLoad.push({ x, y, z, distSq });
        }
      }
    }
    //Only sort if some chunks are close enough to matter
    if (distSq < SettingParams.CHUNK_SORT_DISTANCE_THRESHOLD_SQ)
      chunksToLoad.sort((a, b) => a.distSq - b.distSq);

    // 3. Enqueue chunks for generation in the sorted order
    for (const { x, y, z } of chunksToLoad) {
      const newChunk = new Chunk(x, y, z);
      ChunkWorkerPool.getInstance().scheduleTerrainGeneration(newChunk);
    }

    // optional: remove chunks far outside the radius to free memory
    const removeRadius =
      renderDistance + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER;
    for (const key of Array.from(this.chunks.keys())) {
      const [cx, cy, cz] = key.split(",").map((n) => parseInt(n, 10));
      if (
        Math.abs(cx - centerX) > removeRadius ||
        Math.abs(cz - centerZ) > removeRadius ||
        Math.abs(cy - centerY) >
          verticalRadius + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER
      ) {
        const chunk = this.chunks.get(key);
        if (chunk) {
          chunk.dispose();
          chunk.isLoaded = false;
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
