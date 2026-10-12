/**
 * Distance classification shared by every system that needs to decide how much
 * detail something deserves.
 *
 * PERF/RATIONALE: remote players, particles, chunk LOD, packed-chunk
 * visibility, far tiles, distant terrain, and entity update frequency all need
 * "how far away is this?". Before this they each computed it independently
 * against their own thresholds, which produced contradictory decisions in the
 * same frame — a particle system could spawn colliding debris for a player the
 * renderer had already culled, and a chunk could be streaming at LOD0 priority
 * while its mesh was being skipped as invisible.
 *
 * Classifying once per frame per entity and sharing the record keeps those
 * decisions consistent and collapses N distance computations into one.
 */

export const enum VisibilityTier {
	/** Full-rate animation, full effects and collision, highest chunk LOD. */
	Near,
	/** ~30 Hz visual update, reduced particle counts, normal chunk LOD. */
	Medium,
	/** ~10-15 Hz visual update, flash and smoke only, lower chunk LOD. */
	Far,
	/** Not rendered. State is still tracked so it reappears correctly. */
	Invisible,
}

export interface VisibilityRecord {
	distanceSq: number;
	tier: VisibilityTier;
	visible: boolean;
	/**
	 * Divide an animation interval by this to get the tier's cadence.
	 *
	 * `Invisible` reports 0, meaning "never" — callers must treat 0 as an
	 * infinite interval rather than as "every frame".
	 */
	updateDivisor: number;
	/** Full particle quality is permitted only at or inside this tier. */
	allowFullEffects: boolean;
	/** Tiny debris may run voxel collision only at or inside this tier. */
	allowDebrisCollision: boolean;
}

/*
 * Boundaries. `Near` matches the particle quality ladder in the spec (48 blocks
 * is where Full becomes Normal); `Medium` matches the existing remote-player
 * cull distance in RemotePlayerRenderer (96 blocks), so tiers and the pre-existing
 * cull agree at that boundary instead of fighting each other.
 */
const NEAR_DIST_SQ = 48 * 48;
const MEDIUM_DIST_SQ = 96 * 96;
const FAR_DIST_SQ = 192 * 192;

/*
 * Hysteresis. An entity oscillating across a boundary would otherwise flip
 * tiers every frame, and each flip costs more than the tier saves: a
 * Near->Medium transition drops the animation cadence, a Medium->Far drops
 * particles, and a Far->Invisible destroys the mesh. The pending tier must be
 * held this far past its boundary before the downgrade is accepted.
 */
const HYSTERESIS_SQ = 4 * 4;

const DIVISORS = [1, 2, 4, 0] as const;

/**
 * Classify a squared distance into a tier.
 *
 * @param distanceSq Squared distance to the camera.
 * @param previous The tier this entity held last frame, or `Invisible` for a
 *   newly seen entity. Used only for hysteresis.
 */
export function classifyVisibility(
	distanceSq: number,
	previous: VisibilityTier = VisibilityTier.Invisible,
): VisibilityRecord {
	const tier = resolveTier(distanceSq, previous);

	return {
		distanceSq,
		tier,
		visible: tier !== VisibilityTier.Invisible,
		updateDivisor: DIVISORS[tier],
		allowFullEffects: distanceSq < NEAR_DIST_SQ,
		allowDebrisCollision: distanceSq < MEDIUM_DIST_SQ,
	};
}

function resolveTier(
	distanceSq: number,
	previous: VisibilityTier,
): VisibilityTier {
	// Upgrades apply immediately: approaching an entity should never be delayed
	// by hysteresis, because the whole point of upgrading is that the entity is
	// now close enough to see.
	if (distanceSq < NEAR_DIST_SQ) return VisibilityTier.Near;
	if (distanceSq < MEDIUM_DIST_SQ) return VisibilityTier.Medium;

	// Downgrades are hysteretic. An entity that was Invisible is treated as a
	// fresh sighting, so it must fully cross FAR to stay invisible.
	if (previous === VisibilityTier.Far) {
		if (distanceSq < FAR_DIST_SQ + HYSTERESIS_SQ) return VisibilityTier.Far;
	} else if (distanceSq < FAR_DIST_SQ) {
		return VisibilityTier.Far;
	}

	return VisibilityTier.Invisible;
}

/** Minimum update interval in ms for a tier, given a base interval. */
export function tierIntervalMs(
	baseIntervalMs: number,
	record: VisibilityRecord,
): number {
	return record.updateDivisor === 0
		? Number.POSITIVE_INFINITY
		: baseIntervalMs * record.updateDivisor;
}

/** Milliseconds elapsed since `lastMs`, or `Infinity` when the tier says never. */
export function tierElapsedMs(
	baseIntervalMs: number,
	record: VisibilityRecord,
	lastMs: number,
	nowMs: number,
): number {
	const interval = tierIntervalMs(baseIntervalMs, record);
	return interval === Number.POSITIVE_INFINITY
		? Number.POSITIVE_INFINITY
		: nowMs - lastMs;
}
