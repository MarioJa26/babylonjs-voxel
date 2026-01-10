import { createNoise2D } from "simplex-noise";
import { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { Biome } from "./Biome/Biomes";
import { TerrainHeightMap } from "./TerrainHeightMap";
import { Squirrel3 } from "./NoiseAndParameters/Squirrel13";
import { Structure, StructureData } from "./Structure";
import { RiverGenerator } from "./RiverGeneration";

// --- OTG-Style Feature System ---

export interface IWorldFeature {
  generate(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    _chunkBiome: Biome,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean
    ) => void,
    seed: number,
    chunkSize: number,
    getTerrainHeight: (x: number, z: number, biome: Biome) => number
  ): void;
}

export class TowerFeature implements IWorldFeature {
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
      ow: boolean
    ) => void,
    seed: number,
    chunkSize: number,
    getTerrainHeight: (x: number, z: number, biome: Biome) => number
  ) {
    const TOWER_REGION_SIZE = 16; // in chunks
    const TOWER_SPAWN_CHANCE = 100; // out of 100

    const regionX = Math.floor(chunkX / TOWER_REGION_SIZE);
    const regionZ = Math.floor(chunkZ / TOWER_REGION_SIZE);

    const regionHash = Squirrel3.get(
      regionX * 374761393 + regionZ * 678446653,
      seed
    );

    if (Math.abs(regionHash) % 100 < TOWER_SPAWN_CHANCE) {
      const offsetX =
        Math.abs(Squirrel3.get(regionHash, seed)) %
        (TOWER_REGION_SIZE * chunkSize);
      const offsetZ =
        Math.abs(Squirrel3.get(regionHash + 1, seed)) %
        (TOWER_REGION_SIZE * chunkSize);

      const towerCenterX = regionX * TOWER_REGION_SIZE * chunkSize + offsetX;
      const towerCenterZ = regionZ * TOWER_REGION_SIZE * chunkSize + offsetZ;

      const axisCorridorWidth = 20;
      if (
        Math.abs(towerCenterX) < axisCorridorWidth ||
        Math.abs(towerCenterZ) < axisCorridorWidth
      ) {
        return;
      }

      const towerRadius = 8 + (Squirrel3.get(towerCenterX, seed) % 4);
      const groundHeight = this.findMinGroundHeightForTower(
        towerCenterX,
        towerCenterZ,
        towerRadius,
        biome,
        getTerrainHeight
      );

      this.generateCylinderTower(
        chunkX,
        chunkY,
        chunkZ,
        towerCenterX,
        towerCenterZ,
        towerRadius,
        groundHeight,
        biome,
        placeBlock,
        chunkSize,
        seed,
        getTerrainHeight
      );
      this.generateUndergroundCylinderTower(
        chunkX,
        chunkY,
        chunkZ,
        towerCenterX,
        towerCenterZ,
        towerRadius,
        groundHeight,
        placeBlock,
        chunkSize
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
    ) => void,
    chunkSize: number,
    seed: number,
    getTerrainHeight: (x: number, z: number, biome: Biome) => number
  ) {
    const towerHeight = 76 + (Squirrel3.get(towerCenterZ, seed) % 8);
    const wallBlockId = 1;
    const radiusSq = towerRadius * towerRadius;

    for (let dx = -towerRadius; dx <= towerRadius; dx++) {
      for (let dz = -towerRadius; dz <= towerRadius; dz++) {
        if (dx * dx + dz * dz > radiusSq) continue;

        const worldX = towerCenterX + dx;
        const worldZ = towerCenterZ + dz;

        const originalHeight = getTerrainHeight(worldX, worldZ, biome);
        for (let y = originalHeight; y < groundHeight; y++) {
          placeBlock(worldX, y, worldZ, biome.undergroundBlock, true);
        }
      }
    }

    for (let localY = 0; localY < chunkSize; localY++) {
      const worldY = chunkY * chunkSize + localY;
      if (worldY < groundHeight || worldY >= groundHeight + towerHeight) {
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
    ) => void,
    chunkSize: number
  ) {
    const wallBlockId = 26;
    const MIN_WORLD_Y = -16 * 100;
    const radiusSq = towerRadius * towerRadius;

    for (let localY = 0; localY < chunkSize; localY++) {
      const worldY = chunkY * chunkSize + localY;
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
    biome: Biome,
    getTerrainHeight: (x: number, z: number, biome: Biome) => number
  ): number {
    let minGroundHeight = Infinity;
    const radiusSq = towerRadius * towerRadius;

    for (let dx = -towerRadius; dx <= towerRadius; dx++) {
      for (let dz = -towerRadius; dz <= towerRadius; dz++) {
        if (dx * dx + dz * dz > radiusSq) continue;
        const worldX = towerCenterX + dx;
        const worldZ = towerCenterZ + dz;
        const height = getTerrainHeight(worldX, worldZ, biome);
        if (height < minGroundHeight) {
          minGroundHeight = height;
        }
      }
    }
    return minGroundHeight;
  }
}

export class LavaPoolFeature implements IWorldFeature {
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
      ow: boolean
    ) => void,
    seed: number,
    chunkSize: number
  ) {
    const POOL_REGION_SIZE = 9;
    const POOL_SPAWN_CHANCE = 100;

    const regionX = Math.floor(chunkX / POOL_REGION_SIZE);
    const regionZ = Math.floor(chunkZ / POOL_REGION_SIZE);

    const regionHash = Squirrel3.get(
      regionX * 873461393 + regionZ * 178246653,
      seed
    );

    if (Math.abs(regionHash) % 100 < POOL_SPAWN_CHANCE) {
      const baseHash = Squirrel3.get(regionHash, seed);
      const offsetX =
        Math.abs(Squirrel3.get(baseHash, seed)) %
        (POOL_REGION_SIZE * chunkSize);
      const offsetZ =
        Math.abs(Squirrel3.get(baseHash + 1, seed)) %
        (POOL_REGION_SIZE * chunkSize);
      const offsetY =
        -64 - (Math.abs(Squirrel3.get(baseHash + 2, seed)) % (1024 - 64));

      const poolCenterX = regionX * POOL_REGION_SIZE * chunkSize + offsetX;
      const poolSurfaceY = offsetY;
      const poolCenterZ = regionZ * POOL_REGION_SIZE * chunkSize + offsetZ;

      this.generateLavaPool(
        chunkX,
        chunkY,
        chunkZ,
        poolCenterX,
        poolSurfaceY,
        poolCenterZ,
        placeBlock,
        seed
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
    ) => void,
    seed: number
  ) {
    const poolRadius = 25 + (Squirrel3.get(poolCenterX, seed) % 5);
    const maxDepth = 15 + (Squirrel3.get(poolCenterZ, seed) % 3);
    const radiusSq = poolRadius * poolRadius;
    const lavaBlockId = 24;
    const shoreBlockId = 25;

    const shellRadius = poolRadius + 1;
    const shellRadiusSq = shellRadius * shellRadius;
    for (let dx = -shellRadius; dx <= shellRadius; dx++) {
      for (let dz = -shellRadius; dz <= shellRadius; dz++) {
        const distSq = dx * dx + dz * dz;
        if (distSq >= shellRadiusSq) continue;

        const worldX = poolCenterX + dx;
        const worldZ = poolCenterZ + dz;
        const depthFactor = Math.sqrt(distSq) / shellRadius;
        const depth = Math.floor((maxDepth + 1) * (1 - depthFactor));
        const floorY = poolCenterY - depth;

        for (let y = floorY; y <= poolCenterY; y++) {
          placeBlock(worldX, y, worldZ, shoreBlockId, true);
        }
      }
    }

    for (let dx = -poolRadius; dx <= poolRadius; dx++) {
      for (let dz = -poolRadius; dz <= poolRadius; dz++) {
        const distSq = dx * dx + dz * dz;
        if (distSq >= radiusSq) continue;

        const depth = Math.floor(maxDepth * (1 - distSq / radiusSq));
        const floorY = poolCenterY - depth;
        for (let y = floorY; y <= poolCenterY; y++) {
          placeBlock(poolCenterX + dx, y, poolCenterZ + dz, lavaBlockId, true);
        }
      }
    }
  }
}

export class StructureSpawnerFeature implements IWorldFeature {
  private structures: Map<string, Structure>;

  constructor(structures: Map<string, Structure>) {
    this.structures = structures;
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
      ow: boolean
    ) => void,
    seed: number,
    chunkSize: number,
    getTerrainHeight: (x: number, z: number, biome: Biome) => number
  ) {
    if (this.structures.size === 0) return;

    const REGION_SIZE = 16;
    const SPAWN_CHANCE = 10;

    const regionX = Math.floor(chunkX / REGION_SIZE);
    const regionZ = Math.floor(chunkZ / REGION_SIZE);

    const regionHash = Squirrel3.get(
      regionX * 584661329 + regionZ * 957346603,
      seed
    );

    if (Math.abs(regionHash) % 100 < SPAWN_CHANCE) {
      const structureNames = Array.from(this.structures.keys());
      const structureName =
        structureNames[Math.abs(regionHash) % structureNames.length];
      const structure = this.structures.get(structureName);

      if (!structure) return;

      const offsetX =
        Math.abs(Squirrel3.get(regionHash, seed)) % (REGION_SIZE * chunkSize);
      const offsetZ =
        Math.abs(Squirrel3.get(regionHash + 1, seed)) %
        (REGION_SIZE * chunkSize);

      const structureOriginX = regionX * REGION_SIZE * chunkSize + offsetX;
      const structureOriginZ = regionZ * REGION_SIZE * chunkSize + offsetZ;

      const groundHeight = getTerrainHeight(
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
}

// --- End Feature System ---

export class SurfaceGenerator {
  private params: GenerationParamsType;
  private treeNoise: ReturnType<typeof createNoise2D>;
  private seedAsInt: number;
  private structures: Map<string, Structure> = new Map();
  private chunk_size: number;
  private riverGenerator: RiverGenerator;
  private features: IWorldFeature[];

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

    // Initialize features (OTG style: list of active resources)
    this.features = [
      new TowerFeature(),
      new LavaPoolFeature(),
      new StructureSpawnerFeature(this.structures),
    ];
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

        const biome = TerrainHeightMap.getBiome(worldX, worldZ);
        // Pass undefined for biome to allow parameter blending/smoothing
        const terrainHeight = this.getFinalTerrainHeight(worldX, worldZ);
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
    // Iterate through all registered features (OTG style)
    for (const feature of this.features) {
      feature.generate(
        chunkX,
        chunkY,
        chunkZ,
        biome,
        placeBlock,
        this.seedAsInt,
        this.chunk_size,
        this.getFinalTerrainHeight.bind(this)
      );
    }
  }

  private getFinalTerrainHeight(
    worldX: number,
    worldZ: number,
    biome?: Biome
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
    const terrainHeight = this.getFinalTerrainHeight(worldX, worldZ);

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
