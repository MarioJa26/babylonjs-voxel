// CoastalBiomes.ts
import { GenerationParams } from "../../../NoiseAndParameters/GenerationParams";
import { BIOME_ID, type Biome, type TreeDefinition } from "../../BiomeTypes";
import { OAK_TREE } from "../TemperateBiomes/TemperateTrees";
import { PALM_TREE } from "../TropicalBiomes/TropicalTrees";

// ── Existing ──────────────────────────────────────────────────────────────────

export const OCEAN: Biome = {
	id: BIOME_ID.OCEAN,
	name: "Ocean",
	topBlock: 15, // grass (unused, ocean floor)
	undergroundBlock: 46, // gravel
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.1,
	grassDensity: 0.33,
	beachBlock: 3, // sand
	seafloorBlock: 46, // gravel seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE,
	persistence: 0.2,
	heightExponent: 0.04,
	terrainHeightBase: 0,
	terrainHeightAmplitude: 0.1,

	findlingChance: 0.0008,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return OAK_TREE;
		return null;
	},
};

export const RIVER: Biome = {
	id: BIOME_ID.RIVER,
	name: "River",
	topBlock: 8, // gravel / wet stone
	undergroundBlock: 8, // gravel
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.5, // reeds along the bank
	beachBlock: 8, // gravel bank
	seafloorBlock: 8, // gravel riverbed

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.7,
	persistence: 0.16,
	heightExponent: 1.0,
	terrainHeightBase: GenerationParams.SEA_LEVEL - 6,
	terrainHeightAmplitude: 4,

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};

export const SANDY_SHORE: Biome = {
	id: BIOME_ID.SANDY_SHORE,
	name: "Sandy_Shore",
	topBlock: 3, // sand
	undergroundBlock: 3, // sand
	stoneBlock: 59, // stone
	canSpawnTrees: true,
	treeDensity: 0.12,
	grassDensity: 0.05, // sparse beach grass
	beachBlock: 3, // sandstone
	seafloorBlock: 3, // sandstone

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.7,
	persistence: 0.16,
	heightExponent: 1.2,
	terrainHeightBase: GenerationParams.SEA_LEVEL - 22,
	terrainHeightAmplitude: 1,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return PALM_TREE;
		return null;
	},
};

export const ROCKY_SHORE: Biome = {
	id: BIOME_ID.ROCKY_SHORE,
	name: "Rocky_Shore",
	topBlock: 8, // gravel / wet rock
	undergroundBlock: 8, // gravel
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.0,
	grassDensity: 0.05, // sparse sea grass
	beachBlock: 8, // gravel
	seafloorBlock: 8, // gravel

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.55,
	persistence: 0.22,
	heightExponent: 1.5,
	terrainHeightBase: GenerationParams.SEA_LEVEL - 25,
	terrainHeightAmplitude: 2,

	findlingChance: 0.0006,

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};

// ── New ───────────────────────────────────────────────────────────────────────
//TODO add blocks
export const CORAL_REEF: Biome = {
	id: BIOME_ID.CORAL_REEF,
	name: "Coral_Reef",
	topBlock: 3, // sand
	undergroundBlock: 3, // sand (reef base)
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.3, // dense sea grass and coral plants
	beachBlock: 3, // sand
	seafloorBlock: 84, // coral seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.8,
	persistence: 0.21,
	heightExponent: 0.06,
	terrainHeightBase: 0,
	terrainHeightAmplitude: 0.4, // shallow underwater structures

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};

export const KELP_FOREST: Biome = {
	id: BIOME_ID.KELP_FOREST,
	name: "Kelp_Forest",
	topBlock: 71, // MossyCobble
	undergroundBlock: 46,
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.7, // dense kelp columns rising from the floor
	beachBlock: 8, // rocky shore meeting kelp water
	seafloorBlock: 8, // gravel

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.85,
	persistence: 0.18,
	heightExponent: 0.05,
	terrainHeightBase: 0,
	terrainHeightAmplitude: 0.3,

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};

export const TIDAL_FLATS: Biome = {
	id: BIOME_ID.TIDAL_FLATS,
	name: "Tidal_Flats",
	topBlock: 8, // wet gravel / tidal mud
	undergroundBlock: 8, // gravel
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.15, // sparse sea grass and barnacles
	beachBlock: 8, // gravel
	seafloorBlock: 8, // gravel tidal floor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.9,
	persistence: 0.13,
	heightExponent: 1.02,
	terrainHeightBase: GenerationParams.SEA_LEVEL,
	terrainHeightAmplitude: 3, // nearly flat, right at sea level

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};

export const ARCHIPELAGO: Biome = {
	id: BIOME_ID.ARCHIPELAGO,
	name: "Archipelago",
	topBlock: 15, // grass
	undergroundBlock: 46, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.1, // small scattered trees on island tops
	grassDensity: 0.35,
	beachBlock: 2, // sand beach around each islet
	seafloorBlock: 2, // sandy shallow between islands

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.6,
	persistence: 0.28,
	heightExponent: 1.6, // sharp peaks poking out of the ocean
	terrainHeightBase: GenerationParams.SEA_LEVEL - 10,
	terrainHeightAmplitude: 45,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return OAK_TREE;
		return null;
	},
};

export const DEEP_OCEAN_TRENCH: Biome = {
	id: BIOME_ID.DEEP_OCEAN_TRENCH,
	name: "Deep_Ocean_Trench",
	topBlock: 8, // GrayRocks
	undergroundBlock: 1, // stone
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.1, // sparse deep-sea plants
	beachBlock: 8, // gray rocks
	seafloorBlock: 8, // gray rocks

	terrainScale: GenerationParams.TERRAIN_SCALE,
	persistence: 0.3,
	heightExponent: 0.03,
	terrainHeightBase: 0,
	terrainHeightAmplitude: 0.2, // flat trench floor
	pvNoiseScale: 0.05,
	erosionNoiseScale: 0.1,

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};

export const BIOLUMINESCENT_BAY: Biome = {
	id: BIOME_ID.BIOLUMINESCENT_BAY,
	name: "Bioluminescent_Bay",
	topBlock: 30, // Water surface with bioluminescence
	undergroundBlock: 46, // gravel bay floor
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.5, // bioluminescent sea grass
	beachBlock: 3, // sand shoreline
	seafloorBlock: 46, // gravel bay floor

	terrainScale: GenerationParams.TERRAIN_SCALE,
	persistence: 0.15,
	heightExponent: 0.05,
	terrainHeightBase: 0,
	terrainHeightAmplitude: 0.3, // shallow calm bay
	pvNoiseScale: 0.1,
	erosionNoiseScale: 0.15,

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};
