// ---------------------------------------------------------------------------
// NeighborHealDebouncer: deferred neighbor-heal remesh coalescing (extracted
// from ChunkWorkerPool — P2 load-burst coalescing).
//
// Every generated chunk schedules remeshes for its 6 face-neighbors. In a
// load burst, chunk C therefore got one FULL heal remesh per late-arriving
// neighbor (up to 6 extra mesh builds per chunk) even though only the last
// one matters. Heals requested within HEAL_REMESH_DEBOUNCE_MS of each other
// collapse into a single reschedule call per chunk. One pooled timer total —
// no per-chunk timers.
//
// 300ms covers the observed terrain-generation wave cadence (~230-450ms
// between bursts) so heals from consecutive waves coalesce into one rebuild
// instead of landing as a second full mesh per chunk.
// ---------------------------------------------------------------------------
import type { Chunk } from "../Chunk";

const HEAL_REMESH_DEBOUNCE_MS = 300;

export class NeighborHealDebouncer {
	private pending = new Map<Chunk, boolean>();
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly reschedule: (chunk: Chunk, priority: boolean) => void,
	) {}

	schedule(chunk: Chunk, priority: boolean): void {
		const existing = this.pending.get(chunk);
		this.pending.set(chunk, (existing ?? false) || priority);

		if (this.timer !== null) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			if (this.pending.size === 0) return;
			for (const [c, p] of this.pending) {
				// scheduleRemesh re-validates liveness/emptiness/in-flight state;
				// the isLoaded check here just skips dead entries cheaply.
				if (c.isLoaded) this.reschedule(c, p);
			}
			this.pending.clear();
		}, HEAL_REMESH_DEBOUNCE_MS);
	}
}
