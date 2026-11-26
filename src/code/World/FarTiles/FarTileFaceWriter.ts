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

export class FaceWriter {
	private faces: Uint32Array;
	private wordCount = 0;

	public constructor(initialFaceCapacity = 4096) {
		const capacity = Math.floor(initialFaceCapacity);

		// Ensure at least 1 face (4 words) to prevent zero-length array edge cases
		this.faces = new Uint32Array(
			(capacity > 0 ? capacity : 1) << 2, // * 4
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
		const requiredWordCount = this.wordCount + 4;

		if (requiredWordCount > this.faces.length) {
			let newWordCapacity = this.faces.length << 1; // * 2

			if (newWordCapacity < requiredWordCount) {
				newWordCapacity = requiredWordCount;
			}

			const expanded = new Uint32Array(newWordCapacity);
			expanded.set(this.faces);
			this.faces = expanded;
		}

		const index = this.wordCount;

		// PERF: Fast-path for axis. Modulo is a division instruction and is
		// relatively slow. Since axis is almost always 0, 1, or 2 in practice,
		// we bypass the modulo operation entirely for the common case.
		let safeAxis = axis;
		if (safeAxis < 0 || safeAxis > 2) {
			safeAxis = axis % 3;
			if (safeAxis < 0) safeAxis += 3;
		}

		// w0: x:u10 | (y + 1024):u12 | z:u10
		this.faces[index] =
			(x & 0x3ff) | (((y + 1024) & 0xfff) << 10) | ((z & 0x3ff) << 22);

		// w1: w:u10 | h:u10 | backFace:u1 | axis:u2
		this.faces[index + 1] =
			(w & 0x3ff) |
			((h & 0x3ff) << 10) |
			((backFace & 1) << 20) |
			(safeAxis << 21);

		// w2: tileX:u8 | tileY:u8 | light:u8
		this.faces[index + 2] =
			(tileX & 0xff) | ((tileY & 0xff) << 8) | ((light & 0xff) << 16);

		// w3: kind:u8 | originSlot:u16 (Bits 8-23 intentionally left clear)
		this.faces[index + 3] = kind & 0xff;

		this.wordCount = requiredWordCount;
	}

	public getFaceCount(): number {
		// PERF: Bitwise shift is strictly faster than division by a constant power of 2
		return this.wordCount >>> 2;
	}

	/**
	 * Returns an independently transferable array containing only live words.
	 */
	public toUint32Array(): Uint32Array {
		return this.faces.slice(0, this.wordCount);
	}
}
