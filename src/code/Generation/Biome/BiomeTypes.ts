export type TreeDefinition = {
	woodId: number;
	leavesId: number;
	baseHeight: number;
	heightVariance: number;
	/**
	 * Generates the blocks for this tree type at the given world coordinates.
	 * @param worldX The world X coordinate of the tree's base.
	 * @param worldY The world Y coordinate of the tree's base (usually terrainHeight + 1).
	 * @param worldZ The world Z coordinate of the tree's base.
	 * @param placeBlock A callback function to place a block in the current chunk's block array.
	 * @param seedAsInt The integer seed for deterministic height calculation.
	 */
	generate(
		worldX: number,
		worldY: number,
		worldZ: number,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			blockId: number,
			overwrite?: boolean,
		) => void,
		seedAsInt: number,
	): void;
};

export interface Biome {
	id: BIOME_ID;
	name: string;
	topBlock: number;
	undergroundBlock: number;
	stoneBlock: number;
	canSpawnTrees: boolean;
	treeDensity: number;
	grassDensity: number;
	beachBlock: number;
	seafloorBlock: number;
	terrainHeightBase?: number;
	terrainHeightAmplitude?: number;
	terrainScale?: number;
	octaves?: number;
	persistence?: number;
	lacunarity?: number;
	heightExponent?: number;
	pvNoiseScale?: number;
	erosionNoiseScale?: number;
	continentalNoiseScale?: number;
	findlingChance?: number;
	findlingBlockId?: number;
	getTreeForBlock(blockId?: number, noiseValue?: number): TreeDefinition | null;
}
export const enum BIOME_ID {
	// Existing
	FOREST,
	TUNDRA,
	TUNDRA_MOUNTAINS,
	DESERT,
	JUNGLE,
	PLAINS,
	SWAMP,
	GROVE,
	SANDY_SHORE,
	ROCKY_SHORE,
	OCEAN,
	RIVER,
	GRASS_LAND,
	VOLCANIC_WASTELAND,
	BASALT_DELTAS,
	SAVANNAH,

	// Cold / Arctic
	FROZEN_OCEAN,
	ICE_SPIKES,
	SNOWY_PLAINS,
	PERMAFROST_BOG,
	GLACIER,

	// Temperate
	TEMPERATE_RAINFOREST,
	MAPLE_FOREST,
	BIRCH_FOREST,
	MEADOW,
	HEDGEROW,
	PEAT_BOG,
	WETLANDS,

	// Hot / Arid
	BADLANDS,
	RED_ROCK_CANYON,
	OASIS,
	SALT_FLATS,
	DUNE_SEA,
	SCORCHED_SAVANNAH,

	// Tropical
	MANGROVE,
	BAMBOO_FOREST,
	TROPICAL_ISLAND,
	CLOUD_FOREST,

	// Underground / Geological
	MUSHROOM_FIELDS,
	CRYSTAL_CAVES,
	OBSIDIAN_FLATS,
	GEOTHERMAL_FIELD,

	// Coastal / Aquatic
	CORAL_REEF,
	KELP_FOREST,
	TIDAL_FLATS,
	ARCHIPELAGO,

	// Rare / Exotic
	ANCIENT_RUINS_BIOME,
	PETRIFIED_FOREST,

	// Mountain / Highland
	ALPINE_MEADOW,
	ROCKY_HIGHLANDS,
	MESA_PLATEAU,
	CLOUD_PEAKS,
	VOLCANIC_CALDERA,

	// Cold / Arctic (new)
	FROZEN_TUNDRA_PLAINS,
	AURORA_TUNDRA,

	// Temperate (new)
	CHERRY_BLOSSOM_FOREST,
	AUTUMN_FOREST,
	PINE_FOREST,
	FERN_GULLY,

	// Hot / Arid (new)
	CRACKED_EARTH,
	DUST_BOWL,

	// Aquatic / Coastal (new)
	DEEP_OCEAN_TRENCH,
	BIOLUMINESCENT_BAY,

	// Exotic / Rare (new)
	ASHEN_WASTELAND,
}
