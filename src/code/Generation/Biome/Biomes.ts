import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import {
	ARCHIPELAGO,
	CORAL_REEF,
	KELP_FOREST,
	OCEAN,
	RIVER,
	ROCKY_SHORE,
	SANDY_SHORE,
	TIDAL_FLATS,
} from "./BiomeDefenitions/CoastalBiomes";
import {
	FROZEN_OCEAN,
	GLACIER,
	ICE_SPIKES,
	PERMAFROST_BOG,
	SNOWY_PLAINS,
	TUNDRA,
	TUNDRA_MOUNTAINS,
} from "./BiomeDefenitions/ColdBiomes";
import {
	ANCIENT_RUINS_BIOME,
	PETRIFIED_FOREST,
} from "./BiomeDefenitions/ExoticBiomes";
import {
	CRYSTAL_CAVES,
	GEOTHERMAL_FIELD,
	MUSHROOM_FIELDS,
	OBSIDIAN_FLATS,
} from "./BiomeDefenitions/GeologicalBiomes";
import {
	BADLANDS,
	BASALT_DELTAS,
	DESERT,
	DUNE_SEA,
	OASIS,
	RED_ROCK_CANYON,
	SALT_FLATS,
	SAVANNAH,
	SCORCHED_SAVANNAH,
	VOLCANIC_WASTELAND,
} from "./BiomeDefenitions/HotBiomes";
import {
	BIRCH_FOREST,
	FOREST,
	GRASS_LAND,
	GROVE,
	HEDGEROW,
	MAPLE_FOREST,
	MEADOW,
	PEAT_BOG,
	PLAINS,
	SWAMP,
	TEMPERATE_RAINFOREST,
	WETLANDS,
} from "./BiomeDefenitions/TemperateBiomes";
import {
	BAMBOO_FOREST,
	CLOUD_FOREST,
	JUNGLE,
	MANGROVE,
	TROPICAL_ISLAND,
} from "./BiomeDefenitions/TropicalBiomes";
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
};

export function getBiomeFor(
	temperature: number,
	humidity: number,
	continentalness: number,
	river: number,
	terrainShapedHeight: number,
): Biome {
	const SEA = GenerationParams.SEA_LEVEL;

	// ── River ─────────────────────────────────────────────────────────────────
	/*
	if (river < 0.1 && continentalness > -0.28 && continentalness < 0.67) {
		return RIVER;
	}
	*/

	// ── Deep ocean / underwater biomes ────────────────────────────────────────
	if (continentalness < -0.33 && terrainShapedHeight < SEA) {
		if (temperature > 0.6) return CORAL_REEF;
		if (temperature < 0.2) return FROZEN_OCEAN;
		return KELP_FOREST;
	}

	// Shallow ocean (not deep, not yet shore)
	if (continentalness < -0.1 && terrainShapedHeight < SEA) {
		if (temperature < 0.2) return FROZEN_OCEAN;
		return OCEAN;
	}

	// ── Shore biomes ──────────────────────────────────────────────────────────
	const isNearShore = continentalness > -0.3 && continentalness < 0.2;
	if (isNearShore && terrainShapedHeight < SEA + 10) {
		if (temperature > 0.65) return SANDY_SHORE;
		if (temperature < 0.25) return TIDAL_FLATS;
		if (temperature < 0.4) return ROCKY_SHORE;
		return SANDY_SHORE;
	}

	// Archipelago — small land fragments just above sea level near ocean
	if (
		continentalness > -0.15 &&
		continentalness < 0.1 &&
		terrainShapedHeight < SEA + 15 &&
		terrainShapedHeight >= SEA
	) {
		if (temperature > 0.55) return ARCHIPELAGO;
	}

	// ── Extreme altitude / far inland ─────────────────────────────────────────
	if (continentalness > 0.75) {
		if (temperature < 0.3) return GLACIER;
		if (temperature < 0.55) return TUNDRA_MOUNTAINS;
		if (temperature > 0.85) return VOLCANIC_WASTELAND;
		return TUNDRA_MOUNTAINS;
	}

	// ── Freezing temperature — cold biomes ────────────────────────────────────
	if (temperature < 0.2) {
		if (terrainShapedHeight > SEA + 40) return ICE_SPIKES;
		if (humidity < 0.3) return SNOWY_PLAINS;
		if (humidity < 0.55) return GLACIER;
		return PERMAFROST_BOG;
	}

	// ── Cold temperature ──────────────────────────────────────────────────────
	if (temperature < 0.45) {
		if (continentalness > 0.5) {
			return humidity < 0.5 ? TUNDRA : TUNDRA_MOUNTAINS;
		}
		if (humidity < 0.2) return SNOWY_PLAINS;
		if (humidity < 0.45) return GRASS_LAND;
		if (humidity > 0.65 && terrainShapedHeight < SEA + 15)
			return PERMAFROST_BOG;
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
		if (temperature > 0.6 && humidity < 0.3) return SALT_FLATS;
		if (temperature > 0.55 && humidity < 0.4) return TIDAL_FLATS;
		if (humidity > 0.55 && temperature < 0.5) return PEAT_BOG;
	}

	// ── Hot regions ───────────────────────────────────────────────────────────
	if (temperature > 0.85) {
		if (continentalness > 0.2 && continentalness < 0.6) return BASALT_DELTAS;
		if (continentalness > -0.3) return VOLCANIC_WASTELAND;
	}

	if (temperature > 0.67) {
		if (humidity < 0.2) {
			// Very dry + hot
			if (terrainShapedHeight > SEA + 50) return RED_ROCK_CANYON;
			if (terrainShapedHeight > SEA + 25) return BADLANDS;
			return DUNE_SEA;
		}
		if (humidity < 0.3) {
			if (terrainShapedHeight > SEA + 30) return BADLANDS;
			return DESERT;
		}
		if (humidity < 0.38) {
			// Small oasis pockets — low lying, moderate humidity in the desert band
			if (terrainShapedHeight < SEA + 10) return OASIS;
			return SALT_FLATS;
		}
		if (humidity < 0.5) {
			if (terrainShapedHeight > SEA + 35) return RED_ROCK_CANYON;
			return SCORCHED_SAVANNAH;
		}
		if (humidity < 0.62) return SAVANNAH;
		// Hot + very wet
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

	// ── Rare / exotic biomes — narrow parameter windows ──────────────────────
	// Mushroom Fields: temperate, moderate humidity, low continentalness islands
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

	// Crystal Caves: expressed as surface biome on very high, dry, mid-temp terrain
	if (
		temperature > 0.35 &&
		temperature < 0.6 &&
		humidity < 0.2 &&
		terrainShapedHeight > SEA + 60
	) {
		return CRYSTAL_CAVES;
	}

	// Obsidian Flats: hot, dry, mid continentalness flat terrain
	if (
		temperature > 0.6 &&
		humidity < 0.25 &&
		continentalness > 0.3 &&
		continentalness < 0.65 &&
		terrainShapedHeight < SEA + 20
	) {
		return OBSIDIAN_FLATS;
	}

	// Geothermal Field: hot inland, moderate humidity
	if (
		temperature > 0.7 &&
		humidity > 0.3 &&
		humidity < 0.5 &&
		continentalness > 0.4
	) {
		return GEOTHERMAL_FIELD;
	}

	// Petrified Forest: dry, mid-temp, mid-altitude
	if (
		humidity < 0.22 &&
		temperature > 0.35 &&
		temperature < 0.65 &&
		terrainShapedHeight > SEA + 20 &&
		terrainShapedHeight < SEA + 50
	) {
		return PETRIFIED_FOREST;
	}

	// Ancient Ruins: temperate, moderate humidity, slightly elevated
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

	// Tropical Island: warm, near sea level, low continentalness
	if (
		temperature > 0.55 &&
		continentalness > -0.05 &&
		continentalness < 0.12 &&
		terrainShapedHeight < SEA + 20
	) {
		return TROPICAL_ISLAND;
	}

	// ── Temperate dry regions ─────────────────────────────────────────────────
	if (humidity < 0.24) return PLAINS;

	// ── Temperate standard biomes ─────────────────────────────────────────────
	if (temperature < 0.5) return GRASS_LAND;

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
