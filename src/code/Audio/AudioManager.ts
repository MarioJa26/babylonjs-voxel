import { loadGameSettings, saveGameSettings } from "@/code/UI/GameSettings";

/**
 * Central WebAudio manager: one lazy AudioContext, one master gain, runtime
 * volume/mute state persisted through GameSettings.
 *
 * All functions are safe no-ops when WebAudio or localStorage is unavailable
 * (e.g. tsx tests). Module top-level touches neither — state loads lazily.
 */

let sharedCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;

let masterVolume = 0.8;
let muted = false;
let settingsLoaded = false;

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0.8;
	return Math.min(1, Math.max(0, value));
}

function hasLocalStorage(): boolean {
	try {
		return typeof localStorage !== "undefined";
	} catch {
		return false;
	}
}

function loadPersistedAudio(): void {
	if (settingsLoaded) return;
	settingsLoaded = true;

	try {
		const settings = loadGameSettings();
		masterVolume = clamp01(settings.masterVolume);
		muted = settings.muted;
	} catch {
		// Defaults stand.
	}
}

function persistAudio(): void {
	if (!hasLocalStorage()) return;

	try {
		const settings = loadGameSettings();
		settings.masterVolume = masterVolume;
		settings.muted = muted;
		saveGameSettings(settings);
	} catch {
		// Audio must never break gameplay.
	}
}

function applyGain(): void {
	if (sharedCtx && masterGain) {
		masterGain.gain.setTargetAtTime(
			muted ? 0 : masterVolume,
			sharedCtx.currentTime,
			0.02,
		);
	}
}

function ensureContext(): AudioContext | null {
	try {
		if (typeof AudioContext === "undefined") return null;
		if (!sharedCtx) {
			sharedCtx = new AudioContext();
			masterGain = sharedCtx.createGain();
			masterGain.gain.value = muted ? 0 : masterVolume;
			masterGain.connect(sharedCtx.destination);
		}
		if (sharedCtx.state === "suspended") {
			void sharedCtx.resume();
		}
		return sharedCtx;
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
	masterVolume = clamp01(value);
	applyGain();
	persistAudio();
}

export function setMuted(value: boolean): void {
	loadPersistedAudio();
	muted = value;
	applyGain();
	persistAudio();
}

/**
 * Push boot/persisted settings into the runtime (called by TestScene after
 * loadGameSettings). Marks settings loaded so later lazy loads don't clobber.
 */
export function applyAudioSettings(settings: {
	masterVolume: number;
	muted: boolean;
}): void {
	settingsLoaded = true;
	masterVolume = clamp01(settings.masterVolume);
	muted = settings.muted;
	applyGain();
}

/**
 * Shared master output for sound effects. Null when audio is unavailable or
 * muted — callers treat null as "stay silent".
 */
export function getAudioOutput(): GainNode | null {
	loadPersistedAudio();
	const ctx = ensureContext();
	if (!ctx || !masterGain) return null;
	if (muted) return null;
	return masterGain;
}

/** Shared white-noise buffer helper for procedural sound effects. */
export function makeNoiseBuffer(seconds: number): AudioBuffer | null {
	const ctx = ensureContext();
	if (!ctx) return null;

	try {
		const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
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
