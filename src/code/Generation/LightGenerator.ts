import { Biome } from "./Biome/BiomeTypes";
import { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { TerrainHeightMap } from "./TerrainHeightMap";

export class LightGenerator {
  private static chunkSize: number;
  private static chunkSizeSq: number;
  private lightQueue: Uint16Array;
  private static queueCapacity: number;
  // Bitmask for wrapping the circular buffer — only valid when capacity is a power of two.
  private static queueMask: number;
  private static readonly DENSITY_INFLUENCE_RANGE = 48;
  private static readonly WATER_BLOCK_ID = 30;

  constructor(params: GenerationParamsType) {
    LightGenerator.chunkSize = params.CHUNK_SIZE;
    LightGenerator.chunkSizeSq = LightGenerator.chunkSize ** 2;

    // OPTIMIZATION: Round up to next power of two so we can replace
    // every `tail % capacity` (integer division) with `tail & mask` (bitwise AND).
    // For CHUNK_SIZE=32: 32^3=32768, next POT=32768 (already a power of two).
    // For CHUNK_SIZE=16: 16^3=4096, next POT=4096.
    const rawCap = LightGenerator.chunkSize ** 3;
    const pot = nextPowerOfTwo(rawCap);
    LightGenerator.queueCapacity = pot;
    LightGenerator.queueMask = pot - 1;
    this.lightQueue = new Uint16Array(pot);
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
    const mask = LightGenerator.queueMask;
    const CHUNK_SIZE = LightGenerator.chunkSize;
    const CHUNK_SIZE_SQ = LightGenerator.chunkSizeSq;

    for (let x = 0; x < CHUNK_SIZE; x++) {
      const worldX = chunkX * CHUNK_SIZE + x;
      for (let z = 0; z < CHUNK_SIZE; z++) {
        const worldZ = chunkZ * CHUNK_SIZE + z;
        const topWorldY = chunkY * CHUNK_SIZE + CHUNK_SIZE - 1;
        const columnIndex = x + z * CHUNK_SIZE;
        let incomingSkyLight = topSunlightMask
          ? topSunlightMask[columnIndex] !== 0
            ? 15
            : 0
          : this.columnReceivesDirectSun(worldX, worldZ, topWorldY)
            ? 15
            : 0;
        let sourceIsWater = false;

        for (let y = CHUNK_SIZE - 1; y >= 0; y--) {
          const idx = x + y * CHUNK_SIZE + z * CHUNK_SIZE_SQ;
          const blockId = blocks[idx];

          if (!LightGenerator.isTransparentBlock(blockId)) {
            incomingSkyLight = 0;
            sourceIsWater = false;
            if (blockId === 24) {
              // Lava emits light
              light[idx] = (light[idx] & 0xf0) | 15;
              // OPTIMIZATION: bitwise mask instead of modulo
              queue[tail & mask] = (x << 10) | (y << 5) | z;
              tail++;
            }
          } else if (incomingSkyLight > 0) {
            const preservesFullSun =
              incomingSkyLight === 15 &&
              !sourceIsWater &&
              !LightGenerator.isWaterBlock(blockId);
            const cellSkyLight = preservesFullSun
              ? 15
              : Math.max(incomingSkyLight - 1, 0);

            if (cellSkyLight === 0) {
              incomingSkyLight = 0;
              sourceIsWater = LightGenerator.isWaterBlock(blockId);
              continue;
            }

            light[idx] = (light[idx] & 0xf) | (cellSkyLight << 4);
            queue[tail & mask] = (x << 10) | (y << 5) | z;
            tail++;
            incomingSkyLight = cellSkyLight;
            sourceIsWater = LightGenerator.isWaterBlock(blockId);
          }
        }
      }
    }

    // BFS light propagation
    while (head < tail) {
      const val = queue[head & mask];
      head++;

      const x = (val >> 10) & 0x1f;
      const y = (val >> 5) & 0x1f;
      const z = val & 0x1f;

      const idx = x + y * CHUNK_SIZE + z * CHUNK_SIZE_SQ;
      const lightVal = light[idx];
      const skyLight = (lightVal >> 4) & 0xf;
      const blockLight = lightVal & 0xf;

      if (skyLight <= 1 && blockLight <= 1) continue;

      const skyM1 = skyLight - 1;
      const blkM1 = blockLight - 1;

      if (x + 1 < CHUNK_SIZE) {
        tail = this.tryPropagate(
          x + 1,
          y,
          z,
          skyM1,
          blkM1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ,
        );
      }
      if (x > 0) {
        tail = this.tryPropagate(
          x - 1,
          y,
          z,
          skyM1,
          blkM1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ,
        );
      }
      if (y + 1 < CHUNK_SIZE) {
        tail = this.tryPropagate(
          x,
          y + 1,
          z,
          skyM1,
          blkM1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ,
        );
      }
      if (y > 0) {
        const belowIdx = x + (y - 1) * CHUNK_SIZE + z * CHUNK_SIZE_SQ;
        const preservesFullSunDown =
          skyLight === 15 &&
          !LightGenerator.isWaterBlock(blocks[idx]) &&
          !LightGenerator.isWaterBlock(blocks[belowIdx]);
        // Sky light falls without loss downward
        tail = this.tryPropagate(
          x,
          y - 1,
          z,
          preservesFullSunDown ? 15 : skyM1,
          blkM1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ,
        );
      }
      if (z + 1 < CHUNK_SIZE) {
        tail = this.tryPropagate(
          x,
          y,
          z + 1,
          skyM1,
          blkM1,
          blocks,
          light,
          tail,
          CHUNK_SIZE,
          CHUNK_SIZE_SQ,
        );
      }
      if (z > 0) {
        tail = this.tryPropagate(
          x,
          y,
          z - 1,
          skyM1,
          blkM1,
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
    if (!LightGenerator.isTransparentBlock(blocks[idx])) return tail;

    const currentVal = light[idx];
    const currentSky = (currentVal >> 4) & 0xf;
    const currentBlock = currentVal & 0xf;

    // OPTIMIZATION: combine the two conditionals — only write and enqueue if either improves.
    const newSky = targetSky > currentSky ? targetSky : currentSky;
    const newBlock = targetBlock > currentBlock ? targetBlock : currentBlock;

    if (newSky !== currentSky || newBlock !== currentBlock) {
      light[idx] = (newSky << 4) | newBlock;
      this.lightQueue[tail & LightGenerator.queueMask] =
        (nx << 10) | (ny << 5) | nz;
      return tail + 1;
    }
    return tail;
  }

  private static isTransparentBlock(blockId: number): boolean {
    return blockId === 0 || blockId === 30 || blockId === 60 || blockId === 61;
  }

  private static isWaterBlock(blockId: number): boolean {
    return blockId === LightGenerator.WATER_BLOCK_ID;
  }

  private columnReceivesDirectSun(
    worldX: number,
    worldZ: number,
    topWorldY: number,
  ): boolean {
    // OPTIMIZATION: reuse cached height from TerrainHeightMap instead of a separate call.
    const terrainHeight = TerrainHeightMap.getFinalTerrainHeight(
      worldX,
      worldZ,
    );
    return topWorldY >= terrainHeight - LightGenerator.DENSITY_INFLUENCE_RANGE;
  }
}

/** Returns the smallest power of two that is >= n. */
function nextPowerOfTwo(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
