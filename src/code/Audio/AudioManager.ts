import { loadGameSettings, saveGameSettings } from "@/code/UI/GameSettings";

/**
 * Central WebAudio manager: one lazy AudioContext, one master gain, and
 * runtime volume/mute state persisted through GameSettings.
 *
 * All functions safely degrade when WebAudio or localStorage is unavailable.
 * Module initialization does not access browser-only APIs.
 */

const DEFAULT_MASTER_VOLUME = 0.8;
const GAIN_TRANSITION_SECONDS = 0.02;

let sharedCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;

let masterVolume = DEFAULT_MASTER_VOLUME;
let muted = false;
let settingsLoaded = false;

function clamp01(value: number): number {
	if (!Number.isFinite(value)) {
		return DEFAULT_MASTER_VOLUME;
	}

	if (value <= 0) return 0;
	if (value >= 1) return 1;

	return value;
}

/**
 * Loads persisted audio state at most once.
 *
 * Marking settings as loaded before calling loadGameSettings prevents repeated
 * attempts if storage is unavailable or the stored data is malformed.
 */
function loadPersistedAudio(): void {
	if (settingsLoaded) {
		return;
	}

	settingsLoaded = true;

	try {
		const settings = loadGameSettings();

		masterVolume = clamp01(settings.masterVolume);
		muted = Boolean(settings.muted);
	} catch {
		// Keep runtime defaults.
	}
}

/**
 * Persists the current audio state without allowing storage failures to
 * affect gameplay.
 */
function persistAudio(): void {
	try {
		if (typeof localStorage === "undefined") {
			return;
		}

		const settings = loadGameSettings();

		settings.masterVolume = masterVolume;
		settings.muted = muted;

		saveGameSettings(settings);
	} catch {
		// Audio and storage errors must never interrupt gameplay.
	}
}

function getEffectiveVolume(): number {
	return muted ? 0 : masterVolume;
}

/**
 * Applies the current effective volume to an existing audio graph.
 */
function applyGain(): void {
	const ctx = sharedCtx;
	const gain = masterGain;

	if (!ctx || !gain) {
		return;
	}

	const targetVolume = getEffectiveVolume();
	const gainParam = gain.gain;

	// Prevent previously scheduled transitions from competing with a new
	// volume or mute update.
	gainParam.cancelScheduledValues(ctx.currentTime);
	gainParam.setTargetAtTime(
		targetVolume,
		ctx.currentTime,
		GAIN_TRANSITION_SECONDS,
	);
}

/**
 * Lazily creates and resumes the shared WebAudio graph.
 */
function ensureContext(): AudioContext | null {
	loadPersistedAudio();

	try {
		if (typeof AudioContext === "undefined") {
			return null;
		}

		if (!sharedCtx) {
			const ctx = new AudioContext();
			const gain = ctx.createGain();

			gain.gain.value = getEffectiveVolume();
			gain.connect(ctx.destination);

			// Assign only after the complete audio graph has been created.
			// This avoids retaining a partially initialized context if setup
			// throws.
			sharedCtx = ctx;
			masterGain = gain;
		}

		const ctx = sharedCtx;

		if (ctx.state === "suspended") {
			// Browser autoplay policies may reject resume until a user gesture.
			// Absorb that rejection so it does not become unhandled.
			void ctx.resume().catch(() => {
				// The next audio request can attempt to resume again.
			});
		}

		return ctx;
	} catch {
		return null;
	}
}

export function getMasterVolume(): number {
	loadPersistedAudio();
	return masterVolume;
}

export function isMuted(): boolean {
	loadPersistedAudio();
	return muted;
}

export function setMasterVolume(value: number): void {
	loadPersistedAudio();

	const nextVolume = clamp01(value);

	if (nextVolume === masterVolume) {
		return;
	}

	masterVolume = nextVolume;

	applyGain();
	persistAudio();
}

export function setMuted(value: boolean): void {
	loadPersistedAudio();

	const nextMuted = Boolean(value);

	if (nextMuted === muted) {
		return;
	}

	muted = nextMuted;

	applyGain();
	persistAudio();
}

/**
 * Pushes already-loaded boot settings into the audio runtime.
 *
 * This marks settings as loaded so a subsequent lazy access cannot overwrite
 * the supplied runtime values with storage data.
 */
export function applyAudioSettings(settings: {
	masterVolume: number;
	muted: boolean;
}): void {
	settingsLoaded = true;

	const nextVolume = clamp01(settings.masterVolume);
	const nextMuted = Boolean(settings.muted);

	if (nextVolume === masterVolume && nextMuted === muted) {
		return;
	}

	masterVolume = nextVolume;
	muted = nextMuted;

	applyGain();
}

/**
 * Returns the shared master output for sound effects.
 *
 * Returns null if WebAudio is unavailable or audio is muted. Callers should
 * treat null as a request to remain silent.
 */
export function getAudioOutput(): GainNode | null {
	loadPersistedAudio();

	if (muted) {
		return null;
	}

	if (!ensureContext()) {
		return null;
	}

	return masterGain;
}

/**
 * Creates a mono white-noise buffer for procedural sound effects.
 */
export function makeNoiseBuffer(seconds: number): AudioBuffer | null {
	const ctx = ensureContext();

	if (!ctx) {
		return null;
	}

	try {
		const requestedLength = Math.floor(ctx.sampleRate * seconds);
		const length = Math.max(1, requestedLength);

		const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
		const data = buffer.getChannelData(0);

		for (let i = 0; i < length; i++) {
			data[i] = Math.random() * 2 - 1;
		}

		return buffer;
	} catch {
		return null;
	}
}
