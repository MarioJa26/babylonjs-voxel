import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import {
  CACTUS,
  JUNGLE_TREE,
  OAK_TREE,
  PLAINS_TREE,
  TreeDefinition,
} from "./TreeDefinition";

export interface Biome {
  name: string;
  topBlock: number;
  undergroundBlock: number;
  stoneBlock: number;
  canSpawnTrees: boolean;
  treeDensity: number;
  beachBlock: number;
  seafloorBlock: number;
  terrainHeightBase?: number;
  // The generateTree method is now part of TreeDefinition
  terrainHeightAmplitude?: number;
  terrainScale?: number;
  octaves?: number;
  persistence?: number;
  lacunarity?: number;
  heightExponent?: number;
  getTreeForBlock(blockId: number): TreeDefinition | null;
}
//Default
const FOREST: Biome = {
  name: "Forest",
  topBlock: 15,
  undergroundBlock: 19,
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.05,
  beachBlock: 3,
  seafloorBlock: 46,
  terrainScale: GenerationParams.TERRAIN_SCALE,
  persistence: 0.31,
  heightExponent: 1.2,
  terrainHeightBase: 20,
  terrainHeightAmplitude: 333,
  getTreeForBlock(blockId: number): TreeDefinition | null {
    if (blockId === this.topBlock) {
      return OAK_TREE;
    }
    return null;
  },
};
const TUNDRA: Biome = {
  name: "Tundra",
  topBlock: 9,
  undergroundBlock: 19,
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.0,
  beachBlock: 8, // Gravel
  seafloorBlock: 8, // Dirt
  terrainScale: GenerationParams.TERRAIN_SCALE,
  persistence: 0.26,
  heightExponent: 1.5,
  terrainHeightBase: 35,
  terrainHeightAmplitude: 333,
  getTreeForBlock(blockId: number): TreeDefinition | null {
    if (blockId === this.topBlock) {
      return OAK_TREE; // Or a specific pine/spruce tree definition
    }
    return null;
  },
};

const DESERT: Biome = {
  name: "Desert",
  topBlock: 23,
  undergroundBlock: 3,
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.005,
  beachBlock: 3, // Sand,
  seafloorBlock: 3, // Sand
  terrainScale: GenerationParams.TERRAIN_SCALE,
  persistence: 0.35,
  heightExponent: 1.3,
  terrainHeightBase: 22,
  terrainHeightAmplitude: 289,
  getTreeForBlock(blockId: number): TreeDefinition | null {
    if (blockId === this.topBlock) {
      return CACTUS;
    }
    return null;
  },
};

const JUNGLE: Biome = {
  name: "Jungle",
  topBlock: 51,
  undergroundBlock: 19,
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.1,
  beachBlock: 3, // Sand,
  seafloorBlock: 3,
  terrainScale: GenerationParams.TERRAIN_SCALE,
  persistence: 0.3,
  heightExponent: 1.22,
  terrainHeightBase: 25,
  terrainHeightAmplitude: 350,
  getTreeForBlock(blockId: number): TreeDefinition | null {
    if (blockId === this.topBlock) {
      return JUNGLE_TREE;
    }
    return null;
  },
};

const PLAINS: Biome = {
  name: "Plains",
  topBlock: 57,
  undergroundBlock: 19,
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.005,
  beachBlock: 3,
  seafloorBlock: 46,
  terrainScale: GenerationParams.TERRAIN_SCALE,
  persistence: 0.25,
  heightExponent: 1.0,
  terrainHeightBase: 20,
  terrainHeightAmplitude: 200,
  getTreeForBlock(blockId: number): TreeDefinition | null {
    if (blockId === this.topBlock) {
      return PLAINS_TREE;
    }
    return null;
  },
};

const SWAMP: Biome = {
  name: "Swamp",
  topBlock: 57, // Grass
  undergroundBlock: 8, // Dirt/Mud
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.08,
  beachBlock: 8, // Muddy beach
  seafloorBlock: 57, // Muddy bottom
  terrainScale: GenerationParams.TERRAIN_SCALE * 16,
  persistence: 0.33,
  heightExponent: 1.55,
  terrainHeightBase: GenerationParams.SEA_LEVEL + 5, // Near sea level (42) to create pools
  terrainHeightAmplitude: 14, // Low amplitude for flat terrain
  getTreeForBlock(blockId: number): TreeDefinition | null {
    if (blockId === this.topBlock) {
      return OAK_TREE;
    }
    return null;
  },
};

export function getBiomeFor(temperature: number, humidity: number): Biome {
  // Tundra: Cold regions
  if (temperature < 0.25) {
    return TUNDRA;
  }

  // Hot regions
  if (temperature > 0.75) {
    if (humidity < 0.5) {
      return DESERT; // Hot and dry
    } else {
      return JUNGLE; // Hot and wet
    }
  }

  // Temperate regions (0.3 <= temperature <= 0.7)
  if (humidity < 0.2) {
    return PLAINS; // Temperate and relatively dry
  } else if (humidity > 0.7) {
    return SWAMP; // Temperate and very wet
  } else {
    return FOREST; // Temperate and humid
  }
}
