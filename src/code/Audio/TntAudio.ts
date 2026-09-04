import { getAudioOutput, makeNoiseBuffer } from "./AudioManager";

/**
 * Procedural TNT sound effects, routed through the shared AudioManager master
 * output (volume + mute apply automatically).
 * All functions are safe no-ops when WebAudio is unavailable (e.g. tests).
 */

/**
 * Deep explosion boom: decaying noise through a sweeping lowpass filter.
 * `intensity` 0..1 scales loudness (1 = point blank).
 */
export function playExplosionSound(intensity = 1): void {
	const output = getAudioOutput();
	if (!output) return;

	try {
		const ctx = output.context;
		const duration = 0.8;
		const buffer = makeNoiseBuffer(duration);
		if (!buffer) return;

		const data = buffer.getChannelData(0);
		// Shape the decay envelope into the buffer (t² falloff).
		for (let i = 0; i < data.length; i++) {
			const t = i / data.length;
			const decay = (1 - t) * (1 - t);
			data[i] *= decay;
		}

		const source = ctx.createBufferSource();
		source.buffer = buffer;

		const filter = ctx.createBiquadFilter();
		filter.type = "lowpass";
		filter.frequency.setValueAtTime(1000, ctx.currentTime);
		filter.frequency.exponentialRampToValueAtTime(
			70,
			ctx.currentTime + duration,
		);

		const gain = ctx.createGain();
		gain.gain.value = Math.min(1, Math.max(0, intensity)) * 0.6;

		source.connect(filter);
		filter.connect(gain);
		gain.connect(output);
		source.start();
	} catch {
		// Audio must never break gameplay.
	}
}

/** Short fuse hiss when TNT is ignited. */
export function playFuseHiss(): void {
	const output = getAudioOutput();
	if (!output) return;

	try {
		const ctx = output.context;
		const duration = 0.5;
		const buffer = makeNoiseBuffer(duration);
		if (!buffer) return;

		const source = ctx.createBufferSource();
		source.buffer = buffer;

		const filter = ctx.createBiquadFilter();
		filter.type = "highpass";
		filter.frequency.value = 4000;

		const gain = ctx.createGain();
		gain.gain.setValueAtTime(0.12, ctx.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.02, ctx.currentTime + duration);

		source.connect(filter);
		filter.connect(gain);
		gain.connect(output);
		source.start();
	} catch {
		// Audio must never break gameplay.
	}
}
