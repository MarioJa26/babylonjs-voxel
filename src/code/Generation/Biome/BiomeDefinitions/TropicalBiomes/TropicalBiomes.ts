// TropicalBiomes.ts
import { GenerationParams } from "../../../NoiseAndParameters/GenerationParams";
import { BIOME_ID, type Biome, type TreeDefinition } from "../../BiomeTypes";
import { JUNGLE_TREE, MANGROVE_TREE, PALM_TREE } from "./TropicalTrees";

// ── Existing ──────────────────────────────────────────────────────────────────

export const JUNGLE: Biome = {
	id: BIOME_ID.JUNGLE,
	name: "Jungle",
	topBlock: 51, // jungle grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.2,
	grassDensity: 0.6,
	beachBlock: 3, // sand
	seafloorBlock: 3, // sand

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.6,
	persistence: 0.25,
	heightExponent: 1.05,
	terrainHeightBase: 46,
	terrainHeightAmplitude: 95,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return JUNGLE_TREE;
		return null;
	},
};

// ── New ───────────────────────────────────────────────────────────────────────

export const MANGROVE: Biome = {
	id: BIOME_ID.MANGROVE,
	name: "Mangrove",
	topBlock: 51, // jungle grass / muddy ground
	undergroundBlock: 8, // mud
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.18, // dense mangrove roots/trees at waterline
	grassDensity: 0.5, // thick undergrowth and reeds
	beachBlock: 8, // mud shoreline
	seafloorBlock: 8, // mud seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.75,
	persistence: 0.17,
	heightExponent: 1.1,
	terrainHeightBase: GenerationParams.SEA_LEVEL + 1, // right at waterline
	terrainHeightAmplitude: 6,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return MANGROVE_TREE;
		return null;
	},
};

export const BAMBOO_FOREST: Biome = {
	id: BIOME_ID.BAMBOO_FOREST,
	name: "Bamboo_Forest",
	topBlock: 51, // jungle grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.3, // very dense bamboo stalks
	grassDensity: 0.55,
	beachBlock: 3, // sand
	seafloorBlock: 46, // gravel

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.65,
	persistence: 0.22,
	heightExponent: 1.08,
	terrainHeightBase: 46,
	terrainHeightAmplitude: 50,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		// TODO: replace with BAMBOO once defined
		if (blockId === this.topBlock) return JUNGLE_TREE;
		return null;
	},
};

export const TROPICAL_ISLAND: Biome = {
	id: BIOME_ID.TROPICAL_ISLAND,
	name: "Tropical_Island",
	topBlock: 15, // lush grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.14, // palm trees scattered across the island
	grassDensity: 0.45,
	beachBlock: 3, // white sand beach
	seafloorBlock: 84, // coral / tropical seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.8,
	persistence: 0.19,
	heightExponent: 1.3,
	terrainHeightBase: GenerationParams.SEA_LEVEL + 3,
	terrainHeightAmplitude: 35, // small hills, island peaks

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return PALM_TREE;
		return null;
	},
};

export const CLOUD_FOREST: Biome = {
	id: BIOME_ID.CLOUD_FOREST,
	name: "Cloud_Forest",
	topBlock: 14, // mossy grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.22, // dense moss-draped trees
	grassDensity: 0.65, // thick ferns and undergrowth
	beachBlock: 8, // gravel / rocky cliff base
	seafloorBlock: 46, // gravel

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.5,
	persistence: 0.27,
	heightExponent: 1.35,
	terrainHeightBase: 65, // high altitude tropical mountains
	terrainHeightAmplitude: 90,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		// TODO: replace with MOSSY_TREE once defined
		if (blockId === this.topBlock) return JUNGLE_TREE;
		return null;
	},
};
