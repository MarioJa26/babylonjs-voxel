import { Biome } from "./Biome/Biomes";
import { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { TerrainHeightMap } from "./TerrainHeightMap";

export class LightGenerator {
  private static chunkSize: number;
  private static chunkSizeSq: number;
  private lightQueue: Int32Array;
  private static queueCapacity: number;

  constructor(params: GenerationParamsType) {
    LightGenerator.chunkSize = params.CHUNK_SIZE;
    LightGenerator.chunkSizeSq = LightGenerator.chunkSize ** 2;
    // Allocate a fixed size buffer for the queue.
    // A size of chunkSize^3 is sufficient for a circular buffer in BFS
    LightGenerator.queueCapacity = LightGenerator.chunkSize ** 3;
    this.lightQueue = new Int32Array(LightGenerator.queueCapacity);
  }

  public generate(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    _biome: Biome,
    blocks: Uint8Array,
    light: Uint8Array
  ): void {
    let head = 0;
    let tail = 0;
    const queue = this.lightQueue;
    const capacity = LightGenerator.queueCapacity;
    const CHUNK_SIZE = LightGenerator.chunkSize;
    const CHUNK_SIZE_SQ = LightGenerator.chunkSizeSq;
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const worldX = chunkX * CHUNK_SIZE + x;
      for (let z = 0; z < CHUNK_SIZE; z++) {
        const worldZ = chunkZ * CHUNK_SIZE + z;

        const terrainHeight = TerrainHeightMap.getFinalTerrainHeight(
          worldX,
          worldZ
        );

        let receivingSun = true;
        const topWorldY = chunkY * CHUNK_SIZE + CHUNK_SIZE - 1;
        // Heuristic: If we are deep below the terrain baseline, assume no direct sun.
        // 32 is a margin to account for 3D noise variations (valleys/caves).
        if (topWorldY < terrainHeight - 32) {
          receivingSun = false;
        }

        for (let y = CHUNK_SIZE - 1; y >= 0; y--) {
          const idx = x + y * CHUNK_SIZE + z * CHUNK_SIZE_SQ;
          const blockId = blocks[idx];

          if (blockId !== 0) {
            receivingSun = false;
          } else if (receivingSun) {
            light[idx] = 15 << 4;
            // Pack coordinates: x (8), y (8), z (8)
            queue[tail % capacity] = (x << 16) | (y << 8) | z;
            tail++;
          }
        }
      }
    }

    // Internal propagation (BFS) to spread light into caves within the chunk
    while (head < tail) {
      const val = queue[head % capacity];
      head++;

      const x = (val >> 16) & 0xff;
      const y = (val >> 8) & 0xff;
      const z = val & 0xff;

      const idx = x + y * CHUNK_SIZE + z * CHUNK_SIZE_SQ;
      const l = (light[idx] >> 4) & 0xf;

      if (l <= 1) continue;

      // Check neighbors manually to avoid GC from array allocation
      // x + 1
      if (x + 1 < CHUNK_SIZE) {
        tail = this.tryPropagate(
          x + 1,
          y,
          z,
          l - 1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ
        );
      }
      // x - 1
      if (x - 1 >= 0) {
        tail = this.tryPropagate(
          x - 1,
          y,
          z,
          l - 1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ
        );
      }
      // y + 1
      if (y + 1 < CHUNK_SIZE) {
        tail = this.tryPropagate(
          x,
          y + 1,
          z,
          l - 1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ
        );
      }
      // y - 1
      if (y - 1 >= 0) {
        tail = this.tryPropagate(
          x,
          y - 1,
          z,
          l === 15 ? 15 : l - 1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ
        );
      }
      // z + 1
      if (z + 1 < CHUNK_SIZE) {
        tail = this.tryPropagate(
          x,
          y,
          z + 1,
          l - 1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ
        );
      }
      // z - 1
      if (z - 1 >= 0) {
        tail = this.tryPropagate(
          x,
          y,
          z - 1,
          l - 1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ
        );
      }
    }
  }

  private tryPropagate(
    nx: number,
    ny: number,
    nz: number,
    targetLight: number,
    blocks: Uint8Array,
    light: Uint8Array,
    tail: number,
    CHUNK_SIZE: number,
    CHUNK_SIZE_SQ: number
  ): number {
    const idx = nx + ny * CHUNK_SIZE + nz * CHUNK_SIZE_SQ;
    const blockId = blocks[idx];
    // Check transparency (0: Air, 30: Water, 60/61: Glass)
    const isTransparent =
      blockId === 0 || blockId === 30 || blockId === 60 || blockId === 61;

    if (isTransparent) {
      const currentSky = (light[idx] >> 4) & 0xf;
      if (currentSky < targetLight) {
        const blockLight = light[idx] & 0xf;
        light[idx] = (targetLight << 4) | blockLight;
        this.lightQueue[tail % LightGenerator.queueCapacity] =
          (nx << 16) | (ny << 8) | nz;
        return tail + 1;
      }
    }
    return tail;
  }
}
