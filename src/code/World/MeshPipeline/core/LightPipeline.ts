// MeshPipeline/core/LightPipeline.ts

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
