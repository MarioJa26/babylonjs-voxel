import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import { BIOME_ID, type Biome, type TreeDefinition } from "./BiomeTypes";
import {
	BIG_OAK_TREE,
	CACTUS,
	JUNGLE_TREE,
	OAK_TREE,
	PLAINS_TREE,
	SAVANNAH_TREE,
} from "./TreeDefinition";

//Default
const FOREST: Biome = {
	id: BIOME_ID.FOREST,
	name: "Forest",
	topBlock: 15,
	undergroundBlock: 19,
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.15,
	grassDensity: 0.33,
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
	id: BIOME_ID.TUNDRA,
	name: "Tundra",
	topBlock: 9,
	undergroundBlock: 19,
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.0,
	grassDensity: 0.0,
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
	id: BIOME_ID.TUNDRA_MOUNTAINS,
	name: "Tundra_Mountains",
	topBlock: 9,
	undergroundBlock: 19,
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.0,
	grassDensity: 0.0,
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
	id: BIOME_ID.DESERT,
	name: "Desert",
	topBlock: 23,
	undergroundBlock: 3,
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.075,
	grassDensity: 0.1,
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
	id: BIOME_ID.JUNGLE,
	name: "Jungle",
	topBlock: 51,
	undergroundBlock: 19,
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.2,
	grassDensity: 0.6,
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
	id: BIOME_ID.PLAINS,
	name: "Plains",
	topBlock: 57,
	undergroundBlock: 19,
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.06,
	grassDensity: 0.4,
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
	id: BIOME_ID.SWAMP,
	name: "Swamp",
	topBlock: 57, // Grass
	undergroundBlock: 8, // Dirt/Mud
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.08,
	grassDensity: 0.6,
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
	id: BIOME_ID.GROVE,
	name: "Grove",
	topBlock: 14, // Grass
	undergroundBlock: 46, // Dirt/Mud
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.2,
	grassDensity: 0.6,
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
	id: BIOME_ID.SANDY_SHORE,
	name: "Sandy_Shore",
	topBlock: 23, // Grass
	undergroundBlock: 23, // Dirt/Mud
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.0,
	grassDensity: 0.05,
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
	id: BIOME_ID.ROCKY_SHORE,
	name: "Rocky_Shore",
	topBlock: 8, // Grass
	undergroundBlock: 8, // Dirt/Mud
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.0,
	grassDensity: 0.05,
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
	id: BIOME_ID.OCEAN,
	name: "Ocean",
	topBlock: 46,
	undergroundBlock: 46, // Dirt/Mud
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.0,
	grassDensity: 0.2,
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
	id: BIOME_ID.RIVER,
	name: "River",
	topBlock: 8, // Dirt
	undergroundBlock: 8,
	stoneBlock: 1,
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.5,
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
	id: BIOME_ID.GRASS_LAND,
	name: "Grass_Land",
	topBlock: 15, // Grass
	undergroundBlock: 46, // Dirt
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.067,
	grassDensity: 0.5,
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
	id: BIOME_ID.VOLCANIC_WASTELAND,
	name: "Volcanic_Wasteland",
	topBlock: 1, // Stone (or Obsidian if you have a block ID for it)
	undergroundBlock: 1, // Stone
	stoneBlock: 1,
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.01,
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

const BASALT_DELTAS: Biome = {
	id: BIOME_ID.BASALT_DELTAS,
	name: "Basalt_Deltas",
	topBlock: 1, // Stone
	undergroundBlock: 1, // Stone
	stoneBlock: 1,
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.0,
	beachBlock: 8, // Gravel
	seafloorBlock: 1, // Stone
	terrainScale: GenerationParams.TERRAIN_SCALE,
	persistence: 0.45,
	heightExponent: 1.1,
	terrainHeightBase: 48,
	terrainHeightAmplitude: 120,
	getTreeForBlock(blockId: number): TreeDefinition | null {
		return null;
	},
};

const SAVANNAH: Biome = {
	id: BIOME_ID.SAVANNAH,
	name: "Savannah",
	topBlock: 65, // Grass
	undergroundBlock: 19, // Dirt
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.05, // Sparse trees
	grassDensity: 0.45, // Moderate-high grass
	beachBlock: 3, // Sand
	seafloorBlock: 3, // Sand
	terrainScale: GenerationParams.TERRAIN_SCALE,
	persistence: 0.28,
	heightExponent: 0.85,
	terrainHeightBase: 45,
	terrainHeightAmplitude: 180,
	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) {
			return SAVANNAH_TREE;
		}
		return null;
	},
};
export const BIOME_REGISTRY: Record<BIOME_ID, Biome> = {
	[BIOME_ID.FOREST]: FOREST,
	[BIOME_ID.TUNDRA]: TUNDRA,
	[BIOME_ID.TUNDRA_MOUNTAINS]: TUNDRA_MOUNTAINS,
	[BIOME_ID.DESERT]: DESERT,
	[BIOME_ID.JUNGLE]: JUNGLE,
	[BIOME_ID.PLAINS]: PLAINS,
	[BIOME_ID.SWAMP]: SWAMP,
	[BIOME_ID.GROVE]: GROVE,
	[BIOME_ID.SANDY_SHORE]: SANDY_SHORE,
	[BIOME_ID.ROCKY_SHORE]: ROCKY_SHORE,
	[BIOME_ID.OCEAN]: OCEAN,
	[BIOME_ID.RIVER]: RIVER,
	[BIOME_ID.GRASS_LAND]: GRASS_LAND,
	[BIOME_ID.VOLCANIC_WASTELAND]: VOLCANIC_WASTELAND,
	[BIOME_ID.BASALT_DELTAS]: BASALT_DELTAS,
	[BIOME_ID.SAVANNAH]: SAVANNAH,
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

	// Deep ocean
	if (
		continentalness < -0.33 &&
		terrainShapedHeight < GenerationParams.SEA_LEVEL
	) {
		return OCEAN;
	}

	// Shore biomes - near coastline (continentalness close to 0)
	const isNearShore = continentalness > -0.3 && continentalness < 0.2;
	if (isNearShore && terrainShapedHeight < GenerationParams.SEA_LEVEL + 10) {
		if (temperature > 0.6) {
			return SANDY_SHORE; // Hot coasts
		} else if (temperature < 0.4) {
			return ROCKY_SHORE; // Cold coasts
		}
		return SANDY_SHORE; // Default shore
	}

	// High altitude / far inland
	if (continentalness > 0.75) {
		return TUNDRA_MOUNTAINS;
	}

	// Swamp - low lying areas with high humidity
	if (humidity > 0.6 && terrainShapedHeight < GenerationParams.SEA_LEVEL + 15) {
		return SWAMP;
	}

	// Grove - humid temperate areas
	if (humidity > 0.55 && temperature > 0.4 && temperature < 0.7) {
		return GROVE;
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
		if (humidity < 0.35) {
			if (temperature > 0.85 && continentalness > -0.3) {
				// Basalt Deltas - extremely hot areas near volcanic regions
				if (continentalness > 0.2 && continentalness < 0.6) {
					return BASALT_DELTAS;
				}
				return VOLCANIC_WASTELAND; // Extremely hot and dry
			}
			return DESERT; // Hot and dry
		} else if (humidity < 0.55) {
			return SAVANNAH; // Hot and moderately dry (savannah)
		} else {
			return JUNGLE; // Hot and wet
		}
	}

	// Dry regions
	if (humidity < 0.24) {
		return PLAINS;
	}

	// Temperate-cold regions
	if (temperature < 0.5) {
		return GRASS_LAND;
	}

	// Default
	return FOREST;
}
