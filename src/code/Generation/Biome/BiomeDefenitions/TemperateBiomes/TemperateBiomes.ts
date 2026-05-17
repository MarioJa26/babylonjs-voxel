// TemperateBiomes.ts
import { BlockType } from "@/code/World/Texture/BlockType";
import { GenerationParams } from "../../../NoiseAndParameters/GenerationParams";
import { BIOME_ID, type Biome, type TreeDefinition } from "../../BiomeTypes";
import {
	AUTUMN_TREE,
	BIRCH_TREE,
	CHERRY_BLOSSOM_TREE,
	MAPLE_TREE,
	OAK_TREE,
	PINE_TREE,
	PLAINS_TREE,
	TEMPERATE_RAINFOREST_TREE,
} from "./TemperateTrees";

// ── Existing ──────────────────────────────────────────────────────────────────

export const FOREST: Biome = {
	id: BIOME_ID.FOREST,
	name: "Forest",
	topBlock: 15, // grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.15,
	grassDensity: 0.33,
	beachBlock: 3, // sand
	seafloorBlock: 46, // gravel seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.65,
	persistence: 0.24,
	heightExponent: 1.05,
	terrainHeightBase: 42,
	terrainHeightAmplitude: 33,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return OAK_TREE;
		return null;
	},
};

export const CHERRY_BLOSSOM_FOREST: Biome = {
	id: BIOME_ID.CHERRY_BLOSSOM_FOREST,
	name: "Cherry_Blossom_Forest",
	topBlock: 15, // grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.22, // dense cherry trees
	grassDensity: 0.5, // lush undergrowth
	beachBlock: 3, // sand
	seafloorBlock: 46, // gravel seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.65,
	persistence: 0.2,
	heightExponent: 1.08,
	terrainHeightBase: 44,
	terrainHeightAmplitude: 35,
	pvNoiseScale: 0.7,
	erosionNoiseScale: 0.5,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return CHERRY_BLOSSOM_TREE;
		return null;
	},
};

export const AUTUMN_FOREST: Biome = {
	id: BIOME_ID.AUTUMN_FOREST,
	name: "Autumn_Forest",
	topBlock: 15, // grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.2, // dense autumn trees
	grassDensity: 0.35,
	beachBlock: 3, // sand
	seafloorBlock: 46, // gravel seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.6,
	persistence: 0.24,
	heightExponent: 1.1,
	terrainHeightBase: 45,
	terrainHeightAmplitude: 40,
	pvNoiseScale: 0.8,
	erosionNoiseScale: 0.6,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return AUTUMN_TREE;
		return null;
	},
};

export const PINE_FOREST: Biome = {
	id: BIOME_ID.PINE_FOREST,
	name: "Pine_Forest",
	topBlock: 14, // mossy grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.2, // very dense pine trees
	grassDensity: 0.15, // sparse undergrowth under dense canopy
	beachBlock: 3, // sand
	seafloorBlock: 46, // gravel seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.55,
	persistence: 0.26,
	heightExponent: 1.15,
	terrainHeightBase: 46,
	terrainHeightAmplitude: 48,
	pvNoiseScale: 0.6,
	erosionNoiseScale: 0.5,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return PINE_TREE;
		return null;
	},
};

export const FERN_GULLY: Biome = {
	id: BIOME_ID.FERN_GULLY,
	name: "Fern_Gully",
	topBlock: 14, // mossy grass
	undergroundBlock: 8, // damp dirt / mud
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.85, // extremely dense ferns and moss
	beachBlock: 8, // mud
	seafloorBlock: 8, // mud

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.7,
	persistence: 0.2,
	heightExponent: 1.3, // gully shapes
	terrainHeightBase: GenerationParams.SEA_LEVEL + 3,
	terrainHeightAmplitude: 15, // low-lying gully
	pvNoiseScale: 0.4,
	erosionNoiseScale: 0.7,

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};

export const PLAINS: Biome = {
	id: BIOME_ID.PLAINS,
	name: "Plains",
	topBlock: 57, // plains grass (different shade)
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.06,
	grassDensity: 0.4,
	beachBlock: 3, // sand
	seafloorBlock: 46, // gravel seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.8,
	persistence: 0.18,
	heightExponent: 1.25,
	terrainHeightBase: 44,
	terrainHeightAmplitude: 32,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return PLAINS_TREE;
		return null;
	},
};

export const SWAMP: Biome = {
	id: BIOME_ID.SWAMP,
	name: "Swamp",
	topBlock: 57, // swamp grass
	undergroundBlock: 8, // mud / wet dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.08,
	grassDensity: 0.6,
	beachBlock: 8, // mud
	seafloorBlock: 57, // swamp grass underwater

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.7,
	persistence: 0.18,
	heightExponent: 1.4,
	terrainHeightBase: GenerationParams.SEA_LEVEL + 2,
	terrainHeightAmplitude: 6,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return OAK_TREE;
		return null;
	},
};

export const GROVE: Biome = {
	id: BIOME_ID.GROVE,
	name: "Grove",
	topBlock: 14, // mossy grass
	undergroundBlock: 46, // mossy dirt / loam
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.2,
	grassDensity: 0.6,
	beachBlock: 3, // sand
	seafloorBlock: 14, // mossy seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.65,
	persistence: 0.23,
	heightExponent: 1.1,
	terrainHeightBase: 46,
	terrainHeightAmplitude: 45,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return OAK_TREE;
		return null;
	},
};

export const GRASS_LAND: Biome = {
	id: BIOME_ID.GRASS_LAND,
	name: "Grass_Land",
	topBlock: 15, // grass
	undergroundBlock: 46, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.067,
	grassDensity: 0.5,
	beachBlock: 3, // sand
	seafloorBlock: 1, // stone seafloor

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

// ── New ───────────────────────────────────────────────────────────────────────

export const TEMPERATE_RAINFOREST: Biome = {
	id: BIOME_ID.TEMPERATE_RAINFOREST,
	name: "Temperate_Rainforest",
	topBlock: 14, // mossy grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.15, // very dense trees
	grassDensity: 0.7, // thick undergrowth
	beachBlock: 8, // gravel beach (cold coast)
	seafloorBlock: 46, // gravel seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.3,
	persistence: 0.28,
	heightExponent: 1.1,
	terrainHeightBase: 46,
	terrainHeightAmplitude: 66,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return TEMPERATE_RAINFOREST_TREE;
		return null;
	},
};

export const MAPLE_FOREST: Biome = {
	id: BIOME_ID.MAPLE_FOREST,
	name: "Maple_Forest",
	topBlock: 15, // grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.18,
	grassDensity: 0.3,
	beachBlock: 3, // sand
	seafloorBlock: 46, // gravel seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.65,
	persistence: 0.22,
	heightExponent: 1.08,
	terrainHeightBase: 44,
	terrainHeightAmplitude: 38,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return MAPLE_TREE;
		return null;
	},
};

export const BIRCH_FOREST: Biome = {
	id: BIOME_ID.BIRCH_FOREST,
	name: "Birch_Forest",
	topBlock: 15, // grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.2,
	grassDensity: 0.33, // lighter undergrowth, birch forests are bright
	beachBlock: 3, // sand
	seafloorBlock: 46, // gravel seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.7,
	persistence: 0.2,
	heightExponent: 1.05,
	terrainHeightBase: 43,
	terrainHeightAmplitude: 30,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return BIRCH_TREE;
		return null;
	},
};

export const MEADOW: Biome = {
	id: BIOME_ID.MEADOW,
	name: "Meadow",
	topBlock: 15, // grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.75, // very dense flowers and tall grass
	beachBlock: 3, // sand
	seafloorBlock: 46, // gravel seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.85,
	persistence: 0.16,
	heightExponent: 1.1,
	terrainHeightBase: 44,
	terrainHeightAmplitude: 20, // gently rolling hills

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};

export const HEDGEROW: Biome = {
	id: BIOME_ID.HEDGEROW,
	name: "Hedgerow",
	topBlock: 15, // grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.1, // sparse trees clustered along hedge lines
	grassDensity: 0.5,
	beachBlock: 3, // sand
	seafloorBlock: 46, // gravel seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.8,
	persistence: 0.19,
	heightExponent: 1.12,
	terrainHeightBase: 44,
	terrainHeightAmplitude: 25,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return OAK_TREE;
		return null;
	},
};

export const PEAT_BOG: Biome = {
	id: BIOME_ID.PEAT_BOG,
	name: "Peat_Bog",
	topBlock: BlockType.Peat, // peat / dark soggy dirt
	undergroundBlock: BlockType.Peat, // peat
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.05, // sparse dead/mossy trees
	grassDensity: 0.45, // reeds and bog grass
	beachBlock: 8, // peat shoreline
	seafloorBlock: BlockType.Peat, // peat bog floor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.75,
	persistence: 0.19,
	heightExponent: 1.15,
	terrainHeightBase: GenerationParams.SEA_LEVEL + 1,
	terrainHeightAmplitude: 8, // nearly flat, waterlogged

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return OAK_TREE;
		return null;
	},
};

export const WETLANDS: Biome = {
	id: BIOME_ID.WETLANDS,
	name: "Wetlands",
	topBlock: 57, // wet grass / marsh grass
	undergroundBlock: 8, // mud
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.06,
	grassDensity: 0.65, // dense reeds and marsh plants
	beachBlock: 8, // mud shoreline
	seafloorBlock: 8, // mud floor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.75,
	persistence: 0.17,
	heightExponent: 1.2,
	terrainHeightBase: GenerationParams.SEA_LEVEL + 2,
	terrainHeightAmplitude: 9,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return OAK_TREE;
		return null;
	},
};
