// ---------------------------------------------------------------------------
// RemoteRetryPolicy: backoff constants + pure delay math for parked remote
// chunk retries (extracted from ChunkWorkerPool — Step 3b-ii).
//
// Chunks that exhaust MAX_ATTEMPTS are parked with an exponential backoff
// instead of being dropped permanently, so an overloaded server heals rather
// than leaving a permanent hole. A server that stays unreachable costs one
// probe every MAX_DELAY_MS per chunk rather than a hot loop.
// ---------------------------------------------------------------------------

/** Attempts before a chunk is parked (was MAX_REMOTE_RETRY). */
export const REMOTE_MAX_ATTEMPTS = 3;
/** Sweep interval for the parked-retry timer. */
export const REMOTE_PARK_SWEEP_MS = 2000;
/** Base park delay; doubles per tier. */
export const REMOTE_PARK_BASE_MS = 2000;
/** Ceiling for the park delay. */
export const REMOTE_PARK_MAX_MS = 30000;

/** Park delay for a tier: BASE << min(tier, 4), capped at MAX. */
export function remoteParkDelayMs(tier: number): number {
	return Math.min(REMOTE_PARK_MAX_MS, REMOTE_PARK_BASE_MS << Math.min(tier, 4));
}
