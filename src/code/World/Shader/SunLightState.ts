// World/Light/SunLightState.ts
//
// The world's sun direction and intensity, shared by every custom shader that
// lights its geometry with the sun (chunk meshes, distant terrain, far tiles
// and the player rig).
//
// The direction is blended towards straight up as the sun approaches the
// horizon so the light does not swing wildly at sunrise and sunset. The
// chunk mesher has always used this blend, so anything that should look
// like it is standing in the same light as the terrain has to use the same
// formula.

import { GLOBAL_VALUES } from "../GLOBAL_VALUES";

export type SunLightState = {
	/** Direction pointing towards the sun. */
	x: number;
	y: number;
	z: number;

	/** Daylight strength: 0 at night, 1 around noon. */
	intensity: number;
};

/** Snapping keeps the uniforms stable while the sun barely moves. */
const LIGHT_QUANTIZATION_SCALE = 256;
const LIGHT_QUANTIZATION_INVERSE = 1 / LIGHT_QUANTIZATION_SCALE;

function clampUnit(value: number): number {
	return value <= 0 ? 0 : Math.min(value, 1);
}

function quantizeLightingValue(value: number): number {
	return (
		Math.round(value * LIGHT_QUANTIZATION_SCALE) * LIGHT_QUANTIZATION_INVERSE
	);
}

/**
 * Writes the current sun state into out and returns it.
 *
 * Callers pass a scratch object so the hot path stays allocation free.
 */
export function computeSunLightState(out: SunLightState): SunLightState {
	const sourceDirection = GLOBAL_VALUES.skyLightDirection;

	const lightY = sourceDirection.y;
	const shaderDirectionY = -lightY;

	const normalizedHorizon = clampUnit((shaderDirectionY + 0.2) * 2.5);

	const inverseHorizon = 1 - normalizedHorizon;
	const verticalBlend =
		inverseHorizon * inverseHorizon * (3 - 2 * inverseHorizon);

	const directionalBlend = 1 - verticalBlend;

	out.x = quantizeLightingValue(-sourceDirection.x * directionalBlend);

	out.y = quantizeLightingValue(-lightY * directionalBlend + verticalBlend);

	out.z = quantizeLightingValue(-sourceDirection.z * directionalBlend);

	out.intensity = quantizeLightingValue(clampUnit((-lightY + 0.1) * 4));

	return out;
}
