/**
 * One authoritative clock sample per frame, shared by every system that needs
 * to make a time-based decision.
 *
 * PERF/RATIONALE: before this, ~114 call sites across 32 files called
 * `performance.now()` independently. The cost is not the call itself — it is
 * that subsystems reached *different* conclusions from the same frame. A chunk
 * request deadline, a particle throttle, and a network interpolation step all
 * read the wall clock microseconds apart, so "is this frame over budget?" has
 * no single answer and profiling by frame id is impossible.
 *
 * The frame loop samples once and every consumer reads the same value, which
 * makes timeout and interpolation decisions mutually consistent and lets the
 * profiler correlate cross-system work by `frameId`.
 *
 * IMPORTANT: network receive handlers legitimately run OUTSIDE the frame loop
 * (they fire in Colyseus message tasks). Those must keep using
 * `performance.now()` directly — they are not part of any frame, and stamping
 * them with the last frame's clock would make request deadlines wrong.
 */
export interface FrameClock {
	/** Wall-clock sample taken once at the top of the frame. */
	nowMs: number;
	/** Frame delta in milliseconds, as reported by the render loop. */
	deltaMs: number;
	/** `deltaMs * 0.001`, precomputed so hot paths need not multiply. */
	deltaSec: number;
	/** Monotonic frame counter, incremented once per frame. */
	frameId: number;
}

class SharedFrameClock implements FrameClock {
	nowMs = 0;
	deltaMs = 0;
	deltaSec = 0;
	frameId = 0;

	/**
	 * Sample the clock for a new frame.
	 *
	 * `deltaMs` is taken from the render loop rather than re-derived from two
	 * `performance.now()` reads, because the render loop's delta already
	 * accounts for its own scheduling. `nowMs` is still sampled here (once) so
	 * that every system in the frame agrees on "now".
	 *
	 * @param nowMs Pre-sampled timestamp, or -1 to sample it here. Callers that
	 *   already read the clock to time the loop may pass it in to avoid a
	 *   second call.
	 */
	beginFrame(deltaMs: number, nowMs = -1): FrameClock {
		this.nowMs = nowMs >= 0 ? nowMs : performance.now();
		// A zero or negative delta would make exponential smoothing coefficients
		// NaN, and a post-suspend delta (tens of seconds) would teleport
		// interpolators. Clamp both ends rather than trusting the input.
		this.deltaMs =
			deltaMs > 0 && deltaMs < MAX_FRAME_DELTA_MS ? deltaMs : FALLBACK_DELTA_MS;
		this.deltaSec = this.deltaMs * 0.001;
		this.frameId++;
		return this;
	}
}

const MAX_FRAME_DELTA_MS = 100;
const FALLBACK_DELTA_MS = 16.667;

/**
 * The shared clock. Mutate only via `beginFrame`.
 *
 * Before the first frame this reports delta 0 / frameId 0, which callers must
 * tolerate: subsystems are constructed and can receive work before the render
 * loop has ticked.
 */
export const frameClock = new SharedFrameClock();

/** Sample the shared clock for the frame about to run. */
export function beginFrameClock(deltaMs: number, nowMs = -1): FrameClock {
	return frameClock.beginFrame(deltaMs, nowMs);
}
