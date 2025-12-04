import Alea from "alea";
import { createNoise2D } from "simplex-noise";
import { GenerationParamsType, TreeDefinition } from "./GenerationParams";
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

    // Attempt to generate structures for this chunk
    this.generateStructures(chunkX, chunkY, chunkZ, blocks);

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
            const isBeach = this.#isBeachLocation(
              worldX,
              worldZ,
              terrainHeight,
              biome
            );
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
          const topBlockId = this.#getBlockTypeAtWorldCoord(
            worldX,
            terrainHeight,
            worldZ
          );

          // Ask the biome for a tree definition for the block we're on
          const treeDef = biome.getTreeForBlock(topBlockId);

          if (treeDef) {
            this._generateTreeBlocksForChunk(
              worldX,
              terrainHeight + 1,
              worldZ,
              chunkX,
              chunkY,
              chunkZ,
              blocks,
              treeDef
            );
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
    treeDef: TreeDefinition
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
    const height =
      treeDef.baseHeight +
      (Math.abs(heightHash) % (treeDef.heightVariance + 1));

    // Place trunk
    for (let i = 0; i < height; i++) {
      placeBlock(worldX, worldY + i, worldZ, treeDef.woodId); // Log
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
          placeBlock(worldX + x, y, worldZ + z, treeDef.leavesId); // Leaves
        }
      }
    }
  }

  #getFinalTerrainHeight(worldX: number, worldZ: number, biome: Biome): number {
    return TerrainHeightMap.getFinalTerrainHeight(worldX, worldZ, biome);
  }

  #isBeachLocation(
    worldX: number,
    worldZ: number,
    terrainHeight: number,
    biome: Biome
  ): boolean {
    const { SEA_LEVEL } = this.params;
    const isAtBeachLevel =
      terrainHeight >= SEA_LEVEL - 1 && terrainHeight <= SEA_LEVEL + 2;

    if (!isAtBeachLevel) {
      return false;
    }

    const isAdjacentToWater =
      this.#isNearWater(worldX + 1, worldZ, biome) ||
      this.#isNearWater(worldX - 1, worldZ, biome) ||
      this.#isNearWater(worldX, worldZ + 1, biome) ||
      this.#isNearWater(worldX, worldZ - 1, biome);

    return isAdjacentToWater;
  }
  /**
   * Checks if a given coordinate is at or below sea level.
   */
  #isNearWater(x: number, z: number, biome: Biome): boolean {
    const terrainHeight = TerrainHeightMap.getFinalTerrainHeight(x, z, biome);
    return terrainHeight <= this.params.SEA_LEVEL;
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
      // This logic should mirror generateTerrain to be accurate
      const isBeach = this.#isBeachLocation(
        worldX,
        worldZ,
        terrainHeight,
        biome
      );
      if (terrainHeight < SEA_LEVEL - 1) {
        return biome.seafloorBlock;
      } else if (isBeach) {
        return biome.beachBlock;
      } else {
        return biome.topBlock;
      }
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
  private generateStructures(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    blocks: Uint8Array
  ) {
    this.tryPlacingTower(chunkX, chunkY, chunkZ, blocks);
  }

  private tryPlacingTower(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    blocks: Uint8Array
  ) {
    const { CHUNK_SIZE } = this.params;
    const TOWER_REGION_SIZE = 32; // in chunks
    const TOWER_SPAWN_CHANCE = 100; // out of 100

    // Determine the region this chunk belongs to
    const regionX = Math.floor(chunkX / TOWER_REGION_SIZE);
    const regionZ = Math.floor(chunkZ / TOWER_REGION_SIZE);

    // Use a deterministic hash to decide if a tower spawns in this region
    const regionHash = Squirrel3.get(
      regionX * 374761393 + regionZ * 678446653,
      this.seedAsInt
    );

    if (Math.abs(regionHash) % 100 < TOWER_SPAWN_CHANCE) {
      // A tower should spawn in this region. Now, determine its exact location.
      const offsetX =
        Math.abs(Squirrel3.get(regionHash, this.seedAsInt)) %
        (TOWER_REGION_SIZE * CHUNK_SIZE);
      const offsetZ =
        Math.abs(Squirrel3.get(regionHash + 1, this.seedAsInt)) %
        (TOWER_REGION_SIZE * CHUNK_SIZE);

      const towerCenterX = regionX * TOWER_REGION_SIZE * CHUNK_SIZE + offsetX;
      const towerCenterZ = regionZ * TOWER_REGION_SIZE * CHUNK_SIZE + offsetZ;

      // --- Prevent spawning near the world origin (0,0) ---
      const axisCorridorWidth = 20; // No towers within this distance from the X or Z axis
      if (
        Math.abs(towerCenterX) < axisCorridorWidth ||
        Math.abs(towerCenterZ) < axisCorridorWidth
      ) {
        return;
      }

      // Now that we have a position, generate the tower if this chunk is in range
      this.generateCylinderTower(
        chunkX,
        chunkY,
        chunkZ,
        blocks,
        towerCenterX,
        towerCenterZ
      );
    }
  }

  private generateCylinderTower(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    blocks: Uint8Array,
    towerCenterX: number,
    towerCenterZ: number
  ) {
    const { CHUNK_SIZE } = this.params;
    const towerRadius = 8 + (Squirrel3.get(towerCenterX, this.seedAsInt) % 4);
    const towerHeight = 76 + (Squirrel3.get(towerCenterZ, this.seedAsInt) % 8);
    const wallBlockId = 1;

    // --- 1. Find the lowest ground point within the tower's radius ---
    let minGroundHeight = Infinity;
    const radiusSq = towerRadius * towerRadius;
    const biome = this.#getBiome(towerCenterX, towerCenterZ);
    for (let dx = -towerRadius; dx <= towerRadius; dx++) {
      for (let dz = -towerRadius; dz <= towerRadius; dz++) {
        if (dx * dx + dz * dz > radiusSq) continue;

        const worldX = towerCenterX + dx;
        const worldZ = towerCenterZ + dz;

        const height = this.#getFinalTerrainHeight(worldX, worldZ, biome);
        if (height < minGroundHeight) {
          minGroundHeight = height;
        }
      }
    }

    const groundHeight = minGroundHeight;

    // --- 2. Create a solid foundation up to the groundHeight ---
    for (let localX = 0; localX < CHUNK_SIZE; localX++) {
      for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
        const worldX = chunkX * CHUNK_SIZE + localX;
        const worldZ = chunkZ * CHUNK_SIZE + localZ;

        const dx = worldX - towerCenterX;
        const dz = worldZ - towerCenterZ;
        if (dx * dx + dz * dz <= radiusSq) {
          const originalHeight = this.#getFinalTerrainHeight(
            worldX,
            worldZ,
            biome
          );
          // Fill in blocks from original terrain height up to the new flat groundHeight
          for (let y = originalHeight; y < groundHeight; y++) {
            const localY = y - chunkY * CHUNK_SIZE;
            if (localY >= 0 && localY < CHUNK_SIZE) {
              blocks[
                localX + localY * CHUNK_SIZE + localZ * CHUNK_SIZE * CHUNK_SIZE
              ] = biome.undergroundBlock;
            }
          }
        }
      }
    }

    // Iterate through all possible blocks in the current chunk
    for (let localY = 0; localY < CHUNK_SIZE; localY++) {
      const worldY = chunkY * CHUNK_SIZE + localY;

      // Check if the current world Y is within the tower's height range
      if (worldY < groundHeight || worldY >= groundHeight + towerHeight) {
        continue;
      }

      for (let localX = 0; localX < CHUNK_SIZE; localX++) {
        for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
          const worldX = chunkX * CHUNK_SIZE + localX;
          const worldZ = chunkZ * CHUNK_SIZE + localZ;

          const dx = worldX - towerCenterX;
          const dz = worldZ - towerCenterZ;
          const distSq = dx * dx + dz * dz;

          if (distSq <= radiusSq) {
            blocks[
              localX + localY * CHUNK_SIZE + localZ * CHUNK_SIZE * CHUNK_SIZE
            ] = wallBlockId;
          }
        }
      }
    }
  }
}
