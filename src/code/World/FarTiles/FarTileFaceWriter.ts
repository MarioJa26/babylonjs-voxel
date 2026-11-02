/**
 * Pure far-tile face writer: builds packed 4×u32 face records.
 *
 * ZERO imports. This module must stay dependency-free so the self-test can
 * compile and run it standalone (see scripts/far-tile-selftest.ts).
 *
 * Packed face layout:
 *
 *   w0: x:u10 | (y + 1024):u12 | z:u10
 *   w1: w:u10 | h:u10 | backFace:u1 | axis:u2
 *   w2: tileX:u8 | tileY:u8 | light:u8
 *   w3: kind:u8 | originSlot:u16
 *
 * Bits 8-23 of w3 are intentionally left clear. FarTileManager stamps the
 * tile-origin slot after receiving the worker result.
 *
 * Coercion policy — emit() guarantees valid records and never checks:
 *
 * - emit() performs no validation, cannot throw, and cannot fail. Every
 *   field is forced into a well-formed bit pattern at the moment it is
 *   packed, so the emitted record always decodes.
 * - x, z, w, h are masked to their 10-bit fields, the y bias to 12 bits,
 *   backFace to bit 0, and tileX/tileY/light/kind to their low bytes.
 *   Out-of-range values wrap through those masks; NaN and ±Infinity coerce
 *   through the standard ToInt32 path into valid (if meaningless) bits.
 * - axis is REMAPPED modulo 3 instead of masked, because a plain mask of an
 *   arbitrary value can produce the out-of-domain axis 3, which no axis
 *   basis defines. Modulo-3 maps any integer into a decodable basis index.
 *
 * The writer guarantees only well-formed words. Geometry sanity (strictly
 * positive sizes, integer terrain heights, meaningful coordinates) is the
 * caller's responsibility.
 */
export const FAR_TILE_FACE_WORDS = 4;

export const FAR_TILE_Y_OFFSET = 1024;

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

export class FaceWriter {
	private faces: Uint32Array;
	private wordCount = 0;

	public constructor(initialFaceCapacity = 4096) {
		const capacity = Math.floor(initialFaceCapacity);

		this.faces = new Uint32Array(
			(capacity > 0 ? capacity : 1) * FAR_TILE_FACE_WORDS,
		);
	}

	/**
	 * Emits one packed face without any validation: every field is coerced
	 * into its valid bit pattern below. Appends exactly one record.
	 */
	public emit(
		x: number,
		y: number,
		z: number,
		w: number,
		h: number,
		axis: number,
		backFace: number,
		tileX: number,
		tileY: number,
		light: number,
		kind: number,
	): void {
		const requiredWordCount = this.wordCount + FAR_TILE_FACE_WORDS;

		if (requiredWordCount > this.faces.length) {
			let newWordCapacity = this.faces.length * 2;

			if (newWordCapacity < requiredWordCount) {
				newWordCapacity = requiredWordCount;
			}

			const expanded = new Uint32Array(newWordCapacity);
			expanded.set(this.faces);
			this.faces = expanded;
		}

		const index = this.wordCount;

		const yBiased = y + FAR_TILE_Y_OFFSET;

		/*
		 * Modulo-3 remap makes EVERY integer input decodable — masking alone
		 * could emit axis value 3, which no axis basis defines (see header).
		 */
		const safeAxis = ((axis % 3) + 3) % 3;

		this.faces[index] =
			(x & COORD_MASK) |
			((yBiased & HEIGHT_MASK) << Y_SHIFT) |
			((z & COORD_MASK) << Z_SHIFT);

		this.faces[index + 1] =
			(w & COORD_MASK) |
			((h & COORD_MASK) << FACE_HEIGHT_SHIFT) |
			((backFace & 1) << BACK_FACE_SHIFT) |
			(safeAxis << AXIS_SHIFT);

		this.faces[index + 2] =
			(tileX & BYTE_MASK) |
			((tileY & BYTE_MASK) << TILE_Y_SHIFT) |
			((light & BYTE_MASK) << LIGHT_SHIFT);

		/*
		 * Writing the complete word ensures origin-slot bits 8-23 and
		 * currently unused bits 24-31 are clear.
		 */
		this.faces[index + 3] = kind & BYTE_MASK;

		this.wordCount = requiredWordCount;
	}

	public getFaceCount(): number {
		return this.wordCount / FAR_TILE_FACE_WORDS;
	}

	/**
	 * Returns an independently transferable array containing only live words.
	 */
	public toUint32Array(): Uint32Array {
		return this.faces.slice(0, this.wordCount);
	}
}
