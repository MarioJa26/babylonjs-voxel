import Alea from "alea";
import { createNoise2D, createNoise3D } from "simplex-noise";
import { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { Squirrel3 } from "./NoiseAndParameters/Squirrel13";
import { TerrainHeightMap } from "./TerrainHeightMap";
import { SurfaceGenerator } from "./SurfaceGenerator";
import { UndergroundGenerator } from "./UndergroundGenerator";

export class WorldGenerator {
  private params: GenerationParamsType;
  private prng: ReturnType<typeof Alea>;

  private seedAsInt: number;
  private chunkSizeSq: number;
  private chunk_size: number;

  private surfaceGenerator: SurfaceGenerator;
  private undergroundGenerator: UndergroundGenerator;

  constructor(params: GenerationParamsType) {
    this.params = params;
    this.prng = Alea(this.params.SEED);
    // Convert string seed to a number for hashing
    this.seedAsInt = Squirrel3.get(0, (this.prng() * 0xffffffff) | 0);
    this.chunk_size = this.params.CHUNK_SIZE;
    this.chunkSizeSq = this.chunk_size ** 2;

    // Separate PRNGs for different noise types to avoid correlation
    const treePrng = Alea(this.prng());
    const cavePrng = Alea(this.prng());

    const treeNoise = createNoise2D(treePrng);
    const caveNoise = createNoise3D(cavePrng);

    this.surfaceGenerator = new SurfaceGenerator(
      params,
      treeNoise,
      this.seedAsInt
    );
    this.undergroundGenerator = new UndergroundGenerator(params, caveNoise);
  }

  public generateChunkData(chunkX: number, chunkY: number, chunkZ: number) {
    const blocks = new Uint8Array(this.chunk_size ** 3);
    const light = new Uint8Array(this.chunk_size ** 3);
    /**
     * Places a block in the current chunk's block array by world coordinates.
     * @param x World X coordinate.
     * @param y World Y coordinate.
     * @param z World Z coordinate.
     * @param blockId The ID of the block to place.
     * @param overwrite If true, will place the block even if one already exists.
     */
    const placeBlock = (
      x: number,
      y: number,
      z: number,
      blockId: number,
      overwrite = false
    ) => {
      const localX = x - chunkX * this.chunk_size;
      const localY = y - chunkY * this.chunk_size;
      const localZ = z - chunkZ * this.chunk_size;

      if (
        localX >= 0 &&
        localX < this.chunk_size &&
        localY >= 0 &&
        localY < this.chunk_size &&
        localZ >= 0 &&
        localZ < this.chunk_size
      ) {
        const idx =
          localX + localY * this.chunk_size + localZ * this.chunkSizeSq;

        // --- Rule: Don't let air replace water ---
        if (blockId === 0 && blocks[idx] === 30) {
          return; // Do not place air if water already exists
        }

        if (blocks[idx] === 0 || overwrite) {
          blocks[idx] = blockId;
        }
      }
    };

    const biome = this.#getBiome(
      chunkX * this.chunk_size,
      chunkZ * this.chunk_size
    );

    this.surfaceGenerator.generate(chunkX, chunkY, chunkZ, biome, placeBlock); // Generates solid terrain first
    if (chunkY < 0)
      this.undergroundGenerator.generate(chunkX, chunkY, chunkZ, placeBlock); // Then carves caves into it
    // --- Sunlight Initialization ---
    const queue: number[] = [];
    const { CHUNK_SIZE } = this.params;

    for (let x = 0; x < CHUNK_SIZE; x++) {
      const worldX = chunkX * CHUNK_SIZE + x;
      for (let z = 0; z < CHUNK_SIZE; z++) {
        const worldZ = chunkZ * CHUNK_SIZE + z;

        const biome = TerrainHeightMap.getBiome(worldX, worldZ);
        const terrainHeight = TerrainHeightMap.getFinalTerrainHeight(
          worldX,
          worldZ,
          biome
        );

        for (let y = 0; y < CHUNK_SIZE; y++) {
          const worldY = chunkY * CHUNK_SIZE + y;

          if (worldY > terrainHeight) {
            const idx = x + y * CHUNK_SIZE + z * this.chunkSizeSq;
            if (blocks[idx] === 0) {
              light[idx] = 15;
              queue.push(x, y, z, 15);
            }
          }
        }
      }
    }
    // Internal propagation (BFS) to spread light into caves within the chunk
    let head = 0;
    while (head < queue.length) {
      const x = queue[head++];
      const y = queue[head++];
      const z = queue[head++];
      const l = queue[head++];

      if (l <= 1) continue;

      const neighbors = [
        [x + 1, y, z],
        [x - 1, y, z],
        [x, y + 1, z],
        [x, y - 1, z],
        [x, y, z + 1],
        [x, y, z - 1],
      ];

      for (const [nx, ny, nz] of neighbors) {
        if (
          nx >= 0 &&
          nx < CHUNK_SIZE &&
          ny >= 0 &&
          ny < CHUNK_SIZE &&
          nz >= 0 &&
          nz < CHUNK_SIZE
        ) {
          const idx = nx + ny * CHUNK_SIZE + nz * this.chunkSizeSq;
          const blockId = blocks[idx];
          // Check transparency (0: Air, 30: Water, 60/61: Glass)
          const isTransparent =
            blockId === 0 || blockId === 30 || blockId === 60 || blockId === 61;

          if (isTransparent) {
            if (light[idx] < l - 1) {
              light[idx] = l - 1;
              queue.push(nx, ny, nz, l - 1);
            }
          }
        }
      }
    }

    return { blocks, light };
  }

  /**
   * Gets the biome information for a given world coordinate.
   */
  #getBiome(x: number, z: number) {
    return TerrainHeightMap.getBiome(x, z);
  }
}
