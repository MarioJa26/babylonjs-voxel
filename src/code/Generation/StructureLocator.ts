import { CHUNK_SIZE } from "../Lib/VoxelMath";
import { ABANDONED_CABIN_REGION } from "./Structure/AbandonedCabinFeature";
import { ABYSSAL_TEMPLE_REGION } from "./Structure/AbyssalTempleFeature";
import { BADLANDS_SPIRE_REGION } from "./Structure/BadlandsSpireFeature";
import { BAMBOO_SHRINE_REGION } from "./Structure/BambooShrineFeature";
import { CARAVAN_CAMP_REGION } from "./Structure/CaravanCampFeature";
import { CLIFF_DWELLING_REGION } from "./Structure/CliffDwellingFeature";
import { CRYSTAL_SHRINE_REGION } from "./Structure/CrystalShrineFeature";
import { DESERT_OASIS_REGION } from "./Structure/DesertOasisFeature";
import { DOCK_REGION } from "./Structure/DockFeature";
import { FOSSIL_BED_REGION } from "./Structure/FossilBedFeature";
import { FROZEN_SHRINE_REGION } from "./Structure/FrozenShrineFeature";
import { GEODE_REGION } from "./Structure/GeodeFeature";
import { IGLOO_REGION } from "./Structure/IglooFeature";
import { INFERNAL_PIT_REGION } from "./Structure/InfernalPitFeature";
import { LAVA_POOL_REGION, resolveLavaPoolCentre } from "./Structure/LavaPoolFeature";
import { LIGHTHOUSE_REGION } from "./Structure/LighthouseFeature";
import { MAYA_TEMPLE_REGION } from "./Structure/StructureSeal";
import { MINESHAFT_REGION } from "./Structure/MineshaftFeature";
import { MOUNTAIN_CABIN_REGION } from "./Structure/MountainCabinFeature";
import { MUSHROOM_HUT_REGION } from "./Structure/MushroomHutFeature";
import { OBSERVATORY_REGION } from "./Structure/ObservatoryFeature";
import { PETRIFIED_SHRINE_REGION } from "./Structure/PetrifiedShrineFeature";
import { POND_REGION } from "./Structure/PondFeature";
import { PYRAMID_REGION } from "./Structure/PyramidFeature";
import { RAVINE_REGION } from "./Structure/RavineFeature";
import { RUIN_REGION } from "./Structure/RuinFeature";
import { SHIPWRECK_REGION } from "./Structure/ShipwreckFeature";
import { SNOW_FORT_REGION } from "./Structure/SnowFortFeature";
import { STONE_CIRCLE_REGION } from "./Structure/StoneCircleFeature";
import { STRUCTURE_REGION } from "./Structure/StructureFeature";
import { TOWER_REGION } from "./Structure/TowerFeature";
import { TREEHOUSE_REGION } from "./Structure/TreehouseFeature";
import { TROPICAL_TEMPLE_REGION } from "./Structure/TropicalTempleFeature";
import { WATCHTOWER_REGION } from "./Structure/WatchtowerFeature";
import { WELL_REGION } from "./Structure/WellFeature";
import { computeRegion, type RegionConfig } from "./Structure/RegionFeature";
import { WINDMILL_REGION } from "./Structure/WindmillFeature";

// ---------------------------------------------------------------------------
// /locate — find the nearest instance of a worldgen structure.
//
// Every region-placed feature decides "does this structure exist here?" with a
// single integer hash (computeRegion -> getPRNGBySeed), keyed on
// (regionX, regionZ) and the feature's own magic constants. That makes the
// whole world searchable without touching a single voxel: scanning a region
// costs a handful of integer ops, so finding the nearest temple 4,000 blocks
// away costs microseconds rather than a chunk walk.
//
// The region configs are imported from the features themselves, not copied, so
// retuning a feature's density automatically retunes /locate. The one feature
// that deviates (LavaPoolFeature derives its own centre from a second hash)
// exports its centre resolver for the same reason.
//
// NOT every structure is listed. Region-placed features are; the few that
// decide per-chunk (DungeonFeature) or pick from a table (StructureFeature,
// whose key is an arbitrary house name) are only listed when they have a
// meaningful, stable label.
// ---------------------------------------------------------------------------

export type LocatableStructure = {
	/** What the player types: "temple", "igloo", "mineshaft". */
	key: string;
	/** Display name in the response. */
	label: string;
	/** The feature's own region grid. */
	region: RegionConfig;
	/**
	 * Optional override for the structure's world position. Defaults to
	 * `region.centerX / centerZ`, which is correct for every feature that uses
	 * computeRegion's offsets.
	 */
	centre?: (
		region: { regionX: number; regionZ: number; regionHash: number },
		chunkSize: number,
		seed: number,
	) => { x: number; z: number };
	/** Alternative spellings accepted on the command line. */
	aliases?: readonly string[];
};

export const LOCATABLE_STRUCTURES: readonly LocatableStructure[] = [
	{
		key: "maya_temple",
		label: "Maya temple",
		region: MAYA_TEMPLE_REGION,
		// "temple" is claimed here rather than left ambiguous. It is this
		// world's signature landmark, `tropical temple` has its own distinct
		// alias, and a player who typed "temple" meant one specific building.
		// The plural "temples" stays unresolvable on purpose and falls
		// through to suggestions listing both.
		aliases: ["temple", "maya", "mayan", "maya_temples"],
	},
	{
		key: "tropical_temple",
		label: "Tropical temple",
		region: TROPICAL_TEMPLE_REGION,
		aliases: ["tropical"],
	},
	{ key: "abyssal_temple", label: "Abyssal temple", region: ABYSSAL_TEMPLE_REGION },
	{ key: "pyramid", label: "Pyramid", region: PYRAMID_REGION },
	{ key: "tower", label: "Tower", region: TOWER_REGION },
	{
		key: "lighthouse",
		label: "Lighthouse",
		region: LIGHTHOUSE_REGION,
		aliases: ["light_house"],
	},
	{ key: "dock", label: "Dock", region: DOCK_REGION },
	{ key: "shipwreck", label: "Shipwreck", region: SHIPWRECK_REGION },
	{ key: "oasis", label: "Desert oasis", region: DESERT_OASIS_REGION },
	{ key: "ruin", label: "Ruin", region: RUIN_REGION },
	{ key: "mineshaft", label: "Mineshaft", region: MINESHAFT_REGION },
	{ key: "geode", label: "Geode", region: GEODE_REGION },
	{ key: "ravine", label: "Ravine", region: RAVINE_REGION },
	{ key: "infernal_pit", label: "Infernal pit", region: INFERNAL_PIT_REGION },
	{ key: "pond", label: "Pond", region: POND_REGION },
	{ key: "well", label: "Well", region: WELL_REGION },
	{ key: "fossil_bed", label: "Fossil bed", region: FOSSIL_BED_REGION },
	{
		key: "lava_pool",
		label: "Lava pool",
		region: { ...LAVA_POOL_REGION, spawnChance: 2 },
		centre: (region, chunkSize, seed) =>
			resolveLavaPoolCentre(
				region.regionX,
				region.regionZ,
				region.regionHash,
				chunkSize,
				seed,
			),
		aliases: ["lava"],
	},
	{ key: "cabin", label: "Abandoned cabin", region: ABANDONED_CABIN_REGION },
	{ key: "bamboo_shrine", label: "Bamboo shrine", region: BAMBOO_SHRINE_REGION },
	{ key: "caravan_camp", label: "Caravan camp", region: CARAVAN_CAMP_REGION },
	{
		key: "cliff_dwelling",
		label: "Cliff dwelling",
		region: CLIFF_DWELLING_REGION,
	},
	{ key: "crystal_shrine", label: "Crystal shrine", region: CRYSTAL_SHRINE_REGION },
	{ key: "frozen_shrine", label: "Frozen shrine", region: FROZEN_SHRINE_REGION },
	{ key: "igloo", label: "Igloo", region: IGLOO_REGION },
	{ key: "mountain_cabin", label: "Mountain cabin", region: MOUNTAIN_CABIN_REGION },
	{ key: "mushroom_hut", label: "Mushroom hut", region: MUSHROOM_HUT_REGION },
	{ key: "observatory", label: "Observatory", region: OBSERVATORY_REGION },
	{
		key: "petrified_shrine",
		label: "Petrified shrine",
		region: PETRIFIED_SHRINE_REGION,
		aliases: ["petrified"],
	},
	{ key: "snow_fort", label: "Snow fort", region: SNOW_FORT_REGION },
	{ key: "stone_circle", label: "Stone circle", region: STONE_CIRCLE_REGION },
	{ key: "treehouse", label: "Treehouse", region: TREEHOUSE_REGION },
	{ key: "watchtower", label: "Watchtower", region: WATCHTOWER_REGION },
	{ key: "windmill", label: "Windmill", region: WINDMILL_REGION },
	{
		key: "badlands_spire",
		label: "Badlands spire",
		region: BADLANDS_SPIRE_REGION,
		aliases: ["spire"],
	},
	{ key: "opulent_house", label: "Opulent house", region: STRUCTURE_REGION },
];

export type LocateMatch = {
	structure: LocatableStructure;
	x: number;
	z: number;
	regionX: number;
	regionZ: number;
	/** Horizontal distance in blocks from the search origin. */
	distance: number;
};

/**
 * Lookup index. Three forms are accepted per structure, because players type
 * all of them: the canonical key ("maya_temple"), its aliases, and a
 * separator-free spelling ("mayatemple").
 */
const BY_NAME: Map<string, LocatableStructure> = (() => {
	const map = new Map<string, LocatableStructure>();
	for (const structure of LOCATABLE_STRUCTURES) {
		for (const name of [structure.key, ...(structure.aliases ?? [])]) {
			map.set(name, structure);
			map.set(name.replace(/_/g, ""), structure);
		}
	}
	return map;
})();

/** Canonical keys only — what a plural is allowed to resolve back to. */
const BY_KEY: Map<string, LocatableStructure> = (() => {
	const map = new Map<string, LocatableStructure>();
	for (const structure of LOCATABLE_STRUCTURES) map.set(structure.key, structure);
	return map;
})();

/** Normalise player input to the shape the index is keyed on. */
function normaliseName(name: string): string {
	return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Resolve a player-typed name to a structure, or null.
 *
 * A trailing "s" is only stripped when doing so recovers a canonical KEY
 * ("mineshafts" -> "mineshaft"). Plurals of aliases are deliberately left
 * unresolved: "temples" could be the Maya temple or the tropical one, and
 * quietly picking one is worse than declining and offering both.
 */
export function findLocatableStructure(
	name: string,
): LocatableStructure | null {
	const key = normaliseName(name);
	if (!key) return null;

	const direct = BY_NAME.get(key) ?? BY_NAME.get(key.replace(/_/g, ""));
	if (direct) return direct;

	const singular = key.endsWith("s") ? key.slice(0, -1) : key;
	if (singular === key) return null;

	return BY_KEY.get(singular) ?? null;
}

/**
 * Names a player could have meant, for "did you mean" style feedback. Returns
 * every structure whose key or alias shares a prefix with the input.
 */
export function suggestLocatableStructures(
	name: string,
	limit = 5,
): LocatableStructure[] {
	const key = normaliseName(name);
	if (!key) return [];
	const head = key.slice(0, 3);
	return LOCATABLE_STRUCTURES.filter(
		(s) => s.key.startsWith(head) || (s.aliases ?? []).some((a) => a.startsWith(head)),
	).slice(0, limit);
}

export type LocateOptions = {
	/** Search origin, in world XZ. */
	originX: number;
	originZ: number;
	seed: number;
	/** Give up after this many blocks of horizontal distance. */
	maxDistance?: number;
	/** Cap on regions probed, as a runaway guard. */
	maxRegions?: number;
};

const DEFAULT_MAX_DISTANCE = 12000;
const DEFAULT_MAX_REGIONS = 400_000;

/**
 * Find the nearest instance of `structure`, spiralling outward region by region.
 *
 * The region occupancy test is `computeRegion` itself, not a reimplementation
 * of it, so /locate cannot disagree with the feature about whether a structure
 * exists in a region.
 */
export function locateStructure(
	structure: LocatableStructure,
	options: LocateOptions,
): LocateMatch | null {
	const {
		originX,
		originZ,
		seed,
		maxDistance = DEFAULT_MAX_DISTANCE,
		maxRegions = DEFAULT_MAX_REGIONS,
	} = options;

	const chunkSize = CHUNK_SIZE;
	const { regionSize } = structure.region;
	const span = regionSize * chunkSize;

	const baseRegionX = Math.floor(originX / span);
	const baseRegionZ = Math.floor(originZ / span);

	// Held in an object rather than a plain `let`: the accumulator is written
	// from inside `visit`, and TypeScript's control-flow analysis would
	// otherwise narrow the variable to `null` for the whole loop and never
	// see the assignments.
	const state: { best: LocateMatch | null } = { best: null };
	let probed = 0;

	/**
	 * Lower bound on the distance to any point in a region `ring` steps away
	 * (Chebyshev, in region space).
	 *
	 * A region at ring R has |dx| or |dz| equal to R, so along at least one axis
	 * its nearest edge is (R - 1) * span from the origin's own region. Note this
	 * is *not* sqrt(2) * (R - 1) * span: only one axis reaches R, the other
	 * contributes nothing, and using sqrt(2) prunes away rings that still hold
	 * closer structures.
	 */
	const ringLowerBound = (ring: number): number =>
		ring <= 1 ? 0 : (ring - 1) * span;

	for (let ring = 0; ; ring++) {
		// Every remaining ring is strictly further out than this bound.
		if (ringLowerBound(ring) > maxDistance) break;
		if (state.best !== null && ringLowerBound(ring) > state.best.distance) {
			break;
		}

		const minX = baseRegionX - ring;
		const maxX = baseRegionX + ring;
		const minZ = baseRegionZ - ring;
		const maxZ = baseRegionZ + ring;

		const visit = (rx: number, rz: number) => {
			if (probed >= maxRegions) return;
			probed++;

			// computeRegion derives the region from the CHUNK it is handed, so
			// pass a chunk inside this region — not the region index itself.
			const region = computeRegion(
				rx * regionSize,
				rz * regionSize,
				chunkSize,
				seed,
				structure.region,
			);
			if (!region) return;

			const centre = structure.centre
				? structure.centre(region, chunkSize, seed)
				: { x: region.centerX, z: region.centerZ };

			const dx = centre.x - originX;
			const dz = centre.z - originZ;
			const distance = Math.hypot(dx, dz);
			if (distance > maxDistance) return;

			const current = state.best;
			if (current === null || distance < current.distance) {
				state.best = {
					structure,
					x: centre.x,
					z: centre.z,
					regionX: rx,
					regionZ: rz,
					distance,
				};
			}
		};

		// Perimeter walk. The four edge loops skip the corners so each region on
		// the ring is visited exactly once.
		for (let rx = minX; rx <= maxX; rx++) {
			visit(rx, minZ);
			visit(rx, maxZ);
		}
		for (let rz = minZ + 1; rz <= maxZ - 1; rz++) {
			visit(minX, rz);
			visit(maxX, rz);
		}

		if (probed >= maxRegions) break;
	}

	return state.best;
}

/** Human-readable response for /locate. */
export function formatLocateResult(
	match: LocateMatch,
	originX: number,
	originZ: number,
): string {
	const dx = match.x - originX;
	const dz = match.z - originZ;

	const compass = compassDirection(dx, dz);
	const dist = Math.round(match.distance);

	return (
		`${match.structure.label}: ${match.x} ${match.z} ` +
		`(${dist} blocks ${compass}, region ${match.regionX},${match.regionZ})`
	);
}

function compassDirection(dx: number, dz: number): string {
	const angle = Math.atan2(dx, -dz); // 0 = north (-Z)
	const octant = Math.round((angle / (Math.PI * 2)) * 8) & 7;
	return [
		"north",
		"north-east",
		"east",
		"south-east",
		"south",
		"south-west",
		"west",
		"north-west",
	][octant] as string;
}

/** Nearest instance of every listed structure, for `/locate all`. */
export function locateAll(options: LocateOptions): LocateMatch[] {
	const found: LocateMatch[] = [];
	for (const structure of LOCATABLE_STRUCTURES) {
		const match = locateStructure(structure, options);
		if (match) found.push(match);
	}
	return found.sort((a, b) => a.distance - b.distance);
}
