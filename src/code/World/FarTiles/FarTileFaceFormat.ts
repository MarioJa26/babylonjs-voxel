/**
 * Pure far-tile face format: encoding and decoding.
 *
 * ZERO imports — this module must stay dependency-free so the self-test can
 * compile and run it standalone (see scripts/far-tile-selftest.ts).
 *
 * Face encoding (4 x u32):
 *   w0: x:u10 | (y+Y_OFFSET):u12 | z:u10            tile-local block coords
 *   w1: w:u10(bit0) | h:u10(bit10) | backFace:u1(bit20) | axis:u2(bit21-22)
 *   w2: tileX:u8 | tileY:u8 | light:u8              atlas tile + light
 *   w3: kind:u8                                     0 opaque, 1 water
 *       (bits 8-23 carry the tile-origin slot index, stamped by
 *        FarTileManager on arrival — never set by the worker)
 *
 * Faces are consumed verbatim by the GPU (FarTileShaderLite expands quads in
 * the vertex stage from faceData + tileOrigins storage buffers); there is no
 * CPU expansion step anymore.
 *
 * Axis dimension convention:
 *   axis 0 (+/-X): w = Y-extent, h = Z-extent
 *   axis 1 (+/-Y): w = X-extent, h = Z-extent   [water uses w=X, h=Z too]
 *   axis 2 (+/-Z): w = X-extent, h = Y-extent
 */

export const FAR_TILE_Y_OFFSET = -(-32) * 32; // MIN_CHUNK_Y * CHUNK_SIZE negated

export const KIND_OPAQUE = 0;
export const KIND_WATER = 1;

export const LIGHT_FULL = 0xf0;
export const LIGHT_SIDE = 0xc0;

/** Encode one packed face word-pair helper (w1 value). */
export function packWord1(
	w: number,
	h: number,
	axis: number,
	backFace: number,
): number {
	// Layout: bit20 = backFace, bit21-22 = axis. Mask must keep THREE bits
	// (axis occupies bits 21-22 after the shift) — an &0x3 here silently
	// truncates axis=2 into axis=0 and scrambles every Z-facing quad.
	const axisFace = (((axis << 1) | backFace) & 0x7) << 20;
	return (w & 0x3ff) | ((h & 0x3ff) << 10) | (axisFace & 0x700000);
}

export interface DecodedFarTileFace {
	x: number;
	y: number;
	z: number;
	w: number;
	h: number;
	axis: number;
	backFace: number;
	tileX: number;
	tileY: number;
	light: number;
	kind: number;
}

export function decodeFarTileFace(
	faces: Uint32Array,
	faceIndex: number,
): DecodedFarTileFace {
	const i = faceIndex * 4;
	const w0 = faces[i];
	const w1 = faces[i + 1];
	const w2 = faces[i + 2];

	return {
		x: w0 & 0x3ff,
		y: ((w0 >>> 10) & 0xfff) - FAR_TILE_Y_OFFSET,
		z: (w0 >>> 22) & 0x3ff,
		w: w1 & 0x3ff,
		h: (w1 >>> 10) & 0x3ff,
		// Layout mirrors packWord1: bit20 = backFace, bits21-22 = axis.
		axis: (w1 >>> 21) & 0x3,
		backFace: (w1 >>> 20) & 0x1,
		tileX: w2 & 0xff,
		tileY: (w2 >>> 8) & 0xff,
		light: (w2 >>> 16) & 0xff,
		kind: faces[i + 3] & 0xff,
	};
}
