import {
	type GameSettings,
	loadGameSettings,
	saveGameSettings,
} from "@/code/UI/GameSettings";

/**
 * First-person held-item walk bob.
 *
 * The viewmodel is pinned to the camera, so without this it would sit
 * perfectly still while the player walks. This module owns the small
 * camera-relative offsets that make the item breathe with the walk cycle,
 * plus the runtime amplitude that scales them.
 *
 * The model follows Minecraft's first-person walk:
 *
 *   - the arm swings forward and back in step with the stride, and the item
 *     is pushed away from the camera and pulled back with it. That forward
 *     swing with the matching tilt is what reads as a Minecraft viewmodel;
 *   - the item drifts sideways a quarter cycle out of phase with the swing;
 *   - it bounces vertically twice per stride, once per footfall.
 *
 * The offsets follow the same stride phase the player rig uses, so the item
 * moves in step with the arm swing instead of on an unrelated clock.
 *
 * Every rotation is driven by the displacement it belongs to: the tilt peaks
 * where the item is furthest out, and the turn peaks at the edge of the
 * sideways drift. The item is unrotated as it passes through its neutral
 * holding position.
 */

/** Default bob amplitude: 1 is the full effect. */
const DEFAULT_AMPLITUDE = 1;

/** Peak forward/back travel at amplitude 1, in meters. */
const BOB_FORWARD = 0.05;

/** Peak vertical travel at amplitude 1, in meters. */
const BOB_VERTICAL = 0.025;

/** Peak sideways drift at amplitude 1, in meters. */
const BOB_HORIZONTAL = 0.02;

/** Peak forward/back tilt at amplitude 1, in radians. */
const BOB_PITCH = 0.13;

/** Peak sideways turn at amplitude 1, in radians. */
const BOB_YAW = 0.05;

/**
 * Speed at which the viewmodel bob stops speeding up, in m/s.
 *
 * The player rig swings with the full stride, so a sprint swings the arm
 * faster. The first-person bob keeps a capped rate instead: sprinting should
 * nudge the rhythm up, not turn the bob into a fast jitter.
 */
export const HELD_ITEM_BOB_SPEED_CAP = 5;

/** One full cycle, in radians. The bob phase wraps to this. */
const TWO_PI = Math.PI * 2;

/**
 * Advances the viewmodel bob phase.
 *
 * The rate is capped, so the jump from walking to sprinting is a small
 * change in rhythm instead of a completely different animation. The phase is
 * wrapped to one cycle to keep the trigonometry precise.
 */
export function advanceHeldItemBobPhase(
	phase: number,
	speed: number,
	dt: number,
	strideFactor: number,
): number {
	const cappedSpeed = Math.min(Math.max(speed, 0), HELD_ITEM_BOB_SPEED_CAP);

	const next = phase + cappedSpeed * dt * strideFactor;

	const wrapped = next % TWO_PI;

	return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

/**
 * One frame of camera-relative bob.
 */
export interface HeldItemBobOffset {
	/** Offset along the camera right axis, in meters. */
	x: number;
	/** Offset along the camera up axis, in meters. */
	y: number;
	/** Offset along the camera forward axis, in meters. */
	forward: number;
	/** Extra pitch about the camera right axis, in radians. */
	pitch: number;
	/** Extra yaw about the camera up axis, in radians. */
	yaw: number;
}

let runtimeAmplitude = DEFAULT_AMPLITUDE;
let settingsLoaded = false;

function clamp01(value: number, fallback: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}

	if (value <= 0) {
		return 0;
	}

	if (value >= 1) {
		return 1;
	}

	return value;
}

/**
 * Loads the persisted amplitude once.
 *
 * The flag is set before the read so a storage failure cannot cause a
 * second attempt on the next frame.
 */
function loadPersistedAmplitude(): void {
	if (settingsLoaded) {
		return;
	}

	settingsLoaded = true;

	try {
		runtimeAmplitude = clamp01(
			loadGameSettings().heldItemBobAmplitude,
			DEFAULT_AMPLITUDE,
		);
	} catch {
		// Keep the runtime default.
	}
}

/**
 * Current bob amplitude: 0 disables the bob, 1 is the full effect.
 */
export function getHeldItemBobAmplitude(): number {
	loadPersistedAmplitude();

	return runtimeAmplitude;
}

/**
 * Applies the persisted settings to the runtime amplitude.
 */
export function applyHeldItemBobSettings(settings: GameSettings): void {
	settingsLoaded = true;

	runtimeAmplitude = clamp01(settings.heldItemBobAmplitude, DEFAULT_AMPLITUDE);
}

/**
 * Sets the runtime amplitude and persists it.
 */
export function setHeldItemBobAmplitude(value: number): void {
	const amplitude = clamp01(value, DEFAULT_AMPLITUDE);

	settingsLoaded = true;
	runtimeAmplitude = amplitude;

	try {
		const settings = loadGameSettings();

		settings.heldItemBobAmplitude = amplitude;

		saveGameSettings(settings);
	} catch {
		// A storage failure must never interrupt gameplay.
	}
}

/**
 * Writes the camera-relative bob for one frame into out.
 *
 * phase is the walk-stride phase in radians, walkAmplitude is the player's
 * current stride amplitude in [0, 1], and scale is the player setting that
 * scales the whole effect.
 */
/**
 * Writes one frame of camera-relative held-item bob into `out`.
 *
 * `phase` is the walk-stride phase in radians.
 * `walkAmplitude` and `scale` are clamped to [0, 1].
 */
export function computeHeldItemBob(
	phase: number,
	walkAmplitude: number,
	scale: number,
	out: HeldItemBobOffset,
): HeldItemBobOffset {
	const amplitude =
		Number.isFinite(walkAmplitude) && walkAmplitude > 0
			? walkAmplitude >= 1
				? 1
				: walkAmplitude
			: 0;

	const effectScale =
		Number.isFinite(scale) && scale > 0 ? (scale >= 1 ? 1 : scale) : 0;

	const amount = amplitude * effectScale;

	if (amount === 0) {
		out.x = 0;
		out.y = 0;
		out.forward = 0;
		out.pitch = 0;
		out.yaw = 0;
		return out;
	}

	const swing = Math.sin(phase);
	const drift = Math.cos(phase);
	const scaledSwing = swing * amount;
	const scaledDrift = drift * amount;

	out.x = scaledDrift * BOB_HORIZONTAL;
	out.y = swing * drift * amount * BOB_VERTICAL * 2;
	out.forward = scaledSwing * BOB_FORWARD;
	out.pitch = scaledSwing * BOB_PITCH;
	out.yaw = scaledDrift * BOB_YAW;

	return out;
}
