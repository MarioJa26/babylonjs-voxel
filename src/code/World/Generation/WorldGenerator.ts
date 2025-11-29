import Alea from "alea";
import { createNoise2D } from "simplex-noise";
import { GenerationParamsType } from "./GenerationParams";
import { Biome } from "./Biomes";
import { Squirrel3 } from "./Squirrel13";
import { TerrainHeightMap } from "./TerrainHeightMap";

export class WorldGenerator {
  private params: GenerationParamsType;
  private prng: ReturnType<typeof Alea>;
  private seedAsInt: number;
  private treeNoise: ReturnType<typeof createNoise2D>;

  constructor(params: GenerationParamsType) {
    this.params = params;
    this.prng = Alea(this.params.SEED);
    // Convert string seed to a number for hashing
    this.seedAsInt = Squirrel3.get(0, this.prng() * 0xffffffff);

    // Separate PRNGs for different noise types to avoid correlation
    const treePrng = Alea(this.prng());

    this.treeNoise = createNoise2D(treePrng);
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

        const terrainHeight = this.#getFinalTerrainHeight(
          worldX,
          worldZ,
          biome
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
              (this.#isNearWater(worldX + 1, worldZ, biome) ||
                this.#isNearWater(worldX - 1, worldZ, biome) ||
                this.#isNearWater(worldX, worldZ + 1, biome) ||
                this.#isNearWater(worldX, worldZ - 1, biome));
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

        // Use noise for tree placement. The value is in [-1, 1], so we map it to [0, 1].
        const treeNoiseValue = (this.treeNoise(worldX, worldZ) + 1) / 2;
        const treeChanceRoll = treeNoiseValue;
        if (treeChanceRoll > biome.treeDensity) continue;

        if (biome.canSpawnTrees) {
          const terrainHeight = this.#getFinalTerrainHeight(
            worldX,
            worldZ,
            biome
          );
          const topBlock = this.#getBlockTypeAtWorldCoord(
            worldX,
            terrainHeight,
            worldZ
          );
          if (topBlock === 15) {
            // Use hashing for tree properties (height, etc.)
            // Only on grass
            this._generateTreeBlocksForChunk(
              worldX,
              terrainHeight + 1,
              worldZ, // Tree origin (stem base)
              chunkX,
              chunkY,
              chunkZ, // Current chunk being generated
              blocks
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
                22,
                34,
                12
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
    woodId = 28,
    leavesId = 2,
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

    const heightHash = Squirrel3.get(
      worldX * 374761393 + worldZ * 678446653,
      this.seedAsInt
    );
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
          placeBlock(worldX + x, y, worldZ + z, leavesId); // Leaves
        }
      }
    }
  }

  #getFinalTerrainHeight(worldX: number, worldZ: number, biome: Biome): number {
    return TerrainHeightMap.getFinalTerrainHeight(worldX, worldZ, biome);
  }

  /**
   * Checks if a given coordinate is at or below sea level.
   */
  #isNearWater(x: number, z: number, biome: Biome): boolean {
    const terrainHeight = TerrainHeightMap.getFinalTerrainHeight(x, z, biome);
    return terrainHeight <= this.params.SEA_LEVEL;
  }
  /**
   * Helper to get octave noise for a coordinate, optionally with biome context.
   */
  #getOctaveNoise(x: number, z: number, biome?: Biome) {
    return TerrainHeightMap.getOctaveNoise(x, z, biome);
  }
  /**
   * Gets the biome information for a given world coordinate.
   */
  #getBiome(x: number, z: number) {
    return TerrainHeightMap.getBiome(x, z);
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
    const terrainHeight = this.#getFinalTerrainHeight(worldX, worldZ, biome);

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
