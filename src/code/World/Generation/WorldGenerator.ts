import Alea from "alea";
import { createNoise2D, createNoise3D } from "simplex-noise";
import { GenerationParamsType } from "./GenerationParams";
import { Biome } from "./Biome/Biomes";
import { Squirrel3 } from "./Squirrel13";
import { TerrainHeightMap } from "./TerrainHeightMap";
import { Structure, StructureData } from "./Structure";

export class WorldGenerator {
  private params: GenerationParamsType;
  private prng: ReturnType<typeof Alea>;
  private seedAsInt: number;
  private structures: Map<string, Structure> = new Map();
  private treeNoise: ReturnType<typeof createNoise2D>;
  private caveNoise: ReturnType<typeof createNoise3D>;
  private chunkSizeSq: number;

  private chunk_size: number;

  constructor(params: GenerationParamsType) {
    this.params = params;
    this.prng = Alea(this.params.SEED);
    // Convert string seed to a number for hashing
    this.seedAsInt = Squirrel3.get(0, (this.prng() * 0xffffffff) | 0);

    // Separate PRNGs for different noise types to avoid correlation
    const treePrng = Alea(this.prng());
    const cavePrng = Alea(this.prng());

    this.treeNoise = createNoise2D(treePrng);
    this.chunk_size = this.params.CHUNK_SIZE;
    this.chunkSizeSq = this.chunk_size ** 2;
    this.caveNoise = createNoise3D(cavePrng);

    this.#loadStructures();
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
          localX + localY * this.chunk_size + localZ * this.chunkSizeSq;
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
    const SIZE = CHUNK_SIZE; // Alias for chunk size
    const MIN_WORLD_Y = -16 * 100; // The lowest possible Y coordinate for terrain
    const chunkWorldX = chunkX * SIZE;
    const chunkWorldZ = chunkZ * SIZE;
    const chunkWorldY = chunkY * SIZE;
    const startYForChunk = Math.max(MIN_WORLD_Y, chunkWorldY);

    for (let localX = 0; localX < SIZE; localX++) {
      const worldX = chunkWorldX + localX;
      for (let localZ = 0; localZ < SIZE; localZ++) {
        const worldZ = chunkWorldZ + localZ;

        const terrainHeight = this.#getFinalTerrainHeight(
          worldX,
          worldZ,
          biome
        );

        // Determine the range of Y coordinates to fill for this column
        const endY = Math.min(terrainHeight, chunkWorldY + SIZE - 1);

        const MIN_CAVE_DENSITY = 0.00000001; // For large caves deep underground.
        const MAX_CAVE_DENSITY = 1.0; // For small caves near the surface.
        const DENSITY_TRANSITION_DEPTH = -32; // How many blocks down until caves reach max size.
        // Fill blocks from the bottom of the relevant world area up to the terrain height

        for (let worldY = startYForChunk; worldY <= endY; worldY++) {
          // --- Cave Generation ---
          // Only carve caves below the surface layer
          if (worldY < -2) {
            // --- Dynamic Cave Density ---

            // 't' is the interpolation factor, from 0 (at surface) to 1 (at max depth).
            const t = Math.min(1, worldY / DENSITY_TRANSITION_DEPTH);
            // Interpolate from MIN (deep) to MAX (surface)
            const caveDensity =
              MIN_CAVE_DENSITY * t + MAX_CAVE_DENSITY * (1 - t);

            const CAVE_SCALE = 0.01; // How stretched out the caves are. Smaller = larger caves.
            const noiseValue = this.caveNoise(
              worldX * CAVE_SCALE,
              worldY * CAVE_SCALE,
              worldZ * CAVE_SCALE
            );

            if (noiseValue > caveDensity) {
              // This is a cave space. Check if it should be a lava pool.
              const LAVA_LEVEL = -16 * 100;
              if (worldY < LAVA_LEVEL) {
                placeBlock(worldX, worldY, worldZ, 24, false); // Lava
              }
              continue; // Skip placing a block to create a cave
            }
            placeBlock(worldX, worldY, worldZ, 29, true);
          } else {
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

            placeBlock(worldX, worldY, worldZ, blockId, true);
          }
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
    this.tryPlacingStructure(chunkX, chunkY, chunkZ, placeBlock);
    this.tryPlacingLavaPool(chunkX, chunkY, chunkZ, placeBlock);
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
    const TOWER_REGION_SIZE = 16; // in chunks
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

      const towerRadius = 8 + (Squirrel3.get(towerCenterX, this.seedAsInt) % 4);
      const biome = this.#getBiome(towerCenterX, towerCenterZ);
      const groundHeight = this.findMinGroundHeightForTower(
        towerCenterX,
        towerCenterZ,
        towerRadius,
        biome
      );

      // Now that we have a position, generate the tower if this chunk is in range
      this.generateCylinderTower(
        chunkX,
        chunkY,
        chunkZ,
        towerCenterX,
        towerCenterZ,
        towerRadius,
        groundHeight,
        biome,
        placeBlock
      );
      // Also try to generate the underground part of the tower
      this.generateUndergroundCylinderTower(
        chunkX,
        chunkY,
        chunkZ,
        towerCenterX,
        towerCenterZ,
        towerRadius,
        groundHeight,
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
    towerRadius: number,
    groundHeight: number,
    biome: Biome,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean
    ) => void
  ) {
    const towerHeight = 76 + (Squirrel3.get(towerCenterZ, this.seedAsInt) % 8);
    const wallBlockId = 1;
    const radiusSq = towerRadius * towerRadius;

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

  private generateUndergroundCylinderTower(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    towerCenterX: number,
    towerCenterZ: number,
    towerRadius: number,
    groundHeight: number,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean
    ) => void
  ) {
    const wallBlockId = 26;
    const MIN_WORLD_Y = -16 * 100;
    const radiusSq = towerRadius * towerRadius;

    // Iterate through all possible blocks in the current chunk
    for (let localY = 0; localY < this.chunk_size; localY++) {
      const worldY = chunkY * this.chunk_size + localY;

      // Check if the current world Y is within the tower's height range
      if (worldY < MIN_WORLD_Y || worldY >= groundHeight) {
        continue;
      }

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

  private findMinGroundHeightForTower(
    towerCenterX: number,
    towerCenterZ: number,
    towerRadius: number,
    biome: Biome
  ): number {
    let minGroundHeight = Infinity;
    const radiusSq = towerRadius * towerRadius;

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
    return minGroundHeight;
  }

  private tryPlacingStructure(
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
    if (this.structures.size === 0) return;

    const REGION_SIZE = 3; // in chunks
    const SPAWN_CHANCE = 100; // 5% chance per region

    const regionX = Math.floor(chunkX / REGION_SIZE);
    const regionZ = Math.floor(chunkZ / REGION_SIZE);

    // Use a different prime from other structures to avoid overlap
    const regionHash = Squirrel3.get(
      regionX * 584661329 + regionZ * 957346603,
      this.seedAsInt
    );

    if (Math.abs(regionHash) % 100 < SPAWN_CHANCE) {
      // Pick a random structure to place
      const structureNames = Array.from(this.structures.keys());
      const structureName =
        structureNames[Math.abs(regionHash) % structureNames.length];
      const structure = this.structures.get(structureName);

      if (!structure) return;

      // Determine its exact location within the region
      const offsetX =
        Math.abs(Squirrel3.get(regionHash, this.seedAsInt)) %
        (REGION_SIZE * this.chunk_size);
      const offsetZ =
        Math.abs(Squirrel3.get(regionHash + 1, this.seedAsInt)) %
        (REGION_SIZE * this.chunk_size);

      const structureOriginX =
        regionX * REGION_SIZE * this.chunk_size + offsetX;
      const structureOriginZ =
        regionZ * REGION_SIZE * this.chunk_size + offsetZ;

      const biome = this.#getBiome(structureOriginX, structureOriginZ);
      const groundHeight = this.#getFinalTerrainHeight(
        structureOriginX,
        structureOriginZ,
        biome
      );

      structure.place(
        structureOriginX,
        groundHeight,
        structureOriginZ,
        placeBlock
      );
    }
  }

  private tryPlacingLavaPool(
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
    const POOL_REGION_SIZE = 9; // in chunks
    const POOL_SPAWN_CHANCE = 100; // out of 100

    // Determine the region this chunk belongs to
    const regionX = Math.floor(chunkX / POOL_REGION_SIZE);
    const regionZ = Math.floor(chunkZ / POOL_REGION_SIZE);

    // Use a deterministic hash to decide if a pool spawns in this region
    const regionHash = Squirrel3.get(
      regionX * 873461393 + regionZ * 178246653, // Use different primes
      this.seedAsInt
    );

    if (Math.abs(regionHash) % 100 < POOL_SPAWN_CHANCE) {
      // A pool should spawn in this region. Now, determine its exact location.
      const baseHash = Squirrel3.get(regionHash, this.seedAsInt);

      const offsetX =
        Math.abs(Squirrel3.get(baseHash, this.seedAsInt)) %
        (POOL_REGION_SIZE * this.chunk_size);
      const offsetZ =
        Math.abs(Squirrel3.get(baseHash + 1, this.seedAsInt)) %
        (POOL_REGION_SIZE * this.chunk_size);

      // Place pools between Y=-32 and Y=-256
      const offsetY =
        -64 -
        (Math.abs(Squirrel3.get(baseHash + 2, this.seedAsInt)) % (1024 - 64));

      const poolCenterX =
        regionX * POOL_REGION_SIZE * this.chunk_size + offsetX;
      const poolSurfaceY = offsetY;
      const poolCenterZ =
        regionZ * POOL_REGION_SIZE * this.chunk_size + offsetZ;

      this.generateLavaPool(
        chunkX,
        chunkY,
        chunkZ,
        poolCenterX,
        poolSurfaceY,
        poolCenterZ,
        placeBlock
      );
    }
  }

  private generateLavaPool(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    poolCenterX: number,
    poolCenterY: number,
    poolCenterZ: number,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean
    ) => void
  ) {
    const poolRadius = 25 + (Squirrel3.get(poolCenterX, this.seedAsInt) % 5); // Radius 5 to 9
    const maxDepth = 15 + (Squirrel3.get(poolCenterZ, this.seedAsInt) % 3); // Depth 4 to 6
    const radiusSq = poolRadius * poolRadius;
    const lavaBlockId = 24;
    const shoreBlockId = 25; // e.g., Obsidian

    // --- 1. Carve out the complete obsidian shell first ---
    const shellRadius = poolRadius + 1;
    const shellRadiusSq = shellRadius * shellRadius;
    for (let dx = -shellRadius; dx <= shellRadius; dx++) {
      for (let dz = -shellRadius; dz <= shellRadius; dz++) {
        const distSq = dx * dx + dz * dz;
        if (distSq >= shellRadiusSq) continue;

        const worldX = poolCenterX + dx;
        const worldZ = poolCenterZ + dz;
        const depthFactor = Math.sqrt(distSq) / shellRadius; // sqrt is ok here as it's for the shell shape
        const depth = Math.floor((maxDepth + 1) * (1 - depthFactor));
        const floorY = poolCenterY - depth;

        for (let y = floorY; y <= poolCenterY; y++) {
          placeBlock(worldX, y, worldZ, shoreBlockId, true);
        }
      }
    }

    // --- 2. Fill the inside of the shell with lava ---
    for (let dx = -poolRadius; dx <= poolRadius; dx++) {
      for (let dz = -poolRadius; dz <= poolRadius; dz++) {
        const distSq = dx * dx + dz * dz;
        if (distSq >= radiusSq) continue;

        // Use squared distance to avoid expensive sqrt in the inner loop
        const depth = Math.floor(maxDepth * (1 - distSq / radiusSq));
        const floorY = poolCenterY - depth;
        for (let y = floorY; y <= poolCenterY; y++) {
          placeBlock(poolCenterX + dx, y, poolCenterZ + dz, lavaBlockId, true);
        }
      }
    }
  }

  /**
   * A helper to check if a block is solid. For now, it re-runs cave noise.
   * This is not perfectly accurate if other structures are present but is a good approximation.
   */
  private isBlockSolid(
    worldX: number,
    worldY: number,
    worldZ: number
  ): boolean {
    // Simplified check: if it's in a cave, it's not solid.
    // This is an approximation and doesn't account for other structures.
    if (worldY < -2) {
      const t = Math.min(1, worldY / -32);
      const caveDensity = 0.00000001 * t + 1.0 * (1 - t);
      const CAVE_SCALE = 0.01;
      const noiseValue = this.caveNoise(
        worldX * CAVE_SCALE,
        worldY * CAVE_SCALE,
        worldZ * CAVE_SCALE
      );
      if (noiseValue > caveDensity) {
        return false; // It's a cave, so not solid
      }
    }
    return true; // Assume solid otherwise
  }

  /**
   * Loads hardcoded structures for testing purposes.
   * In a production environment, this would typically load from external files.
   */
  #loadStructures() {
    const smallHouseData: StructureData = {
      name: "Small Stone House", // Name is not part of StructureData interface, but useful for context
      width: 5,
      height: 4,
      depth: 5,
      palette: {
        "0": 0, // air
        "1": 1, // stone_brick
        "2": 18, // oak_wood
        "3": 19, // glass
      },
      blocks: [
        // Layer Y=0 (bottom)
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        // Layer Y=1
        2, 0, 0, 0, 2, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 2, 0, 0, 0, 2,
        // Layer Y=2
        2, 2, 2, 2, 2, 1, 3, 0, 3, 1, 1, 0, 0, 0, 1, 2, 2, 2, 2, 2,
        // Layer Y=3 (top)
        0, 2, 2, 2, 0, 0, 2, 0, 2, 0, 0, 2, 0, 2, 0, 0, 2, 2, 2, 0,
      ],
    };

    this.structures.set("Small Stone House", new Structure(smallHouseData));
    console.log(`Loaded hardcoded structure: ${smallHouseData.name}`);
  }
}
