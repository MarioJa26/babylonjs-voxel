// ColdBiomes.ts
import { GenerationParams } from "../../NoiseAndParameters/GenerationParams";
import { BIOME_ID, type Biome, type TreeDefinition } from "../BiomeTypes";
import { DEAD_TREE, ICE_SPIKE_COLUMN, OAK_TREE } from "../TreeDefinition";

// ── Existing ──────────────────────────────────────────────────────────────────

export const TUNDRA: Biome = {
	id: BIOME_ID.TUNDRA,
	name: "Tundra",
	topBlock: 9, // snow
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.0,
	grassDensity: 0.0,
	beachBlock: 8, // gravel
	seafloorBlock: 8, // gravel

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.5,
	persistence: 0.221,
	heightExponent: 1.1,
	terrainHeightBase: 50,
	terrainHeightAmplitude: 90,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return OAK_TREE;
		return null;
	},
};

export const TUNDRA_MOUNTAINS: Biome = {
	id: BIOME_ID.TUNDRA_MOUNTAINS,
	name: "Tundra_Mountains",
	topBlock: 9, // snow
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.0,
	grassDensity: 0.0,
	beachBlock: 8, // gravel
	seafloorBlock: 8, // gravel

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.4,
	persistence: 0.2,
	heightExponent: 2,
	terrainHeightBase: 80,
	terrainHeightAmplitude: 180,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return OAK_TREE;
		return null;
	},
};

// ── New ───────────────────────────────────────────────────────────────────────

export const FROZEN_OCEAN: Biome = {
	id: BIOME_ID.FROZEN_OCEAN,
	name: "Frozen_Ocean",
	topBlock: 74, // ice block (surface layer floating on water)
	undergroundBlock: 1, // packed ice
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.0,
	beachBlock: 9, // snow
	seafloorBlock: 8, // gravel

	terrainScale: GenerationParams.TERRAIN_SCALE,
	persistence: 0.18,
	heightExponent: 0.05,
	terrainHeightBase: 0,
	terrainHeightAmplitude: 0.3,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		return null;
	},
};

export const ICE_SPIKES: Biome = {
	id: BIOME_ID.ICE_SPIKES,
	name: "Ice_Spikes",
	topBlock: 74, // packed ice (forms the spike columns)
	undergroundBlock: 9, // snow
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.0,
	beachBlock: 9, // snow
	seafloorBlock: 8, // packed ice

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.45,
	persistence: 0.35,
	heightExponent: 2.8, // very spiky exponent for dramatic vertical terrain
	terrainHeightBase: 55,
	terrainHeightAmplitude: 120,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		return ICE_SPIKE_COLUMN;
	},
};

export const SNOWY_PLAINS: Biome = {
	id: BIOME_ID.SNOWY_PLAINS,
	name: "Snowy_Plains",
	topBlock: 9, // snow
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.02, // very sparse dead grass poking through snow
	beachBlock: 9, // snow
	seafloorBlock: 8, // gravel

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.9,
	persistence: 0.15,
	heightExponent: 1.05,
	terrainHeightBase: 43,
	terrainHeightAmplitude: 14, // very flat

	getTreeForBlock(blockId: number): TreeDefinition | null {
		return DEAD_TREE;
	},
};

export const PERMAFROST_BOG: Biome = {
	id: BIOME_ID.PERMAFROST_BOG,
	name: "Permafrost_Bog",
	topBlock: 69, // frozen mud / permafrost dirt
	undergroundBlock: 64, // frozen mud
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.1, // sparse frozen grass / dead reeds
	beachBlock: 8, // frozen mud
	seafloorBlock: 8, // frozen mud

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.7,
	persistence: 0.2,
	heightExponent: 1.1,
	terrainHeightBase: GenerationParams.SEA_LEVEL,
	terrainHeightAmplitude: 7,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		return null;
	},
};

export const GLACIER: Biome = {
	id: BIOME_ID.GLACIER,
	name: "Glacier",
	topBlock: 101, // packed ice
	undergroundBlock: 103, // blue ice (dense glacier core)
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.0,
	beachBlock: 101, // packed ice
	seafloorBlock: 103, // blue ice

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.5,
	persistence: 0.26,
	heightExponent: 1.4,
	terrainHeightBase: 58,
	terrainHeightAmplitude: 70, // large slow rolling hills of ice

	getTreeForBlock(blockId: number): TreeDefinition | null {
		return ICE_SPIKE_COLUMN;
	},
};
