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

export type SurfaceGenerationResult = {
  topSunlightMask: Uint8Array;
  topSurfaceYMap: Int16Array;
};

export class SurfaceGenerator {
  private params: GenerationParamsType;
  private static treeNoise: (x: number, z: number) => number;
  private static densityNoise: (x: number, y: number, z: number) => number;
  private static readonly DENSITY_BASE_AMPLITUDE = 32;
  private static readonly DENSITY_OVERHANG_AMPLITUDE = 32;
  private static readonly DENSITY_CLIFF_AMPLITUDE = 32;
  private static readonly DENSITY_INFLUENCE_RANGE = 32;
  private static readonly DENSITY_VERTICAL_SCAN_RANGE =
    SurfaceGenerator.DENSITY_INFLUENCE_RANGE +
    SurfaceGenerator.DENSITY_BASE_AMPLITUDE +
    SurfaceGenerator.DENSITY_OVERHANG_AMPLITUDE +
    SurfaceGenerator.DENSITY_CLIFF_AMPLITUDE;
  private static readonly SUBSURFACE_LAYER_DEPTH = 5;
  private static readonly SURFACE_RESET_AIR_GAP = 6;
  private static readonly NO_SURFACE_Y = -32768;
  private static seedAsInt: number;
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
    SurfaceGenerator.treeNoise = treeNoise;
    SurfaceGenerator.densityNoise = densityNoise;
    SurfaceGenerator.seedAsInt = seedAsInt;
    this.chunk_size = this.params.CHUNK_SIZE;
    this.riverGenerator = new RiverGenerator(params);

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
  ): SurfaceGenerationResult {
    const generationResult = this.generateTerrain(
      chunkX,
      chunkY,
      chunkZ,
      biome,
      placeBlock,
    );
    this.generateFlora(
      chunkX,
      chunkY,
      chunkZ,
      biome,
      placeBlock,
      generationResult.topSurfaceYMap,
    );
    this.generateStructures(chunkX, chunkY, chunkZ, biome, placeBlock);
    return generationResult;
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
  ): SurfaceGenerationResult {
    const { CHUNK_SIZE, SEA_LEVEL } = this.params;
    const chunkWorldX = chunkX * CHUNK_SIZE;
    const chunkWorldZ = chunkZ * CHUNK_SIZE;
    const topWorldY = chunkY * CHUNK_SIZE + CHUNK_SIZE - 1;
    const topSunlightMask = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    const topSurfaceYMap = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
    topSurfaceYMap.fill(SurfaceGenerator.NO_SURFACE_Y);

    let isTunnel = false;

    for (let localX = 0; localX < CHUNK_SIZE; localX++) {
      const worldX = chunkWorldX + localX;
      for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
        const worldZ = chunkWorldZ + localZ;

        // OPTIMIZATION: getTerrainSample() returns height + biome + riverNoise in one cache hit.
        // Previously, getFinalTerrainHeight() and getRiverNoise() each ran the full noise stack.
        const sample = TerrainHeightMap.getTerrainSample(worldX, worldZ);
        const terrainHeight = sample.height;
        // Reuse the cached river noise — no second noise evaluation.
        const riverNoise = sample.riverNoise;

        const columnIndex = localX + localZ * CHUNK_SIZE;
        const topSurfaceY = this.findTopSurfaceY(worldX, worldZ, terrainHeight);
        const hasSurface = Number.isFinite(topSurfaceY);
        const columnTopSurfaceY = hasSurface
          ? (topSurfaceY as number)
          : SurfaceGenerator.NO_SURFACE_Y;

        if (hasSurface) {
          topSurfaceYMap[columnIndex] = topSurfaceY as number;
        }
        topSunlightMask[columnIndex] =
          !hasSurface || topSurfaceY <= topWorldY ? 1 : 0;

        const tunnelHeight = GenerationParams.SEA_LEVEL;
        let depthAnchorY = columnTopSurfaceY;

        // Check the block just above this chunk for continuity
        const densityAboveChunk = this.getDensity(
          worldX,
          topWorldY + 1,
          worldZ,
          terrainHeight,
        );
        const isTunnelAboveChunk = this.riverGenerator.isRiver(
          worldX,
          topWorldY + 1,
          worldZ,
          riverNoise,
        );
        let airGapSinceLastSolid =
          !isTunnelAboveChunk && densityAboveChunk > 0 ? 0 : 1;

        // Iterate Y column top-to-bottom within this chunk
        for (let localY = CHUNK_SIZE - 1; localY >= 0; localY--) {
          const worldY = chunkY * CHUNK_SIZE + localY;

          // River check reuses the already-fetched riverNoise — no extra noise call.
          if (worldY < GenerationParams.SEA_LEVEL + 16) {
            isTunnel = this.riverGenerator.isRiver(
              worldX,
              worldY,
              worldZ,
              riverNoise,
            );
            if (isTunnel) {
              if (worldY <= tunnelHeight) {
                placeBlock(worldX, worldY, worldZ, 30, true); // Water
              } else {
                placeBlock(worldX, worldY, worldZ, 0, true); // Air
              }
              airGapSinceLastSolid++;
              continue;
            }
          }
          const density = this.getDensity(
            worldX,
            worldY,
            worldZ,
            terrainHeight,
          );

          if (density > 0) {
            if (
              airGapSinceLastSolid >= SurfaceGenerator.SURFACE_RESET_AIR_GAP
            ) {
              depthAnchorY = worldY;
            }
            const depthBelowSurface =
              depthAnchorY !== SurfaceGenerator.NO_SURFACE_Y
                ? depthAnchorY - worldY
                : Number.POSITIVE_INFINITY;

            let blockId = _currentBiome.stoneBlock;

            if (depthBelowSurface === 0) {
              const isBeach = this.isBeachLocation(worldX, worldZ, worldY);
              if (worldY < SEA_LEVEL - 1) {
                blockId = _currentBiome.seafloorBlock;
              } else if (isBeach) {
                blockId = _currentBiome.beachBlock;
              } else {
                blockId = _currentBiome.topBlock;
              }
            } else if (
              depthBelowSurface > 0 &&
              depthBelowSurface <= SurfaceGenerator.SUBSURFACE_LAYER_DEPTH
            ) {
              blockId = _currentBiome.undergroundBlock;
            }
            placeBlock(worldX, worldY, worldZ, blockId, true);
            airGapSinceLastSolid = 0;
          } else {
            if (worldY <= SEA_LEVEL) {
              if (worldY >= 0) {
                const liquidId =
                  _currentBiome.name === "Volcanic_Wasteland" ? 24 : 30;
                placeBlock(worldX, worldY, worldZ, liquidId, false);
              } else {
                placeBlock(worldX, worldY, worldZ, 29, false);
              }
            }
            airGapSinceLastSolid++;
          }
        }
      }
    }

    return { topSunlightMask, topSurfaceYMap };
  }

  private generateFlora(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    _biome: Biome,
    placeBlock: (x: number, y: number, z: number, id: number) => void,
    topSurfaceYMap: Int16Array,
  ) {
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

        // OPTIMIZATION: getTerrainSample() gives us biome, height, and riverNoise
        // all in one cache lookup — previously this called getBiome() + getFinalTerrainHeight()
        // + getRiverNoise() separately, each re-running the same noise functions.
        const sample = TerrainHeightMap.getTerrainSample(worldX, worldZ);
        const colBiome = sample.biome;

        if (!colBiome.canSpawnTrees) continue;

        const treeNoiseValue =
          (SurfaceGenerator.treeNoise(worldX, worldZ) + 1) / 2;
        if (treeNoiseValue > colBiome.treeDensity) continue;

        let surfaceY = SurfaceGenerator.NO_SURFACE_Y;
        const isInsideChunkColumn =
          localX >= 0 &&
          localX < this.chunk_size &&
          localZ >= 0 &&
          localZ < this.chunk_size;

        if (isInsideChunkColumn) {
          surfaceY = topSurfaceYMap[localX + localZ * this.chunk_size];
        } else {
          // OPTIMIZATION: reuse sample.height instead of calling getFinalTerrainHeight() again.
          const sampledSurfaceY = this.findTopSurfaceY(
            worldX,
            worldZ,
            sample.height,
          );
          if (Number.isFinite(sampledSurfaceY)) {
            surfaceY = sampledSurfaceY as number;
          }
        }

        if (surfaceY === SurfaceGenerator.NO_SURFACE_Y) continue;

        // OPTIMIZATION: reuse cached river noise — no extra noise evaluation.
        const riverNoise = sample.riverNoise;
        if (this.riverGenerator.isRiver(worldX, surfaceY, worldZ, riverNoise))
          continue;

        if (surfaceY < this.params.SEA_LEVEL) continue;

        const isBeach = this.isBeachLocation(worldX, worldZ, surfaceY);
        const topBlockId = isBeach ? colBiome.beachBlock : colBiome.topBlock;

        colBiome
          .getTreeForBlock(topBlockId)
          ?.generate(
            worldX,
            surfaceY + 1,
            worldZ,
            placeBlock,
            SurfaceGenerator.seedAsInt,
          );
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
    const STRUCTURE_SEARCH_RADIUS = 2;

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
        for (const feature of this.features) {
          feature.generate(
            cx,
            chunkY,
            cz,
            biome,
            placeBlock,
            SurfaceGenerator.seedAsInt,
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

  private isNearWater(x: number, z: number): boolean {
    return (
      TerrainHeightMap.getFinalTerrainHeight(x, z) <= this.params.SEA_LEVEL
    );
  }

  private getDensity(
    x: number,
    y: number,
    z: number,
    baseHeight: number,
  ): number {
    const relativeHeight = baseHeight - y;
    if (relativeHeight > SurfaceGenerator.DENSITY_INFLUENCE_RANGE) {
      return relativeHeight;
    }
    if (relativeHeight < -SurfaceGenerator.DENSITY_INFLUENCE_RANGE) {
      return relativeHeight;
    }

    // OPTIMIZATION NOTE: These 3 noise calls remain because they are 3D density noise
    // (different from the 2D terrain noise). They are already relatively cheap (FastNoise).
    // The cliff noise uses very low frequency — if you need more perf, you could
    // sample it on a coarser grid (e.g., every 4 blocks) and trilinearly interpolate,
    // similar to how UndergroundGenerator uses NoiseSampler.

    const baseNoise = SurfaceGenerator.densityNoise(
      x * 0.002,
      y * (0.04 + SurfaceGenerator.treeNoise(x * 0.00001, z * 0.00001) * 0.02),
      z * 0.01,
    );
    const overhangNoise = SurfaceGenerator.densityNoise(
      (x + y * 0.55) * 0.008,
      y * 0.012,
      (z - y * 0.45) * 0.008,
    );
    const cliffNoise = SurfaceGenerator.densityNoise(
      x * 0.0035,
      y * 0.004,
      z * 0.0035,
    );

    return (
      relativeHeight +
      baseNoise * SurfaceGenerator.DENSITY_BASE_AMPLITUDE +
      overhangNoise * SurfaceGenerator.DENSITY_OVERHANG_AMPLITUDE +
      cliffNoise * SurfaceGenerator.DENSITY_CLIFF_AMPLITUDE
    );
  }

  private findTopSurfaceY(
    worldX: number,
    worldZ: number,
    baseHeight: number,
  ): number {
    const range = SurfaceGenerator.DENSITY_VERTICAL_SCAN_RANGE;
    const maxY = baseHeight + range;
    const minY = baseHeight - range;

    let densityAbove = this.getDensity(worldX, maxY + 1, worldZ, baseHeight);
    let highestSolid = Number.NEGATIVE_INFINITY;

    for (let y = maxY; y >= minY; y--) {
      const densityHere = this.getDensity(worldX, y, worldZ, baseHeight);

      if (densityHere > 0 && densityAbove <= 0) {
        return y;
      }

      if (densityHere > 0 && !Number.isFinite(highestSolid)) {
        highestSolid = y;
      }

      densityAbove = densityHere;
    }

    return highestSolid;
  }
}
