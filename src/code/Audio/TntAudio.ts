import { getAudioOutput, makeNoiseBuffer } from "./AudioManager";

/**
 * Procedural TNT sound effects routed through the shared AudioManager output.
 * All functions are safe no-ops when WebAudio is unavailable.
 */

const EXPLOSION_DURATION = 0.8;
const EXPLOSION_GAIN = 0.6;
const EXPLOSION_FILTER_START = 1000;
const EXPLOSION_FILTER_END = 70;

const FUSE_DURATION = 0.5;
const FUSE_GAIN_START = 0.12;
const FUSE_GAIN_END = 0.02;
const FUSE_FILTER_FREQUENCY = 4000;

type NoiseBuffers = {
	explosion?: AudioBuffer;
	fuse?: AudioBuffer;
};

/**
 * AudioBuffers belong to the AudioContext that created them. WeakMap keeps
 * buffers isolated per context without preventing discarded contexts from
 * being garbage-collected.
 */
const noiseBuffers = new WeakMap<BaseAudioContext, NoiseBuffers>();

function getContextBuffers(ctx: BaseAudioContext): NoiseBuffers {
	let buffers = noiseBuffers.get(ctx);

	if (!buffers) {
		buffers = {};
		noiseBuffers.set(ctx, buffers);
	}

	return buffers;
}

function getExplosionBuffer(ctx: BaseAudioContext): AudioBuffer | null {
	const buffers = getContextBuffers(ctx);

	if (buffers.explosion) {
		return buffers.explosion;
	}

	const buffer = makeNoiseBuffer(EXPLOSION_DURATION);

	if (!buffer) {
		return null;
	}

	const data = buffer.getChannelData(0);
	const inverseLength = 1 / data.length;

	// Shape the random noise once. AudioBufferSourceNode can safely reuse the
	// same immutable AudioBuffer across simultaneous explosions.
	for (let i = 0; i < data.length; i++) {
		const remaining = 1 - i * inverseLength;
		data[i] *= remaining * remaining;
	}

	buffers.explosion = buffer;
	return buffer;
}

function getFuseBuffer(ctx: BaseAudioContext): AudioBuffer | null {
	const buffers = getContextBuffers(ctx);

	if (buffers.fuse) {
		return buffers.fuse;
	}

	const buffer = makeNoiseBuffer(FUSE_DURATION);

	if (!buffer) {
		return null;
	}

	buffers.fuse = buffer;
	return buffer;
}

/**
 * Deep explosion boom: decaying noise through a sweeping low-pass filter.
 * `intensity` from 0 to 1 scales loudness, with 1 representing point blank.
 */
export function playExplosionSound(intensity = 1): void {
	if (!Number.isFinite(intensity) || intensity <= 0) {
		return;
	}

	const output = getAudioOutput();

	if (!output) {
		return;
	}

	try {
		const ctx = output.context;
		const buffer = getExplosionBuffer(ctx);

		if (!buffer) {
			return;
		}

		const now = ctx.currentTime;
		const volume = Math.min(1, intensity) * EXPLOSION_GAIN;

		const source = ctx.createBufferSource();
		source.buffer = buffer;

		const filter = ctx.createBiquadFilter();
		filter.type = "lowpass";
		filter.frequency.setValueAtTime(EXPLOSION_FILTER_START, now);
		filter.frequency.exponentialRampToValueAtTime(
			EXPLOSION_FILTER_END,
			now + EXPLOSION_DURATION,
		);

		const gain = ctx.createGain();
		gain.gain.setValueAtTime(volume, now);

		source.connect(filter);
		filter.connect(gain);
		gain.connect(output);

		source.start(now);
	} catch {
		// Audio must never break gameplay.
	}
}

/** Plays a short high-frequency hiss when TNT is ignited. */
export function playFuseHiss(): void {
	const output = getAudioOutput();

	if (!output) {
		return;
	}

	try {
		const ctx = output.context;
		const buffer = getFuseBuffer(ctx);

		if (!buffer) {
			return;
		}

		const now = ctx.currentTime;

		const source = ctx.createBufferSource();
		source.buffer = buffer;

		const filter = ctx.createBiquadFilter();
		filter.type = "highpass";
		filter.frequency.setValueAtTime(FUSE_FILTER_FREQUENCY, now);

		const gain = ctx.createGain();
		gain.gain.setValueAtTime(FUSE_GAIN_START, now);
		gain.gain.exponentialRampToValueAtTime(FUSE_GAIN_END, now + FUSE_DURATION);

		source.connect(filter);
		filter.connect(gain);
		gain.connect(output);

		source.start(now);
	} catch {
		// Audio must never break gameplay.
	}
}
