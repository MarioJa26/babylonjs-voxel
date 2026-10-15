import type { ExplosionData } from "@/code/Network/protocol/messages";

/**
 * Highest explosion serial number applied by this connection.
 *
 * The server assigns monotonically increasing unsigned 32-bit IDs. RFC-1982
 * serial arithmetic handles wraparound without resetting this value.
 *
 * ID 0 is reserved for legacy messages that do not carry a usable event ID.
 */
let lastSeenId = 0;

const U32_HALF_RANGE = 0x80000000;

const DISTANT_RANGE = 96;
const OFFSCREEN_RANGE = 256;

const DISTANT_RANGE_SQUARED = DISTANT_RANGE * DISTANT_RANGE;

const OFFSCREEN_RANGE_SQUARED = OFFSCREEN_RANGE * OFFSCREEN_RANGE;

// Coordinate hash quantization and constants.
const VISUAL_SEED_SCALE = 16;
const HASH_X = 73856093;
const HASH_Y = 19349663;
const HASH_Z = 83492791;

/**
 * True when an explosion event has not already been applied.
 *
 * This function consumes accepted nonzero IDs. Call it exactly once for each
 * received event, before applying terrain changes or audiovisual effects.
 *
 * ID 0 means the server did not provide a usable ID, so those events cannot
 * be deduplicated and are always accepted.
 */
export function claimExplosionEvent(id: number): boolean {
	/*
	 * Convert the wire value to its unsigned 32-bit representation once.
	 * This also keeps serial arithmetic consistent if the decoder exposes a
	 * signed int32 value.
	 */
	const normalizedId = id >>> 0;

	if (normalizedId === 0) {
		return true;
	}

	const previousId = lastSeenId;

	if (previousId === 0) {
		lastSeenId = normalizedId;
		return true;
	}

	if (!isNewer(normalizedId, previousId)) {
		return false;
	}

	lastSeenId = normalizedId;
	return true;
}

/**
 * RFC-1982-style comparison for unsigned 32-bit serial numbers.
 *
 * A is newer than B when the forward distance is in the open interval
 * (0, 2^31). A distance of exactly 2^31 is intentionally treated as
 * ambiguous and therefore not newer.
 */
function isNewer(a: number, b: number): boolean {
	const delta = (a - b) >>> 0;

	return delta !== 0 && delta < U32_HALF_RANGE;
}

/** Forget deduplication history when starting a new server connection. */
export function resetExplosionDedup(): void {
	lastSeenId = 0;
}

/**
 * Returns a deterministic unsigned 32-bit visual seed for an explosion.
 *
 * A nonzero server-provided seed is preferred. Legacy events derive a stable
 * seed from coordinates so all clients render the same particle pattern.
 */
export function explosionVisualSeed(data: ExplosionData): number {
	const providedSeed = data.seed;

	if (providedSeed !== undefined && providedSeed !== 0) {
		return providedSeed >>> 0;
	}

	const x = Math.round(data.x * VISUAL_SEED_SCALE);
	const y = Math.round(data.y * VISUAL_SEED_SCALE);
	const z = Math.round(data.z * VISUAL_SEED_SCALE);

	return (
		(Math.imul(x, HASH_X) ^ Math.imul(y, HASH_Y) ^ Math.imul(z, HASH_Z)) >>> 0
	);
}

/** Effect fidelity for an explosion, selected from camera distance. */
export const enum ExplosionVisualTier {
	/** Full particles and debris collision. */
	Near,

	/** Flash and smoke, without debris collision. */
	Distant,

	/** Minimal visual work; audio only. */
	Offscreen,
}

/**
 * Select an explosion's visual tier from squared camera distance.
 *
 * Passing squared distance avoids a square root in the caller.
 */
export function explosionVisualTier(distanceSq: number): ExplosionVisualTier {
	if (distanceSq > OFFSCREEN_RANGE_SQUARED) {
		return ExplosionVisualTier.Offscreen;
	}

	if (distanceSq > DISTANT_RANGE_SQUARED) {
		return ExplosionVisualTier.Distant;
	}

	return ExplosionVisualTier.Near;
}
