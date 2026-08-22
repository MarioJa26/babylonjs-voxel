/**
 * Pure far-tile face format: encoding, decoding and CPU expansion.
 *
 * ZERO imports — this module must stay dependency-free so the self-test can
 * compile and run it standalone (see scripts/far-tile-selftest.ts).
 *
 * Face encoding (4 x u32):
 *   w0: x:u10 | (y+Y_OFFSET):u12 | z:u10            tile-local block coords
 *   w1: w:u10(bit0) | h:u10(bit10) | backFace:u1(bit20) | axis:u2(bit21-22)
 *   w2: tileX:u8 | tileY:u8 | light:u8              atlas tile + light
 *   w3: kind:u8                                     0 opaque, 1 water
 *
 * Axis dimension convention (must match QuadBuffer):
 *   axis 0 (+/-X): w = Y-extent, h = Z-extent
 *   axis 1 (+/-Y): w = X-extent, h = Z-extent
 *   axis 2 (+/-Z): w = X-extent, h = Y-extent
 *
 * Corner tables all traverse [P00, P10, P11, P01] over (u,v) so ONE index
 * policy serves every facing:
 *   straight (0,1,2)(0,2,3) -> vertex-cross = +axis -> used for -axis faces
 *   reversed (0,2,1)(0,3,2) -> vertex-cross = -axis -> used for +axis faces
 * (Lite renders the triangle whose vertex-order cross OPPOSES its intended
 * face normal — verified against DistantTerrain's grid winding.)
 */

export const FAR_TILE_Y_OFFSET = -(-32) * 32; // MIN_CHUNK_Y * CHUNK_SIZE negated

export const KIND_OPAQUE = 0;
export const KIND_WATER = 1;

export const LIGHT_FULL = 0xf0;
export const LIGHT_SIDE = 0xc0;

const AXISFACE_MASK = 0x3 << 20;

/** Encode one packed face word-pair helper (w1 value). */
export function packWord1(
	w: number,
	h: number,
	axis: number,
	backFace: number,
): number {
	// Layout: bit20 = backFace, bit21 = axis. Mask must keep THREE bits
	// (axis occupies bits 21-22 after the shift) — an &0x3 here silently
	// truncates axis=2 into axis=0 and scrambles every Z-facing quad.
	const axisFace = (((axis << 1) | backFace) & 0x7) << 20;
	return (w & 0x3ff) | ((h & 0x3ff) << 10) | (axisFace & 0x700000);
}

/** Encode the full 4-word record for one face. */
export function packFace(
	out: number[],
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
	const yBiased = y + FAR_TILE_Y_OFFSET;

	if (
		x < 0 ||
		z < 0 ||
		yBiased < 0 ||
		x > 1023 ||
		z > 1023 ||
		yBiased > 4095 ||
		w > 1023 ||
		h > 1023
	) {
		return;
	}

	out.push(
		x | (yBiased << 10) | (z << 22),
		packWord1(w, h, axis, backFace),
		(tileX & 0xff) | ((tileY & 0xff) << 8) | ((light & 0xff) << 16),
		kind & 0xff,
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

// ---------------------------------------------------------------------------
// Expansion
//
// Uniform scheme: every axis gets a right-handed (U, V) basis — U scaled by
// the face's w, V by h — and ALL faces share the same corner weights
// [P00, P10, P11, P01]. Right-handedness guarantees straight triangles always
// compute vertex-cross = +axis, so ONE index policy is provably correct:
//   backFace 0 (+axis intent): reversed  -> cross = -axis (opposes intent)
//   backFace 1 (-axis intent): straight  -> cross = +axis (opposes intent)
// Axis basis/semantics:
//   axis 0: U=Y(w), V=Z(h)   (Y x Z = +X)
//   axis 1: U=Z(w), V=X(h)   (Z x X = +Y)   [w/h swap vs naive X/Z!]
//   axis 2: U=X(w), V=Y(h)   (X x Y = +Z)
// ---------------------------------------------------------------------------

const CORNER_WEIGHTS = [0, 0, 1, 0, 1, 1, 0, 1]; // (au, av) per corner

// Per-axis basis: [Ux,Uy,Uz, Vx,Vy,Vz]
const AXIS_BASIS: Int8Array[] = [
	Int8Array.from([0, 1, 0, 0, 0, 1]), // X: U=Y, V=Z
	Int8Array.from([0, 0, 1, 1, 0, 0]), // Y: U=Z, V=X
	Int8Array.from([1, 0, 0, 0, 1, 0]), // Z: U=X, V=Y
];

export interface TileVertexData {
	positions: Float32Array;
	normals: Float32Array;
	uv2: Float32Array;
	colors: Float32Array;
	indices: Uint32Array;
}

export interface ExpandedTile {
	opaque: TileVertexData | null;
	waterPositions: Float32Array | null;
	/** Per-water-quad indices (ORDER A walk + reversed tris => top-up). */
	waterIndices: Uint32Array | null;
}

/**
 * Expand packed faces into vertex buffers. Positions are absolute world
 * coordinates; water output is position-only (12 floats per quad, ORDER A
 * corner walk [P00,P01,P11,P10]).
 */
export function expandTileFaces(
	opaqueFaces: Uint32Array,
	waterFaces: Uint32Array,
	originX: number,
	originZ: number,
): ExpandedTile {
	const opaqueCount = opaqueFaces.length >> 2;
	const positions = new Float32Array(opaqueCount * 4 * 3);
	const normals = new Float32Array(opaqueCount * 4 * 3);
	const uv2 = new Float32Array(opaqueCount * 4 * 2);
	const colors = new Float32Array(opaqueCount * 4 * 4);
	const indices = new Uint32Array(opaqueCount * 6);

	let vOff = 0;
	let iOff = 0;

	for (let f = 0; f < opaqueCount; f++) {
		const q = decodeFarTileFace(opaqueFaces, f);

		const x = originX + q.x;
		const y = q.y;
		const z = originZ + q.z;

		const basis = AXIS_BASIS[q.axis];
		const ux = basis[0];
		const uy = basis[1];
		const uz = basis[2];
		const vx = basis[3];
		const vy = basis[4];
		const vz = basis[5];

		const nx = q.axis === 0 ? (q.backFace ? -1 : 1) : 0;
		const ny = q.axis === 1 ? (q.backFace ? -1 : 1) : 0;
		const nz = q.axis === 2 ? (q.backFace ? -1 : 1) : 0;

		const lightFactor = q.light >= 224 ? 1 : 0.8;

		for (let corner = 0; corner < 4; corner++) {
			const au = CORNER_WEIGHTS[corner * 2];
			const av = CORNER_WEIGHTS[corner * 2 + 1];

			const vi = vOff + corner;
			positions[vi * 3] = x + au * q.w * ux + av * q.h * vx;
			positions[vi * 3 + 1] = y + au * q.w * uy + av * q.h * vy;
			positions[vi * 3 + 2] = z + au * q.w * uz + av * q.h * vz;

			normals[vi * 3] = nx;
			normals[vi * 3 + 1] = ny;
			normals[vi * 3 + 2] = nz;

			uv2[vi * 2] = q.tileX;
			uv2[vi * 2 + 1] = q.tileY;

			colors[vi * 4] = lightFactor;
			colors[vi * 4 + 1] = lightFactor;
			colors[vi * 4 + 2] = lightFactor;
			colors[vi * 4 + 3] = 1;
		}

		if (q.backFace) {
			// -axis intent: straight keeps cross=+axis, opposing it.
			indices[iOff++] = vOff;
			indices[iOff++] = vOff + 1;
			indices[iOff++] = vOff + 2;
			indices[iOff++] = vOff;
			indices[iOff++] = vOff + 2;
			indices[iOff++] = vOff + 3;
		} else {
			// +axis intent: reversed flips the cross to -axis.
			indices[iOff++] = vOff;
			indices[iOff++] = vOff + 2;
			indices[iOff++] = vOff + 1;
			indices[iOff++] = vOff;
			indices[iOff++] = vOff + 3;
			indices[iOff++] = vOff + 2;
		}

		vOff += 4;
	}

	// Water: position-only quads, ORDER A corner walk.
	const waterQuadCount = waterFaces.length >> 2;
	const waterPositions = new Float32Array(waterQuadCount * 12);
	let wOff = 0;

	for (let f = 0; f < waterQuadCount; f++) {
		const q = decodeFarTileFace(waterFaces, f);
		const x = originX + q.x;
		const y = q.y;
		const z = originZ + q.z;

		waterPositions[wOff++] = x;
		waterPositions[wOff++] = y;
		waterPositions[wOff++] = z;
		waterPositions[wOff++] = x;
		waterPositions[wOff++] = y;
		waterPositions[wOff++] = z + q.h;
		waterPositions[wOff++] = x + q.w;
		waterPositions[wOff++] = y;
		waterPositions[wOff++] = z + q.h;
		waterPositions[wOff++] = x + q.w;
		waterPositions[wOff++] = y;
		waterPositions[wOff++] = z;
	}

	return {
		opaque:
			iOff > 0
				? {
						positions: positions.subarray(0, vOff * 3),
						normals: normals.subarray(0, vOff * 3),
						uv2: uv2.subarray(0, vOff * 2),
						colors: colors.subarray(0, vOff * 4),
						indices: indices.subarray(0, iOff),
					}
				: null,
		waterPositions: wOff > 0 ? waterPositions.subarray(0, wOff) : null,
		waterIndices:
			wOff > 0
				? (() => {
						const qi = new Uint32Array(waterQuadCount * 6);
						let q = 0;
						for (let f = 0; f < waterQuadCount; f++) {
							const b = f * 4;
							// Reversed: ORDER-A walk needs it for top-up (+Y).
							qi[q++] = b;
							qi[q++] = b + 2;
							qi[q++] = b + 1;
							qi[q++] = b;
							qi[q++] = b + 3;
							qi[q++] = b + 2;
						}
						return qi;
					})()
				: null,
	};
}
