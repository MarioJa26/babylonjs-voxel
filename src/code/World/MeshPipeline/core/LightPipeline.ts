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

// Fused byte-quantization LUT for the LOD light-packing hot path (called
// once per emitted face on every LOD2+ chunk, i.e. most on-screen chunks at
// typical view distances). Index is the raw packed light byte (block nibble
// | sky nibble << 4); value is the pre-quantized byte. Built once from
// quantizeNibble at module load, so behavior is guaranteed identical while
// the hot call becomes a single array read instead of 2 nibble extractions
// + up to 4 comparisons each.
const LIGHT_BYTE_QUANT_LUT: Uint8Array = (() => {
	const lut = new Uint8Array(256);
	for (let light = 0; light < 256; light++) {
		const block = quantizeNibble(light & 0x0f);
		const sky = quantizeNibble((light >> 4) & 0x0f);
		lut[light] = block | (sky << 4);
	}
	return lut;
})();

/**
 * Quantize a raw packed light byte for LOD2+ rendering. Callers that already
 * know disableAO is true (e.g. inside a branch that checked it once) should
 * call this directly instead of quantizeLightForLOD(light, true) to avoid
 * re-checking a flag that's already known.
 */
export function quantizeByteForLOD(light: number): number {
	return LIGHT_BYTE_QUANT_LUT[light & 0xff];
}

export function quantizeLightForLOD(
	packed: number,
	disableAO: boolean,
): number {
	const light = packed & 0xff;

	// LOD0/LOD1: keep full precision lighting/AO-compatible packed byte.
	if (!disableAO) return light;

	return LIGHT_BYTE_QUANT_LUT[light];
}
