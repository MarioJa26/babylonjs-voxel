import { createNoise2D, createNoise3D } from "simplex-noise";
import {
  GenerationParams,
  GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
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
  private densityNoise: ReturnType<typeof createNoise3D>;
  private seedAsInt: number;
  private chunk_size: number;
  private riverGenerator: RiverGenerator;
  private features: IWorldFeature[];

  constructor(
    params: GenerationParamsType,
    treeNoise: ReturnType<typeof createNoise2D>,
    densityNoise: ReturnType<typeof createNoise3D>,
    seedAsInt: number
  ) {
    this.params = params;
    this.treeNoise = treeNoise;
    this.densityNoise = densityNoise;
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
        const tunnelHeight = GenerationParams.SEA_LEVEL;

        // Iterate through the Y column for this chunk
        for (let localY = 0; localY < CHUNK_SIZE; localY++) {
          const worldY = chunkY * CHUNK_SIZE + localY;

          const isTunnel = this.riverGenerator.isRiver(
            worldX,
            worldY,
            worldZ,
            riverNoise
          );

          const density = this.getDensity(
            worldX,
            worldY,
            worldZ,
            terrainHeight,
            biome
          );

          if (isTunnel) {
            if (worldY <= tunnelHeight) {
              placeBlock(worldX, worldY, worldZ, 30, true); // Water
            } else {
              placeBlock(worldX, worldY, worldZ, 0, true); // Air
            }
            continue;
          }

          if (density > 0) {
            // It's a solid cell, place the appropriate terrain block
            // Check the density of the block above to decide if this is a surface block
            const densityAbove = this.getDensity(
              worldX,
              worldY + 1,
              worldZ,
              terrainHeight,
              biome
            );

            let blockId = 29; // Use block 29 for all underground stone

            if (densityAbove <= 0) {
              // This is the surface layer
              const isBeach = this.isBeachLocation(worldX, worldZ, worldY);
              if (worldY < SEA_LEVEL - 1) {
                blockId = biome.seafloorBlock;
              } else if (isBeach) {
                blockId = biome.beachBlock;
              } else {
                blockId = biome.topBlock;
              }
            } else if (densityAbove < 6) {
              // Just below surface
              blockId = biome.undergroundBlock;
            } else {
              // Deep underground
              if (worldY > 0) {
                blockId = 1;
              }
            }
            placeBlock(worldX, worldY, worldZ, blockId, true);
          } else {
            // Air or Water
            if (worldY <= SEA_LEVEL) {
              placeBlock(worldX, worldY, worldZ, 30, false); // water
            }
          }
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
          const colBiome = TerrainHeightMap.getBiome(worldX, worldZ);
          const baseHeight = this.getFinalTerrainHeight(worldX, worldZ);

          let scanHeight = baseHeight;
          if (colBiome.name === "Floating_Islands") {
            scanHeight += 128;
          }

          // Find the actual surface height using density
          let surfaceY = -Infinity;
          // Scan range around base height. 3D noise amplitude is approx +/- 8.
          for (let y = scanHeight + 16; y >= scanHeight - 16; y--) {
            const density = this.getDensity(
              worldX,
              y,
              worldZ,
              baseHeight,
              colBiome
            );
            if (density > 0) {
              surfaceY = y;
              break;
            }
          }

          if (surfaceY === -Infinity) continue;

          const riverNoise = this.riverGenerator.getRiverNoise(worldX, worldZ);
          if (this.riverGenerator.isRiver(worldX, surfaceY, worldZ, riverNoise))
            continue;

          // Don't place trees underwater
          if (surfaceY < this.params.SEA_LEVEL) continue;

          const isBeach = this.isBeachLocation(worldX, worldZ, surfaceY);
          const topBlockId = isBeach ? biome.beachBlock : biome.topBlock;

          // Ask the biome for a tree definition for the block we're on
          biome
            .getTreeForBlock(topBlockId)
            ?.generate(
              worldX,
              surfaceY + 1,
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

  private getFinalTerrainHeight(worldX: number, worldZ: number): number {
    return TerrainHeightMap.getFinalTerrainHeight(worldX, worldZ);
  }

  private isBeachLocation(
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
      this.isNearWater(worldX + 1, worldZ) ||
      this.isNearWater(worldX - 1, worldZ) ||
      this.isNearWater(worldX, worldZ + 1) ||
      this.isNearWater(worldX, worldZ - 1);

    return isAdjacentToWater;
  }

  /**
   * Checks if a given coordinate is at or below sea level.
   */
  private isNearWater(x: number, z: number): boolean {
    const terrainHeight = TerrainHeightMap.getFinalTerrainHeight(x, z);
    return terrainHeight <= this.params.SEA_LEVEL;
  }

  private getDensity(
    x: number,
    y: number,
    z: number,
    baseHeight: number,
    biome: Biome
  ): number {
    if (biome.name === "Floating_Islands") {
      // 1. Floating islands logic: Create blobs around the base height
      const islandOffset = 60;
      const islandBaseHeight = baseHeight + islandOffset;

      let islandDensity = -100;
      if (Math.abs(islandBaseHeight - y) < 50) {
        const noise = this.densityNoise(x * 0.02, y * 0.05, z * 0.02);
        islandDensity = noise * 30 - Math.abs(islandBaseHeight - y) * 0.8;
      }

      // 2. Floor logic: Ensure there is terrain below (e.g. ocean floor)
      const floorHeight = this.params.SEA_LEVEL - 15;
      const floorNoise = this.densityNoise(x * 0.04, y * 0.04, z * 0.04);
      const floorDensity = floorHeight - y + floorNoise * 8;

      return Math.max(islandDensity, floorDensity);
    }

    const relativeHeight = baseHeight - y;
    // Optimization: Skip noise calculation if far from the surface approximation.
    // The noise amplitude is 8.
    // We use a margin of 16 to be safe for both:
    // 1. Determining solid vs air (threshold 0) -> margin 8 is enough.
    // 2. Determining block type (threshold 6 for dirt depth) -> margin 14 is needed (6 + 8).
    if (relativeHeight > 16) return relativeHeight;
    if (relativeHeight < -16) return relativeHeight;

    // 3D noise for density.
    // Scale controls the size of the features (caves/overhangs).
    const noise = this.densityNoise(x * 0.04, y * 0.04, z * 0.04);
    // (baseHeight - y) creates the ground. Adding noise distorts it.
    return relativeHeight + noise * 8;
  }
}
