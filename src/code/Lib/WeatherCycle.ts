/**
 * Shared rain-intensity cycle.
 *
 * The client runs this locally in singleplayer; in multiplayer the server
 * runs the SAME class and ships the resulting intensity in its WorldTime
 * packet, so every player in a world shares one weather state.
 *
 * Deliberately free of engine imports so the server can bundle it unchanged.
 */

/** Current phase of the weather cycle. */
export const enum WeatherPhase {
	/** No rain. */
	Clear,
	/** Rain is falling. */
	Raining,
}

/** Seconds of clear weather before the next downpour. */
const CLEAR_MIN_SEC = 150;
const CLEAR_MAX_SEC = 480;

/** Seconds of rain before the weather clears again. */
const RAIN_MIN_SEC = 60;
const RAIN_MAX_SEC = 210;

/**
 * Seconds for the intensity to travel the whole 0..1 range.
 *
 * Also the rate the client eases toward a server-sent intensity, so the
 * server's 5-second broadcast cadence does not show up as stepping.
 */
export const WEATHER_RAMP_SEC = 14;

/**
 * Rain intensity over time.
 *
 * The phase machine picks how long each spell lasts; `intensity` is the
 * eased 0..1 value that drives the visuals. Easing lives here (rather than
 * in the renderer) so the server can broadcast an already-smooth value.
 */
export class WeatherCycle {
	public phase: WeatherPhase = WeatherPhase.Clear;

	/** Eased rain intensity, 0..1. */
	public intensity = 0;

	/** Target for the current phase: 0 while clear, 1 while raining. */
	public target = 0;

	#phaseTimerSec = 0;
	#rngState: number;

	constructor(seed = 0x2f6e2b1) {
		this.#rngState = seed >>> 0 || 0x2f6e2b1;
		this.#phaseTimerSec = this.#nextDuration(CLEAR_MIN_SEC, CLEAR_MAX_SEC);
	}

	/**
	 * Advance the cycle.
	 *
	 * `dtSec` is REAL elapsed time, not game time: the weather runs on
	 * wall-clock seconds so it does not speed up when the day/night time
	 * scale is raised.
	 */
	public update(dtSec: number): void {
		if (!(dtSec > 0)) return;

		this.#phaseTimerSec -= dtSec;
		if (this.#phaseTimerSec <= 0) {
			this.#advancePhase();
		}

		const step = dtSec / WEATHER_RAMP_SEC;
		if (this.intensity < this.target) {
			this.intensity = Math.min(this.target, this.intensity + step);
		} else if (this.intensity > this.target) {
			this.intensity = Math.max(this.target, this.intensity - step);
		}
	}

	/**
	 * Force the cycle into a phase right now.
	 *
	 * The ordinary cycle eases between phases over WEATHER_RAMP_SEC, which
	 * is right for weather that drifts on its own. A command that sets the
	 * weather has to take effect at once, so this jumps the phase, the
	 * target and the eased intensity straight to the new state.
	 *
	 * The spell still ends on its own: the phase timer is re-armed, so a
	 * forced shower lasts for a normal-length spell and then eases away
	 * like any other.
	 */
	public force(phase: WeatherPhase): void {
		this.phase = phase;
		this.target = phase === WeatherPhase.Raining ? 1 : 0;
		this.intensity = this.target;

		this.#phaseTimerSec = this.#nextDuration(
			phase === WeatherPhase.Raining ? RAIN_MIN_SEC : CLEAR_MIN_SEC,
			phase === WeatherPhase.Raining ? RAIN_MAX_SEC : CLEAR_MAX_SEC,
		);
	}

	#advancePhase(): void {
		if (this.phase === WeatherPhase.Raining) {
			this.phase = WeatherPhase.Clear;
			this.target = 0;
			this.#phaseTimerSec = this.#nextDuration(CLEAR_MIN_SEC, CLEAR_MAX_SEC);
			return;
		}

		this.phase = WeatherPhase.Raining;
		this.target = 1;
		this.#phaseTimerSec = this.#nextDuration(RAIN_MIN_SEC, RAIN_MAX_SEC);
	}

	/** xorshift32 — self-contained so rain never perturbs the terrain PRNG. */
	#nextRandom(): number {
		let x = this.#rngState;
		x ^= x << 13;
		x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5;
		x >>>= 0;
		this.#rngState = x;
		return x / 4294967296;
	}

	#nextDuration(minSec: number, maxSec: number): number {
		return minSec + this.#nextRandom() * (maxSec - minSec);
	}
}
