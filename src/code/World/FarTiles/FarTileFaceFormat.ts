/**
 * Pure far-tile face format: encoding and decoding.
 *
 * ZERO imports. This module must stay dependency-free so the self-test can
 * compile and run it standalone (see scripts/far-tile-selftest.ts).
 *
 * Face encoding (4 x u32):
 *   w0: x:u10 | (y + Y_OFFSET):u12 | z:u10
 *   w1: w:u10 | h:u10 | backFace:u1 | axis:u2
 *   w2: tileX:u8 | tileY:u8 | light:u8
 *   w3: kind:u8
 *
 * Bits 8-23 of w3 carry the tile-origin slot index. The worker leaves those
 * bits clear and FarTileManager stamps them after receiving the face data.
 *
 * Faces are consumed verbatim by the GPU. FarTileShaderLite expands each
 * packed face into a quad in the vertex stage using faceData and tileOrigins.
 *
 * Axis dimension convention used by axisBases():
 *   axis 0 (+/-X): w = Y extent, h = Z extent
 *   axis 1 (+/-Y): w = Z extent, h = X extent
 *   axis 2 (+/-Z): w = X extent, h = Y extent
 *
 * For square terrain and water faces the axis-1 distinction is invisible,
 * but non-square axis-1 faces must follow the convention above.
 */

export const FAR_TILE_Y_OFFSET = 1024;

export const KIND_OPAQUE = 0;
export const KIND_WATER = 1;

export const LIGHT_FULL = 0xf0;
export const LIGHT_SIDE = 0xc0;

const COORD_MASK = 0x3ff;
const HEIGHT_MASK = 0xfff;
const BYTE_MASK = 0xff;

const Y_SHIFT = 10;
const Z_SHIFT = 22;

const FACE_HEIGHT_SHIFT = 10;
const BACK_FACE_SHIFT = 20;
const AXIS_SHIFT = 21;

const TILE_Y_SHIFT = 8;
const LIGHT_SHIFT = 16;

/**
 * Encodes the second packed face word.
 *
 * Layout:
 *   bits  0-9:  width
 *   bits 10-19: height
 *   bit  20:    backFace
 *   bits 21-22: axis
 */
export function packWord1(
	w: number,
	h: number,
	axis: number,
	backFace: number,
): number {
	return (
		((w & COORD_MASK) |
			((h & COORD_MASK) << FACE_HEIGHT_SHIFT) |
			((backFace & 1) << BACK_FACE_SHIFT) |
			((axis & 3) << AXIS_SHIFT)) >>>
		0
	);
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

/**
 * Decodes one face from a packed four-word face array.
 *
 * The caller is responsible for ensuring that faceIndex identifies a complete
 * record. No bounds check is performed because this function may be used in
 * validation loops and Uint32Array already returns undefined for invalid
 * element access.
 */
export function decodeFarTileFace(
	faces: Uint32Array,
	faceIndex: number,
): DecodedFarTileFace {
	const offset = faceIndex << 2;

	const word0 = faces[offset];
	const word1 = faces[offset + 1];
	const word2 = faces[offset + 2];
	const word3 = faces[offset + 3];

	return {
		x: word0 & COORD_MASK,
		y: ((word0 >>> Y_SHIFT) & HEIGHT_MASK) - FAR_TILE_Y_OFFSET,
		z: (word0 >>> Z_SHIFT) & COORD_MASK,

		w: word1 & COORD_MASK,
		h: (word1 >>> FACE_HEIGHT_SHIFT) & COORD_MASK,
		backFace: (word1 >>> BACK_FACE_SHIFT) & 1,
		axis: (word1 >>> AXIS_SHIFT) & 3,

		tileX: word2 & BYTE_MASK,
		tileY: (word2 >>> TILE_Y_SHIFT) & BYTE_MASK,
		light: (word2 >>> LIGHT_SHIFT) & BYTE_MASK,

		kind: word3 & BYTE_MASK,
	};
}
