// MountainBiomes.ts
import { BlockType } from "@/code/World/Texture/BlockType";
import { GenerationParams } from "../../../NoiseAndParameters/GenerationParams";
import { BIOME_ID, type Biome, type TreeDefinition } from "../../BiomeTypes";
import { CONIFER_TREE } from "./MountainTrees";

// ── Mountain / Highland Biomes ────────────────────────────────────────────────

export const ALPINE_MEADOW: Biome = {
	id: BIOME_ID.ALPINE_MEADOW,
	name: "Alpine_Meadow",
	topBlock: BlockType.Grass001, // alpine grass
	undergroundBlock: 19, // dirt
	stoneBlock: 1, // stone
	canSpawnTrees: true,
	treeDensity: 0.08, // sparse conifers at treeline
	grassDensity: 0.3, // lush alpine grass
	beachBlock: BlockType.RocksGround02, // rocky shore
	seafloorBlock: BlockType.RocksGround02, // rocky seafloor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.5,
	persistence: 0.25,
	heightExponent: 1.9, // sharper alpine peaks
	terrainHeightBase: GenerationParams.SEA_LEVEL + 55,
	terrainHeightAmplitude: 67,
	pvNoiseScale: 0.6,
	erosionNoiseScale: 0.5,

	getTreeForBlock(blockId: number): TreeDefinition | null {
		if (blockId === this.topBlock) return CONIFER_TREE;
		return null;
	},
};

export const ROCKY_HIGHLANDS: Biome = {
	id: BIOME_ID.ROCKY_HIGHLANDS,
	name: "Rocky_Highlands",
	topBlock: BlockType.RockyTerrain02, // rocky ground cover
	undergroundBlock: 1, // stone
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.05, // almost no vegetation
	beachBlock: BlockType.GrayRocks, // gray rock shoreline
	seafloorBlock: BlockType.GrayRocks, // gray rock floor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.4,
	persistence: 0.35,
	heightExponent: 2.4, // jagged rocky terrain
	terrainHeightBase: GenerationParams.SEA_LEVEL + 60,
	terrainHeightAmplitude: 90,
	pvNoiseScale: 1.5, // high detail for rocky texture
	erosionNoiseScale: 0.8,

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};

export const MESA_PLATEAU: Biome = {
	id: BIOME_ID.MESA_PLATEAU,
	name: "Mesa_Plateau",
	topBlock: BlockType.TerracottaBlock, // terracotta surface
	undergroundBlock: BlockType.TerracottaBlock, // layered terracotta
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.03, // very sparse dry grass
	beachBlock: BlockType.GravellySand, // sandy/gravelly shore
	seafloorBlock: BlockType.TerracottaBlock, // terracotta floor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.45,
	persistence: 0.28,
	heightExponent: 2.3, // flat-topped mesa with steep walls
	terrainHeightBase: GenerationParams.SEA_LEVEL + 50,
	terrainHeightAmplitude: 70,
	pvNoiseScale: 0.3, // smoother plateau tops
	erosionNoiseScale: 1.2, // eroded cliff faces

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};

export const CLOUD_PEAKS: Biome = {
	id: BIOME_ID.CLOUD_PEAKS,
	name: "Cloud_Peaks",
	topBlock: BlockType.MossyCobble, // mossy cobblestone (snow-dusted rock)
	undergroundBlock: 1, // stone
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.0, // nothing grows at this altitude
	beachBlock: BlockType.MossyCobble, // mossy rock
	seafloorBlock: BlockType.StoneTiles02, // stone floor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.3,
	persistence: 0.4,
	heightExponent: 3.2, // dramatic mountain peaks
	terrainHeightBase: GenerationParams.SEA_LEVEL + 80,
	terrainHeightAmplitude: 120,
	pvNoiseScale: 1.8, // extreme detail for craggy peaks
	erosionNoiseScale: 1.0,

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};

export const VOLCANIC_CALDERA: Biome = {
	id: BIOME_ID.VOLCANIC_CALDERA,
	name: "Volcanic_Caldera",
	topBlock: BlockType.BasaltBlock, // basalt surface
	undergroundBlock: BlockType.BasaltBlock, // basalt
	stoneBlock: 1, // stone
	canSpawnTrees: false,
	treeDensity: 0.0,
	grassDensity: 0.0, // nothing grows in volcanic zone
	beachBlock: BlockType.Obsidian, // obsidian shoreline
	seafloorBlock: BlockType.BasaltBlock, // basalt floor

	terrainScale: GenerationParams.TERRAIN_SCALE * 0.35,
	persistence: 0.38,
	heightExponent: 2.9, // steep volcanic cone
	terrainHeightBase: GenerationParams.SEA_LEVEL + 70,
	terrainHeightAmplitude: 110,
	pvNoiseScale: 1.3, // rough volcanic texture
	erosionNoiseScale: 0.9,

	getTreeForBlock(): TreeDefinition | null {
		return null;
	},
};
