import { TreeDefinition } from "./GenerationParams";

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
  terrainHeightAmplitude?: number;
  getTreeForBlock(blockId: number): TreeDefinition | null;
}

const OAK_TREE: TreeDefinition = {
  woodId: 28,
  leavesId: 2,
  baseHeight: 5,
  heightVariance: 2,
};

const JUNGLE_TREE: TreeDefinition = {
  woodId: 33, // Consider a different wood type for jungle
  leavesId: 34, // Consider different leaves
  baseHeight: 14,
  heightVariance: 5,
};

const CACTUS: TreeDefinition = {
  woodId: 34,
  leavesId: 0, // No leaves on a cactus
  baseHeight: 3,
  heightVariance: 2,
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
  getTreeForBlock(blockId: number): TreeDefinition | null {
    if (blockId === this.topBlock) {
      return JUNGLE_TREE;
    }
    return null;
  },
};

const PLAINS: Biome = {
  name: "Plains",
  topBlock: 15,
  undergroundBlock: 19,
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.005,
  beachBlock: 3,
  seafloorBlock: 46,
  getTreeForBlock(blockId: number): TreeDefinition | null {
    if (blockId === this.topBlock) {
      return OAK_TREE;
    }
    return null;
  },
};

const FOREST: Biome = {
  name: "Forest",
  topBlock: 15,
  undergroundBlock: 19,
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.05,
  beachBlock: 3,
  seafloorBlock: 46,
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
    if (humidity < 0.4) {
      return DESERT; // Hot and dry
    } else {
      return JUNGLE; // Hot and wet
    }
  }

  // Temperate regions (0.3 <= temperature <= 0.7)
  if (humidity < 0.5) {
    return PLAINS; // Temperate and relatively dry
  } else {
    return FOREST; // Temperate and humid
  }
}
