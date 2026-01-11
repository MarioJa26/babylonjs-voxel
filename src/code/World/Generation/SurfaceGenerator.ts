import { createNoise2D } from "simplex-noise";
import { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { Biome } from "./Biome/Biomes";
import { TerrainHeightMap } from "./TerrainHeightMap";
import { RiverGenerator } from "./RiverGeneration";
import { IWorldFeature } from "./Structure/IWorldFeature";
import { StructureSpawnerFeature } from "./Structure/StructureFeature";
import { LavaPoolFeature } from "./Structure/LavaPoolFeature";
import { TowerFeature } from "./Structure/TowerFeature";

export class SurfaceGenerator {
  private params: GenerationParamsType;
  private treeNoise: ReturnType<typeof createNoise2D>;
  private seedAsInt: number;
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

    // Initialize features (OTG style: list of active resources)
    this.features = [
      new TowerFeature(),
      new LavaPoolFeature(),
      new StructureSpawnerFeature(),
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
}
