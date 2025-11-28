import Alea from "alea";
import { createNoise2D, createNoise3D } from "simplex-noise";
import { GenerationParamsType } from "./GenerationParams";
import { Biome, getBiomeFor } from "./Biomes";
import { Squirrel3 } from "./Squirrel13";
import { TerrainHeightMap } from "./TerrainHeightMap";

export class WorldGenerator {
  private params: GenerationParamsType;
  private prng: ReturnType<typeof Alea>;
  private seedAsInt: number;
  private temperatureNoise: ReturnType<typeof createNoise2D>;
  private humidityNoise: ReturnType<typeof createNoise2D>;
  private caveNoise: ReturnType<typeof createNoise3D>;
  private coalNoise: ReturnType<typeof createNoise3D>;
  private ironNoise: ReturnType<typeof createNoise3D>;

  constructor(params: GenerationParamsType) {
    this.params = params;
    this.prng = Alea(this.params.SEED);
    // Convert string seed to a number for hashing
    this.seedAsInt = Squirrel3.get(0, this.prng() * 0xffffffff);

    // Separate PRNGs for different noise types to avoid correlation
    const tempPrng = Alea(this.prng());
    const humidityPrng = Alea(this.prng());
    const cavePrng = Alea(this.prng());
    const coalPrng = Alea(this.prng());
    const ironPrng = Alea(this.prng());

    this.temperatureNoise = createNoise2D(tempPrng);
    this.humidityNoise = createNoise2D(humidityPrng);
    this.caveNoise = createNoise3D(cavePrng);
    this.coalNoise = createNoise3D(coalPrng);
    this.ironNoise = createNoise3D(ironPrng);
  }

  public generateChunkData(chunkX: number, chunkY: number, chunkZ: number) {
    const { CHUNK_SIZE } = this.params;
    const blocks = new Uint8Array(CHUNK_SIZE ** 3);
    const biome = this.#getBiome(chunkX * CHUNK_SIZE, chunkZ * CHUNK_SIZE);
    this.generateTerrain(chunkX, chunkY, chunkZ, blocks, biome);
    this.generateFlora(chunkX, chunkY, chunkZ, blocks, biome);

    return { blocks };
  }

  private generateTerrain(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    blocks: Uint8Array,
    biome: Biome
  ) {
    const { CHUNK_SIZE, SEA_LEVEL } = this.params;
    const SIZE = CHUNK_SIZE;
    const SIZE2 = SIZE * SIZE;

    for (let localX = 0; localX < SIZE; localX++) {
      for (let localZ = 0; localZ < SIZE; localZ++) {
        const worldX = chunkX * SIZE + localX;
        const worldZ = chunkZ * SIZE + localZ;

        const terrainHeight = Math.floor(
          TerrainHeightMap.getOctaveNoise(worldX, worldZ)
        );

        for (let worldY = 0; worldY <= terrainHeight; worldY++) {
          const localY = worldY - chunkY * SIZE;
          if (localY < 0 || localY >= SIZE) continue;

          let blockId = biome.stoneBlock;
          if (worldY === terrainHeight) {
            // Check for beach generation
            const isBeach =
              terrainHeight >= SEA_LEVEL - 1 &&
              terrainHeight <= SEA_LEVEL + 2 &&
              (this.#isNearWater(worldX + 1, worldZ) ||
                this.#isNearWater(worldX - 1, worldZ) ||
                this.#isNearWater(worldX, worldZ + 1) ||
                this.#isNearWater(worldX, worldZ - 1));
            if (terrainHeight < SEA_LEVEL - 1) {
              blockId = biome.seafloorBlock;
            } else if (isBeach) {
              blockId = biome.beachBlock;
            } else {
              blockId = biome.topBlock;
            }
          } else if (worldY > terrainHeight - 5) {
            blockId = biome.undergroundBlock;
          }

          blocks[localX + localY * SIZE + localZ * SIZE2] = blockId;
        }

        for (let worldY = terrainHeight + 1; worldY <= SEA_LEVEL; worldY++) {
          const localY = worldY - chunkY * SIZE;
          if (localY < 0 || localY >= SIZE) continue;
          blocks[localX + localY * SIZE + localZ * SIZE2] = 30; // water
        }
      }
    }
  }

  private generateFlora(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    blocks: Uint8Array,
    biome: Biome
  ) {
    const { CHUNK_SIZE } = this.params;
    const SIZE = CHUNK_SIZE;
    const TREE_RADIUS = 4; // Max horizontal extent of a tree from its stem

    for (let localX = -TREE_RADIUS; localX < SIZE + TREE_RADIUS; localX++) {
      for (let localZ = -TREE_RADIUS; localZ < SIZE + TREE_RADIUS; localZ++) {
        const worldX = chunkX * SIZE + localX;
        const worldZ = chunkZ * SIZE + localZ;

        // Use hashing for fast, deterministic randomness.
        // Combine worldX and worldZ into a unique position integer.
        const position = worldX * 374761393 + worldZ * 668265263;
        const hash = Squirrel3.get(position, this.seedAsInt);

        // Check if a tree should spawn
        const treeChanceRoll = (hash & 0x7fffffff) / 0x7fffffff; // Get a float [0, 1)
        if (treeChanceRoll > biome.treeDensity) continue;

        if (biome.canSpawnTrees) {
          const terrainHeight = Math.floor(
            TerrainHeightMap.getOctaveNoise(worldX, worldZ)
          );
          const topBlock = this.#getBlockTypeAtWorldCoord(
            worldX,
            terrainHeight,
            worldZ
          );
          if (topBlock === 15) {
            // Only on grass
            this._generateTreeBlocksForChunk(
              worldX,
              terrainHeight + 1,
              worldZ, // Tree origin (stem base)
              chunkX,
              chunkY,
              chunkZ, // Current chunk being generated
              blocks,
              hash // Pass the generated hash to determine tree properties
            );
          } else {
            if (topBlock === 14) {
              this._generateTreeBlocksForChunk(
                worldX,
                terrainHeight + 1,
                worldZ, // Tree origin (stem base)
                chunkX,
                chunkY,
                chunkZ, // Current chunk being generated
                blocks,
                hash, // Pass the generated hash to determine tree properties
                22,
                10
              );
            } else continue;
          }
        }
      }
    }
  }

  private _generateTreeBlocksForChunk(
    worldX: number,
    worldY: number,
    worldZ: number,
    currentChunkX: number,
    currentChunkY: number,
    currentChunkZ: number,
    blocks: Uint8Array,
    hash: number,
    woodId = 28,
    treeHeight = 5
  ) {
    const placeBlock = (x: number, y: number, z: number, blockId: number) => {
      const { CHUNK_SIZE } = this.params;
      const SIZE = CHUNK_SIZE;
      const SIZE2 = SIZE * SIZE;
      const localX = x - currentChunkX * SIZE;
      const localY = y - currentChunkY * SIZE;
      const localZ = z - currentChunkZ * SIZE;

      if (
        localX >= 0 &&
        localX < SIZE &&
        localY >= 0 &&
        localY < SIZE &&
        localZ >= 0 &&
        localZ < SIZE
      ) {
        const idx = localX + localY * SIZE + localZ * SIZE2;
        const existing = blocks[idx];
        if (existing === 0) {
          blocks[idx] = blockId;
        }
      }
    };

    // Use the hash to determine tree height.
    // We can "re-hash" the hash to get a new pseudo-random number.
    const heightHash = Squirrel3.get(hash, this.seedAsInt);
    const height = treeHeight + (Math.abs(heightHash) % 3);

    // Place trunk
    for (let i = 0; i < height; i++) {
      placeBlock(worldX, worldY + i, worldZ, woodId); // Log
    }

    // A more authentic Minecraft oak tree canopy
    const leafYStart = worldY + height - 3;

    // Main canopy layers (two 5x5 layers with corners removed)
    let radius = 2;
    for (let y = leafYStart; y < leafYStart + 4; y++) {
      if (y < leafYStart + 2) radius = 2;
      else radius = 1;
      for (let x = -radius; x <= radius; x++) {
        for (let z = -radius; z <= radius; z++) {
          placeBlock(worldX + x, y, worldZ + z, 2); // Leaves
        }
      }
    }
  }

  /**
   * Checks if a given coordinate is at or below sea level.
   */
  #isNearWater(x: number, z: number): boolean {
    const terrainHeight = Math.floor(this.#getOctaveNoise(x, z));
    return terrainHeight <= this.params.SEA_LEVEL;
  }
  #getOctaveNoise = TerrainHeightMap.getOctaveNoise.bind(TerrainHeightMap);
  /**
   * Gets the biome information for a given world coordinate.
   */
  #getBiome(x: number, z: number) {
    const temperature =
      (this.temperatureNoise(x * (1 / 1000), z * (1 / 1000)) + 1) / 2;
    const humidity =
      (this.humidityNoise(x * (1 / 1000), z * (1 / 1000)) + 1) / 2;

    return getBiomeFor(temperature, humidity);
  }

  /**
   * Handles the generation of caves and ores for a given block.
   */
  #getUndergroundBlock(
    worldX: number,
    worldY: number,
    worldZ: number,
    currentBlockId: number,
    biome: Biome
  ): number {
    if (currentBlockId !== biome.stoneBlock) {
      return currentBlockId;
    }

    // Caves
    const CAVE_SCALE = 0.05;
    const caveDensity = this.caveNoise(
      worldX * CAVE_SCALE,
      worldY * CAVE_SCALE,
      worldZ * CAVE_SCALE
    );
    if (caveDensity > 0.6) {
      return 0; // Air
    }

    // Ores
    const COAL_SCALE = 0.1;
    const coalDensity = this.coalNoise(
      worldX * COAL_SCALE,
      worldY * COAL_SCALE,
      worldZ * COAL_SCALE
    );
    if (coalDensity > 0.75) {
      return 45; // Coal Ore
    }

    const IRON_SCALE = 0.08;
    const ironDensity = this.ironNoise(
      worldX * IRON_SCALE,
      worldY * IRON_SCALE,
      worldZ * IRON_SCALE
    );
    if (worldY < 50 && ironDensity > 0.8) {
      return 46; // Iron Ore
    }

    return currentBlockId; // Return original stone block if no feature was generated
  }

  /**
   * Deterministically gets the block type at a given world coordinate,
   * by re-evaluating the terrain generation logic for that specific point.
   */
  #getBlockTypeAtWorldCoord(
    worldX: number,
    worldY: number,
    worldZ: number
  ): number {
    const { SEA_LEVEL } = this.params;
    const biome = this.#getBiome(worldX, worldZ);
    const terrainHeight = Math.floor(this.#getOctaveNoise(worldX, worldZ));

    if (worldY > terrainHeight) {
      // Above terrain, check for water
      return worldY <= SEA_LEVEL ? 30 : 0; // Water or Air
    } else if (worldY === terrainHeight) {
      if (worldY < SEA_LEVEL + 2) {
        return 3; // Sand
      }
      // Top layer of terrain
      return biome.topBlock;
    } else if (worldY > terrainHeight - 5) {
      // 4 blocks below the top layer
      return biome.undergroundBlock;
    }
    return biome.undergroundBlock;
    /* else {
      const stoneBlock = biome.stoneBlock;
      return this.#getUndergroundBlock(
        worldX,
        worldY,
        worldZ,
        stoneBlock,
        biome
      );
    } */
  }
}
