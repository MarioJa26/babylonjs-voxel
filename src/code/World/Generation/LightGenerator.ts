import { Biome } from "./Biome/BiomeTypes";
import { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { TerrainHeightMap } from "./TerrainHeightMap";

export class LightGenerator {
  private static chunkSize: number;
  private static chunkSizeSq: number;
  private lightQueue: Uint16Array;
  private static queueCapacity: number;
  private densityNoise: (x: number, y: number, z: number) => number;
  private static readonly DENSITY_BASE_AMPLITUDE = 32;
  private static readonly DENSITY_OVERHANG_AMPLITUDE = 32;
  private static readonly DENSITY_CLIFF_AMPLITUDE = 16;
  private static readonly DENSITY_INFLUENCE_RANGE = 48;

  constructor(
    params: GenerationParamsType,
    densityNoise: (x: number, y: number, z: number) => number,
  ) {
    LightGenerator.chunkSize = params.CHUNK_SIZE;
    LightGenerator.chunkSizeSq = LightGenerator.chunkSize ** 2;
    // Allocate a fixed size buffer for the queue.
    // A size of chunkSize^3 is sufficient for a circular buffer in BFS
    LightGenerator.queueCapacity = LightGenerator.chunkSize ** 3;
    this.lightQueue = new Uint16Array(LightGenerator.queueCapacity);
    this.densityNoise = densityNoise;
  }

  public generate(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    _biome: Biome,
    blocks: Uint8Array,
    light: Uint8Array,
    topSunlightMask?: Uint8Array,
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
        const topWorldY = chunkY * CHUNK_SIZE + CHUNK_SIZE - 1;
        const columnIndex = x + z * CHUNK_SIZE;
        let receivingSun = topSunlightMask
          ? topSunlightMask[columnIndex] !== 0
          : this.columnReceivesDirectSun(worldX, worldZ, topWorldY);

        for (let y = CHUNK_SIZE - 1; y >= 0; y--) {
          const idx = x + y * CHUNK_SIZE + z * CHUNK_SIZE_SQ;
          const blockId = blocks[idx];

          if (!LightGenerator.isTransparentBlock(blockId)) {
            receivingSun = false;
            // Check for light emitting blocks (e.g. Lava)
            if (blockId === 24) {
              light[idx] = (light[idx] & 0xf0) | 15;
              queue[tail % capacity] = (x << 10) | (y << 5) | z;
              tail++;
            }
          } else if (receivingSun) {
            light[idx] = 15 << 4;
            // Pack coordinates: x (5), y (5), z (5) -> Max 32
            queue[tail % capacity] = (x << 10) | (y << 5) | z;
            tail++;
          }
        }
      }
    }

    // Internal propagation (BFS) to spread light into caves within the chunk
    while (head < tail) {
      const val = queue[head % capacity];
      head++;

      const x = (val >> 10) & 0x1f;
      const y = (val >> 5) & 0x1f;
      const z = val & 0x1f;

      const idx = x + y * CHUNK_SIZE + z * CHUNK_SIZE_SQ;
      const lightVal = light[idx];
      const skyLight = (lightVal >> 4) & 0xf;
      const blockLight = lightVal & 0xf;

      if (skyLight <= 1 && blockLight <= 1) continue;

      // Check neighbors manually to avoid GC from array allocation
      // x + 1
      if (x + 1 < CHUNK_SIZE) {
        tail = this.tryPropagate(
          x + 1,
          y,
          z,
          skyLight - 1,
          blockLight - 1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ,
        );
      }
      // x - 1
      if (x - 1 >= 0) {
        tail = this.tryPropagate(
          x - 1,
          y,
          z,
          skyLight - 1,
          blockLight - 1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ,
        );
      }
      // y + 1
      if (y + 1 < CHUNK_SIZE) {
        tail = this.tryPropagate(
          x,
          y + 1,
          z,
          skyLight - 1,
          blockLight - 1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ,
        );
      }
      // y - 1
      if (y - 1 >= 0) {
        tail = this.tryPropagate(
          x,
          y - 1,
          z,
          skyLight === 15 ? 15 : skyLight - 1,
          blockLight - 1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ,
        );
      }
      // z + 1
      if (z + 1 < CHUNK_SIZE) {
        tail = this.tryPropagate(
          x,
          y,
          z + 1,
          skyLight - 1,
          blockLight - 1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ,
        );
      }
      // z - 1
      if (z - 1 >= 0) {
        tail = this.tryPropagate(
          x,
          y,
          z - 1,
          skyLight - 1,
          blockLight - 1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ,
        );
      }
    }
  }

  private tryPropagate(
    nx: number,
    ny: number,
    nz: number,
    targetSky: number,
    targetBlock: number,
    blocks: Uint8Array,
    light: Uint8Array,
    tail: number,
    CHUNK_SIZE: number,
    CHUNK_SIZE_SQ: number,
  ): number {
    const idx = nx + ny * CHUNK_SIZE + nz * CHUNK_SIZE_SQ;
    const blockId = blocks[idx];
    // Check transparency (0: Air, 30: Water, 60/61: Glass)
    const isTransparent = LightGenerator.isTransparentBlock(blockId);

    if (isTransparent) {
      const currentVal = light[idx];
      const currentSky = (currentVal >> 4) & 0xf;
      const currentBlock = currentVal & 0xf;

      let updated = false;
      let newSky = currentSky;
      let newBlock = currentBlock;

      if (targetSky > currentSky) {
        newSky = targetSky;
        updated = true;
      }
      if (targetBlock > currentBlock) {
        newBlock = targetBlock;
        updated = true;
      }

      if (updated) {
        light[idx] = (newSky << 4) | newBlock;
        this.lightQueue[tail % LightGenerator.queueCapacity] =
          (nx << 10) | (ny << 5) | nz;
        return tail + 1;
      }
    }
    return tail;
  }

  private static isTransparentBlock(blockId: number): boolean {
    return blockId === 0 || blockId === 30 || blockId === 60 || blockId === 61;
  }

  private getDensity(x: number, y: number, z: number, baseHeight: number): number {
    const relativeHeight = baseHeight - y;
    if (relativeHeight > LightGenerator.DENSITY_INFLUENCE_RANGE) {
      return relativeHeight;
    }
    if (relativeHeight < -LightGenerator.DENSITY_INFLUENCE_RANGE) {
      return relativeHeight;
    }

    const baseNoise = this.densityNoise(x * 0.01, y * 0.02, z * 0.02);
    const overhangNoise = this.densityNoise(
      (x + y * 0.55) * 0.008,
      y * 0.012,
      (z - y * 0.45) * 0.008,
    );
    const cliffNoise = this.densityNoise(x * 0.0035, y * 0.004, z * 0.0035);

    return (
      relativeHeight +
      baseNoise * LightGenerator.DENSITY_BASE_AMPLITUDE +
      overhangNoise * LightGenerator.DENSITY_OVERHANG_AMPLITUDE +
      cliffNoise * LightGenerator.DENSITY_CLIFF_AMPLITUDE
    );
  }

  private columnReceivesDirectSun(
    worldX: number,
    worldZ: number,
    topWorldY: number,
  ): boolean {
    const terrainHeight = TerrainHeightMap.getFinalTerrainHeight(worldX, worldZ);
    const influence = LightGenerator.DENSITY_INFLUENCE_RANGE;

    if (topWorldY < terrainHeight - influence) {
      return false;
    }
    if (topWorldY >= terrainHeight + influence) {
      return true;
    }

    for (let y = topWorldY + 1; y <= terrainHeight + influence; y++) {
      if (this.getDensity(worldX, y, worldZ, terrainHeight) > 0) {
        return false;
      }
    }

    return true;
  }
}
