// GeologicalBiomes.ts
import { BlockType } from "@/code/World/BlockType";
import { GenerationParams } from "../../../NoiseAndParameters/GenerationParams";
import { BIOME_ID, type Biome, type TreeDefinition } from "../../BiomeTypes";
import {
	CRYSTAL_SPIRE,
	GIANT_MUSHROOM,
	MEDIUM_MUSHROOM,
	MINI_MUSHROOM,
	SMALL_MUSHROOM,
	SPHERE_MUSHROOM,
	TINY_MUSHROOM,
} from "./GeologicalTrees";

export const MUSHROOM_FIELDS: Biome = {
	id: BIOME_ID.MUSHROOM_FIELDS,
	name: "Mushroom_Fields",
	topBlock: BlockType.Grass001, // mycelium
	undergroundBlock: BlockType.Mycelium, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.2, // giant mushrooms instead of trees
	grassDensity: 0.5, // small mushrooms as grass replacement
	beachBlock: 110, // mycelium beach
	seafloorBlock: 46, // gravel

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.7,
	persistence: 0.24,
	heightExponent: 1.1,
	terrainHeightBase: 46,
	terrainHeightAmplitude: 40,

	getTreeForBlock(
		blockId: number,
		noiseValue: number = 0.0,
	): TreeDefinition | null {
		if (blockId !== this.topBlock) return null;

		const MAX_NOISE = this.treeDensity;

		// Revised weighting: Mini Mushroom takes up 70% of the spawn range
		if (noiseValue < MAX_NOISE * 0.7) return MINI_MUSHROOM; // 0.000 – 0.140 (70%)

		if (noiseValue < MAX_NOISE * 0.8)
			// 0.140 – 0.160 (10%)
			return TINY_MUSHROOM;
		if (noiseValue < MAX_NOISE * 0.85)
			// 0.160 – 0.170 (5%)
			return SMALL_MUSHROOM;
		if (noiseValue < MAX_NOISE * 0.9)
			// 0.170 – 0.180 (5%)
			return MEDIUM_MUSHROOM;
		if (noiseValue < MAX_NOISE * 0.96)
			// 0.180 – 0.192 (6%)
			return SPHERE_MUSHROOM;

		// 0.192 – 0.200 (4%)
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

	getTreeForBlock(): TreeDefinition | null {
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

	getTreeForBlock(): TreeDefinition | null {
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

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};
