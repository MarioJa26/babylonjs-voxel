/**
 * The rain audio mix, as pure data.
 *
 * Deliberately free of engine and browser imports so it can be checked
 * headlessly and shared with tests. `RainAudio.ts` turns these values into
 * WebAudio parameters.
 */

/** Length of the looping noise buffer, in seconds. */
export const RAIN_NOISE_SECONDS = 6;

/** Crossfade length at the end of the loop, in seconds. */
export const RAIN_CROSSFADE_SECONDS = 0.25;

/** Time constant of gain and filter ramps, in seconds. */
export const RAIN_RAMP_SECONDS = 0.12;

/** Peak gain of the low body band at full intensity. */
export const RAIN_BODY_GAIN = 0.3;

/** Peak gain of the mid hiss band at full intensity. */
export const RAIN_HISS_GAIN = 0.34;

/** Peak gain of the high patter band at full intensity. */
export const RAIN_PATTER_GAIN = 0.085;

/** Cutoff of the low body band, in Hz. */
export const RAIN_BODY_FREQ = 520;

/** Centre frequency of the mid hiss band, in Hz. */
export const RAIN_HISS_FREQ = 1600;

/** Cutoff of the high patter band, in Hz. */
export const RAIN_PATTER_FREQ = 3000;

/** Lowpass cutoff with an unobstructed listener, in Hz. */
export const RAIN_OPEN_CUTOFF = 20000;

/** Lowpass cutoff when fully muffled, in Hz. */
export const RAIN_MUFFLED_CUTOFF = 480;

/** Bus gain with an unobstructed listener. */
export const RAIN_OPEN_BUS_GAIN = 1;

/** Bus gain when fully muffled. */
export const RAIN_MUFFLED_BUS_GAIN = 0.55;

/**
 * Exposure used while the camera is underwater.
 *
 * Rain remains faintly audible as a muffled impact through the water.
 */
export const UNDERWATER_EXPOSURE = 0.2;

// ---------------------------------------------------------------------------
// Derived constants
// ---------------------------------------------------------------------------

const SKY_LIGHT_MAX = 15;
const INVERSE_SKY_LIGHT_MAX = 1 / SKY_LIGHT_MAX;

const BUS_GAIN_RANGE = RAIN_OPEN_BUS_GAIN - RAIN_MUFFLED_BUS_GAIN;

/**
 * Exponential cutoff interpolation:
 *
 * muffled * (open / muffled) ** exposure
 * =
 * muffled * exp(log(open / muffled) * exposure)
 */
const CUTOFF_LOG_RANGE = Math.log(RAIN_OPEN_CUTOFF / RAIN_MUFFLED_CUTOFF);

/**
 * Clamp a finite number to 0..1.
 *
 * Invalid values become zero so malformed weather state cannot propagate
 * NaN into WebAudio parameters.
 */
function clamp01(value: number): number {
	if (!(value > 0)) return 0;
	if (value >= 1) return 1;
	return value;
}

/**
 * Gain and cutoff settings for one moment of rain.
 */
export interface RainAudioMix {
	/** Gain of the low body band. */
	bodyGain: number;

	/** Gain of the mid hiss band. */
	hissGain: number;

	/** Gain of the high patter band. */
	patterGain: number;

	/**
	 * Amount of rain reaching the listener, 0..1.
	 *
	 * Independent of weather intensity. The bands describe how hard it is
	 * raining; this value describes how much reaches the listener.
	 */
	exposureGain: number;

	/** Lowpass cutoff applied to the complete rain bus, in Hz. */
	cutoff: number;
}

/**
 * Map weather intensity and listener exposure to an audio mix.
 *
 * @param intensity Weather intensity, clamped to 0..1.
 * @param exposure Amount of rain reaching the listener, clamped to 0..1.
 */
export function computeRainMix(
	intensity: number,
	exposure: number,
): RainAudioMix {
	const rain = clamp01(intensity);
	const open = clamp01(exposure);

	const rainSquared = rain * rain;

	const bodyGain = rainSquared * RAIN_BODY_GAIN;
	const hissGain = rain * RAIN_HISS_GAIN;

	// Fade the patter in more gradually. This prevents isolated high-frequency
	// transients from sounding like ice, glass, or sharp metallic clicks.
	const patterGain = rainSquared * RAIN_PATTER_GAIN;

	// Frequency perception is logarithmic, so interpolate exponentially.
	const cutoff = RAIN_MUFFLED_CUTOFF * Math.exp(CUTOFF_LOG_RANGE * open);

	const exposureGain = open * (RAIN_MUFFLED_BUS_GAIN + BUS_GAIN_RANGE * open);

	return {
		bodyGain,
		hissGain,
		patterGain,
		exposureGain,
		cutoff,
	};
}

/**
 * Calculate rain exposure from a skylight level.
 *
 * @param skyLight Skylight level, clamped to 0..15.
 * @param underwater Whether the listener is underwater.
 */
export function rainExposureForSkyLight(
	skyLight: number,
	underwater: boolean,
): number {
	if (underwater) {
		return UNDERWATER_EXPOSURE;
	}

	/*
	 * This branch form avoids nested Math.min/Math.max calls and makes
	 * non-finite handling explicit.
	 *
	 * `!(skyLight > 0)` also catches NaN.
	 */
	if (!(skyLight > 0)) {
		return 0;
	}

	if (skyLight >= SKY_LIGHT_MAX) {
		return 1;
	}

	return skyLight * INVERSE_SKY_LIGHT_MAX;
}
