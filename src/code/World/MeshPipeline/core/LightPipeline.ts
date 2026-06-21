// MeshPipeline/core/LightPipeline.ts

import type { MeshContext } from "../types/MeshTypes";

/**
 * Quantize a single nibble (used for LOD lighting).
 */
export function quantizeNibble(v: number): number {
	if (v >= 12) return 15;
	if (v >= 8) return 11;
	if (v >= 4) return 4;
	return 0;
}

export function quantizeLightForLOD(
	packed: number,
	disableAO: boolean,
): number {
	const light = packed & 0xff;

	// LOD0/LOD1: keep full precision lighting/AO-compatible packed byte.
	if (!disableAO) return light;

	const block = quantizeNibble(light & 0x0f);
	const sky = quantizeNibble((light >> 4) & 0x0f);

	return block | (sky << 4);
}

/**
 * Merge light from current and neighbor blocks.
 * Matches logic in your original code: partial blocks use max().
 */
export function mergeLight(
	currLight: number,
	neighborLight: number,
	isPartialCurrent: boolean,
	isPartialNeighbor: boolean,
): number {
	return isPartialCurrent && !isPartialNeighbor
		? Math.max(currLight, neighborLight)
		: neighborLight;
}

/**
 * Extract packed sky/block light as a single byte.
 */
export function getPackedLightByte(
	ctx: MeshContext,
	x: number,
	y: number,
	z: number,
): number {
	return ctx.getLight(x, y, z, 0) & 0xff;
}
