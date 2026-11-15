import { getAudioOutput } from "./AudioManager";
import {
	computeRainMix,
	RAIN_BODY_FREQ,
	RAIN_CROSSFADE_SECONDS,
	RAIN_HISS_FREQ,
	RAIN_NOISE_SECONDS,
	RAIN_OPEN_CUTOFF,
	RAIN_PATTER_FREQ,
	RAIN_RAMP_SECONDS,
} from "./RainAudioMix";

/**
 * Procedural rain audio.
 *
 * The rain bed is one looping, shaped buffer split into three bands by
 * parallel filters: a low "body" for the rumble of a heavy shower, a
 * band-passed "hiss" for the sheet of falling water, and a high-passed
 * "patter" for sparse individual drops striking the ground. The source is
 * deliberately correlated and contains short impacts; raw white noise made
 * the old effect sound like static even after filtering.
 *
 * Everything is synthesised — there is no rain asset to load, so the
 * effect costs one buffer, one source and four filters.
 *
 * The mix itself lives in `RainAudioMix.ts`, which has no browser
 * dependencies and can therefore be checked headlessly.
 */

let audioCtx: BaseAudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let busGain: GainNode | null = null;
let muffle: BiquadFilterNode | null = null;
let bodyGain: GainNode | null = null;
let hissGain: GainNode | null = null;
let patterGain: GainNode | null = null;

/*
 * The last value scheduled on each parameter.
 *
 * -1 means "never scheduled", which forces the first update through even
 * when the target happens to be the default.
 */
let lastBodyGain = -1;
let lastHissGain = -1;
let lastPatterGain = -1;
let lastExposureGain = -1;
let lastCutoff = -1;

/**
 * How far a target has to move before it is worth rescheduling.
 *
 * Small enough to be inaudible as a level change, large enough to stop
 * the automation timeline being refilled with near-identical events.
 */
const PARAM_EPSILON = 0.002;

/**
 * Build a noise buffer that loops without a click.
 *
 * The tail is crossfaded into the head with the pairing reversed, so the
 * last sample ends up equal to the first one. The loop point is then
 * continuous and the repeat is inaudible.
 */
function buildSeamlessNoise(ctx: BaseAudioContext): AudioBuffer {
	const sampleRate = ctx.sampleRate;
	const length = Math.max(1, Math.floor(sampleRate * RAIN_NOISE_SECONDS));
	const fade = Math.min(
		Math.floor(sampleRate * RAIN_CROSSFADE_SECONDS),
		Math.floor(length / 2),
	);

	const buffer = ctx.createBuffer(1, length, sampleRate);
	const data = buffer.getChannelData(0);

	// A local deterministic generator keeps the buffer repeatable without
	// touching the game's random streams.
	let rng = 0x6d2b79f5;
	const random = (): number => {
		rng |= 0;
		rng = (rng + 0x6d2b79f5) | 0;
		let t = Math.imul(rng ^ (rng >>> 15), 1 | rng);
		t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};

	// Correlated noise makes the continuous sheet read as water rather than
	// an unbroken white-noise hiss. The slow component supplies natural gusts.
	let low = 0;
	let mid = 0;
	let gust = 0;
	for (let i = 0; i < length; i++) {
		const white = random() * 2 - 1;
		low += (white - low) * 0.006;
		mid += (white - mid) * 0.12;
		gust += (random() * 2 - 1 - gust) * 0.0015;
		const envelope = 0.72 + Math.min(0.28, Math.max(-0.18, gust));
		data[i] = (low * 0.8 + mid * 0.65) * envelope;
	}

	// Add discrete drops. They are short, decaying noise grains with a small
	// tonal component, which gives the high band recognizable impacts instead
	// of leaving it as a constant static layer.
	const dropCount = Math.floor(RAIN_NOISE_SECONDS * 115);
	for (let drop = 0; drop < dropCount; drop++) {
		const start = Math.floor(random() * Math.max(1, length - 1));
		const grainLength = Math.max(
			1,
			Math.floor(sampleRate * (0.008 + random() * 0.035)),
		);
		const amplitude = 0.2 + random() * 0.55;
		const frequency = 900 + random() * 4200;
		const phase = random() * Math.PI * 2;
		const decay = Math.max(1, grainLength * (0.2 + random() * 0.18));

		for (let j = 0; j < grainLength && start + j < length; j++) {
			const t = j / grainLength;
			const fade = Math.exp(-j / decay) * (1 - t * 0.55);
			const tonal = Math.sin(
				phase + (j / sampleRate) * frequency * Math.PI * 2,
			);
			const noisy = random() * 2 - 1;
			data[start + j] += (tonal * 0.35 + noisy * 0.65) * fade * amplitude;
		}
	}

	for (let i = 0; i < fade; i++) {
		const t = fade > 1 ? i / (fade - 1) : 1;
		const tail = length - fade + i;

		// The head region is still untouched here — only the tail is written.
		// Crossfade the end into the beginning so the loop point is not a
		// repeated click or a static reset.
		data[tail] = data[tail] * (1 - t) + data[i] * t;
	}

	return buffer;
}

/**
 * Create the rain graph if it does not exist yet.
 *
 * The graph is built lazily, on the first rain, so a session that never
 * rains never creates an AudioContext.
 */
function ensureGraph(): boolean {
	const output = getAudioOutput();
	if (!output) return false;

	const ctx = output.context;

	if (audioCtx === ctx && source !== null) return true;

	try {
		const buffer = buildSeamlessNoise(ctx);

		const src = ctx.createBufferSource();
		src.buffer = buffer;
		src.loop = true;

		const bus = ctx.createGain();
		bus.gain.value = 0;

		const muffleFilter = ctx.createBiquadFilter();
		muffleFilter.type = "lowpass";
		muffleFilter.frequency.value = RAIN_OPEN_CUTOFF;
		muffleFilter.Q.value = 0.7;

		const bodyFilter = ctx.createBiquadFilter();
		bodyFilter.type = "lowpass";
		bodyFilter.frequency.value = RAIN_BODY_FREQ;

		const body = ctx.createGain();
		body.gain.value = 0;

		const hissFilter = ctx.createBiquadFilter();
		hissFilter.type = "bandpass";
		hissFilter.frequency.value = RAIN_HISS_FREQ;
		hissFilter.Q.value = 0.6;

		const hiss = ctx.createGain();
		hiss.gain.value = 0;

		const patterFilter = ctx.createBiquadFilter();
		patterFilter.type = "highpass";
		patterFilter.frequency.value = RAIN_PATTER_FREQ;

		const patter = ctx.createGain();
		patter.gain.value = 0;

		src.connect(bodyFilter);
		bodyFilter.connect(body);
		body.connect(bus);

		src.connect(hissFilter);
		hissFilter.connect(hiss);
		hiss.connect(bus);

		src.connect(patterFilter);
		patterFilter.connect(patter);
		patter.connect(bus);

		bus.connect(muffleFilter);
		muffleFilter.connect(output);

		src.start();

		audioCtx = ctx;
		source = src;
		busGain = bus;
		muffle = muffleFilter;
		bodyGain = body;
		hissGain = hiss;
		patterGain = patter;

		// The new nodes start silent: force every target through once.
		lastBodyGain = -1;
		lastHissGain = -1;
		lastPatterGain = -1;
		lastExposureGain = -1;
		lastCutoff = -1;

		return true;
	} catch {
		// Audio must never break gameplay.
		return false;
	}
}

/**
 * Drive the rain bed.
 *
 * Called once per frame from the rain system, which owns the decision
 * about whether the player is out in the rain, under cover, or under
 * water — the visuals and the sound follow the same rule.
 *
 * @param intensity - Rain intensity, 0..1.
 * @param exposure - How much of the rain reaches the listener, 0..1.
 */
export function updateRainAudio(intensity: number, exposure: number): void {
	const mix = computeRainMix(intensity, exposure);

	/*
	 * Nothing to hear and nothing built yet: leave the graph alone, so a
	 * session that never rains never creates an AudioContext.
	 */
	const audible =
		mix.exposureGain > 0 &&
		(mix.bodyGain > 0 || mix.hissGain > 0 || mix.patterGain > 0);

	if (!audible && busGain === null) return;

	if (!ensureGraph()) return;

	const ctx = audioCtx;
	if (!ctx || !busGain || !muffle || !bodyGain || !hissGain || !patterGain) {
		return;
	}

	const now = ctx.currentTime;

	/*
	 * Only reschedule a parameter when its target actually moved. The
	 * rain is updated every frame, and refilling the automation timeline
	 * with identical events sixty times a second is pure overhead — the
	 * values only change when the weather or the shelter does.
	 */
	lastBodyGain = scheduleTarget(bodyGain.gain, mix.bodyGain, lastBodyGain, now);
	lastHissGain = scheduleTarget(hissGain.gain, mix.hissGain, lastHissGain, now);
	lastPatterGain = scheduleTarget(
		patterGain.gain,
		mix.patterGain,
		lastPatterGain,
		now,
	);
	lastExposureGain = scheduleTarget(
		busGain.gain,
		mix.exposureGain,
		lastExposureGain,
		now,
	);
	lastCutoff = scheduleTarget(muffle.frequency, mix.cutoff, lastCutoff, now);
}

/**
 * Schedule a parameter change, but only when the target actually moved.
 *
 * Returns the value to remember for the next call.
 */
function scheduleTarget(
	param: AudioParam,
	value: number,
	last: number,
	now: number,
): number {
	if (Math.abs(value - last) < PARAM_EPSILON) return last;

	param.setTargetAtTime(value, now, RAIN_RAMP_SECONDS);
	return value;
}

/** Stop the rain bed and release its nodes. */
export function disposeRainAudio(): void {
	try {
		source?.stop();
	} catch {
		// The source may already have been stopped.
	}

	try {
		source?.disconnect();
		busGain?.disconnect();
		muffle?.disconnect();
		bodyGain?.disconnect();
		hissGain?.disconnect();
		patterGain?.disconnect();
	} catch {
		// Disconnecting a node that was never connected is harmless.
	}

	audioCtx = null;
	source = null;
	busGain = null;
	muffle = null;
	bodyGain = null;
	hissGain = null;
	patterGain = null;

	lastBodyGain = -1;
	lastHissGain = -1;
	lastPatterGain = -1;
	lastExposureGain = -1;
	lastCutoff = -1;
}
