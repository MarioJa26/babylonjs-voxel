import Alea from "alea";
import { createNoise2D, createNoise3D } from "simplex-noise";
import { GenerationParamsType, TreeDefinition } from "./GenerationParams";
import { Biome } from "./Biomes";
import { Squirrel3 } from "./Squirrel13";
import { TerrainHeightMap } from "./TerrainHeightMap";

export class WorldGenerator {
  private params: GenerationParamsType;
  private prng: ReturnType<typeof Alea>;
  private seedAsInt: number;
  private treeNoise: ReturnType<typeof createNoise2D>;
  private caveNoise: ReturnType<typeof createNoise3D>;
  private readonly CHUNK_SIZE: number;
  private readonly CHUNK_SIZE_2: number;
  private readonly CHUNK_SIZE_3: number;

  constructor(params: GenerationParamsType) {
    this.params = params;
    this.prng = Alea(this.params.SEED);
    // Convert string seed to a number for hashing
    this.seedAsInt = Squirrel3.get(0, this.prng() * 0xffffffff);

    // Separate PRNGs for different noise types to avoid correlation
    const treePrng = Alea(this.prng());
    const cavePrng = Alea(this.prng());

    this.treeNoise = createNoise2D(treePrng);
    this.caveNoise = createNoise3D(cavePrng);

    this.CHUNK_SIZE = this.params.CHUNK_SIZE;
    this.CHUNK_SIZE_2 = this.CHUNK_SIZE * this.CHUNK_SIZE;
    this.CHUNK_SIZE_3 = this.CHUNK_SIZE_2 * this.CHUNK_SIZE;
  }

  public generateTerrainForChunk(
    chunkX: number,
    chunkY: number,
    chunkZ: number
  ) {
    const blocks = new Uint8Array(this.CHUNK_SIZE_3);
    const CHUNK_SIZE = this.CHUNK_SIZE;
    const biome = this.#getBiome(chunkX * CHUNK_SIZE, chunkZ * CHUNK_SIZE);

    this.generateTerrain(chunkX, chunkY, chunkZ, blocks, biome);

    return { blocks };
  }

  public generateStructuresForChunk(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    blocks: Uint8Array
  ) {
    const CHUNK_SIZE = this.CHUNK_SIZE;
    this.#getBiome(chunkX * CHUNK_SIZE, chunkZ * CHUNK_SIZE);

    this.generateStructures(chunkX, chunkY, chunkZ, blocks);

    return { blocks };
  }

  public generateFloraForChunk(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    blocks: Uint8Array
  ) {
    const CHUNK_SIZE = this.CHUNK_SIZE;
    const biome = this.#getBiome(chunkX * CHUNK_SIZE, chunkZ * CHUNK_SIZE);

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
    const { SEA_LEVEL } = this.params;

    // Single-pass terrain generation
    for (let localX = 0; localX < this.CHUNK_SIZE; localX++) {
      for (let localZ = 0; localZ < this.CHUNK_SIZE; localZ++) {
        const worldX = chunkX * this.CHUNK_SIZE + localX;
        const worldZ = chunkZ * this.CHUNK_SIZE + localZ;

        // Calculate terrain height once for this column
        const terrainHeight = this.#getFinalTerrainHeight(worldX, worldZ);

        for (let localY = 0; localY < this.CHUNK_SIZE; localY++) {
          const worldY = chunkY * this.CHUNK_SIZE + localY;
          const index =
            localX + localY * this.CHUNK_SIZE + localZ * this.CHUNK_SIZE_2;

          if (worldY > terrainHeight) {
            // This block is above the ground. It's either air or water.
            if (worldY <= SEA_LEVEL) {
              blocks[index] = 30; // Water
            } else {
              blocks[index] = 0; // Air
            }
            continue;
          }

          // This block is at or below the ground. It's solid unless carved by a cave.
          // --- 3D Cave Generation ---
          const tempNoise = Squirrel3.get(worldY, this.seedAsInt) % 2;
          const caveNoiseScale = 200 + tempNoise;
          const caveNoiseScaleZX = 240 + tempNoise;
          const caveThreshold = 0.9;
          const falloffStartHeight = 40;
          const falloff =
            worldY < falloffStartHeight ? worldY / falloffStartHeight : 1.0;

          if (falloff > 0) {
            const adjustedThreshold = caveThreshold / falloff;
            const caveNoiseValue = this.caveNoise(
              worldX / caveNoiseScaleZX,
              worldY / caveNoiseScale,
              worldZ / caveNoiseScaleZX
            );
            if (Math.abs(caveNoiseValue) > adjustedThreshold) {
              // Carved out by a cave. If below sea level, it might become water.
              blocks[index] = worldY <= SEA_LEVEL ? 30 : 0;
              continue;
            }
          }

          // --- Solid Block Type Determination ---
          let blockId = biome.stoneBlock;
          if (worldY === terrainHeight) {
            const isBeach = this.#isBeachLocation(
              worldX,
              worldZ,
              terrainHeight
            );
            if (terrainHeight < SEA_LEVEL - 1) blockId = biome.seafloorBlock;
            else if (isBeach) blockId = biome.beachBlock;
            else blockId = biome.topBlock;
          } else if (worldY > terrainHeight - 5) {
            blockId = biome.undergroundBlock;
          }
          blocks[index] = blockId;
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
    const SIZE = this.CHUNK_SIZE;
    const TREE_RADIUS = 4; // Max horizontal extent of a tree from its stem

    for (let localX = -TREE_RADIUS; localX < SIZE + TREE_RADIUS; localX++) {
      for (let localZ = -TREE_RADIUS; localZ < SIZE + TREE_RADIUS; localZ++) {
        const worldX = chunkX * SIZE + localX;
        const worldZ = chunkZ * SIZE + localZ;

        // Use noise for tree placement. The value is in [-1, 1], so we map it to [0, 1].
        const treeNoiseValue = (this.treeNoise(worldX, worldZ) + 1) / 2; // This is correct
        const treeChanceRoll = treeNoiseValue;
        if (treeChanceRoll > biome.treeDensity) continue;

        if (biome.canSpawnTrees) {
          const terrainHeight = this.#getFinalTerrainHeight(worldX, worldZ);
          const topBlockId = this._getBlockTypeAtWorldCoord(
            worldX,
            terrainHeight,
            worldZ,
            chunkX,
            chunkY, // These are for the *current* chunk
            chunkZ,
            blocks
          );

          // --- Cave Check ---
          // Don't spawn a tree if its base block has been carved out by a cave.
          // A non-zero block ID means the ground is solid.
          if (topBlockId === 0) {
            continue;
          }

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
      const localX = x - currentChunkX * this.CHUNK_SIZE;
      const localY = y - currentChunkY * this.CHUNK_SIZE;
      const localZ = z - currentChunkZ * this.CHUNK_SIZE;

      if (
        localX >= 0 &&
        localX < this.CHUNK_SIZE &&
        localY >= 0 &&
        localY < this.CHUNK_SIZE &&
        localZ >= 0 &&
        localZ < this.CHUNK_SIZE
      ) {
        const idx =
          localX + localY * this.CHUNK_SIZE + localZ * this.CHUNK_SIZE_2;
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

  #getFinalTerrainHeight(worldX: number, worldZ: number): number {
    const biome = this.#getBiome(worldX, worldZ);
    return TerrainHeightMap.getFinalTerrainHeight(worldX, worldZ, biome);
  }

  #isBeachLocation(
    worldX: number,
    worldZ: number,
    terrainHeight: number
  ): boolean {
    const { SEA_LEVEL } = this.params;
    const isAtBeachLevel =
      terrainHeight >= SEA_LEVEL - 1 && terrainHeight <= SEA_LEVEL + 2;

    if (!isAtBeachLevel) {
      return false;
    }

    const isAdjacentToWater =
      this.#isNearWater(worldX + 1, worldZ) ||
      this.#isNearWater(worldX - 1, worldZ) ||
      this.#isNearWater(worldX, worldZ + 1) ||
      this.#isNearWater(worldX, worldZ - 1);

    return isAdjacentToWater;
  }
  /**
   * Checks if a given coordinate is at or below sea level.
   */
  #isNearWater(x: number, z: number): boolean {
    const terrainHeight = this.#getFinalTerrainHeight(x, z);
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
  private _getBlockTypeAtWorldCoord(
    worldX: number,
    worldY: number,
    worldZ: number,
    currentChunkX: number,
    currentChunkY: number,
    currentChunkZ: number,
    blocks: Uint8Array
  ): number {
    const SIZE = this.CHUNK_SIZE;

    // Check if the coordinate is within the current chunk being generated
    const targetChunkX = Math.floor(worldX / this.CHUNK_SIZE);
    const targetChunkY = Math.floor(worldY / this.CHUNK_SIZE);
    const targetChunkZ = Math.floor(worldZ / this.CHUNK_SIZE);

    if (
      targetChunkX === currentChunkX &&
      targetChunkY === currentChunkY &&
      targetChunkZ === currentChunkZ
    ) {
      // It's in the current chunk, read from the blocks array.
      // This is fast and accounts for previous generation steps (e.g., structures).
      const localX =
        ((worldX % this.CHUNK_SIZE) + this.CHUNK_SIZE) % this.CHUNK_SIZE;
      const localY =
        ((worldY % this.CHUNK_SIZE) + this.CHUNK_SIZE) % this.CHUNK_SIZE;
      const localZ =
        ((worldZ % this.CHUNK_SIZE) + this.CHUNK_SIZE) % this.CHUNK_SIZE;
      return blocks[
        localX + localY * this.CHUNK_SIZE + localZ * this.CHUNK_SIZE_2
      ];
    }

    // Fallback for out-of-chunk coordinates.
    // We can't know the exact block type without the neighbor's block data,
    // but we can determine if it's likely solid or not.
    // Returning 0 (air) is a safe default.
    return 0; // This case should be avoided if possible.
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
        (TOWER_REGION_SIZE * this.CHUNK_SIZE);
      const offsetZ =
        Math.abs(Squirrel3.get(regionHash + 1, this.seedAsInt)) %
        (TOWER_REGION_SIZE * this.CHUNK_SIZE);

      const towerCenterX =
        regionX * TOWER_REGION_SIZE * this.CHUNK_SIZE + offsetX;
      const towerCenterZ =
        regionZ * TOWER_REGION_SIZE * this.CHUNK_SIZE + offsetZ;

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
    const towerRadius = 8 + (Squirrel3.get(towerCenterX, this.seedAsInt) % 4);
    const towerHeight = 76 + (Squirrel3.get(towerCenterZ, this.seedAsInt) % 8);
    const wallBlockId = 1;
    const radiusSq = towerRadius * towerRadius;

    // Determine the base height of the tower from its center point.
    const groundHeight = this.#getFinalTerrainHeight(
      towerCenterX,
      towerCenterZ
    );

    // Iterate through all possible blocks in the current chunk
    for (let localY = 0; localY < this.CHUNK_SIZE; localY++) {
      const worldY = chunkY * this.CHUNK_SIZE + localY;

      // Check if this Y-level is even in the tower's range first
      for (let localX = 0; localX < this.CHUNK_SIZE; localX++) {
        for (let localZ = 0; localZ < this.CHUNK_SIZE; localZ++) {
          const worldX = chunkX * this.CHUNK_SIZE + localX;
          const worldZ = chunkZ * this.CHUNK_SIZE + localZ;

          const dx = worldX - towerCenterX;
          const dz = worldZ - towerCenterZ;
          const distSq = dx * dx + dz * dz;

          if (distSq <= radiusSq) {
            // This position is inside the tower's radius.
            // Overwrite the block if it's within the tower's vertical extent.
            if (worldY >= groundHeight && worldY < groundHeight + towerHeight) {
              blocks[
                localX + localY * this.CHUNK_SIZE + localZ * this.CHUNK_SIZE_2
              ] = wallBlockId;
            }
          }
        }
      }
    }
  }
}
