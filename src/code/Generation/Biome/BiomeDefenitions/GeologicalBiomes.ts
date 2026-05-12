// GeologicalBiomes.ts
import { BlockType } from "@/code/World/BlockType";
import { GenerationParams } from "../../NoiseAndParameters/GenerationParams";
import { BIOME_ID, type Biome, type TreeDefinition } from "../BiomeTypes";
import { CRYSTAL_SPIRE, GIANT_MUSHROOM } from "../TreeDefinition";

export const MUSHROOM_FIELDS: Biome = {
	id: BIOME_ID.MUSHROOM_FIELDS,
	name: "Mushroom_Fields",
	topBlock: BlockType.Mycelium, // mycelium
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.12, // giant mushrooms instead of trees
	grassDensity: 0.5, // small mushrooms as grass replacement
	beachBlock: 110, // mycelium beach
	seafloorBlock: 46, // gravel

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.7,
	persistence: 0.24,
	heightExponent: 1.1,
	terrainHeightBase: 46,
	terrainHeightAmplitude: 40,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		return GIANT_MUSHROOM;
	},
};

export const CRYSTAL_CAVES: Biome = {
	id: BIOME_ID.CRYSTAL_CAVES,
	name: "Crystal_Caves",
	topBlock: 111, // crystal-encrusted stone surface
	undergroundBlock: 111, // crystal stone
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.2, // glowing crystal growths as grass replacement
	beachBlock: 1, // stone
	seafloorBlock: 111, // crystal seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.5,
	persistence: 0.32,
	heightExponent: 1.55,
	terrainHeightBase: 50,
	terrainHeightAmplitude: 85,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		return CRYSTAL_SPIRE;
	},
};

export const OBSIDIAN_FLATS: Biome = {
	id: BIOME_ID.OBSIDIAN_FLATS,
	name: "Obsidian_Flats",
	topBlock: 112, // obsidian
	undergroundBlock: 1, // stone
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.0, // nothing grows on obsidian
	beachBlock: 112, // obsidian
	seafloorBlock: 112, // obsidian

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.65,
	persistence: 0.25,
	heightExponent: 1.08,
	terrainHeightBase: 50,
	terrainHeightAmplitude: 20, // relatively flat glassy plains

	getTreeForBlock(blockId: number): TreeDefinition | null {
		return null;
	},
};

export const GEOTHERMAL_FIELD: Biome = {
	id: BIOME_ID.GEOTHERMAL_FIELD,
	name: "Geothermal_Field",
	topBlock: 1, // stone / mineral-stained rock
	undergroundBlock: 113, // sulfurous / geothermal rock
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.08, // sparse extremophile plant patches
	beachBlock: 113, // sulfurous shore
	seafloorBlock: 113, // geothermal seafloor (hot springs)

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.6,
	persistence: 0.29,
	heightExponent: 1.2,
	terrainHeightBase: 52,
	terrainHeightAmplitude: 55,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		return null;
	},
};
