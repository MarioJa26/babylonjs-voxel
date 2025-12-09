import Alea from "alea";
import { createNoise2D } from "simplex-noise";
import { GenerationParamsType } from "./GenerationParams";
import { Biome } from "./Biome/Biomes";
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

  private chunk_size: number;

  constructor(params: GenerationParamsType) {
    this.params = params;
    this.prng = Alea(this.params.SEED);
    // Convert string seed to a number for hashing
    this.seedAsInt = Squirrel3.get(0, this.prng() * 0xffffffff);

    // Separate PRNGs for different noise types to avoid correlation
    const treePrng = Alea(this.prng());
    const cavePrng = Alea(this.prng());

    this.treeNoise = createNoise2D(treePrng);
    this.chunk_size = this.params.CHUNK_SIZE;
  }

  public generateChunkData(chunkX: number, chunkY: number, chunkZ: number) {
    const blocks = new Uint8Array(this.chunk_size ** 3);

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
          localX + localY * this.chunk_size + localZ * this.chunk_size ** 2;
        if (overwrite || blocks[idx] === 0) {
          blocks[idx] = blockId;
        }
      }
    };

    const biome = this.#getBiome(
      chunkX * this.chunk_size,
      chunkZ * this.chunk_size
    );
    this.generateTerrain(chunkX, chunkY, chunkZ, biome, placeBlock);
    this.generateFlora(chunkX, chunkY, chunkZ, biome, placeBlock);

    // Attempt to generate structures for this chunk
    this.generateStructures(chunkX, chunkY, chunkZ, placeBlock);

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
    biome: Biome,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean
    ) => void
  ) {
    const { CHUNK_SIZE, SEA_LEVEL } = this.params;
    const SIZE = CHUNK_SIZE;

    // Single-pass terrain generation
    for (let localX = 0; localX < this.CHUNK_SIZE; localX++) {
      for (let localZ = 0; localZ < this.CHUNK_SIZE; localZ++) {
        const worldX = chunkX * this.CHUNK_SIZE + localX;
        const worldZ = chunkZ * this.CHUNK_SIZE + localZ;

        // Calculate terrain height once for this column
        const terrainHeight = this.#getFinalTerrainHeight(worldX, worldZ);

        for (let worldY = 0; worldY <= terrainHeight; worldY++) {
          const localY = worldY - chunkY * SIZE;
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

          placeBlock(worldX, worldY, worldZ, blockId, true);
        }

        for (let worldY = terrainHeight + 1; worldY <= SEA_LEVEL; worldY++) {
          // Water should not overwrite existing blocks (like tower walls)
          placeBlock(worldX, worldY, worldZ, 30, false); // water
        }
      }
    }
  }

  private generateFlora(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    biome: Biome,
    placeBlock: (x: number, y: number, z: number, id: number) => void
  ) {
    const TREE_RADIUS = Math.ceil(biome.treeDensity * 100) + 1;

    for (
      let localX = -TREE_RADIUS;
      localX < this.chunk_size + TREE_RADIUS;
      localX++
    ) {
      for (
        let localZ = -TREE_RADIUS;
        localZ < this.chunk_size + TREE_RADIUS;
        localZ++
      ) {
        const worldX = chunkX * this.chunk_size + localX;
        const worldZ = chunkZ * this.chunk_size + localZ;

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
          biome
            .getTreeForBlock(topBlockId)
            ?.generate(
              worldX,
              terrainHeight + 1,
              worldZ,
              placeBlock,
              this.seedAsInt
            );
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
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean
    ) => void
  ) {
    this.tryPlacingTower(chunkX, chunkY, chunkZ, placeBlock);
  }

  private tryPlacingTower(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean
    ) => void
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
        (TOWER_REGION_SIZE * this.chunk_size);
      const offsetZ =
        Math.abs(Squirrel3.get(regionHash + 1, this.seedAsInt)) %
        (TOWER_REGION_SIZE * this.chunk_size);

      const towerCenterX =
        regionX * TOWER_REGION_SIZE * this.chunk_size + offsetX;
      const towerCenterZ =
        regionZ * TOWER_REGION_SIZE * this.chunk_size + offsetZ;

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
        towerCenterX,
        towerCenterZ,
        placeBlock
      );
    }
  }

  private generateCylinderTower(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    towerCenterX: number,
    towerCenterZ: number,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean
    ) => void
  ) {
    const towerRadius = 8 + (Squirrel3.get(towerCenterX, this.seedAsInt) % 4);
    const towerHeight = 76 + (Squirrel3.get(towerCenterZ, this.seedAsInt) % 8);
    const wallBlockId = 1;
    const radiusSq = towerRadius * towerRadius;

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
    for (let dx = -towerRadius; dx <= towerRadius; dx++) {
      for (let dz = -towerRadius; dz <= towerRadius; dz++) {
        if (dx * dx + dz * dz > radiusSq) continue;

        const worldX = towerCenterX + dx;
        const worldZ = towerCenterZ + dz;

        const originalHeight = this.#getFinalTerrainHeight(
          worldX,
          worldZ,
          biome
        );
        // Fill in blocks from original terrain height up to the new flat groundHeight
        for (let y = originalHeight; y < groundHeight; y++) {
          placeBlock(worldX, y, worldZ, biome.undergroundBlock, true);
        }
      }
    }

    // Iterate through all possible blocks in the current chunk
    for (let localY = 0; localY < this.chunk_size; localY++) {
      const worldY = chunkY * this.chunk_size + localY;

      // Check if the current world Y is within the tower's height range
      if (worldY < groundHeight || worldY >= groundHeight + towerHeight) {
        continue;
      }

      if (localY < 0 || localY >= this.chunk_size) continue;

      for (let dx = -towerRadius; dx <= towerRadius; dx++) {
        for (let dz = -towerRadius; dz <= towerRadius; dz++) {
          if (dx * dx + dz * dz > radiusSq) continue;
          placeBlock(
            towerCenterX + dx,
            worldY,
            towerCenterZ + dz,
            wallBlockId,
            true
          );
        }
      }
    }
  }
}
