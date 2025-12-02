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
}

const TUNDRA: Biome = {
  name: "Tundra",
  topBlock: 9,
  undergroundBlock: 19,
  stoneBlock: 1,
  canSpawnTrees: true,
  treeDensity: 0.01,
  beachBlock: 8, // Gravel
  seafloorBlock: 8, // Dirt
};

const DESERT: Biome = {
  name: "Desert",
  topBlock: 23,
  undergroundBlock: 3,
  stoneBlock: 1,
  canSpawnTrees: false,
  treeDensity: 0,
  beachBlock: 3, // Sand,
  seafloorBlock: 3, // Sand
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
