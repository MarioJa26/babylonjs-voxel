import type { ExplosionData } from "@/code/Network/protocol/messages";

/**
 * Recent explosion ids, for redelivery suppression.
 *
 * PERF/RATIONALE: an explosion used to cross the network as a bare coordinate
 * triple plus radius, with no way to tell a NEW detonation from a redelivered
 * one. Every effect it triggered — particles, sound, screen flash, the terrain
 * mutation — was therefore non-idempotent: a single duplicated packet replayed
 * all of it. Making the event carry an id turns the whole thing into one
 * operation that can be applied exactly once.
 *
 * A single high-water mark rather than a set of recent ids. The server assigns
 * ids monotonically, so "strictly newer than everything seen" is a complete
 * test for "not a redelivery" — a ring of recent ids would reject exactly the
 * same set, and a set that outgrows its window would start ACCEPTING old
 * packets, which is the one behaviour a dedup check must never have.
 *
 * Comparison is serial-number arithmetic, so the u32 wrap needs no reset.
 */
let lastSeenId = 0;

/**
 * True when `id` has not been applied before.
 *
 * Consumes the id: a second call with the same id returns false. Callers must
 * therefore invoke this exactly once per received event, before doing any work.
 */
export function claimExplosionEvent(id: number): boolean {
	// 0 means "no id on the wire" — an older or partial server. Nothing to
	// dedup against, so treat every such event as new.
	if (id === 0) return true;

	if (lastSeenId === 0) {
		lastSeenId = id;
		return true;
	}

	// Anything not strictly newer than the high-water mark is a duplicate or a
	// straggler, and replaying an old explosion is worse than dropping a new one.
	if (!isNewer(id, lastSeenId)) return false;

	lastSeenId = id;
	return true;
}

/** RFC-1982 style comparison for wrapping u32 counters. */
function isNewer(a: number, b: number): boolean {
	return (a - b) >>> 0 !== 0 && (a - b) >>> 0 < 0x80000000;
}

/** Forget all history. Call on connect, so a new room starts clean. */
export function resetExplosionDedup(): void {
	lastSeenId = 0;
}

/**
 * Deterministic visual seed for one explosion.
 *
 * Every client derives the same value from the same server-assigned seed, so
 * particles are identical across clients instead of each client producing
 * whatever its local PRNG happened to emit.
 */
export function explosionVisualSeed(data: ExplosionData): number {
	if (data.seed !== undefined && data.seed !== 0) return data.seed >>> 0;

	// Fallback for a server that does not send a seed: derive from the
	// coordinates so all clients still agree, at the cost of two explosions at
	// the same place looking alike.
	return (
		((Math.round(data.x * 16) * 73856093) ^
			(Math.round(data.y * 16) * 19349663) ^
			(Math.round(data.z * 16) * 83492791)) >>>
		0
	);
}

/** Effect fidelity for an explosion, from distance alone. */
export const enum ExplosionVisualTier {
	/** Full particles and collision. */
	Near,
	/** Flash and smoke, no debris collision. */
	Distant,
	/** Almost nothing — audio only. */
	Offscreen,
}

/**
 * Pick an explosion's visual tier.
 *
 * @param distanceSq Squared distance from the camera.
 */
export function explosionVisualTier(distanceSq: number): ExplosionVisualTier {
	if (distanceSq > 256 * 256) return ExplosionVisualTier.Offscreen;
	if (distanceSq > 96 * 96) return ExplosionVisualTier.Distant;
	return ExplosionVisualTier.Near;
}
