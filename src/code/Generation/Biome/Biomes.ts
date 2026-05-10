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

// Default
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

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.65,
	persistence: 0.24,
	heightExponent: 1.05,
	terrainHeightBase: 42,
	terrainHeightAmplitude: 33,

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
	beachBlock: 8,
	seafloorBlock: 8,

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.5,
	persistence: 0.221,
	heightExponent: 1.1,
	terrainHeightBase: 50,
	terrainHeightAmplitude: 90,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) {
			return OAK_TREE;
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
	beachBlock: 8,
	seafloorBlock: 8,

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.4,
	persistence: 0.2,
	heightExponent: 121.95,
	terrainHeightBase: 80,
	terrainHeightAmplitude: 180,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) {
			return OAK_TREE;
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
	beachBlock: 3,
	seafloorBlock: 3,

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.75,
	persistence: 0.22,
	heightExponent: 1.35,
	terrainHeightBase: 43,
	terrainHeightAmplitude: 55,

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
	beachBlock: 3,
	seafloorBlock: 3,

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.6,
	persistence: 0.25,
	heightExponent: 1.05,
	terrainHeightBase: 46,
	terrainHeightAmplitude: 95,

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

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.8,
	persistence: 0.18,
	heightExponent: 1.25,
	terrainHeightBase: 44,
	terrainHeightAmplitude: 32,

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
	topBlock: 57,
	undergroundBlock: 8,
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.08,
	grassDensity: 0.6,
	beachBlock: 8,
	seafloorBlock: 57,

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.7,
	persistence: 0.18,
	heightExponent: 1.4,
	terrainHeightBase: GenerationParams.SEA_LEVEL + 2,
	terrainHeightAmplitude: 6,

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
	topBlock: 14,
	undergroundBlock: 46,
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.2,
	grassDensity: 0.6,
	beachBlock: 3,
	seafloorBlock: 14,

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.65,
	persistence: 0.23,
	heightExponent: 1.1,
	terrainHeightBase: 46,
	terrainHeightAmplitude: 45,

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
	topBlock: 23,
	undergroundBlock: 23,
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.0,
	grassDensity: 0.05,
	beachBlock: 3,
	seafloorBlock: 3,

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.7,
	persistence: 0.16,
	heightExponent: 1.2,
	terrainHeightBase: GenerationParams.SEA_LEVEL + 2,
	terrainHeightAmplitude: 4,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		return null;
	},
};

const ROCKY_SHORE: Biome = {
	id: BIOME_ID.ROCKY_SHORE,
	name: "Rocky_Shore",
	topBlock: 8,
	undergroundBlock: 8,
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.0,
	grassDensity: 0.05,
	beachBlock: 8,
	seafloorBlock: 8,

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.55,
	persistence: 0.22,
	heightExponent: 1.05,
	terrainHeightBase: GenerationParams.SEA_LEVEL + 3,
	terrainHeightAmplitude: 20,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		return null;
	},
};

const OCEAN: Biome = {
	id: BIOME_ID.OCEAN,
	name: "Ocean",
	topBlock: 15,
	undergroundBlock: 46,
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.1,
	grassDensity: 0.33,
	beachBlock: 3,
	seafloorBlock: 46,

	terrainScale: GenerationParams.TERRAIN_SCALE,
	persistence: 0.2,
	heightExponent: 0.04,
	terrainHeightBase: 0,
	terrainHeightAmplitude: 0.2,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) {
			return OAK_TREE;
		}
		return null;
	},
};

const RIVER: Biome = {
	id: BIOME_ID.RIVER,
	name: "River",
	topBlock: 8,
	undergroundBlock: 8,
	stoneBlock: 1,
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.5,
	beachBlock: 8,
	seafloorBlock: 8,

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.7,
	persistence: 0.16,
	heightExponent: 1.0,
	terrainHeightBase: GenerationParams.SEA_LEVEL - 6,
	terrainHeightAmplitude: 4,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		return null;
	},
};

const GRASS_LAND: Biome = {
	id: BIOME_ID.GRASS_LAND,
	name: "Grass_Land",
	topBlock: 15,
	undergroundBlock: 46,
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.067,
	grassDensity: 0.5,
	beachBlock: 3,
	seafloorBlock: 1,

	terrainScale: GenerationParams.TERRAIN_SCALE,
	persistence: 0.33,
	heightExponent: 1.15,
	terrainHeightBase: 44,
	terrainHeightAmplitude: 50,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return OAK_TREE;
		return null;
	},
};

const VOLCANIC_WASTELAND: Biome = {
	id: BIOME_ID.VOLCANIC_WASTELAND,
	name: "Volcanic_Wasteland",
	topBlock: 1,
	undergroundBlock: 1,
	stoneBlock: 1,
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.01,
	beachBlock: 8,
	seafloorBlock: 1,

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.55,
	persistence: 0.3,
	heightExponent: 1.15,
	terrainHeightBase: 55,
	terrainHeightAmplitude: 95,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		return null;
	},
};

const BASALT_DELTAS: Biome = {
	id: BIOME_ID.BASALT_DELTAS,
	name: "Basalt_Deltas",
	topBlock: 1,
	undergroundBlock: 1,
	stoneBlock: 1,
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.0,
	beachBlock: 8,
	seafloorBlock: 1,

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.6,
	persistence: 0.28,
	heightExponent: 1.1,
	terrainHeightBase: 52,
	terrainHeightAmplitude: 75,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		return null;
	},
};

const SAVANNAH: Biome = {
	id: BIOME_ID.SAVANNAH,
	name: "Savannah",
	topBlock: 65,
	undergroundBlock: 19,
	stoneBlock: 1,
	canSpawnTrees: true,
	treeDensity: 0.05,
	grassDensity: 0.41,
	beachBlock: 3,
	seafloorBlock: 3,

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.75,
	persistence: 0.2,
	heightExponent: 1.15,
	terrainHeightBase: 45,
	terrainHeightAmplitude: 42,

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

	// Shore biomes
	const isNearShore = continentalness > -0.3 && continentalness < 0.2;
	if (isNearShore && terrainShapedHeight < GenerationParams.SEA_LEVEL + 10) {
		if (temperature > 0.6) {
			return SANDY_SHORE;
		} else if (temperature < 0.4) {
			return ROCKY_SHORE;
		}
		return SANDY_SHORE;
	}

	// High altitude / far inland
	if (continentalness > 0.75) {
		return TUNDRA_MOUNTAINS;
	}

	// Swamp
	if (humidity > 0.6 && terrainShapedHeight < GenerationParams.SEA_LEVEL + 15) {
		return SWAMP;
	}

	// Grove
	if (humidity > 0.55 && temperature > 0.4 && temperature < 0.7) {
		return GROVE;
	}

	// Tundra
	if (temperature < 0.45 && continentalness > 0.5) {
		if (humidity < 0.5) {
			return TUNDRA;
		}
		return TUNDRA_MOUNTAINS;
	}

	// Hot regions
	if (temperature > 0.67) {
		if (humidity < 0.35) {
			if (temperature > 0.85 && continentalness > -0.3) {
				if (continentalness > 0.2 && continentalness < 0.6) {
					return BASALT_DELTAS;
				}
				return VOLCANIC_WASTELAND;
			}
			return DESERT;
		} else if (humidity < 0.55) {
			return SAVANNAH;
		}
		return JUNGLE;
	}

	// Dry regions
	if (humidity < 0.24) {
		return PLAINS;
	}

	// Temperate-cold regions
	if (temperature < 0.5) {
		return GRASS_LAND;
	}

	return FOREST;
}
