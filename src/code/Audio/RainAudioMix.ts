/**
 * The rain audio mix, as pure data.
 *
 * Deliberately free of engine and browser imports so it can be checked
 * headlessly and shared with the tests. `RainAudio.ts` turns these numbers
 * into WebAudio nodes; nothing else depends on how the mix is computed.
 */

/** Length of the looping noise buffer, in seconds. */
export const RAIN_NOISE_SECONDS = 6;

/**
 * Crossfade length at the end of the loop, in seconds.
 *
 * The tail of the buffer is folded back onto its own head so the loop
 * repeats without the click a hard cut would produce.
 */
export const RAIN_CROSSFADE_SECONDS = 0.25;

/** Time constant of the gain and filter ramps, in seconds. */
export const RAIN_RAMP_SECONDS = 0.12;

/** Peak gain of the low body band at full intensity. */
export const RAIN_BODY_GAIN = 0.3;

/** Peak gain of the mid hiss band at full intensity. */
export const RAIN_HISS_GAIN = 0.34;

/** Peak gain of the high patter band at full intensity. */
export const RAIN_PATTER_GAIN = 0.14;

/** Cutoff of the low body band (Hz). */
export const RAIN_BODY_FREQ = 520;

/** Centre frequency of the mid hiss band (Hz). */
export const RAIN_HISS_FREQ = 1600;

/** Cutoff of the high patter band (Hz). */
export const RAIN_PATTER_FREQ = 4200;

/** Lowpass cutoff when nothing stands between the listener and the sky. */
export const RAIN_OPEN_CUTOFF = 20000;

/** Lowpass cutoff when the rain is fully muffled. */
export const RAIN_MUFFLED_CUTOFF = 480;

/** Bus gain out in the open. */
export const RAIN_OPEN_BUS_GAIN = 1;

/** Bus gain when the rain is fully muffled. */
export const RAIN_MUFFLED_BUS_GAIN = 0.55;

/**
 * Exposure used while the camera is under water.
 *
 * Under water the rain is neither seen nor heard directly — what reaches
 * the listener is a dull thud through the water, so the band is left
 * wide open but very quiet.
 */
export const UNDERWATER_EXPOSURE = 0.2;

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value <= 0) return 0;
	if (value >= 1) return 1;
	return value;
}

/**
 * The gain and cutoff settings for one moment of rain.
 */
export interface RainAudioMix {
	/** Gain of the low body band. */
	bodyGain: number;
	/** Gain of the mid hiss band. */
	hissGain: number;
	/** Gain of the high patter band. */
	patterGain: number;
	/**
	 * How much of the rain reaches the listener, 0..1.
	 *
	 * Independent of the intensity: the bands carry how hard it is
	 * raining, this carries how much of it can be heard at all.
	 */
	exposureGain: number;
	/** Lowpass cutoff applied to the whole bus (Hz). */
	cutoff: number;
}

/**
 * Map the rain intensity and the listener's exposure to a mix.
 *
 * `intensity` is the weather intensity, 0..1. `exposure` is how much of
 * the rain reaches the listener: 1 out in the open, 0 fully sealed away
 * from it, and anything in between is partial cover.
 */
export function computeRainMix(
	intensity: number,
	exposure: number,
): RainAudioMix {
	const rain = clamp01(intensity);
	const open = clamp01(exposure);

	/*
	 * The body band is the rumble of a heavy shower, so it only really
	 * shows up once the rain is going full tilt — a light shower is
	 * mostly hiss and patter.
	 */
	const bodyGain = rain * rain * RAIN_BODY_GAIN;
	const hissGain = rain * RAIN_HISS_GAIN;
	const patterGain = rain * RAIN_PATTER_GAIN;

	/*
	 * The cutoff is interpolated exponentially rather than linearly: a
	 * filter's frequency is perceived logarithmically, so a linear ramp
	 * spends most of its travel in the muddy part of the range and the
	 * muffle only becomes audible right at the end.
	 */
	const cutoff =
		RAIN_MUFFLED_CUTOFF * (RAIN_OPEN_CUTOFF / RAIN_MUFFLED_CUTOFF) ** open;

	/*
	 * A sealed position is silent outright, and the muffle takes over
	 * from there: the bus gain falls away as the exposure drops.
	 */
	const exposureGain =
		open *
		(RAIN_MUFFLED_BUS_GAIN +
			(RAIN_OPEN_BUS_GAIN - RAIN_MUFFLED_BUS_GAIN) * open);

	return { bodyGain, hissGain, patterGain, exposureGain, cutoff };
}

/**
 * How much of the rain reaches a listener at a position with the given
 * sky light.
 *
 * `skyLight` is the skylight level, 0..15. 15 means the position sees
 * the open sky and the rain is heard in full; 0 means it is fully
 * enclosed — a cave, or a room with a solid roof — and the rain is
 * inaudible. The levels in between are partial cover: the rain is
 * muffled but still there.
 */
export function rainExposureForSkyLight(
	skyLight: number,
	underwater: boolean,
): number {
	if (underwater) return UNDERWATER_EXPOSURE;

	const level = Math.min(Math.max(skyLight, 0), 15);
	return level / 15;
}
