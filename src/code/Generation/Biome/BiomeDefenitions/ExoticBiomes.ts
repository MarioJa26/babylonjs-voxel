// ExoticBiomes.ts
import { GenerationParams } from "../../NoiseAndParameters/GenerationParams";
import { BIOME_ID, type Biome, type TreeDefinition } from "../BiomeTypes";
import { BIG_OAK_TREE, PETRIFIED_TREE } from "../TreeDefinition";

export const ANCIENT_RUINS_BIOME: Biome = {
	id: BIOME_ID.ANCIENT_RUINS_BIOME,
	name: "Ancient_Ruins",
	topBlock: 114, // cracked stone brick / ancient stone
	undergroundBlock: 19, // dirt (nature reclaiming the ruins)
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.08, // trees growing through the ruins
	grassDensity: 0.35, // overgrown vegetation
	beachBlock: 3, // sand
	seafloorBlock: 114, // submerged ruins floor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.65,
	persistence: 0.26,
	heightExponent: 1.15,
	terrainHeightBase: 46,
	terrainHeightAmplitude: 45,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return BIG_OAK_TREE;
		return null;
	},
};

export const PETRIFIED_FOREST: Biome = {
	id: BIOME_ID.PETRIFIED_FOREST,
	name: "Petrified_Forest",
	topBlock: 1, // stone (petrified ground, no living soil)
	undergroundBlock: 1, // stone
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.1, // petrified tree trunks (stone columns)
	grassDensity: 0.05, // almost no living vegetation
	beachBlock: 8, // gravel / rocky shore
	seafloorBlock: 1, // stone

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.7,
	persistence: 0.23,
	heightExponent: 1.1,
	terrainHeightBase: 47,
	terrainHeightAmplitude: 38,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		// TODO: replace with PETRIFIED_TREE (stone trunk, no leaves) once defined
		if (blockId === this.topBlock) return PETRIFIED_TREE;
		return null;
	},
};
