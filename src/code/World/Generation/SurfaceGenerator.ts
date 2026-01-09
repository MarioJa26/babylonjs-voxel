import { createNoise2D } from "simplex-noise";
import { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { Biome } from "./Biome/Biomes";
import { TerrainHeightMap } from "./TerrainHeightMap";
import { Squirrel3 } from "./NoiseAndParameters/Squirrel13";
import { Structure, StructureData } from "./Structure";
import { RiverGenerator } from "./RiverGeneration";

export class SurfaceGenerator {
  private params: GenerationParamsType;
  private treeNoise: ReturnType<typeof createNoise2D>;
  private seedAsInt: number;
  private structures: Map<string, Structure> = new Map();
  private chunk_size: number;
  private riverGenerator: RiverGenerator;

  constructor(
    params: GenerationParamsType,
    treeNoise: ReturnType<typeof createNoise2D>,
    seedAsInt: number
  ) {
    this.params = params;
    this.treeNoise = treeNoise;
    this.seedAsInt = seedAsInt;
    this.chunk_size = this.params.CHUNK_SIZE;
    this.riverGenerator = new RiverGenerator(params);

    this.loadStructures();
  }

  public generate(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    biome: Biome,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow?: boolean
    ) => void
  ) {
    this.generateTerrain(chunkX, chunkY, chunkZ, biome, placeBlock);
    this.generateFlora(chunkX, chunkY, chunkZ, biome, placeBlock);
    this.generateStructures(chunkX, chunkY, chunkZ, biome, placeBlock);
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
    const chunkWorldX = chunkX * CHUNK_SIZE;
    const chunkWorldZ = chunkZ * CHUNK_SIZE;

    for (let localX = 0; localX < CHUNK_SIZE; localX++) {
      const worldX = chunkWorldX + localX;
      for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
        const worldZ = chunkWorldZ + localZ;

        const terrainHeight = this.getFinalTerrainHeight(worldX, worldZ, biome);
        const riverNoise = this.riverGenerator.getRiverNoise(worldX, worldZ);

        // Iterate through the Y column for this chunk
        for (let localY = 0; localY < CHUNK_SIZE; localY++) {
          const worldY = chunkY * CHUNK_SIZE + localY;

          const isTunnel = this.riverGenerator.isRiver(
            worldX,
            worldZ,
            riverNoise,
            worldY
          );

          if (worldY > terrainHeight) {
            // Above ground, fill with water if below sea level
            if (worldY <= SEA_LEVEL) {
              placeBlock(worldX, worldY, worldZ, 30, false); // water
            }
            continue; // Air
          }

          if (isTunnel) {
            if (worldY <= SEA_LEVEL) {
              placeBlock(worldX, worldY, worldZ, 30, true); // Water
            } else {
              placeBlock(worldX, worldY, worldZ, 0, true); // Air
            }
            continue;
          }

          // It's a solid cell, place the appropriate terrain block
          let blockId = 29; // Use block 29 for all underground stone
          if (worldY === terrainHeight) {
            const isBeach = this.isBeachLocation(
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
          } else if (worldY > terrainHeight - 6) {
            blockId = biome.undergroundBlock;
          } else {
            if (worldY > 0) {
              blockId = 1;
            }
          }
          placeBlock(worldX, worldY, worldZ, blockId, true);
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
          const terrainHeight = this.getFinalTerrainHeight(
            worldX,
            worldZ,
            biome
          );

          const riverNoise = this.riverGenerator.getRiverNoise(worldX, worldZ);
          if (
            this.riverGenerator.isRiver(
              worldX,
              worldZ,
              riverNoise,
              terrainHeight
            )
          )
            continue;

          const topBlockId = this.getBlockTypeAtWorldCoord(
            worldX,
            terrainHeight,
            worldZ,
            biome
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

  private generateStructures(
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
    this.tryPlacingTower(chunkX, chunkY, chunkZ, biome, placeBlock);
    this.tryPlacingStructure(chunkX, chunkY, chunkZ, biome, placeBlock);
    this.tryPlacingLavaPool(chunkX, chunkY, chunkZ, placeBlock);
  }

  private tryPlacingTower(
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

        const originalHeight = this.getFinalTerrainHeight(
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

        const height = this.getFinalTerrainHeight(worldX, worldZ, biome);
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
    biome: Biome,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean
    ) => void
  ) {
    if (this.structures.size === 0) return;

    const REGION_SIZE = 16; // in chunks
    const SPAWN_CHANCE = 10; // % chance per region

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

      const groundHeight = this.getFinalTerrainHeight(
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

  private getFinalTerrainHeight(
    worldX: number,
    worldZ: number,
    biome: Biome
  ): number {
    return TerrainHeightMap.getFinalTerrainHeight(worldX, worldZ, biome);
  }

  private isBeachLocation(
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
      this.isNearWater(worldX + 1, worldZ, biome) ||
      this.isNearWater(worldX - 1, worldZ, biome) ||
      this.isNearWater(worldX, worldZ + 1, biome) ||
      this.isNearWater(worldX, worldZ - 1, biome);

    return isAdjacentToWater;
  }

  /**
   * Checks if a given coordinate is at or below sea level.
   */
  private isNearWater(x: number, z: number, biome: Biome): boolean {
    const terrainHeight = TerrainHeightMap.getFinalTerrainHeight(x, z, biome);
    return terrainHeight <= this.params.SEA_LEVEL;
  }

  /**
   * Deterministically gets the block type at a given world coordinate,
   * by re-evaluating the terrain generation logic for that specific point.
   */
  private getBlockTypeAtWorldCoord(
    worldX: number,
    worldY: number,
    worldZ: number,
    biome: Biome
  ): number {
    const { SEA_LEVEL } = this.params;
    const terrainHeight = this.getFinalTerrainHeight(worldX, worldZ, biome);

    if (worldY > terrainHeight) {
      // Above terrain, check for water
      return worldY <= SEA_LEVEL ? 30 : 0; // Water or Air
    } else if (worldY === terrainHeight) {
      // This logic should mirror generateTerrain to be accurate
      const isBeach = this.isBeachLocation(
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

  /**
   * Loads hardcoded structures for testing purposes.
   * In a production environment, this would typically load from external files.
   */
  private loadStructures() {
    const opulentHouseData: StructureData = {
      name: "Opulent House",
      width: 5,
      height: 4,
      depth: 5,
      palette: {
        "0": 0, // air
        "1": 43, // Marble
        "2": 41, // Gold Block
        "3": 19, // glass
        "4": 42, // Lapis Block
      },
      blocks: [
        // Layer Y=0 (Foundation: Solid Marble)
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        1,
        // Layer Y=1 (Walls: Marble with Gold corners, Gold floor)
        2, 1, 1, 1, 2, 1, 2, 2, 2, 1, 1, 2, 0, 2, 1, 1, 2, 2, 2, 1, 2, 1, 1, 1,
        2,
        // Layer Y=2 (Windows: Marble walls, Gold pillars, Glass)
        2, 1, 1, 1, 2, 1, 3, 0, 3, 1, 1, 0, 0, 0, 1, 1, 3, 0, 3, 1, 2, 1, 1, 1,
        2,

        // Layer Y=3 (Roof: Lapis Lazuli with Marble trim)
        1, 4, 4, 4, 1, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 1, 4, 4, 4,
        1,
      ],
    };

    this.structures.set("Opulent House", new Structure(opulentHouseData));
    console.log(`Loaded hardcoded structure: ${opulentHouseData.name}`);
  }
}
