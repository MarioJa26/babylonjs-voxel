import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import {
  BIG_OAK_TREE,
  CACTUS,
  JUNGLE_TREE,
  OAK_TREE,
  PLAINS_TREE,
} from "./TreeDefinition";
import { Biome, TreeDefinition } from "./BiomeTypes";

//Default
const FOREST: Biome = {
  name: "Forest",
  topBlock: 15,
  undergroundBlock: 19,
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.15,
  beachBlock: 3,
  seafloorBlock: 46,
  terrainScale: GenerationParams.TERRAIN_SCALE,
  persistence: 0.31,
  heightExponent: 0.8,
  terrainHeightBase: 42,
  terrainHeightAmplitude: 222,
  getTreeForBlock(blockId: number): TreeDefinition | null {
    if (blockId === this.topBlock) {
      return BIG_OAK_TREE;
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
  terrainScale: GenerationParams.TERRAIN_SCALE * 0.6,
  persistence: 0.26,
  heightExponent: 0.9,
  terrainHeightBase: 60,
  terrainHeightAmplitude: 300,
  getTreeForBlock(blockId: number): TreeDefinition | null {
    if (blockId === this.topBlock) {
      return OAK_TREE; // Or a specific pine/spruce tree definition
    }
    return null;
  },
};
const TUNDRA_MOUNTAINS: Biome = {
  name: "Tundra_Mountains",
  topBlock: 9,
  undergroundBlock: 19,
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.0,
  beachBlock: 8, // Gravel
  seafloorBlock: 8, // Dirt
  terrainScale: GenerationParams.TERRAIN_SCALE * 0.6,
  persistence: 0.26,
  heightExponent: 0.7,
  terrainHeightBase: 50,
  terrainHeightAmplitude: 600,
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
  treeDensity: 0.075,
  beachBlock: 3, // Sand,
  seafloorBlock: 3, // Sand
  terrainScale: GenerationParams.TERRAIN_SCALE,
  persistence: 0.35,
  heightExponent: 1.3,
  terrainHeightBase: 42,
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
  treeDensity: 0.2,
  beachBlock: 3, // Sand,
  seafloorBlock: 3,
  terrainScale: GenerationParams.TERRAIN_SCALE,
  persistence: 0.3,
  heightExponent: 1.22,
  terrainHeightBase: 42,
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
  treeDensity: 0.06,
  beachBlock: 3,
  seafloorBlock: 46,
  terrainScale: GenerationParams.TERRAIN_SCALE,
  persistence: 0.25,
  heightExponent: 0.8,
  terrainHeightBase: 42,
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

const GROVE: Biome = {
  name: "Grove",
  topBlock: 14, // Grass
  undergroundBlock: 46, // Dirt/Mud
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.2,
  beachBlock: 3, // Muddy beach
  seafloorBlock: 14, // Muddy bottom
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

const SANDY_SHORE: Biome = {
  name: "Sandy_Shore",
  topBlock: 23, // Grass
  undergroundBlock: 23, // Dirt/Mud
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.0,
  beachBlock: 3, // Muddy beach
  seafloorBlock: 3, // Muddy bottom
  terrainScale: GenerationParams.TERRAIN_SCALE,
  persistence: 0.33,
  heightExponent: 1.0,
  terrainHeightBase: GenerationParams.SEA_LEVEL + 5,
  terrainHeightAmplitude: 2, // Low amplitude for flat terrain
  getTreeForBlock(blockId: number): TreeDefinition | null {
    return null;
  },
};
const ROCKY_SHORE: Biome = {
  name: "Rocky_Shore",
  topBlock: 8, // Grass
  undergroundBlock: 8, // Dirt/Mud
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.0,
  beachBlock: 8, // Muddy beach
  seafloorBlock: 8, // Muddy bottom
  terrainScale: GenerationParams.TERRAIN_SCALE * 8,
  persistence: 0.33,
  heightExponent: 1.3,
  terrainHeightBase: GenerationParams.SEA_LEVEL + 4,
  terrainHeightAmplitude: 14, // Low amplitude for flat terrain
  getTreeForBlock(blockId: number): TreeDefinition | null {
    return null;
  },
};

const OCEAN: Biome = {
  name: "Ocean",
  topBlock: 46,
  undergroundBlock: 46, // Dirt/Mud
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.0,
  beachBlock: 3, // Muddy beach
  seafloorBlock: 57, // Muddy bottom
  terrainScale: GenerationParams.TERRAIN_SCALE * 16,
  persistence: 0.3,
  heightExponent: 1.0,
  terrainHeightBase: GenerationParams.SEA_LEVEL - 48, // Near sea level (42) to create pools
  terrainHeightAmplitude: 4, // Low amplitude for flat terrain
  getTreeForBlock(blockId: number): TreeDefinition | null {
    return null;
  },
};

const RIVER: Biome = {
  name: "River",
  topBlock: 8, // Dirt
  undergroundBlock: 8,
  stoneBlock: 1,
  canSpawnTrees: false,
  treeDensity: 0.0,
  beachBlock: 8,
  seafloorBlock: 8,
  terrainScale: GenerationParams.TERRAIN_SCALE,
  persistence: 0.3,
  heightExponent: 1.0,
  terrainHeightBase: GenerationParams.SEA_LEVEL - 5,
  terrainHeightAmplitude: 5,
  getTreeForBlock(blockId: number): TreeDefinition | null {
    return null;
  },
};

const GRASS_LAND: Biome = {
  name: "Grass_Land",
  topBlock: 15, // Grass
  undergroundBlock: 46, // Dirt
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.067,
  beachBlock: 3,
  seafloorBlock: 1,
  terrainScale: GenerationParams.TERRAIN_SCALE,
  persistence: 0.5,
  heightExponent: 1.0,
  terrainHeightBase: 0,
  terrainHeightAmplitude: 100,
  getTreeForBlock(blockId: number): TreeDefinition | null {
    if (blockId === this.topBlock) return OAK_TREE;
    return null;
  },
};

const VOLCANIC_WASTELAND: Biome = {
  name: "Volcanic_Wasteland",
  topBlock: 1, // Stone (or Obsidian if you have a block ID for it)
  undergroundBlock: 1, // Stone
  stoneBlock: 1,
  canSpawnTrees: false,
  treeDensity: 0.0,
  beachBlock: 8, // Gravel or similar
  seafloorBlock: 1, // Stone bottom for lava lakes
  terrainScale: GenerationParams.TERRAIN_SCALE,
  persistence: 0.5, // Rough terrain
  heightExponent: 1.2,
  terrainHeightBase: 50,
  terrainHeightAmplitude: 150,
  getTreeForBlock(blockId: number): TreeDefinition | null {
    return null;
  },
};

export function getBiomeFor(
  temperature: number,
  humidity: number,
  continentalness: number,
  river: number,
  terrainShapedHeight: number,
): Biome {
  /*
  if (river < 0.1 && continentalness > -0.28 && continentalness < 0.67) {
    return RIVER;
  }
  */

  if (
    continentalness < -0.33 &&
    terrainShapedHeight < GenerationParams.SEA_LEVEL
  ) {
    return OCEAN;
  }

  if (continentalness > 0.75) {
    return TUNDRA_MOUNTAINS;
  }

  // Temperate regions (0.3 <= temperature <= 0.7)
  if (humidity > 0.45) {
    if (temperature < 0.15) {
      return ROCKY_SHORE; // Temperate and humid
    }
  }
  // Tundra: Cold regions
  if (temperature < 0.45 && continentalness > 0.5) {
    if (humidity < 0.5) {
      return TUNDRA; // Cold and dry
    } else {
      return TUNDRA_MOUNTAINS; // Cold and wet
    }
  }

  // Hot regions
  if (temperature > 0.67) {
    if (humidity < 0.4) {
      if (temperature > 0.85 && continentalness > -0.3) {
        return VOLCANIC_WASTELAND; // Extremely hot and dry
      }
      return DESERT; // Hot and dry
    } else {
      return JUNGLE; // Hot and wet
    }
  }

  if (humidity < 0.24) {
    return PLAINS;
  }

  if (temperature < 0.5) {
    return GRASS_LAND;
  }

  return FOREST;
}
