/**
 * Physical-core estimation for browser worker-pool sizing.
 *
 * WHY THIS EXISTS
 *
 * `navigator.hardwareConcurrency` reports LOGICAL processors (hardware
 * threads), not physical cores. On any SMT machine — which is essentially
 * every modern x86 CPU — that is 2x the physical count, so a pool sized from it
 * over-allocates.
 *
 * Over-allocating a CPU-bound pool is not merely wasteful, it is slower:
 * once a physical core is saturated, an SMT sibling running alongside it
 * contends for the same execution resources instead of adding throughput, and
 * the extra thread costs cache and scheduling pressure. Running N threads on
 * N/2 physical cores is measurably worse than running N/2 threads on N/2 cores.
 *
 * This matters doubly in a co-located setup (running a game server on the same
 * machine as the client), because client and server worker pools then compete
 * for the same physical cores while both believe they own the whole machine.
 *
 * There is no browser API for physical core count, so this infers it:
 *
 *   - The `hardwareConcurrency` value is widely understood to already discount
 *     SMT on some browsers and not others, so a single heuristic is used rather
 *     than pretending to a precision that does not exist here.
 *   - Logical counts of 8 or more are treated as SMT (2 threads per core),
 *     which is the safe assumption for capacity planning: over-reserving costs
 *     a little throughput, under-reserving costs a stall.
 *   - Below that, take the count at face value, since assuming SMT on a small
 *     machine would starve it.
 *
 * An explicit `SETTING_PARAMS.CHUNK_WORKER_POOL_SIZE` still wins outright, so
 * anyone who knows their machine can bypass this entirely.
 */
export function estimatePhysicalCores(logicalThreads: number): number {
	const logical = Math.max(1, Math.floor(logicalThreads) || 1);

	if (logical >= 8) {
		return Math.max(1, Math.round(logical / 2));
	}

	return logical;
}