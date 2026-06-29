import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import {
	ARCHIPELAGO,
	BIOLUMINESCENT_BAY,
	CORAL_REEF,
	DEEP_OCEAN_TRENCH,
	KELP_FOREST,
	OCEAN,
	RIVER,
	ROCKY_SHORE,
	SANDY_SHORE,
	TIDAL_FLATS,
} from "./BiomeDefinitions/CoastalBiomes/CoastalBiomes";
import {
	AURORA_TUNDRA,
	FROZEN_OCEAN,
	FROZEN_TUNDRA_PLAINS,
	GLACIER,
	ICE_SPIKES,
	PERMAFROST_BOG,
	SNOWY_PLAINS,
	TUNDRA,
	TUNDRA_MOUNTAINS,
} from "./BiomeDefinitions/ColdBiomes/ColdBiomes";
import {
	ANCIENT_RUINS_BIOME,
	ASHEN_WASTELAND,
	PETRIFIED_FOREST,
} from "./BiomeDefinitions/ExoticBiomes/ExoticBiomes";
import {
	CRYSTAL_CAVES,
	GEOTHERMAL_FIELD,
	MUSHROOM_FIELDS,
	OBSIDIAN_FLATS,
} from "./BiomeDefinitions/GeologicalBiomes/GeologicalBiomes";
import {
	BADLANDS,
	BASALT_DELTAS,
	CRACKED_EARTH,
	DESERT,
	DUNE_SEA,
	DUST_BOWL,
	OASIS,
	RED_ROCK_CANYON,
	SALT_FLATS,
	SAVANNAH,
	SCORCHED_SAVANNAH,
	VOLCANIC_WASTELAND,
} from "./BiomeDefinitions/HotBiomes/HotBiomes";
import {
	ALPINE_MEADOW,
	CLOUD_PEAKS,
	MESA_PLATEAU,
	ROCKY_HIGHLANDS,
	VOLCANIC_CALDERA,
} from "./BiomeDefinitions/MountainBiomes/MountainBiomes";
import {
	AUTUMN_FOREST,
	BIRCH_FOREST,
	CHERRY_BLOSSOM_FOREST,
	FERN_GULLY,
	FOREST,
	GRASS_LAND,
	GROVE,
	HEDGEROW,
	MAPLE_FOREST,
	MEADOW,
	PEAT_BOG,
	PINE_FOREST,
	PLAINS,
	SWAMP,
	TEMPERATE_RAINFOREST,
	WETLANDS,
} from "./BiomeDefinitions/TemperateBiomes/TemperateBiomes";
import {
	BAMBOO_FOREST,
	CLOUD_FOREST,
	JUNGLE,
	MANGROVE,
	TROPICAL_ISLAND,
} from "./BiomeDefinitions/TropicalBiomes/TropicalBiomes";
import { BIOME_ID, type Biome } from "./BiomeTypes";

export const BIOME_REGISTRY: Record<BIOME_ID, Biome> = {
	// Existing
	[BIOME_ID.FOREST]: FOREST,
	[BIOME_ID.TUNDRA]: TUNDRA,
	[BIOME_ID.TUNDRA_MOUNTAINS]: TUNDRA_MOUNTAINS,
	[BIOME_ID.DESERT]: DESERT,
	[BIOME_ID.JUNGLE]: JUNGLE,
	[BIOME_ID.PLAINS]: PLAINS,
	[BIOME_ID.SWAMP]: SWAMP,
	[BIOME_ID.GROVE]: GROVE,
	[BIOME_ID.SANDY_SHORE]: SANDY_SHORE,
	[BIOME_ID.ROCKY_SHORE]: ROCKY_SHORE,
	[BIOME_ID.OCEAN]: OCEAN,
	[BIOME_ID.RIVER]: RIVER,
	[BIOME_ID.GRASS_LAND]: GRASS_LAND,
	[BIOME_ID.VOLCANIC_WASTELAND]: VOLCANIC_WASTELAND,
	[BIOME_ID.BASALT_DELTAS]: BASALT_DELTAS,
	[BIOME_ID.SAVANNAH]: SAVANNAH,

	// Cold / Arctic
	[BIOME_ID.FROZEN_OCEAN]: FROZEN_OCEAN,
	[BIOME_ID.ICE_SPIKES]: ICE_SPIKES,
	[BIOME_ID.SNOWY_PLAINS]: SNOWY_PLAINS,
	[BIOME_ID.PERMAFROST_BOG]: PERMAFROST_BOG,
	[BIOME_ID.GLACIER]: GLACIER,

	// Temperate
	[BIOME_ID.TEMPERATE_RAINFOREST]: TEMPERATE_RAINFOREST,
	[BIOME_ID.MAPLE_FOREST]: MAPLE_FOREST,
	[BIOME_ID.BIRCH_FOREST]: BIRCH_FOREST,
	[BIOME_ID.MEADOW]: MEADOW,
	[BIOME_ID.HEDGEROW]: HEDGEROW,
	[BIOME_ID.PEAT_BOG]: PEAT_BOG,
	[BIOME_ID.WETLANDS]: WETLANDS,

	// Hot / Arid
	[BIOME_ID.BADLANDS]: BADLANDS,
	[BIOME_ID.RED_ROCK_CANYON]: RED_ROCK_CANYON,
	[BIOME_ID.OASIS]: OASIS,
	[BIOME_ID.SALT_FLATS]: SALT_FLATS,
	[BIOME_ID.DUNE_SEA]: DUNE_SEA,
	[BIOME_ID.SCORCHED_SAVANNAH]: SCORCHED_SAVANNAH,

	// Tropical
	[BIOME_ID.MANGROVE]: MANGROVE,
	[BIOME_ID.BAMBOO_FOREST]: BAMBOO_FOREST,
	[BIOME_ID.TROPICAL_ISLAND]: TROPICAL_ISLAND,
	[BIOME_ID.CLOUD_FOREST]: CLOUD_FOREST,

	// Underground / Geological
	[BIOME_ID.MUSHROOM_FIELDS]: MUSHROOM_FIELDS,
	[BIOME_ID.CRYSTAL_CAVES]: CRYSTAL_CAVES,
	[BIOME_ID.OBSIDIAN_FLATS]: OBSIDIAN_FLATS,
	[BIOME_ID.GEOTHERMAL_FIELD]: GEOTHERMAL_FIELD,

	// Coastal / Aquatic
	[BIOME_ID.CORAL_REEF]: CORAL_REEF,
	[BIOME_ID.KELP_FOREST]: KELP_FOREST,
	[BIOME_ID.TIDAL_FLATS]: TIDAL_FLATS,
	[BIOME_ID.ARCHIPELAGO]: ARCHIPELAGO,

	// Rare / Exotic
	[BIOME_ID.ANCIENT_RUINS_BIOME]: ANCIENT_RUINS_BIOME,
	[BIOME_ID.PETRIFIED_FOREST]: PETRIFIED_FOREST,

	// Mountain / Highland
	[BIOME_ID.ALPINE_MEADOW]: ALPINE_MEADOW,
	[BIOME_ID.ROCKY_HIGHLANDS]: ROCKY_HIGHLANDS,
	[BIOME_ID.MESA_PLATEAU]: MESA_PLATEAU,
	[BIOME_ID.CLOUD_PEAKS]: CLOUD_PEAKS,
	[BIOME_ID.VOLCANIC_CALDERA]: VOLCANIC_CALDERA,

	// Cold / Arctic (new)
	[BIOME_ID.FROZEN_TUNDRA_PLAINS]: FROZEN_TUNDRA_PLAINS,
	[BIOME_ID.AURORA_TUNDRA]: AURORA_TUNDRA,

	// Temperate (new)
	[BIOME_ID.CHERRY_BLOSSOM_FOREST]: CHERRY_BLOSSOM_FOREST,
	[BIOME_ID.AUTUMN_FOREST]: AUTUMN_FOREST,
	[BIOME_ID.PINE_FOREST]: PINE_FOREST,
	[BIOME_ID.FERN_GULLY]: FERN_GULLY,

	// Hot / Arid (new)
	[BIOME_ID.CRACKED_EARTH]: CRACKED_EARTH,
	[BIOME_ID.DUST_BOWL]: DUST_BOWL,

	// Aquatic / Coastal (new)
	[BIOME_ID.DEEP_OCEAN_TRENCH]: DEEP_OCEAN_TRENCH,
	[BIOME_ID.BIOLUMINESCENT_BAY]: BIOLUMINESCENT_BAY,

	// Exotic / Rare (new)
	[BIOME_ID.ASHEN_WASTELAND]: ASHEN_WASTELAND,
};

export function getBiomeFor(
	temperature: number,
	humidity: number,
	continentalness: number,
	river: number,
	terrainShapedHeight: number,
): Biome {
	const SEA = GenerationParams.SEA_LEVEL;

	// ── Deep ocean trench ─────────────────────────────────────────────────────
	if (continentalness < -0.9) {
		return DEEP_OCEAN_TRENCH;
	}

	// ── Open ocean ────────────────────────────────────────────────────────────
	if (continentalness < -0.27 && terrainShapedHeight < SEA) {
		if (temperature < 0.2) return FROZEN_OCEAN;
		if (temperature > 0.6) return CORAL_REEF;
		if (temperature < 0.45) return KELP_FOREST;
		// ── Archipelago ───────────────────────────────────────────────────────────
		if (
			continentalness < -0.8 &&
			continentalness > -0.84 &&
			temperature > 0.55
		) {
			return ARCHIPELAGO;
		}
		return OCEAN;
	}

	/*
	// ── Hard gate: nothing below sea level gets a land biome ─────────────────
	if (terrainShapedHeight < SEA) {
		return OCEAN;
	}
	*/

	// ── Shore band above water ────────────────────────────────────────────────
	if (continentalness < -0.15) {
		if (temperature < 0.25) return TIDAL_FLATS;
		if (temperature < 0.4) return ROCKY_SHORE;
		return SANDY_SHORE;
	}

	// ── Bioluminescent Bay ────────────────────────────────────────────────────
	if (
		continentalness >= -0.5 &&
		continentalness < 0.0 &&
		terrainShapedHeight >= SEA &&
		terrainShapedHeight < SEA + 4 &&
		temperature > 0.5 &&
		humidity > 0.5 &&
		humidity < 0.7
	) {
		return BIOLUMINESCENT_BAY;
	}

	// ── Extreme altitude / far inland ─────────────────────────────────────────
	if (continentalness > 0.75) {
		if (temperature < 0.3) return GLACIER;
		if (temperature < 0.55) return TUNDRA_MOUNTAINS;
		if (temperature > 0.85) return VOLCANIC_WASTELAND;
		return TUNDRA_MOUNTAINS;
	}

	// ── Mountain / Highland biomes ────────────────────────────────────────────
	if (terrainShapedHeight > SEA + 50 && continentalness > 0.4) {
		if (temperature < 0.25) return CLOUD_PEAKS;
		if (temperature > 0.85) return VOLCANIC_CALDERA;
		if (humidity < 0.15 && temperature > 0.6) return MESA_PLATEAU;
		if (humidity < 0.25) return ROCKY_HIGHLANDS;
		if (humidity > 0.4 && temperature < 0.6) return ALPINE_MEADOW;
		return ROCKY_HIGHLANDS;
	}

	if (terrainShapedHeight > SEA + 35 && continentalness > 0.3) {
		if (temperature < 0.3) return CLOUD_PEAKS;
		if (temperature > 0.8 && humidity < 0.2) return VOLCANIC_CALDERA;
		if (humidity < 0.2 && temperature > 0.55) return MESA_PLATEAU;
		if (humidity < 0.3) return ROCKY_HIGHLANDS;
		if (humidity > 0.45) return ALPINE_MEADOW;
	}

	// ── Freezing temperature ──────────────────────────────────────────────────
	if (temperature < 0.2) {
		if (terrainShapedHeight > SEA + 40) return ICE_SPIKES;
		if (humidity < 0.15) return FROZEN_TUNDRA_PLAINS;
		if (humidity < 0.3) return SNOWY_PLAINS;
		if (humidity < 0.55) return GLACIER;
		if (humidity > 0.6) return AURORA_TUNDRA;
		return PERMAFROST_BOG;
	}

	// ── Cold temperature ──────────────────────────────────────────────────────
	if (temperature < 0.45) {
		if (continentalness > 0.5) {
			return humidity < 0.5 ? TUNDRA : TUNDRA_MOUNTAINS;
		}
		if (humidity < 0.12) return FROZEN_TUNDRA_PLAINS;
		if (humidity < 0.2) return SNOWY_PLAINS;
		if (humidity < 0.45) return GRASS_LAND;
		if (humidity > 0.65 && terrainShapedHeight < SEA + 15)
			return PERMAFROST_BOG;
		if (humidity > 0.55 && terrainShapedHeight < SEA + 30) return AURORA_TUNDRA;
		return TUNDRA;
	}

	// ── Waterlogged / low-lying wet biomes ───────────────────────────────────
	if (terrainShapedHeight < SEA + 8) {
		if (humidity > 0.65) {
			if (temperature > 0.6) return MANGROVE;
			return SWAMP;
		}
		if (humidity > 0.5 && temperature < 0.6) return WETLANDS;
		if (humidity > 0.5 && temperature > 0.6) return MANGROVE;
	}

	// ── Near sea level — shore-adjacent flat biomes ───────────────────────────
	if (terrainShapedHeight < SEA + 12) {
		if (temperature > 0.7 && humidity < 0.1) return SALT_FLATS;
		if (temperature > 0.55 && humidity < 0.4) return TIDAL_FLATS;
		if (humidity > 0.55 && temperature < 0.5) return PEAT_BOG;
	}

	// ── Hot regions ───────────────────────────────────────────────────────────
	if (temperature > 0.85) {
		if (continentalness > 0.2 && continentalness < 0.6) return BASALT_DELTAS;
		if (continentalness > -0.3) return VOLCANIC_WASTELAND;
	}

	// ── Ashen Wasteland ───────────────────────────────────────────────────────
	if (
		temperature > 0.75 &&
		humidity < 0.1 &&
		continentalness > 0.15 &&
		continentalness < 0.55 &&
		terrainShapedHeight > SEA + 10 &&
		terrainShapedHeight < SEA + 45
	) {
		return ASHEN_WASTELAND;
	}

	// ── Hot + dry gradients ───────────────────────────────────────────────────
	if (temperature > 0.67) {
		if (humidity < 0.08) {
			if (terrainShapedHeight < SEA + 20) return DUST_BOWL;
			return CRACKED_EARTH;
		}
		if (humidity < 0.2) {
			if (terrainShapedHeight > SEA + 50) return RED_ROCK_CANYON;
			if (terrainShapedHeight > SEA + 25) return BADLANDS;
			return DUNE_SEA;
		}
		if (humidity < 0.3) {
			if (terrainShapedHeight > SEA + 30) return BADLANDS;
			return DESERT;
		}
		if (humidity < 0.38) {
			if (terrainShapedHeight < SEA + 20) return OASIS;
			if (continentalness < 0.3) return SALT_FLATS;
		}
		if (humidity < 0.5) {
			if (terrainShapedHeight > SEA + 35) return RED_ROCK_CANYON;
			return SCORCHED_SAVANNAH;
		}
		if (humidity < 0.62) return SAVANNAH;
		if (terrainShapedHeight > SEA + 55) return CLOUD_FOREST;
		return JUNGLE;
	}

	// ── Temperate wet biomes ──────────────────────────────────────────────────
	if (humidity > 0.65) {
		if (terrainShapedHeight < SEA + 15) return SWAMP;
		if (temperature > 0.55) return GROVE;
		return TEMPERATE_RAINFOREST;
	}

	if (humidity > 0.55) {
		if (temperature > 0.4 && temperature < 0.7) return GROVE;
		if (temperature >= 0.7) return BAMBOO_FOREST;
		return TEMPERATE_RAINFOREST;
	}

	// ── Fern Gully ────────────────────────────────────────────────────────────
	if (
		humidity > 0.5 &&
		temperature > 0.4 &&
		temperature < 0.65 &&
		terrainShapedHeight < SEA + 10 &&
		terrainShapedHeight >= SEA
	) {
		return FERN_GULLY;
	}

	// ── Rare / exotic biomes ──────────────────────────────────────────────────
	if (
		humidity > 0.45 &&
		humidity < 0.58 &&
		temperature > 0.4 &&
		temperature < 0.6 &&
		continentalness > -0.1 &&
		continentalness < 0.15
	) {
		return MUSHROOM_FIELDS;
	}

	if (
		temperature > 0.35 &&
		temperature < 0.6 &&
		humidity < 0.2 &&
		terrainShapedHeight > SEA + 60
	) {
		return CRYSTAL_CAVES;
	}

	if (
		temperature > 0.6 &&
		humidity < 0.25 &&
		continentalness > 0.3 &&
		continentalness < 0.65 &&
		terrainShapedHeight < SEA + 20
	) {
		return OBSIDIAN_FLATS;
	}

	if (
		temperature > 0.7 &&
		humidity > 0.3 &&
		humidity < 0.5 &&
		continentalness > 0.4
	) {
		return GEOTHERMAL_FIELD;
	}

	if (
		humidity < 0.22 &&
		temperature > 0.35 &&
		temperature < 0.65 &&
		terrainShapedHeight > SEA + 20 &&
		terrainShapedHeight < SEA + 50
	) {
		return PETRIFIED_FOREST;
	}

	if (
		temperature > 0.4 &&
		temperature < 0.65 &&
		humidity > 0.3 &&
		humidity < 0.5 &&
		terrainShapedHeight > SEA + 15 &&
		terrainShapedHeight < SEA + 40 &&
		continentalness > 0.1 &&
		continentalness < 0.5
	) {
		return ANCIENT_RUINS_BIOME;
	}

	if (
		temperature > 0.6 &&
		continentalness > -0.33 &&
		terrainShapedHeight < SEA + 20
	) {
		return TROPICAL_ISLAND;
	}

	// ── Temperate dry ─────────────────────────────────────────────────────────
	if (humidity < 0.24) return PLAINS;

	// ── Temperate standard ────────────────────────────────────────────────────
	if (temperature < 0.5) return GRASS_LAND;

	if (
		temperature > 0.4 &&
		temperature < 0.55 &&
		humidity > 0.3 &&
		humidity < 0.5 &&
		terrainShapedHeight > SEA + 15 &&
		terrainShapedHeight < SEA + 50
	) {
		return PINE_FOREST;
	}

	if (
		temperature > 0.5 &&
		temperature < 0.62 &&
		humidity > 0.35 &&
		humidity < 0.55 &&
		terrainShapedHeight > SEA + 10 &&
		terrainShapedHeight < SEA + 40 &&
		continentalness > 0.05 &&
		continentalness < 0.45
	) {
		return CHERRY_BLOSSOM_FOREST;
	}

	if (
		temperature > 0.48 &&
		temperature < 0.6 &&
		humidity > 0.28 &&
		humidity < 0.45 &&
		terrainShapedHeight > SEA + 10 &&
		terrainShapedHeight < SEA + 45
	) {
		return AUTUMN_FOREST;
	}

	if (humidity > 0.45) {
		if (temperature > 0.55) return MAPLE_FOREST;
		return BIRCH_FOREST;
	}

	if (humidity > 0.35) {
		if (terrainShapedHeight > SEA + 35) return HEDGEROW;
		return MEADOW;
	}

	return FOREST;
}
