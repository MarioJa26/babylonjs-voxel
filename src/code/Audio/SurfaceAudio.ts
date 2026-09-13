import { BlockType } from "@/code/World/Texture/BlockType";
import { TextureDefinitionMap } from "@/code/World/Texture/TextureDefinitions";
import { getAudioOutput, makeNoiseBuffer } from "./AudioManager";

/**
 * Procedural footstep / mining / break sounds, one timbre per general
 * surface category. All synthesis runs through the AudioManager master
 * output (volume + mute apply); everything is a no-op without WebAudio.
 *
 * Category mapping is a pure function of the block definition (id + name +
 * texture path), so it is unit-testable without loading blocks.json.
 */

export type SurfaceKind =
	| "stone"
	| "wood"
	| "dirt"
	| "grass"
	| "sand"
	| "leaves"
	| "metal"
	| "glass"
	| "water";

/** Minimal block description for category mapping (subset of TextureDefinition). */
export interface SurfaceBlockInfo {
	id: number;
	name: string;
	path: string;
}

/**
 * Map a block to its surface category. Resolution order: explicit block ids,
 * name keywords, texture-path folder, then a stone default. Case-insensitive
 * on name and path so blocks.json casing never matters.
 */
export function surfaceKindForDef(
	blockId: number,
	def: SurfaceBlockInfo | undefined,
): SurfaceKind {
	if (blockId === BlockType.Water) {
		return "water";
	}

	if (blockId === BlockType.Torch) {
		return "wood";
	}

	if (def) {
		const name = def.name.toLowerCase();
		const path = def.path.toLowerCase();

		if (name.includes("glass")) return "glass";
		if (name.includes("leaves")) return "leaves";
		if (name.includes("grass") || name.includes("mycelium")) return "grass";
		if (name.includes("ice") || name.includes("crystal")) return "glass";
		if (name.includes("sand")) return "sand";
		if (name.includes("torch")) return "wood";

		if (path.includes("/transparent/")) return "glass";
		if (path.includes("/water/")) return "glass";
		if (path.includes("/metal/")) return "metal";
		if (path.includes("/wood/")) return "wood";
		if (path.includes("/sand/")) return "sand";
		if (path.includes("/dirt/")) return "dirt";
		if (path.includes("/items/")) return "wood";
	}

	return "stone";
}

/** Category for a registered block id (stone fallback when unknown). */
export function surfaceKindForBlock(blockId: number): SurfaceKind {
	const def = TextureDefinitionMap.get(blockId);
	return surfaceKindForDef(
		blockId,
		def ? { id: def.id, name: def.name, path: def.path } : undefined,
	);
}

interface TapPreset {
	filter: BiquadFilterType;
	freq: number;
	freqEnd?: number;
	q?: number;
	duration: number;
	gain: number;
	osc?: {
		type: OscillatorType;
		freq: number;
		duration: number;
		gain: number;
	};
}

interface KindTaps {
	step: TapPreset;
	hit: TapPreset;
	break: TapPreset;
}

const KIND_TAPS: Record<SurfaceKind, KindTaps> = {
	stone: {
		step: {
			filter: "lowpass",
			freq: 750,
			freqEnd: 320,
			duration: 0.1,
			gain: 0.3,
		},
		hit: {
			filter: "lowpass",
			freq: 900,
			freqEnd: 350,
			duration: 0.07,
			gain: 0.32,
		},
		break: {
			filter: "lowpass",
			freq: 650,
			freqEnd: 220,
			duration: 0.2,
			gain: 0.45,
		},
	},
	wood: {
		step: {
			filter: "bandpass",
			freq: 480,
			q: 1.1,
			duration: 0.09,
			gain: 0.3,
			osc: { type: "triangle", freq: 170, duration: 0.07, gain: 0.2 },
		},
		hit: {
			filter: "bandpass",
			freq: 560,
			q: 1.1,
			duration: 0.06,
			gain: 0.32,
			osc: { type: "triangle", freq: 200, duration: 0.05, gain: 0.22 },
		},
		break: {
			filter: "bandpass",
			freq: 420,
			q: 1.0,
			duration: 0.16,
			gain: 0.45,
			osc: { type: "triangle", freq: 140, duration: 0.12, gain: 0.3 },
		},
	},
	dirt: {
		step: {
			filter: "lowpass",
			freq: 480,
			freqEnd: 250,
			duration: 0.13,
			gain: 0.26,
		},
		hit: {
			filter: "lowpass",
			freq: 560,
			freqEnd: 280,
			duration: 0.09,
			gain: 0.28,
		},
		break: {
			filter: "lowpass",
			freq: 420,
			freqEnd: 200,
			duration: 0.22,
			gain: 0.42,
		},
	},
	grass: {
		step: {
			filter: "lowpass",
			freq: 900,
			freqEnd: 500,
			duration: 0.14,
			gain: 0.24,
		},
		hit: {
			filter: "bandpass",
			freq: 2600,
			freqEnd: 1900,
			q: 0.9,
			duration: 0.1,
			gain: 0.24,
		},
		break: {
			filter: "bandpass",
			freq: 2100,
			freqEnd: 1300,
			q: 0.9,
			duration: 0.24,
			gain: 0.38,
		},
	},
	sand: {
		step: {
			filter: "bandpass",
			freq: 1300,
			q: 0.8,
			duration: 0.16,
			gain: 0.23,
		},
		hit: { filter: "bandpass", freq: 1500, q: 0.8, duration: 0.1, gain: 0.25 },
		break: {
			filter: "bandpass",
			freq: 1100,
			q: 0.8,
			duration: 0.22,
			gain: 0.38,
		},
	},
	leaves: {
		step: { filter: "highpass", freq: 3800, duration: 0.06, gain: 0.14 },
		hit: { filter: "highpass", freq: 4000, duration: 0.05, gain: 0.16 },
		break: { filter: "highpass", freq: 3200, duration: 0.12, gain: 0.3 },
	},
	metal: {
		step: {
			filter: "bandpass",
			freq: 1400,
			q: 4,
			duration: 0.16,
			gain: 0.26,
		},
		hit: {
			filter: "bandpass",
			freq: 1600,
			q: 4.5,
			duration: 0.08,
			gain: 0.3,
		},
		break: {
			filter: "bandpass",
			freq: 1200,
			q: 3,
			duration: 0.3,
			gain: 0.42,
		},
	},
	glass: {
		step: {
			filter: "highpass",
			freq: 1500,
			duration: 0.08,
			gain: 0.2,
			osc: { type: "sine", freq: 1900, duration: 0.12, gain: 0.1 },
		},
		hit: {
			filter: "highpass",
			freq: 1700,
			duration: 0.06,
			gain: 0.24,
			osc: { type: "sine", freq: 2100, duration: 0.1, gain: 0.12 },
		},
		break: {
			filter: "highpass",
			freq: 1200,
			duration: 0.3,
			gain: 0.4,
			osc: { type: "sine", freq: 1400, duration: 0.25, gain: 0.2 },
		},
	},
	water: {
		step: {
			filter: "lowpass",
			freq: 1000,
			freqEnd: 300,
			duration: 0.22,
			gain: 0.26,
		},
		hit: {
			filter: "lowpass",
			freq: 1000,
			freqEnd: 300,
			duration: 0.15,
			gain: 0.24,
		},
		break: {
			filter: "lowpass",
			freq: 900,
			freqEnd: 250,
			duration: 0.3,
			gain: 0.36,
		},
	},
};

function playTap(preset: TapPreset, intensity: number): void {
	const output = getAudioOutput();
	if (!output) return;

	try {
		const ctx = output.context;
		const now = ctx.currentTime;
		const buffer = makeNoiseBuffer(preset.duration);
		if (!buffer) return;

		const source = ctx.createBufferSource();
		source.buffer = buffer;

		const filter = ctx.createBiquadFilter();
		filter.type = preset.filter;
		filter.frequency.setValueAtTime(preset.freq, now);
		if (preset.freqEnd !== undefined) {
			filter.frequency.exponentialRampToValueAtTime(
				Math.max(40, preset.freqEnd),
				now + preset.duration,
			);
		}
		if (preset.q !== undefined) {
			filter.Q.value = preset.q;
		}

		const gain = ctx.createGain();
		const peak = Math.min(1, Math.max(0, intensity)) * preset.gain;
		gain.gain.setValueAtTime(peak, now);
		gain.gain.exponentialRampToValueAtTime(0.001, now + preset.duration);

		source.connect(filter);
		filter.connect(gain);
		gain.connect(output);
		source.start();

		if (preset.osc) {
			const osc = ctx.createOscillator();
			osc.type = preset.osc.type;
			osc.frequency.value = preset.osc.freq;
			const oscGain = ctx.createGain();
			oscGain.gain.setValueAtTime(
				Math.min(1, Math.max(0, intensity)) * preset.osc.gain,
				now,
			);
			oscGain.gain.exponentialRampToValueAtTime(
				0.001,
				now + preset.osc.duration,
			);
			osc.connect(oscGain);
			oscGain.connect(output);
			osc.start();
			osc.stop(now + preset.osc.duration + 0.02);
		}
	} catch {
		// Audio must never break gameplay.
	}
}

/**
 * Shared footstep cooldown shared by stride steps and step-up steps so the
 * two sources can never overlap: at most one footstep sound every interval.
 */
export const FOOTSTEP_MIN_INTERVAL_MS = 250;

let lastFootstepPlayMs = -Infinity;

/**
 * Footstep on a block. Intensity 0..1 scales with movement speed.
 * Returns true when a sound was emitted (false when throttled or silent),
 * so callers sharing the cooldown can reset their own cadence.
 */
export function playFootstep(blockId: number, intensity = 1): boolean {
	const now = performance.now();
	if (now - lastFootstepPlayMs < FOOTSTEP_MIN_INTERVAL_MS) return false;
	if (!getAudioOutput()) return false;
	lastFootstepPlayMs = now;
	playTap(KIND_TAPS[surfaceKindForBlock(blockId)].step, intensity);
	return true;
}

let lastMineHitMs = 0;
const MINE_HIT_MIN_INTERVAL_MS = 300;

/** Pickaxe thock while mining (internally throttled — call every frame). */
export function playMineHit(blockId: number): void {
	const now = performance.now();
	if (now - lastMineHitMs < MINE_HIT_MIN_INTERVAL_MS) return;
	lastMineHitMs = now;
	playTap(KIND_TAPS[surfaceKindForBlock(blockId)].hit, 1);
}

/** Crunch when a block breaks. */
export function playBlockBreak(blockId: number): void {
	playTap(KIND_TAPS[surfaceKindForBlock(blockId)].break, 1);
}

/**
 * Landing thud on a ground block. Intensity grows with fall distance —
 * a 0.5-block hop is soft, a 6+ block drop lands at full volume.
 */
export function playLand(blockId: number, fallDistance: number): void {
	if (!Number.isFinite(fallDistance) || fallDistance <= 0) return;
	const intensity = Math.min(1, 0.35 + fallDistance / 12);
	playTap(KIND_TAPS[surfaceKindForBlock(blockId)].break, intensity);
}
