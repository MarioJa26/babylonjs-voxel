import {
  GenerationParams,
  GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
import { TerrainHeightMap } from "./TerrainHeightMap";
import { RiverGenerator } from "./RiverGeneration";
import { IWorldFeature } from "./Structure/IWorldFeature";
import { StructureSpawnerFeature } from "./Structure/StructureFeature";
import { LavaPoolFeature } from "./Structure/LavaPoolFeature";
import { TowerFeature } from "./Structure/TowerFeature";
import { DungeonFeature } from "./Structure/DungeonFeature";
import { Biome } from "./Biome/BiomeTypes";

export class SurfaceGenerator {
  private params: GenerationParamsType;
  private treeNoise: (x: number, z: number) => number;
  private densityNoise: (x: number, y: number, z: number) => number;
  private static readonly DENSITY_BASE_AMPLITUDE = 32;
  private static readonly DENSITY_OVERHANG_AMPLITUDE = 32;
  private static readonly DENSITY_CLIFF_AMPLITUDE = 16;
  private static readonly DENSITY_INFLUENCE_RANGE = 48;
  private seedAsInt: number;
  private chunk_size: number;
  private riverGenerator: RiverGenerator;
  private features: IWorldFeature[];

  constructor(
    params: GenerationParamsType,
    treeNoise: (x: number, z: number) => number,
    densityNoise: (x: number, y: number, z: number) => number,
    seedAsInt: number,
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
      new DungeonFeature(),
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
      ow?: boolean,
    ) => void,
  ) {
    this.generateTerrain(chunkX, chunkY, chunkZ, biome, placeBlock);
    this.generateFlora(chunkX, chunkY, chunkZ, biome, placeBlock);
    this.generateStructures(chunkX, chunkY, chunkZ, biome, placeBlock);
  }

  private generateTerrain(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    _currentBiome: Biome,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean,
    ) => void,
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

          let isTunnel = this.riverGenerator.isRiver(
            worldX,
            worldY,
            worldZ,
            riverNoise,
          );
          isTunnel = false;

          const density = this.getDensity(
            worldX,
            worldY,
            worldZ,
            terrainHeight,
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
            // Air / liquids:
            // - keep sea-level filling near the surface
            // - below y=0, keep a stone baseline so underground chunks don't turn into vast empty space
            if (worldY <= SEA_LEVEL) {
              if (worldY >= 0) {
                const liquidId = biome.name === "Volcanic_Wasteland" ? 24 : 30; // 24 = Lava, 30 = Water
                placeBlock(worldX, worldY, worldZ, liquidId, false);
              } else {
                placeBlock(worldX, worldY, worldZ, 29, false);
              }
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
    _biome: Biome,
    placeBlock: (x: number, y: number, z: number, id: number) => void,
  ) {
    // Scan a fixed radius outside the chunk to catch trees from neighbors.
    // 8 blocks is usually enough for standard tree canopies.
    const SCAN_RADIUS = 8;

    for (
      let localX = -SCAN_RADIUS;
      localX < this.chunk_size + SCAN_RADIUS;
      localX++
    ) {
      const worldX = chunkX * this.chunk_size + localX;
      for (
        let localZ = -SCAN_RADIUS;
        localZ < this.chunk_size + SCAN_RADIUS;
        localZ++
      ) {
        const worldZ = chunkZ * this.chunk_size + localZ;

        // Get the biome for this specific column.
        // This ensures that if we are in a Desert chunk but scanning the margin of a Forest neighbor,
        // we correctly identify it as Forest and spawn the tree.
        const colBiome = TerrainHeightMap.getBiome(worldX, worldZ);

        if (!colBiome.canSpawnTrees) continue;

        // Use noise for tree placement. The value is in [-1, 1], so we map it to [0, 1].
        const treeNoiseValue = (this.treeNoise(worldX, worldZ) + 1) / 2;
        if (treeNoiseValue > colBiome.treeDensity) continue;

        const baseHeight = this.getFinalTerrainHeight(worldX, worldZ);

        // Find the actual surface height using density
        let surfaceY = -Infinity;
        // Scan range around base height. 3D noise amplitude is approx +/- 8.
        for (let y = baseHeight + 16; y >= baseHeight - 16; y--) {
          const density = this.getDensity(worldX, y, worldZ, baseHeight);
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
        const topBlockId = isBeach ? colBiome.beachBlock : colBiome.topBlock;

        // Ask the biome for a tree definition for the block we're on
        colBiome
          .getTreeForBlock(topBlockId)
          ?.generate(worldX, surfaceY + 1, worldZ, placeBlock, this.seedAsInt);
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
      ow: boolean,
    ) => void,
  ) {
    // To handle structures that span across chunk boundaries without breaking,
    // we must check neighbor chunks to see if a structure starts there and overlaps into this chunk.
    const STRUCTURE_SEARCH_RADIUS = 2; // Check 2 chunk radius (5x5 area) to catch larger structures.

    for (
      let cx = chunkX - STRUCTURE_SEARCH_RADIUS;
      cx <= chunkX + STRUCTURE_SEARCH_RADIUS;
      cx++
    ) {
      for (
        let cz = chunkZ - STRUCTURE_SEARCH_RADIUS;
        cz <= chunkZ + STRUCTURE_SEARCH_RADIUS;
        cz++
      ) {
        // Determine the biome at the origin of the potential structure
        const originWorldX = cx * this.chunk_size + this.chunk_size / 2;
        const originWorldZ = cz * this.chunk_size + this.chunk_size / 2;

        // Optimization: Lazy load the biome using a Proxy.
        // This avoids expensive noise calculations if the feature decides not to spawn (e.g. due to random chance) before checking the biome.
        let cachedBiome: Biome | null = null;
        const originBiome = new Proxy({} as Biome, {
          get: (_target, prop) => {
            if (!cachedBiome) {
              cachedBiome = TerrainHeightMap.getBiome(
                originWorldX,
                originWorldZ,
              );
            }
            const value = cachedBiome[prop as keyof Biome];
            return typeof value === "function"
              ? value.bind(cachedBiome)
              : value;
          },
        });

        for (const feature of this.features) {
          feature.generate(
            cx,
            chunkY,
            cz,
            originBiome,
            placeBlock,
            this.seedAsInt,
            this.chunk_size,
            this.getFinalTerrainHeight.bind(this),
            chunkX,
            chunkZ,
          );
        }
      }
    }
  }

  private getFinalTerrainHeight(worldX: number, worldZ: number): number {
    return TerrainHeightMap.getFinalTerrainHeight(worldX, worldZ);
  }

  private isBeachLocation(
    worldX: number,
    worldZ: number,
    terrainHeight: number,
  ): boolean {
    const { SEA_LEVEL } = this.params;

    if (!(terrainHeight >= SEA_LEVEL - 2 && terrainHeight <= SEA_LEVEL + 2)) {
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
    //biome: Biome,
  ): number {
    const relativeHeight = baseHeight - y;
    // Skip far from transition band to keep generation fast.
    if (relativeHeight > SurfaceGenerator.DENSITY_INFLUENCE_RANGE) {
      return relativeHeight;
    }
    if (relativeHeight < -SurfaceGenerator.DENSITY_INFLUENCE_RANGE) {
      return relativeHeight;
    }

    // Base shaping component.
    const baseNoise = this.densityNoise(x * 0.01, y * 0.02, z * 0.02);
    // Y-skewed sample creates shelves and overhang-like lateral drift.
    const overhangNoise = this.densityNoise(
      (x + y * 0.55) * 0.008,
      y * 0.012,
      (z - y * 0.45) * 0.008,
    );
    // Low-frequency component reinforces cliff bands.
    const cliffNoise = this.densityNoise(x * 0.0035, y * 0.004, z * 0.0035);

    return (
      relativeHeight +
      baseNoise * SurfaceGenerator.DENSITY_BASE_AMPLITUDE +
      overhangNoise * SurfaceGenerator.DENSITY_OVERHANG_AMPLITUDE +
      cliffNoise * SurfaceGenerator.DENSITY_CLIFF_AMPLITUDE
    );
  }
}
