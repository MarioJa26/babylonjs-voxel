// HotBiomes.ts
import { BlockType } from "@/code/World/Texture/BlockType";
import { GenerationParams } from "../../../NoiseAndParameters/GenerationParams";
import { BIOME_ID, type Biome, type TreeDefinition } from "../../BiomeTypes";
import { PALM_TREE } from "../TropicalBiomes/TropicalTrees";
import { BAOBAB_TREE, CACTUS, DEAD_TREE } from "./HotTrees";

// ── Existing ──────────────────────────────────────────────────────────────────

export const DESERT: Biome = {
	id: BIOME_ID.DESERT,
	name: "Desert",
	topBlock: 3, // sand
	undergroundBlock: 3, // sandstone
	stoneBlock: 59, // stone
	canSpawnTrees: true,
	treeDensity: 0.075,
	grassDensity: 0.1,
	beachBlock: 3, // sandstone
	seafloorBlock: 3, // sandstone

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.75,
	persistence: 0.22,
	heightExponent: 1.35,
	terrainHeightBase: 43,
	terrainHeightAmplitude: 55,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return CACTUS;
		return null;
	},
};

export const SAVANNAH: Biome = {
	id: BIOME_ID.SAVANNAH,
	name: "Savannah",
	topBlock: 65, // dry savannah grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.05,
	grassDensity: 0.41,
	beachBlock: 3, // sand
	seafloorBlock: 3, // sand

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.75,
	persistence: 0.2,
	heightExponent: 1.15,
	terrainHeightBase: 45,
	terrainHeightAmplitude: 42,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return BAOBAB_TREE;
		return null;
	},
};

export const VOLCANIC_WASTELAND: Biome = {
	id: BIOME_ID.VOLCANIC_WASTELAND,
	name: "Volcanic_Wasteland",
	topBlock: 1, // stone / ash covered stone
	undergroundBlock: 1, // stone
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.01, // barely any vegetation
	beachBlock: 8, // ash/gravel shoreline
	seafloorBlock: 1, // stone

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.55,
	persistence: 0.3,
	heightExponent: 1.15,
	terrainHeightBase: 55,
	terrainHeightAmplitude: 95,

	getTreeForBlock(): TreeDefinition | null {
		return DEAD_TREE;
	},
};

export const BASALT_DELTAS: Biome = {
	id: BIOME_ID.BASALT_DELTAS,
	name: "Basalt_Deltas",
	topBlock: 1, // basalt / dark stone
	undergroundBlock: 1, // basalt
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.0,
	beachBlock: 8, // ash/gravel
	seafloorBlock: 1, // basalt

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.6,
	persistence: 0.28,
	heightExponent: 1.1,
	terrainHeightBase: 52,
	terrainHeightAmplitude: 75,

	getTreeForBlock(): TreeDefinition | null {
		return DEAD_TREE;
	},
};

// ── New ───────────────────────────────────────────────────────────────────────

export const BADLANDS: Biome = {
	id: BIOME_ID.BADLANDS,
	name: "Badlands",
	topBlock: BlockType.TerracottaBlock, // red sand / terracotta
	undergroundBlock: BlockType.TerracottaBlock, // layered terracotta / hardened clay
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.05, // almost no vegetation
	beachBlock: 3, // red sand
	seafloorBlock: 3, // sandstone

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.6,
	persistence: 0.3,
	heightExponent: 1.5, // steep eroded cliffs and mesas
	terrainHeightBase: 52,
	terrainHeightAmplitude: 80,

	getTreeForBlock(): TreeDefinition | null {
		return DEAD_TREE;
	},
};

export const RED_ROCK_CANYON: Biome = {
	id: BIOME_ID.RED_ROCK_CANYON,
	name: "Red_Rock_Canyon",
	topBlock: BlockType.TerracottaBlock, // red sandstone / terracotta
	undergroundBlock: BlockType.TerracottaBlock, // layered red rock
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.03,
	beachBlock: 3, // red sand
	seafloorBlock: 3, // red rock floor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.5,
	persistence: 0.32,
	heightExponent: 2.2, // dramatic canyon walls
	terrainHeightBase: 48,
	terrainHeightAmplitude: 110,

	getTreeForBlock(): TreeDefinition | null {
		return DEAD_TREE;
	},
};

export const OASIS: Biome = {
	id: BIOME_ID.OASIS,
	name: "Oasis",
	topBlock: 15, // lush grass (contrast against surrounding desert)
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.12, // palm-like trees clustered around water
	grassDensity: 0.5,
	beachBlock: 3, // sand shore around the pool
	seafloorBlock: 46, // gravel pool floor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.9,
	persistence: 0.14,
	heightExponent: 1.05,
	terrainHeightBase: GenerationParams.SEA_LEVEL + 1, // depression in the desert
	terrainHeightAmplitude: 5,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		//CATUS
		if (blockId === this.topBlock) return PALM_TREE;
		return null;
	},
};

export const SALT_FLATS: Biome = {
	id: BIOME_ID.SALT_FLATS,
	name: "Salt_Flats",
	topBlock: BlockType.SaltBlock, // salt / white cracked ground
	undergroundBlock: 1, // sandstone
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.0, // nothing grows here
	beachBlock: BlockType.SaltBlock, // salt
	seafloorBlock: 8, // salt flat floor (dried lake bed)

	terrainScale: GenerationParams.TERRAIN_SCALE,
	persistence: 0.12,
	heightExponent: 1.02,
	terrainHeightBase: 42,
	terrainHeightAmplitude: 1,
	pvNoiseScale: 0.05,
	erosionNoiseScale: 0.1,

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};

export const DUNE_SEA: Biome = {
	id: BIOME_ID.DUNE_SEA,
	name: "Dune_Sea",
	topBlock: 3, // sand
	undergroundBlock: 3, // sand (deep dunes, no sandstone underneath)
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.02, // occasional dry shrub
	beachBlock: 3, // sand
	seafloorBlock: 3, // sandstone below the dunes

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.7,
	persistence: 0.26,
	heightExponent: 1.45, // rolling dune shapes
	terrainHeightBase: 46,
	terrainHeightAmplitude: 1,

	getTreeForBlock(): TreeDefinition | null {
		return CACTUS;
	},
};

export const SCORCHED_SAVANNAH: Biome = {
	id: BIOME_ID.SCORCHED_SAVANNAH,
	name: "Scorched_Savannah",
	topBlock: 72, // scorched / cracked dry grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.03, // very sparse dead trees
	grassDensity: 0.15, // mostly bare, some dead grass
	beachBlock: 3, // sand
	seafloorBlock: 3, // sand

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.75,
	persistence: 0.21,
	heightExponent: 1.2,
	terrainHeightBase: 46,
	terrainHeightAmplitude: 48,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		// DEAD_TREE
		if (blockId === this.topBlock) return BAOBAB_TREE;
		return null;
	},
};

export const CRACKED_EARTH: Biome = {
	id: BIOME_ID.CRACKED_EARTH,
	name: "Cracked_Earth",
	topBlock: 1, // MudCrackedDry03
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.02, // almost nothing grows
	beachBlock: 8, // gravel
	seafloorBlock: 8, // gravel

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.9,
	persistence: 0.12,
	heightExponent: 1.01,
	terrainHeightBase: 44,
	terrainHeightAmplitude: 3, // nearly flat cracked plains
	pvNoiseScale: 0.1,
	erosionNoiseScale: 0.15,

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};

export const DUST_BOWL: Biome = {
	id: BIOME_ID.DUST_BOWL,
	name: "Dust_Bowl",
	topBlock: 3, // GravellySand
	undergroundBlock: 3, // sand
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.0, // nothing grows in the dust bowl
	beachBlock: 3, // sand
	seafloorBlock: 8, // gravel

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.85,
	persistence: 0.13,
	heightExponent: 1.01,
	terrainHeightBase: 43,
	terrainHeightAmplitude: 3, // extremely flat
	pvNoiseScale: 0.08,
	erosionNoiseScale: 0.1,

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};
