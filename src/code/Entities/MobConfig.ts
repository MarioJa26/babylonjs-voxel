/**
 * Centralized mob configuration — single source of truth for mob stats.
 *
 * Both singleplayer (client mob classes) and multiplayer (server MobSimulation)
 * import from here so stats never diverge between SP and MP.
 */

export const MobTypeId = {
	Chicken: 1,
	Sheep: 2,
	Cow: 3,
	Squid: 4,
	Fish: 5,
	Kraken: 6,
} as const;

/** Squared radius (meters) within which a nearby player triggers panic. */
export const DEFAULT_FLEE_RADIUS_SQ = 25;

/** Safe fall distance (blocks) — no damage for falls at or below this. */
export const FALL_DAMAGE_THRESHOLD = 3;

/** Damage dealt per block of fall distance beyond the threshold. */
export const FALL_DAMAGE_PER_BLOCK = 1;

/** Mob stats shared between client and server. */
export interface MobStats {
	/** Hit points a freshly spawned mob of this type gets. */
	hp: number;
	/** Wander speed in blocks per second. */
	speed: number;
	/** Half the mob's body height, used for voxel collision and rendering. */
	halfHeight: number;
	/** Distance from center to the bottom of the feet (visual bottom of the model). */
	feetHeight: number;
	/** Full hit box half-extents (x, y, z). */
	halfExtents: { x: number; y: number; z: number };
	/**
	 * Squared radius (meters) within which a nearby player triggers panic.
	 * Mobs whose proximity panic is disabled only flee when damaged.
	 */
	fleeRadiusSq: number;
	/** True for water-native mobs that swim instead of walking on land. */
	aquatic: boolean;
	/**
	 * Preferred depth range below water surface (blocks). Mobs will drift
	 * within this range. Shallow-water mobs stay near the surface,
	 * deep-water mobs dwell near the bottom. Land mobs ignore this.
	 */
	depthRange?: { min: number; max: number };
}

/** Natural spawn configuration. */
export interface MobSpawnConfig {
	/** Maximum number of naturally spawned mobs of this type. */
	maxCount: number;
	/** Relative spawn weight (higher = more common). */
	spawnWeight: number;
	/** Block ID this mob naturally spawns on (grass for land, water for aquatic). */
	spawnBlockId: number;
	/** Whether this mob can despawn when far from players. */
	despawnable: boolean;
	/** Y offset applied to spawn position. */
	spawnYOffset: number;
}

/** All mob stats, keyed by MobTypeId. */
export const MOB_STATS: Record<number, MobStats> = {
	[MobTypeId.Chicken]: {
		hp: 4,
		speed: 1.8,
		halfHeight: 0.45,
		feetHeight: 0.45,
		halfExtents: { x: 0.31, y: 0.45, z: 0.3 },
		fleeRadiusSq: DEFAULT_FLEE_RADIUS_SQ,
		aquatic: false,
	},
	[MobTypeId.Sheep]: {
		hp: 8,
		speed: 1.5,
		halfHeight: 0.325,
		feetHeight: 0.555,
		halfExtents: { x: 0.36, y: 0.325, z: 0.52 },
		fleeRadiusSq: 0,
		aquatic: false,
	},
	[MobTypeId.Cow]: {
		hp: 10,
		speed: 1.4,
		halfHeight: 0.7,
		feetHeight: 0.6,
		halfExtents: { x: 0.45, y: 0.7, z: 0.62 },
		fleeRadiusSq: 0,
		aquatic: false,
	},
	[MobTypeId.Squid]: {
		hp: 10,
		speed: 1.6,
		halfHeight: 0.45,
		feetHeight: 0.45,
		halfExtents: { x: 0.35, y: 0.45, z: 0.35 },
		fleeRadiusSq: DEFAULT_FLEE_RADIUS_SQ,
		aquatic: true,
		depthRange: { min: 2, max: 6 }, // Medium depth swimmer
	},
	[MobTypeId.Fish]: {
		hp: 3,
		speed: 2.0,
		halfHeight: 0.15,
		feetHeight: 0.15,
		halfExtents: { x: 0.2, y: 0.15, z: 0.32 },
		fleeRadiusSq: DEFAULT_FLEE_RADIUS_SQ,
		aquatic: true,
		depthRange: { min: 1, max: 4 }, // Shallow to mid-depth
	},
	[MobTypeId.Kraken]: {
		hp: 80,
		speed: 1.1,
		halfHeight: 1.0,
		feetHeight: 1.0,
		halfExtents: { x: 0.85, y: 1.0, z: 0.85 },
		fleeRadiusSq: DEFAULT_FLEE_RADIUS_SQ,
		aquatic: true,
		depthRange: { min: 5, max: 12 }, // Deep water dweller
	},
};

/** Natural spawn configurations, keyed by MobTypeId. */
export const MOB_SPAWN_CONFIGS: Record<number, MobSpawnConfig> = {
	[MobTypeId.Chicken]: {
		maxCount: 15,
		spawnWeight: 1,
		spawnBlockId: 15, // BlockType.Grass001
		despawnable: false,
		spawnYOffset: 0.2,
	},
	[MobTypeId.Sheep]: {
		maxCount: 10,
		spawnWeight: 1,
		spawnBlockId: 15, // BlockType.Grass001
		despawnable: false,
		spawnYOffset: 0.3,
	},
	[MobTypeId.Cow]: {
		maxCount: 10,
		spawnWeight: 1,
		spawnBlockId: 15, // BlockType.Grass001
		despawnable: false,
		spawnYOffset: 0.3,
	},
	[MobTypeId.Squid]: {
		maxCount: 8,
		spawnWeight: 1,
		spawnBlockId: 20, // BlockType.Water
		despawnable: false,
		spawnYOffset: 0.5,
	},
	[MobTypeId.Fish]: {
		maxCount: 15,
		spawnWeight: 1.5,
		spawnBlockId: 20, // BlockType.Water
		despawnable: false,
		spawnYOffset: 0.5,
	},
	[MobTypeId.Kraken]: {
		maxCount: 2,
		spawnWeight: 0.15,
		spawnBlockId: 20, // BlockType.Water
		despawnable: false,
		spawnYOffset: 0.5,
	},
};

/** Get stats for a mob type, throwing if unknown. */
export function getMobStats(typeId: number): MobStats {
	const stats = MOB_STATS[typeId];
	if (!stats) {
		throw new Error(`Unknown mob typeId: ${typeId}`);
	}
	return stats;
}

/** Get spawn config for a mob type, throwing if unknown. */
export function getMobSpawnConfig(typeId: number): MobSpawnConfig {
	const config = MOB_SPAWN_CONFIGS[typeId];
	if (!config) {
		throw new Error(`Unknown mob typeId: ${typeId}`);
	}
	return config;
}
