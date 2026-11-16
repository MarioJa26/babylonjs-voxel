/**
 * Shared rain-intensity cycle.
 *
 * The client runs this locally in singleplayer; in multiplayer the server
 * runs the same class and sends the resulting intensity in its WorldTime
 * packet, keeping every player in the world on one weather state.
 *
 * Deliberately free of engine imports so the server can bundle it unchanged.
 * The only imports are the shared `clamp01` and the Squirrel13 hash, both of
 * which are plain TypeScript.
 */

import { clamp01 } from "../Generation/CaveCarver";
import { getPRNGBySeed } from "../Generation/NoiseAndParameters/Squirrel13";

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
 * Seconds required for intensity to travel through the complete 0..1 range.
 */
export const WEATHER_RAMP_SEC = 14;

// ---------------------------------------------------------------------------
// Derived constants
// ---------------------------------------------------------------------------

const DEFAULT_SEED = 0x02f6e2b1;

/**
 * Scale that turns a Squirrel13 hash into a unit value.
 *
 * The hash ends with `mangled ^ (mangled >> 8)`, and the shift sign-extends,
 * so bit 31 of the result is always 0: the output is uniform over
 * [0, 2^31), not [0, 2^32).
 */
const PRNG_UNIT_SCALE = 1 / 2147483648;

const INVERSE_WEATHER_RAMP_SEC = 1 / WEATHER_RAMP_SEC;

const CLEAR_DURATION_RANGE_SEC = CLEAR_MAX_SEC - CLEAR_MIN_SEC;
const RAIN_DURATION_RANGE_SEC = RAIN_MAX_SEC - RAIN_MIN_SEC;

/**
 * Rain intensity over time.
 *
 * The phase machine controls spell duration. `intensity` is the eased value
 * used by rendering and audio and, on the server, sent to clients.
 */
export class WeatherCycle {
	public phase: WeatherPhase = WeatherPhase.Clear;

	/** Eased rain intensity, 0..1. */
	public intensity = 0;

	/** Current phase target: zero while clear and one while raining. */
	public target = 0;

	#phaseTimerSec: number;

	/** Seed for the Squirrel13 hash that draws the spell durations. */
	#seed: number;

	/** Monotonic draw counter; the hash turns it into a value. */
	#rngCounter = 0;

	public constructor(seed = DEFAULT_SEED) {
		this.#seed = seed >>> 0 || DEFAULT_SEED;
		this.#phaseTimerSec = this.#nextClearDuration();
	}

	/**
	 * Advance the weather cycle using real elapsed seconds.
	 *
	 * At most one phase transition is processed per call, preserving the
	 * original behavior when an unusually large frame delta is supplied.
	 */
	public update(dtSec: number): void {
		if (!(dtSec > 0)) {
			return;
		}

		const remaining = this.#phaseTimerSec - dtSec;

		if (remaining <= 0) {
			this.#advancePhase();
		} else {
			this.#phaseTimerSec = remaining;
		}

		const intensity = this.intensity;
		const target = this.target;
		const step = dtSec * INVERSE_WEATHER_RAMP_SEC;

		/*
		 * The target is always 0 or 1, so clamping to 0..1 is the same as
		 * clamping to the target: the ramp lands on the target and stops,
		 * never crossing it.
		 */
		if (intensity < target) {
			this.intensity = clamp01(intensity + step);
		} else if (intensity > target) {
			this.intensity = clamp01(intensity - step);
		}
	}

	/**
	 * Immediately force a weather phase.
	 *
	 * The phase, target, and intensity change immediately. The phase timer is
	 * re-armed with a normal randomized duration, so automatic cycling resumes.
	 */
	public force(phase: WeatherPhase): void {
		const raining = phase === WeatherPhase.Raining;
		const target = raining ? 1 : 0;

		this.phase = phase;
		this.target = target;
		this.intensity = target;
		this.#phaseTimerSec = raining
			? this.#nextRainDuration()
			: this.#nextClearDuration();
	}

	#advancePhase(): void {
		if (this.phase === WeatherPhase.Raining) {
			this.phase = WeatherPhase.Clear;
			this.target = 0;
			this.#phaseTimerSec = this.#nextClearDuration();
		} else {
			this.phase = WeatherPhase.Raining;
			this.target = 1;
			this.#phaseTimerSec = this.#nextRainDuration();
		}
	}

	/**
	 * Next random unit value, drawn from the Squirrel13 hash.
	 *
	 * The hash is pure, so the spell schedule is reproducible from the seed
	 * on any machine — the server and the client build the same one — and it
	 * leaves the shared terrain PRNG state alone.
	 */
	#nextRandom(): number {
		return getPRNGBySeed(this.#rngCounter++, this.#seed) * PRNG_UNIT_SCALE;
	}

	#nextClearDuration(): number {
		return CLEAR_MIN_SEC + this.#nextRandom() * CLEAR_DURATION_RANGE_SEC;
	}

	#nextRainDuration(): number {
		return RAIN_MIN_SEC + this.#nextRandom() * RAIN_DURATION_RANGE_SEC;
	}
}
