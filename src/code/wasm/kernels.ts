// WASM SIMD noise kernels (AssemblyScript).
//
// Faithful f32 port of the vendored FastNoiseLite OpenSimplex2 path
// (src/code/Generation/NoiseAndParameters/FastNoise/FastNoiseLite.ts):
//   - GetNoise2D/GetNoise3D  -> noise_scalar_2d / noise_scalar_3d
//   - FillNoise2D/FillNoise3D -> noise_fill_2d / noise_fill_3d (4-lane f32x4 SIMD
//     for the OpenSimplex2 single-noise + None/FBm/Ridged/PingPong fractals)
//
// Noise types other than OpenSimplex2 (1) return 0 - the project only creates
// OpenSimplex2 instances (see FastNoiseFactory.createFastNoise).

import { Gradients2D, Gradients3D } from "./gradient_tables";

// --- constants (f32-rounded to match f32 math) ------------------------------
const F2: f32 = 0.3660254180431366;
const G2: f32 = 0.21132487058639526;
const G2_2: f32 = -0.5773502588272095;
const C1: f32 = 3.154700517654419;
const C2: f32 = -0.6666666865348816;
const NORM_2D: f32 = 99.83685302734375;
const F3: f32 = 0.6666666865348816;
const G3: f32 = -0.21132487058639526;
const H3: f32 = 0.5773502588272095;
const NORM_3D: f32 = 32.69428253173828;
const PRIME_X: i32 = 501125321;
const PRIME_Y: i32 = 1136930381;
const PRIME_Z: i32 = 1720413743;
const HASH_MUL: i32 = 0x27d4eb2d;

// --- scalar helpers ----------------------------------------------------------

function hash2(seed: i32, xp: i32, yp: i32): i32 {
	return (seed ^ xp ^ yp) * HASH_MUL;
}

function hash3(seed: i32, xp: i32, yp: i32, zp: i32): i32 {
	return (seed ^ xp ^ yp ^ zp) * HASH_MUL;
}

function gradCoord2(seed: i32, xp: i32, yp: i32, xd: f32, yd: f32): f32 {
	let h: i32 = hash2(seed, xp, yp);
	h ^= h >> 15;
	h &= 254;
	return xd * Gradients2D[h] + yd * Gradients2D[h | 1];
}

function gradCoord3(
	seed: i32,
	xp: i32,
	yp: i32,
	zp: i32,
	xd: f32,
	yd: f32,
	zd: f32,
): f32 {
	let h: i32 = hash3(seed, xp, yp, zp);
	h ^= h >> 15;
	h &= 252;
	return (
		xd * Gradients3D[h] + yd * Gradients3D[h | 1] + zd * Gradients3D[h | 2]
	);
}

function pingpong(t: f32): f32 {
	t -= Mathf.trunc(t * 0.5) * 2;
	return t < 1 ? t : 2 - t;
}

function lerp(a: f32, b: f32, t: f32): f32 {
	return a + t * (b - a);
}

// --- scalar single noise (OpenSimplex2) --------------------------------------

function singleSimplex2(seed: i32, x: f32, y: f32): f32 {
	let i: i32 = x >= 0 ? i32(x) : i32(x) - 1;
	let j: i32 = y >= 0 ? i32(y) : i32(y) - 1;
	const xi: f32 = x - f32(i);
	const yi: f32 = y - f32(j);

	const t: f32 = (xi + yi) * G2;
	const x0: f32 = xi - t;
	const y0: f32 = yi - t;

	i *= PRIME_X;
	j *= PRIME_Y;

	let n0: f32 = 0;
	let n1: f32 = 0;
	let n2: f32 = 0;

	const a: f32 = 0.5 - x0 * x0 - y0 * y0;
	if (a > 0) {
		const a2: f32 = a * a;
		n0 = a2 * a2 * gradCoord2(seed, i, j, x0, y0);
	}

	const c: f32 = C1 * t + (C2 + a);
	if (c > 0) {
		const x2: f32 = x0 + G2_2;
		const y2: f32 = y0 + G2_2;
		const c2: f32 = c * c;
		n2 = c2 * c2 * gradCoord2(seed, i + PRIME_X, j + PRIME_Y, x2, y2);
	}

	if (y0 > x0) {
		const x1: f32 = x0 + G2;
		const y1: f32 = y0 + (G2 - 1);
		const b: f32 = 0.5 - x1 * x1 - y1 * y1;
		if (b > 0) {
			const b2: f32 = b * b;
			n1 = b2 * b2 * gradCoord2(seed, i, j + PRIME_Y, x1, y1);
		}
	} else {
		const x1: f32 = x0 + (G2 - 1);
		const y1: f32 = y0 + G2;
		const b: f32 = 0.5 - x1 * x1 - y1 * y1;
		if (b > 0) {
			const b2: f32 = b * b;
			n1 = b2 * b2 * gradCoord2(seed, i + PRIME_X, j, x1, y1);
		}
	}

	return (n0 + n1 + n2) * NORM_2D;
}

function singleSimplex3(seed: i32, x: f32, y: f32, z: f32): f32 {
	let i: i32 = i32(Mathf.round(x));
	let j: i32 = i32(Mathf.round(y));
	let k: i32 = i32(Mathf.round(z));

	let x0: f32 = x - f32(i);
	let y0: f32 = y - f32(j);
	let z0: f32 = z - f32(k);

	let xNSign: i32 = i32(-1.0 - x0) | 1;
	let yNSign: i32 = i32(-1.0 - y0) | 1;
	let zNSign: i32 = i32(-1.0 - z0) | 1;

	let ax0: f32 = -f32(xNSign) * x0;
	let ay0: f32 = -f32(yNSign) * y0;
	let az0: f32 = -f32(zNSign) * z0;

	i *= PRIME_X;
	j *= PRIME_Y;
	k *= PRIME_Z;

	let value: f32 = 0;

	let a: f32 = 0.6 - x0 * x0 - (y0 * y0 + z0 * z0);
	if (a > 0) {
		const a2: f32 = a * a;
		value += a2 * a2 * gradCoord3(seed, i, j, k, x0, y0, z0);
	}

	if (ax0 >= ay0 && ax0 >= az0) {
		let b: f32 = a + ax0 + ax0;
		if (b > 1) {
			b -= 1;
			const b2: f32 = b * b;
			value +=
				b2 *
				b2 *
				gradCoord3(seed, i - xNSign * PRIME_X, j, k, x0 + f32(xNSign), y0, z0);
		}
	} else if (ay0 >= az0) {
		let b: f32 = a + ay0 + ay0;
		if (b > 1) {
			b -= 1;
			const b2: f32 = b * b;
			value +=
				b2 *
				b2 *
				gradCoord3(seed, i, j - yNSign * PRIME_Y, k, x0, y0 + f32(yNSign), z0);
		}
	} else {
		let b: f32 = a + az0 + az0;
		if (b > 1) {
			b -= 1;
			const b2: f32 = b * b;
			value +=
				b2 *
				b2 *
				gradCoord3(seed, i, j, k - zNSign * PRIME_Z, x0, y0, z0 + f32(zNSign));
		}
	}

	ax0 = 0.5 - ax0;
	ay0 = 0.5 - ay0;
	az0 = 0.5 - az0;

	x0 = f32(xNSign) * ax0;
	y0 = f32(yNSign) * ay0;
	z0 = f32(zNSign) * az0;

	a += 0.75 - ax0 - (ay0 + az0);

	i += (xNSign >> 1) & PRIME_X;
	j += (yNSign >> 1) & PRIME_Y;
	k += (zNSign >> 1) & PRIME_Z;

	xNSign = -xNSign;
	yNSign = -yNSign;
	zNSign = -zNSign;

	seed = ~seed;

	if (a > 0) {
		const a2: f32 = a * a;
		value += a2 * a2 * gradCoord3(seed, i, j, k, x0, y0, z0);
	}

	if (ax0 >= ay0 && ax0 >= az0) {
		let b: f32 = a + ax0 + ax0;
		if (b > 1) {
			b -= 1;
			const b2: f32 = b * b;
			value +=
				b2 *
				b2 *
				gradCoord3(seed, i - xNSign * PRIME_X, j, k, x0 + f32(xNSign), y0, z0);
		}
	} else if (ay0 >= az0) {
		let b: f32 = a + ay0 + ay0;
		if (b > 1) {
			b -= 1;
			const b2: f32 = b * b;
			value +=
				b2 *
				b2 *
				gradCoord3(seed, i, j - yNSign * PRIME_Y, k, x0, y0 + f32(yNSign), z0);
		}
	} else {
		let b: f32 = a + az0 + az0;
		if (b > 1) {
			b -= 1;
			const b2: f32 = b * b;
			value +=
				b2 *
				b2 *
				gradCoord3(seed, i, j, k - zNSign * PRIME_Z, x0, y0, z0 + f32(zNSign));
		}
	}

	return value * NORM_3D;
}

// --- scalar fractals ---------------------------------------------------------

function fractalBounding(gain: f32, octaves: i32): f32 {
	let amp: f32 = gain;
	let ampFractal: f32 = 1.0;
	for (let i: i32 = 1; i < octaves; i++) {
		ampFractal += amp;
		amp *= gain;
	}
	return 1 / ampFractal;
}

function fractal2(
	seed: i32,
	x: f32,
	y: f32,
	fractalType: i32,
	octaves: i32,
	lacunarity: f32,
	gain: f32,
	ws: f32,
	pp: f32,
): f32 {
	if (fractalType == 1) {
		let sum: f32 = 0;
		let amp: f32 = fractalBounding(gain, octaves);
		if (ws == 0) {
			for (let i: i32 = 0; i < octaves; i++) {
				sum += singleSimplex2(seed++, x, y) * amp;
				x *= lacunarity;
				y *= lacunarity;
				amp *= gain;
			}
			return sum;
		}
		for (let i: i32 = 0; i < octaves; i++) {
			const n: f32 = singleSimplex2(seed++, x, y);
			sum += n * amp;
			const t: f32 = n < 1.0 ? (n + 1.0) * 0.5 : 1.0;
			amp *= 1.0 + (t - 1.0) * ws;
			x *= lacunarity;
			y *= lacunarity;
			amp *= gain;
		}
		return sum;
	}
	if (fractalType == 2) {
		let sum: f32 = 0;
		let amp: f32 = fractalBounding(gain, octaves);
		for (let i: i32 = 0; i < octaves; i++) {
			const n: f32 = Mathf.abs(singleSimplex2(seed++, x, y));
			sum += (n * -2 + 1) * amp;
			amp -= amp * ws * n;
			x *= lacunarity;
			y *= lacunarity;
			amp *= gain;
		}
		return sum;
	}
	if (fractalType == 3) {
		let sum: f32 = 0;
		let amp: f32 = fractalBounding(gain, octaves);
		for (let i: i32 = 0; i < octaves; i++) {
			const n: f32 = pingpong((singleSimplex2(seed++, x, y) + 1) * pp);
			sum += (n - 0.5) * 2 * amp;
			amp *= lerp(1.0, n, ws);
			x *= lacunarity;
			y *= lacunarity;
			amp *= gain;
		}
		return sum;
	}
	return singleSimplex2(seed, x, y);
}

function fractal3(
	seed: i32,
	x: f32,
	y: f32,
	z: f32,
	fractalType: i32,
	octaves: i32,
	lacunarity: f32,
	gain: f32,
	ws: f32,
	pp: f32,
): f32 {
	if (fractalType == 1) {
		let sum: f32 = 0;
		let amp: f32 = fractalBounding(gain, octaves);
		if (ws == 0) {
			for (let i: i32 = 0; i < octaves; i++) {
				sum += singleSimplex3(seed++, x, y, z) * amp;
				x *= lacunarity;
				y *= lacunarity;
				z *= lacunarity;
				amp *= gain;
			}
			return sum;
		}
		for (let i: i32 = 0; i < octaves; i++) {
			const n: f32 = singleSimplex3(seed++, x, y, z);
			sum += n * amp;
			amp *= 1.0 + (n - 1.0) * 0.5 * ws;
			x *= lacunarity;
			y *= lacunarity;
			z *= lacunarity;
			amp *= gain;
		}
		return sum;
	}
	if (fractalType == 2) {
		let sum: f32 = 0;
		let amp: f32 = fractalBounding(gain, octaves);
		for (let i: i32 = 0; i < octaves; i++) {
			const n: f32 = Mathf.abs(singleSimplex3(seed++, x, y, z));
			sum += (n * -2 + 1) * amp;
			amp -= amp * ws * n;
			x *= lacunarity;
			y *= lacunarity;
			z *= lacunarity;
			amp *= gain;
		}
		return sum;
	}
	if (fractalType == 3) {
		let sum: f32 = 0;
		let amp: f32 = fractalBounding(gain, octaves);
		for (let i: i32 = 0; i < octaves; i++) {
			const n: f32 = pingpong((singleSimplex3(seed++, x, y, z) + 1) * pp);
			sum += (n - 0.5) * 2 * amp;
			amp *= lerp(1.0, n, ws);
			x *= lacunarity;
			y *= lacunarity;
			z *= lacunarity;
			amp *= gain;
		}
		return sum;
	}
	return singleSimplex3(seed, x, y, z);
}

// --- 4-lane SIMD helpers -----------------------------------------------------

function gradL2(seed: i32, xp: v128, yp: v128, xd: v128, yd: v128): v128 {
	const sp: v128 = i32x4.splat(seed);
	let h: v128 = v128.xor(v128.xor(sp, xp), yp);
	h = i32x4.mul(h, i32x4.splat(HASH_MUL));
	h = v128.xor(h, i32x4.shr_s(h, 15));
	h = v128.and(h, i32x4.splat(254));
	const h0: i32 = i32x4.extract_lane(h, 0);
	const h1: i32 = i32x4.extract_lane(h, 1);
	const h2: i32 = i32x4.extract_lane(h, 2);
	const h3: i32 = i32x4.extract_lane(h, 3);
	let gx: v128 = f32x4.splat(Gradients2D[h0]);
	gx = f32x4.replace_lane(gx, 1, Gradients2D[h1]);
	gx = f32x4.replace_lane(gx, 2, Gradients2D[h2]);
	gx = f32x4.replace_lane(gx, 3, Gradients2D[h3]);
	let gy: v128 = f32x4.splat(Gradients2D[h0 | 1]);
	gy = f32x4.replace_lane(gy, 1, Gradients2D[h1 | 1]);
	gy = f32x4.replace_lane(gy, 2, Gradients2D[h2 | 1]);
	gy = f32x4.replace_lane(gy, 3, Gradients2D[h3 | 1]);
	return f32x4.add(f32x4.mul(xd, gx), f32x4.mul(yd, gy));
}

function gradL3(
	seed: i32,
	xp: v128,
	yp: v128,
	zp: v128,
	xd: v128,
	yd: v128,
	zd: v128,
): v128 {
	const sp: v128 = i32x4.splat(seed);
	let h: v128 = v128.xor(v128.xor(v128.xor(sp, xp), yp), zp);
	h = i32x4.mul(h, i32x4.splat(HASH_MUL));
	h = v128.xor(h, i32x4.shr_s(h, 15));
	h = v128.and(h, i32x4.splat(252));
	const h0: i32 = i32x4.extract_lane(h, 0);
	const h1: i32 = i32x4.extract_lane(h, 1);
	const h2: i32 = i32x4.extract_lane(h, 2);
	const h3: i32 = i32x4.extract_lane(h, 3);
	let gx: v128 = f32x4.splat(Gradients3D[h0]);
	gx = f32x4.replace_lane(gx, 1, Gradients3D[h1]);
	gx = f32x4.replace_lane(gx, 2, Gradients3D[h2]);
	gx = f32x4.replace_lane(gx, 3, Gradients3D[h3]);
	let gy: v128 = f32x4.splat(Gradients3D[h0 | 1]);
	gy = f32x4.replace_lane(gy, 1, Gradients3D[h1 | 1]);
	gy = f32x4.replace_lane(gy, 2, Gradients3D[h2 | 1]);
	gy = f32x4.replace_lane(gy, 3, Gradients3D[h3 | 1]);
	let gz: v128 = f32x4.splat(Gradients3D[h0 | 2]);
	gz = f32x4.replace_lane(gz, 1, Gradients3D[h1 | 2]);
	gz = f32x4.replace_lane(gz, 2, Gradients3D[h2 | 2]);
	gz = f32x4.replace_lane(gz, 3, Gradients3D[h3 | 2]);
	return f32x4.add(
		f32x4.add(f32x4.mul(xd, gx), f32x4.mul(yd, gy)),
		f32x4.mul(zd, gz),
	);
}

// Selects b if mask (any bit set) else c. Uses v128.bitselect (fixed in AS 0.28+).
function selectB(a: v128, b: v128, c: v128): v128 {
	return v128.bitselect(b, c, a);
}

// One 3D simplex pass (corner 0 + the 3-way branch), all lanes.
// Deferred gradient: computes only the selected branch's gradient per lane,
// eliminating 2 of 3 gradL3 calls.
function cornerPassL3(
	seed: i32,
	i: v128,
	j: v128,
	k: v128,
	x0: v128,
	y0: v128,
	z0: v128,
	xNSign: v128,
	yNSign: v128,
	zNSign: v128,
	ax0: v128,
	ay0: v128,
	az0: v128,
	a: v128,
): v128 {
	const zero: v128 = f32x4.splat(0.0);

	// corner 0
	const a2: v128 = f32x4.mul(a, a);
	let n0: v128 = f32x4.mul(
		f32x4.mul(a2, a2),
		gradL3(seed, i, j, k, x0, y0, z0),
	);
	n0 = selectB(f32x4.gt(a, f32x4.splat(0.0)), n0, zero);

	// branch selection masks
	const mX: v128 = v128.and(f32x4.ge(ax0, ay0), f32x4.ge(ax0, az0));
	const mY: v128 = f32x4.ge(ay0, az0);

	// b per branch (same formula, different axis)
	const bX: v128 = f32x4.add(f32x4.add(a, ax0), ax0);
	const bY: v128 = f32x4.add(f32x4.add(a, ay0), ay0);
	const bZ: v128 = f32x4.add(f32x4.add(a, az0), az0);
	let b: v128 = selectB(mY, bY, bZ);
	b = selectB(mX, bX, b);

	// b -= 1 where b > 1
	const bGt1: v128 = f32x4.gt(b, f32x4.splat(1.0));
	b = selectB(bGt1, f32x4.sub(b, f32x4.splat(1.0)), b);
	const b2: v128 = f32x4.mul(b, b);

	// lattice offsets
	const offX: v128 = i32x4.mul(xNSign, i32x4.splat(PRIME_X));
	const offY: v128 = i32x4.mul(yNSign, i32x4.splat(PRIME_Y));
	const offZ: v128 = i32x4.mul(zNSign, i32x4.splat(PRIME_Z));

	const sx: v128 = f32x4.convert_i32x4_s(xNSign);
	const sy: v128 = f32x4.convert_i32x4_s(yNSign);
	const sz: v128 = f32x4.convert_i32x4_s(zNSign);

	// Blend the selected branch's integer lattice coords and float offsets per lane
	// instead of evaluating all 3 gradL3 calls and selecting after.
	const selI: v128 = selectB(mX, i32x4.sub(i, offX), i);
	const selJ: v128 = selectB(mX, j, selectB(mY, i32x4.sub(j, offY), j));
	const selK: v128 = selectB(mX, k, selectB(mY, k, i32x4.sub(k, offZ)));

	const selXd: v128 = selectB(mX, f32x4.add(x0, sx), x0);
	const selYd: v128 = selectB(mX, y0, selectB(mY, f32x4.add(y0, sy), y0));
	const selZd: v128 = selectB(mX, z0, selectB(mY, z0, f32x4.add(z0, sz)));

	const g: v128 = gradL3(seed, selI, selJ, selK, selXd, selYd, selZd);

	let n1: v128 = f32x4.mul(f32x4.mul(b2, b2), g);
	n1 = selectB(bGt1, n1, zero);

	return f32x4.add(n0, n1);
}

function singleSimplex2L4(seed: i32, x: v128, y: v128): v128 {
	// fastFloor parity: scalar singleSimplex2 uses `x >= 0 ? i32(x) : i32(x)-1`
	// (and the JS FastNoiseLite mirror uses the same). Plain f32x4.floor would
	// diverge at exact negative integers (floor(-5)=-5 vs fastFloor(-5)=-6),
	// which shows up as a one-cell seam when the same field is sampled through
	// both GetNoise2D and FillNoise2D (e.g. freq=1 at x == -y). Emulate
	// fastFloor exactly: truncate, then subtract 1 where x < 0.
	const negMask: v128 = f32x4.lt(x, f32x4.splat(0.0));
	let i: v128 = i32x4.trunc_sat_f32x4_s(x);
	i = i32x4.sub(i, v128.and(negMask, i32x4.splat(1)));
	const negMaskY: v128 = f32x4.lt(y, f32x4.splat(0.0));
	let j: v128 = i32x4.trunc_sat_f32x4_s(y);
	j = i32x4.sub(j, v128.and(negMaskY, i32x4.splat(1)));
	const xf: v128 = f32x4.sub(x, f32x4.convert_i32x4_s(i));
	const yf: v128 = f32x4.sub(y, f32x4.convert_i32x4_s(j));

	const t: v128 = f32x4.mul(f32x4.add(xf, yf), f32x4.splat(G2));
	const x0: v128 = f32x4.sub(xf, t);
	const y0: v128 = f32x4.sub(yf, t);

	const iP: v128 = i32x4.mul(i, i32x4.splat(PRIME_X));
	const jP: v128 = i32x4.mul(j, i32x4.splat(PRIME_Y));

	const a: v128 = f32x4.sub(
		f32x4.sub(f32x4.splat(0.5), f32x4.mul(x0, x0)),
		f32x4.mul(y0, y0),
	);
	const a2: v128 = f32x4.mul(a, a);
	const zero: v128 = f32x4.splat(0.0);
	let n0: v128 = f32x4.mul(f32x4.mul(a2, a2), gradL2(seed, iP, jP, x0, y0));
	n0 = selectB(f32x4.gt(a, zero), n0, zero);

	// c corner
	const c: v128 = f32x4.add(
		f32x4.mul(f32x4.splat(C1), t),
		f32x4.add(f32x4.splat(C2), a),
	);
	const x2: v128 = f32x4.add(x0, f32x4.splat(G2_2));
	const y2: v128 = f32x4.add(y0, f32x4.splat(G2_2));
	const c2: v128 = f32x4.mul(c, c);
	let n2: v128 = f32x4.mul(
		f32x4.mul(c2, c2),
		gradL2(
			seed,
			i32x4.add(iP, i32x4.splat(PRIME_X)),
			i32x4.add(jP, i32x4.splat(PRIME_Y)),
			x2,
			y2,
		),
	);
	n2 = selectB(f32x4.gt(c, zero), n2, zero);

	// B/C corner (y0 > x0) — deferred gradient: select the lattice coords and
	// deltas first, then ONE gradL2 call (gradL2 is the most scalar-bound
	// function: 4x extract_lane + 8x replace_lane), mirroring cornerPassL3.
	const mBC: v128 = f32x4.gt(y0, x0);
	const x1B: v128 = f32x4.add(x0, f32x4.splat(G2));
	const y1B: v128 = f32x4.add(y0, f32x4.splat(G2 - 1));
	const x1C: v128 = f32x4.add(x0, f32x4.splat(G2 - 1));
	const y1C: v128 = f32x4.add(y0, f32x4.splat(G2));
	const x1: v128 = selectB(mBC, x1B, x1C);
	const y1: v128 = selectB(mBC, y1B, y1C);
	const b: v128 = f32x4.sub(
		f32x4.sub(f32x4.splat(0.5), f32x4.mul(x1, x1)),
		f32x4.mul(y1, y1),
	);
	const b2: v128 = f32x4.mul(b, b);
	const selI1: v128 = selectB(mBC, iP, i32x4.add(iP, i32x4.splat(PRIME_X)));
	const selJ1: v128 = selectB(mBC, i32x4.add(jP, i32x4.splat(PRIME_Y)), jP);
	const g: v128 = gradL2(seed, selI1, selJ1, x1, y1);
	let n1: v128 = f32x4.mul(f32x4.mul(b2, b2), g);
	n1 = selectB(f32x4.gt(b, zero), n1, zero);

	return f32x4.mul(f32x4.add(f32x4.add(n0, n1), n2), f32x4.splat(NORM_2D));
}

function singleSimplex3L4(seed: i32, x: v128, y: v128, z: v128): v128 {
	const xr: v128 = f32x4.floor(f32x4.add(x, f32x4.splat(0.5)));
	const yr: v128 = f32x4.floor(f32x4.add(y, f32x4.splat(0.5)));
	const zr: v128 = f32x4.floor(f32x4.add(z, f32x4.splat(0.5)));

	let i: v128 = i32x4.trunc_sat_f32x4_s(xr);
	let j: v128 = i32x4.trunc_sat_f32x4_s(yr);
	let k: v128 = i32x4.trunc_sat_f32x4_s(zr);

	let x0: v128 = f32x4.sub(x, f32x4.convert_i32x4_s(i));
	let y0: v128 = f32x4.sub(y, f32x4.convert_i32x4_s(j));
	let z0: v128 = f32x4.sub(z, f32x4.convert_i32x4_s(k));

	let xNSign: v128 = v128.or(
		i32x4.trunc_sat_f32x4_s(f32x4.sub(f32x4.splat(-1.0), x0)),
		i32x4.splat(1),
	);
	let yNSign: v128 = v128.or(
		i32x4.trunc_sat_f32x4_s(f32x4.sub(f32x4.splat(-1.0), y0)),
		i32x4.splat(1),
	);
	let zNSign: v128 = v128.or(
		i32x4.trunc_sat_f32x4_s(f32x4.sub(f32x4.splat(-1.0), z0)),
		i32x4.splat(1),
	);

	let ax0: v128 = f32x4.mul(f32x4.neg(f32x4.convert_i32x4_s(xNSign)), x0);
	let ay0: v128 = f32x4.mul(f32x4.neg(f32x4.convert_i32x4_s(yNSign)), y0);
	let az0: v128 = f32x4.mul(f32x4.neg(f32x4.convert_i32x4_s(zNSign)), z0);

	i = i32x4.mul(i, i32x4.splat(PRIME_X));
	j = i32x4.mul(j, i32x4.splat(PRIME_Y));
	k = i32x4.mul(k, i32x4.splat(PRIME_Z));

	let a: v128 = f32x4.sub(
		f32x4.sub(f32x4.splat(0.6), f32x4.mul(x0, x0)),
		f32x4.add(f32x4.mul(y0, y0), f32x4.mul(z0, z0)),
	);

	let value: v128 = cornerPassL3(
		seed,
		i,
		j,
		k,
		x0,
		y0,
		z0,
		xNSign,
		yNSign,
		zNSign,
		ax0,
		ay0,
		az0,
		a,
	);

	// prep pass 2
	ax0 = f32x4.sub(f32x4.splat(0.5), ax0);
	ay0 = f32x4.sub(f32x4.splat(0.5), ay0);
	az0 = f32x4.sub(f32x4.splat(0.5), az0);

	x0 = f32x4.mul(f32x4.convert_i32x4_s(xNSign), ax0);
	y0 = f32x4.mul(f32x4.convert_i32x4_s(yNSign), ay0);
	z0 = f32x4.mul(f32x4.convert_i32x4_s(zNSign), az0);

	a = f32x4.add(
		f32x4.sub(f32x4.add(a, f32x4.splat(0.75)), ax0),
		f32x4.neg(f32x4.add(ay0, az0)),
	);

	i = i32x4.add(i, v128.and(i32x4.shr_s(xNSign, 1), i32x4.splat(PRIME_X)));
	j = i32x4.add(j, v128.and(i32x4.shr_s(yNSign, 1), i32x4.splat(PRIME_Y)));
	k = i32x4.add(k, v128.and(i32x4.shr_s(zNSign, 1), i32x4.splat(PRIME_Z)));

	xNSign = i32x4.sub(i32x4.splat(0), xNSign);
	yNSign = i32x4.sub(i32x4.splat(0), yNSign);
	zNSign = i32x4.sub(i32x4.splat(0), zNSign);

	seed = ~seed;

	value = f32x4.add(
		value,
		cornerPassL3(
			seed,
			i,
			j,
			k,
			x0,
			y0,
			z0,
			xNSign,
			yNSign,
			zNSign,
			ax0,
			ay0,
			az0,
			a,
		),
	);

	return f32x4.mul(value, f32x4.splat(NORM_3D));
}

// --- lane fractals -----------------------------------------------------------

function fractal2L4(
	seed: i32,
	x: v128,
	y: v128,
	fractalType: i32,
	octaves: i32,
	lacunarity: f32,
	gain: f32,
	ws: f32,
	pp: f32,
): v128 {
	const splatLac: v128 = f32x4.splat(lacunarity);
	const splatGain: v128 = f32x4.splat(gain);
	const splatWs: v128 = f32x4.splat(ws);
	const splatPp: v128 = f32x4.splat(pp);
	const one: v128 = f32x4.splat(1.0);

	if (fractalType == 1) {
		let sum: v128 = f32x4.splat(0.0);
		let amp: v128 = f32x4.splat(fractalBounding(gain, octaves));
		if (ws == 0) {
			for (let o: i32 = 0; o < octaves; o++) {
				sum = f32x4.add(sum, f32x4.mul(singleSimplex2L4(seed++, x, y), amp));
				x = f32x4.mul(x, splatLac);
				y = f32x4.mul(y, splatLac);
				amp = f32x4.mul(amp, splatGain);
			}
			return sum;
		}
		for (let o: i32 = 0; o < octaves; o++) {
			const n: v128 = singleSimplex2L4(seed++, x, y);
			sum = f32x4.add(sum, f32x4.mul(n, amp));
			const t: v128 = selectB(f32x4.lt(n, one), n, one);
			amp = f32x4.mul(
				amp,
				f32x4.add(one, f32x4.mul(f32x4.sub(t, one), splatWs)),
			);
			x = f32x4.mul(x, splatLac);
			y = f32x4.mul(y, splatLac);
			amp = f32x4.mul(amp, splatGain);
		}
		return sum;
	}
	if (fractalType == 2) {
		let sum: v128 = f32x4.splat(0.0);
		let amp: v128 = f32x4.splat(fractalBounding(gain, octaves));
		for (let o: i32 = 0; o < octaves; o++) {
			const n: v128 = f32x4.abs(singleSimplex2L4(seed++, x, y));
			sum = f32x4.add(
				sum,
				f32x4.mul(f32x4.add(f32x4.mul(n, f32x4.splat(-2.0)), one), amp),
			);
			amp = f32x4.sub(amp, f32x4.mul(f32x4.mul(amp, splatWs), n));
			x = f32x4.mul(x, splatLac);
			y = f32x4.mul(y, splatLac);
			amp = f32x4.mul(amp, splatGain);
		}
		return sum;
	}
	if (fractalType == 3) {
		let sum: v128 = f32x4.splat(0.0);
		let amp: v128 = f32x4.splat(fractalBounding(gain, octaves));
		const half: v128 = f32x4.splat(0.5);
		for (let o: i32 = 0; o < octaves; o++) {
			let t: v128 = f32x4.mul(
				f32x4.add(singleSimplex2L4(seed++, x, y), one),
				splatPp,
			);
			const tt: v128 = f32x4.mul(t, f32x4.splat(0.5));
			t = f32x4.sub(
				t,
				f32x4.mul(
					selectB(
						f32x4.ge(tt, f32x4.splat(0.0)),
						f32x4.floor(tt),
						f32x4.ceil(tt),
					),
					f32x4.splat(2.0),
				),
			);
			// (PingPong: t -= 2*trunc-like(tt); the selectB mask must be the
			// ge() comparator, exactly as fractal3L4 does.)
			const n: v128 = selectB(
				f32x4.lt(t, one),
				t,
				f32x4.sub(f32x4.splat(2.0), t),
			);
			sum = f32x4.add(
				sum,
				f32x4.mul(f32x4.mul(f32x4.sub(n, half), f32x4.splat(2.0)), amp),
			);
			amp = f32x4.mul(
				amp,
				f32x4.add(one, f32x4.mul(f32x4.sub(n, one), splatWs)),
			);
			x = f32x4.mul(x, splatLac);
			y = f32x4.mul(y, splatLac);
			amp = f32x4.mul(amp, splatGain);
		}
		return sum;
	}
	return singleSimplex2L4(seed, x, y);
}

function fractal3L4(
	seed: i32,
	x: v128,
	y: v128,
	z: v128,
	fractalType: i32,
	octaves: i32,
	lacunarity: f32,
	gain: f32,
	ws: f32,
	pp: f32,
): v128 {
	const splatLac: v128 = f32x4.splat(lacunarity);
	const splatGain: v128 = f32x4.splat(gain);
	const splatWs: v128 = f32x4.splat(ws);
	const splatPp: v128 = f32x4.splat(pp);
	const one: v128 = f32x4.splat(1.0);

	if (fractalType == 1) {
		let sum: v128 = f32x4.splat(0.0);
		let amp: v128 = f32x4.splat(fractalBounding(gain, octaves));
		if (ws == 0) {
			for (let o: i32 = 0; o < octaves; o++) {
				sum = f32x4.add(sum, f32x4.mul(singleSimplex3L4(seed++, x, y, z), amp));
				x = f32x4.mul(x, splatLac);
				y = f32x4.mul(y, splatLac);
				z = f32x4.mul(z, splatLac);
				amp = f32x4.mul(amp, splatGain);
			}
			return sum;
		}
		for (let o: i32 = 0; o < octaves; o++) {
			const n: v128 = singleSimplex3L4(seed++, x, y, z);
			sum = f32x4.add(sum, f32x4.mul(n, amp));
			amp = f32x4.mul(
				amp,
				f32x4.add(
					one,
					f32x4.mul(f32x4.mul(f32x4.sub(n, one), f32x4.splat(0.5)), splatWs),
				),
			);
			x = f32x4.mul(x, splatLac);
			y = f32x4.mul(y, splatLac);
			z = f32x4.mul(z, splatLac);
			amp = f32x4.mul(amp, splatGain);
		}
		return sum;
	}
	if (fractalType == 2) {
		let sum: v128 = f32x4.splat(0.0);
		let amp: v128 = f32x4.splat(fractalBounding(gain, octaves));
		for (let o: i32 = 0; o < octaves; o++) {
			const n: v128 = f32x4.abs(singleSimplex3L4(seed++, x, y, z));
			sum = f32x4.add(
				sum,
				f32x4.mul(f32x4.add(f32x4.mul(n, f32x4.splat(-2.0)), one), amp),
			);
			amp = f32x4.sub(amp, f32x4.mul(f32x4.mul(amp, splatWs), n));
			x = f32x4.mul(x, splatLac);
			y = f32x4.mul(y, splatLac);
			z = f32x4.mul(z, splatLac);
			amp = f32x4.mul(amp, splatGain);
		}
		return sum;
	}
	if (fractalType == 3) {
		let sum: v128 = f32x4.splat(0.0);
		let amp: v128 = f32x4.splat(fractalBounding(gain, octaves));
		const half: v128 = f32x4.splat(0.5);
		for (let o: i32 = 0; o < octaves; o++) {
			let t: v128 = f32x4.mul(
				f32x4.add(singleSimplex3L4(seed++, x, y, z), one),
				splatPp,
			);
			const tt: v128 = f32x4.mul(t, f32x4.splat(0.5));
			t = f32x4.sub(
				t,
				f32x4.mul(
					selectB(
						f32x4.ge(tt, f32x4.splat(0.0)),
						f32x4.floor(tt),
						f32x4.ceil(tt),
					),
					f32x4.splat(2.0),
				),
			);
			const n: v128 = selectB(
				f32x4.lt(t, one),
				t,
				f32x4.sub(f32x4.splat(2.0), t),
			);
			sum = f32x4.add(
				sum,
				f32x4.mul(f32x4.mul(f32x4.sub(n, half), f32x4.splat(2.0)), amp),
			);
			amp = f32x4.mul(
				amp,
				f32x4.add(one, f32x4.mul(f32x4.sub(n, one), splatWs)),
			);
			x = f32x4.mul(x, splatLac);
			y = f32x4.mul(y, splatLac);
			z = f32x4.mul(z, splatLac);
			amp = f32x4.mul(amp, splatGain);
		}
		return sum;
	}
	return singleSimplex3L4(seed, x, y, z);
}

// --- scratch allocation (16-byte aligned) -------------------------------------

let _scratchSize: i32 = 0;
let _scratchPtr: usize = 0;

export function ensureScratch(n: i32): usize {
	if (n > _scratchSize) {
		_scratchPtr = heap.alloc(n + 16);
		_scratchPtr = (_scratchPtr + 15) & ~15;
		_scratchSize = n + 16;
	}
	return _scratchPtr;
}

// --- scalar exports -----------------------------------------------------------

export function noise_scalar_2d(
	x: f32,
	y: f32,
	freq: f32,
	noiseType: i32,
	fractalType: i32,
	seed: i32,
	octaves: i32,
	lacunarity: f32,
	gain: f32,
	ws: f32,
	pp: f32,
): f32 {
	if (noiseType != 1) return 0;
	x *= freq;
	y *= freq;
	const t: f32 = (x + y) * F2;
	x += t;
	y += t;
	return fractal2(seed, x, y, fractalType, octaves, lacunarity, gain, ws, pp);
}

export function noise_scalar_3d(
	x: f32,
	y: f32,
	z: f32,
	freq: f32,
	noiseType: i32,
	fractalType: i32,
	transformType: i32,
	seed: i32,
	octaves: i32,
	lacunarity: f32,
	gain: f32,
	ws: f32,
	pp: f32,
): f32 {
	if (noiseType != 1) return 0;
	x *= freq;
	y *= freq;
	z *= freq;
	if (transformType == 1) {
		const xy: f32 = x + y;
		const s2: f32 = xy * G3;
		const zH: f32 = z * H3;
		x += s2 - zH;
		y += s2 - zH;
		z += xy * H3;
	} else if (transformType == 2) {
		const xz: f32 = x + z;
		const s2xz: f32 = xz * G3;
		const yH: f32 = y * H3;
		x += s2xz - yH;
		z += s2xz - yH;
		y += xz * H3;
	} else if (transformType == 3) {
		const r: f32 = (x + y + z) * F3;
		x = r - x;
		y = r - y;
		z = r - z;
	}
	return fractal3(
		seed,
		x,
		y,
		z,
		fractalType,
		octaves,
		lacunarity,
		gain,
		ws,
		pp,
	);
}

// 4-lane equivalent of noise_scalar_3d: applies freq, the 3D transform and the
// fractal per lane. Every op is per-lane scalar math, so each lane is
// bit-identical to the scalar kernel (same guarantee as the fill kernels).
function noise3L4(
	x: v128,
	y: v128,
	z: v128,
	freq: f32,
	noiseType: i32,
	fractalType: i32,
	transformType: i32,
	seed: i32,
	octaves: i32,
	lacunarity: f32,
	gain: f32,
	ws: f32,
	pp: f32,
): v128 {
	if (noiseType != 1) return f32x4.splat(0.0);
	const freqV: v128 = f32x4.splat(freq);
	x = f32x4.mul(x, freqV);
	y = f32x4.mul(y, freqV);
	z = f32x4.mul(z, freqV);
	if (transformType == 1) {
		const G3s: v128 = f32x4.splat(G3);
		const H3s: v128 = f32x4.splat(H3);
		const xy: v128 = f32x4.add(x, y);
		const s2: v128 = f32x4.mul(xy, G3s);
		const zH: v128 = f32x4.mul(z, H3s);
		x = f32x4.add(x, f32x4.sub(s2, zH));
		y = f32x4.add(y, f32x4.sub(s2, zH));
		z = f32x4.add(z, f32x4.mul(xy, H3s));
	} else if (transformType == 2) {
		const G3s: v128 = f32x4.splat(G3);
		const H3s: v128 = f32x4.splat(H3);
		const xz: v128 = f32x4.add(x, z);
		const s2xz: v128 = f32x4.mul(xz, G3s);
		const yH: v128 = f32x4.mul(y, H3s);
		x = f32x4.add(x, f32x4.sub(s2xz, yH));
		z = f32x4.add(z, f32x4.sub(s2xz, yH));
		y = f32x4.add(y, f32x4.mul(xz, H3s));
	} else if (transformType == 3) {
		const F3s: v128 = f32x4.splat(F3);
		const r: v128 = f32x4.mul(f32x4.add(f32x4.add(x, y), z), F3s);
		x = f32x4.sub(r, x);
		y = f32x4.sub(r, y);
		z = f32x4.sub(r, z);
	}
	return fractal3L4(
		seed,
		x,
		y,
		z,
		fractalType,
		octaves,
		lacunarity,
		gain,
		ws,
		pp,
	);
}

// --- batch exports -------------------------------------------------------------

export function noise_fill_2d(
	out: usize,
	width: i32,
	height: i32,
	offsetX: f32,
	offsetY: f32,
	freq: f32,
	noiseType: i32,
	fractalType: i32,
	seed: i32,
	octaves: i32,
	lacunarity: f32,
	gain: f32,
	ws: f32,
	pp: f32,
): void {
	if (noiseType != 1) {
		for (let i: i32 = 0; i < width * height; i++) store<f32>(out + i * 4, 0);
		return;
	}
	const F2s: v128 = f32x4.splat(F2);
	const freqs: v128 = f32x4.splat(freq);
	// Hoisted once: the four x-lane offsets (0, freq, 2freq, 3freq) are the
	// same for every row/col, so each aligned group only needs an add.
	const laneFreq: v128 = f32x4.mul(f32x4(0.0, 1.0, 2.0, 3.0), freqs);
	const widthAligned: i32 = width & ~3;
	let idx: i32 = 0;
	for (let row: i32 = 0; row < height; row++) {
		const y: f32 = (f32(row) + offsetY) * freq;
		const ys: v128 = f32x4.splat(y);
		let col: i32 = 0;
		for (; col < widthAligned; col += 4) {
			const base: f32 = (f32(col) + offsetX) * freq;
			let xs: v128 = f32x4.add(f32x4.splat(base), laneFreq);
			let ysT: v128 = ys;
			const t: v128 = f32x4.mul(f32x4.add(xs, ysT), F2s);
			xs = f32x4.add(xs, t);
			ysT = f32x4.add(ysT, t);
			store<v128>(
				out + idx * 4,
				fractal2L4(
					seed,
					xs,
					ysT,
					fractalType,
					octaves,
					lacunarity,
					gain,
					ws,
					pp,
				),
			);
			idx += 4;
		}
		for (; col < width; col++) {
			let x: f32 = (f32(col) + offsetX) * freq;
			let yS: f32 = y;
			const t: f32 = (x + yS) * F2;
			x += t;
			yS += t;
			store<f32>(
				out + idx * 4,
				fractal2(seed, x, yS, fractalType, octaves, lacunarity, gain, ws, pp),
			);
			idx++;
		}
	}
}

export function noise_fill_3d(
	out: usize,
	width: i32,
	height: i32,
	depth: i32,
	offsetX: f32,
	offsetY: f32,
	offsetZ: f32,
	freq: f32,
	noiseType: i32,
	fractalType: i32,
	transformType: i32,
	seed: i32,
	octaves: i32,
	lacunarity: f32,
	gain: f32,
	ws: f32,
	pp: f32,
): void {
	if (noiseType != 1) {
		for (let i: i32 = 0; i < width * height * depth; i++)
			store<f32>(out + i * 4, 0);
		return;
	}
	const widthAligned: i32 = width & ~3;
	// Hoisted once: the four x-lane offsets, reused by every transform branch.
	const laneFreq: v128 = f32x4.mul(
		f32x4(0.0, 1.0, 2.0, 3.0),
		f32x4.splat(freq),
	);
	let idx: i32 = 0;
	if (transformType == 1) {
		const G3s: v128 = f32x4.splat(G3);
		const H3s: v128 = f32x4.splat(H3);
		for (let slice: i32 = 0; slice < depth; slice++) {
			const z: f32 = (f32(slice) + offsetZ) * freq;
			for (let row: i32 = 0; row < height; row++) {
				const y: f32 = (f32(row) + offsetY) * freq;
				const ys: v128 = f32x4.splat(y);
				const zs: v128 = f32x4.splat(z);
				let col: i32 = 0;
				for (; col < widthAligned; col += 4) {
					const base: f32 = (f32(col) + offsetX) * freq;
					const xs: v128 = f32x4.add(f32x4.splat(base), laneFreq);
					const xy: v128 = f32x4.add(xs, ys);
					const s2: v128 = f32x4.mul(xy, G3s);
					const zH: v128 = f32x4.mul(zs, H3s);
					const xv: v128 = f32x4.add(xs, f32x4.sub(s2, zH));
					const yv: v128 = f32x4.add(ys, f32x4.sub(s2, zH));
					const zv: v128 = f32x4.add(zs, f32x4.mul(xy, H3s));
					store<v128>(
						out + idx * 4,
						fractal3L4(
							seed,
							xv,
							yv,
							zv,
							fractalType,
							octaves,
							lacunarity,
							gain,
							ws,
							pp,
						),
					);
					idx += 4;
				}
				for (; col < width; col++) {
					let x: f32 = (f32(col) + offsetX) * freq;
					let yS: f32 = y;
					let zS: f32 = z;
					const xy: f32 = x + yS;
					const s2: f32 = xy * G3;
					const zH: f32 = zS * H3;
					x += s2 - zH;
					yS += s2 - zH;
					zS += xy * H3;
					store<f32>(
						out + idx * 4,
						fractal3(
							seed,
							x,
							yS,
							zS,
							fractalType,
							octaves,
							lacunarity,
							gain,
							ws,
							pp,
						),
					);
					idx++;
				}
			}
		}
	} else if (transformType == 2) {
		const G3s: v128 = f32x4.splat(G3);
		const H3s: v128 = f32x4.splat(H3);
		for (let slice: i32 = 0; slice < depth; slice++) {
			const z: f32 = (f32(slice) + offsetZ) * freq;
			for (let row: i32 = 0; row < height; row++) {
				const y: f32 = (f32(row) + offsetY) * freq;
				const ys: v128 = f32x4.splat(y);
				const zs: v128 = f32x4.splat(z);
				let col: i32 = 0;
				for (; col < widthAligned; col += 4) {
					const base: f32 = (f32(col) + offsetX) * freq;
					const xs: v128 = f32x4.add(f32x4.splat(base), laneFreq);
					const xz: v128 = f32x4.add(xs, zs);
					const s2xz: v128 = f32x4.mul(xz, G3s);
					const yH: v128 = f32x4.mul(ys, H3s);
					const xv: v128 = f32x4.add(xs, f32x4.sub(s2xz, yH));
					const zv: v128 = f32x4.add(zs, f32x4.sub(s2xz, yH));
					const yv: v128 = f32x4.add(ys, f32x4.mul(xz, H3s));
					store<v128>(
						out + idx * 4,
						fractal3L4(
							seed,
							xv,
							yv,
							zv,
							fractalType,
							octaves,
							lacunarity,
							gain,
							ws,
							pp,
						),
					);
					idx += 4;
				}
				for (; col < width; col++) {
					let x: f32 = (f32(col) + offsetX) * freq;
					let yS: f32 = y;
					let zS: f32 = z;
					const xz: f32 = x + zS;
					const s2xz: f32 = xz * G3;
					const yH: f32 = yS * H3;
					x += s2xz - yH;
					zS += s2xz - yH;
					yS += xz * H3;
					store<f32>(
						out + idx * 4,
						fractal3(
							seed,
							x,
							yS,
							zS,
							fractalType,
							octaves,
							lacunarity,
							gain,
							ws,
							pp,
						),
					);
					idx++;
				}
			}
		}
	} else {
		const F3s: v128 = f32x4.splat(F3);
		for (let slice: i32 = 0; slice < depth; slice++) {
			const z: f32 = (f32(slice) + offsetZ) * freq;
			for (let row: i32 = 0; row < height; row++) {
				const y: f32 = (f32(row) + offsetY) * freq;
				const ys: v128 = f32x4.splat(y);
				const zs: v128 = f32x4.splat(z);
				let col: i32 = 0;
				for (; col < widthAligned; col += 4) {
					const base: f32 = (f32(col) + offsetX) * freq;
					const xs: v128 = f32x4.add(f32x4.splat(base), laneFreq);
					const r: v128 = f32x4.mul(f32x4.add(f32x4.add(xs, ys), zs), F3s);
					const xv: v128 = f32x4.sub(r, xs);
					const yv: v128 = f32x4.sub(r, ys);
					const zv: v128 = f32x4.sub(r, zs);
					store<v128>(
						out + idx * 4,
						fractal3L4(
							seed,
							xv,
							yv,
							zv,
							fractalType,
							octaves,
							lacunarity,
							gain,
							ws,
							pp,
						),
					);
					idx += 4;
				}
				for (; col < width; col++) {
					let x: f32 = (f32(col) + offsetX) * freq;
					let yS: f32 = y;
					let zS: f32 = z;
					const r: f32 = (x + yS + zS) * F3;
					x = r - x;
					yS = r - yS;
					zS = r - zS;
					store<f32>(
						out + idx * 4,
						fractal3(
							seed,
							x,
							yS,
							zS,
							fractalType,
							octaves,
							lacunarity,
							gain,
							ws,
							pp,
						),
					);
					idx++;
				}
			}
		}
	}
}

// --- affine 3D batch fill -----------------------------------------------------
// Samples a 3D grid where x' = x0 + col*ax + row*bx, y' = y0 + row*ay,
// z' = z0 + slice*az + row*bz (row-dependent shear along x and z).
// SIMD lanes run along x; bit-identical math to noise_scalar_3d (f32).

export function noise_fill_3d_affine(
	out: usize,
	width: i32,
	height: i32,
	depth: i32,
	x0: f32,
	y0: f32,
	z0: f32,
	ax: f32,
	bx: f32,
	ay: f32,
	az: f32,
	bz: f32,
	freq: f32,
	noiseType: i32,
	fractalType: i32,
	transformType: i32,
	seed: i32,
	octaves: i32,
	lacunarity: f32,
	gain: f32,
	ws: f32,
	pp: f32,
): void {
	if (noiseType != 1) {
		for (let i: i32 = 0; i < width * height * depth; i++)
			store<f32>(out + i * 4, 0);
		return;
	}
	const LANE_X: v128 = f32x4(0.0, 1.0, 2.0, 3.0);
	const laneFreq: v128 = f32x4.mul(LANE_X, f32x4.splat(ax * freq));
	const widthAligned: i32 = width & ~3;
	let idx: i32 = 0;
	if (transformType == 1) {
		const G3s: v128 = f32x4.splat(G3);
		const H3s: v128 = f32x4.splat(H3);
		for (let slice: i32 = 0; slice < depth; slice++) {
			const zSlice: f32 = z0 + f32(slice) * az;
			for (let row: i32 = 0; row < height; row++) {
				const xRowBase: f32 = x0 + f32(row) * bx;
				const y: f32 = (y0 + f32(row) * ay) * freq;
				const z: f32 = (zSlice + f32(row) * bz) * freq;
				const ys: v128 = f32x4.splat(y);
				const zs: v128 = f32x4.splat(z);
				let col: i32 = 0;
				for (; col < widthAligned; col += 4) {
					const xBase: f32 = (xRowBase + f32(col) * ax) * freq;
					const xs: v128 = f32x4.add(f32x4.splat(xBase), laneFreq);
					const xy: v128 = f32x4.add(xs, ys);
					const s2: v128 = f32x4.mul(xy, G3s);
					const zH: v128 = f32x4.mul(zs, H3s);
					const xv: v128 = f32x4.add(xs, f32x4.sub(s2, zH));
					const yv: v128 = f32x4.add(ys, f32x4.sub(s2, zH));
					const zv: v128 = f32x4.add(zs, f32x4.mul(xy, H3s));
					store<v128>(
						out + idx * 4,
						fractal3L4(
							seed,
							xv,
							yv,
							zv,
							fractalType,
							octaves,
							lacunarity,
							gain,
							ws,
							pp,
						),
					);
					idx += 4;
				}
				for (; col < width; col++) {
					let x: f32 = (xRowBase + f32(col) * ax) * freq;
					let yS: f32 = y;
					let zS: f32 = z;
					const xy: f32 = x + yS;
					const s2: f32 = xy * G3;
					const zH: f32 = zS * H3;
					x += s2 - zH;
					yS += s2 - zH;
					zS += xy * H3;
					store<f32>(
						out + idx * 4,
						fractal3(
							seed,
							x,
							yS,
							zS,
							fractalType,
							octaves,
							lacunarity,
							gain,
							ws,
							pp,
						),
					);
					idx++;
				}
			}
		}
	} else if (transformType == 2) {
		const G3s: v128 = f32x4.splat(G3);
		const H3s: v128 = f32x4.splat(H3);
		for (let slice: i32 = 0; slice < depth; slice++) {
			const zSlice: f32 = z0 + f32(slice) * az;
			for (let row: i32 = 0; row < height; row++) {
				const xRowBase: f32 = x0 + f32(row) * bx;
				const y: f32 = (y0 + f32(row) * ay) * freq;
				const z: f32 = (zSlice + f32(row) * bz) * freq;
				const ys: v128 = f32x4.splat(y);
				const zs: v128 = f32x4.splat(z);
				let col: i32 = 0;
				for (; col < widthAligned; col += 4) {
					const xBase: f32 = (xRowBase + f32(col) * ax) * freq;
					const xs: v128 = f32x4.add(f32x4.splat(xBase), laneFreq);
					const xz: v128 = f32x4.add(xs, zs);
					const s2xz: v128 = f32x4.mul(xz, G3s);
					const yH: v128 = f32x4.mul(ys, H3s);
					const xv: v128 = f32x4.add(xs, f32x4.sub(s2xz, yH));
					const zv: v128 = f32x4.add(zs, f32x4.sub(s2xz, yH));
					const yv: v128 = f32x4.add(ys, f32x4.mul(xz, H3s));
					store<v128>(
						out + idx * 4,
						fractal3L4(
							seed,
							xv,
							yv,
							zv,
							fractalType,
							octaves,
							lacunarity,
							gain,
							ws,
							pp,
						),
					);
					idx += 4;
				}
				for (; col < width; col++) {
					let x: f32 = (xRowBase + f32(col) * ax) * freq;
					let yS: f32 = y;
					let zS: f32 = z;
					const xz: f32 = x + zS;
					const s2xz: f32 = xz * G3;
					const yH: f32 = yS * H3;
					x += s2xz - yH;
					zS += s2xz - yH;
					yS += xz * H3;
					store<f32>(
						out + idx * 4,
						fractal3(
							seed,
							x,
							yS,
							zS,
							fractalType,
							octaves,
							lacunarity,
							gain,
							ws,
							pp,
						),
					);
					idx++;
				}
			}
		}
	} else {
		const F3s: v128 = f32x4.splat(F3);
		for (let slice: i32 = 0; slice < depth; slice++) {
			const zSlice: f32 = z0 + f32(slice) * az;
			for (let row: i32 = 0; row < height; row++) {
				const xRowBase: f32 = x0 + f32(row) * bx;
				const y: f32 = (y0 + f32(row) * ay) * freq;
				const z: f32 = (zSlice + f32(row) * bz) * freq;
				const ys: v128 = f32x4.splat(y);
				const zs: v128 = f32x4.splat(z);
				let col: i32 = 0;
				for (; col < widthAligned; col += 4) {
					const xBase: f32 = (xRowBase + f32(col) * ax) * freq;
					const xs: v128 = f32x4.add(f32x4.splat(xBase), laneFreq);
					const r: v128 = f32x4.mul(f32x4.add(f32x4.add(xs, ys), zs), F3s);
					const xv: v128 = f32x4.sub(r, xs);
					const yv: v128 = f32x4.sub(r, ys);
					const zv: v128 = f32x4.sub(r, zs);
					store<v128>(
						out + idx * 4,
						fractal3L4(
							seed,
							xv,
							yv,
							zv,
							fractalType,
							octaves,
							lacunarity,
							gain,
							ws,
							pp,
						),
					);
					idx += 4;
				}
				for (; col < width; col++) {
					let x: f32 = (xRowBase + f32(col) * ax) * freq;
					let yS: f32 = y;
					let zS: f32 = z;
					const r: f32 = (x + yS + zS) * F3;
					x = r - x;
					yS = r - yS;
					zS = r - zS;
					store<f32>(
						out + idx * 4,
						fractal3(
							seed,
							x,
							yS,
							zS,
							fractalType,
							octaves,
							lacunarity,
							gain,
							ws,
							pp,
						),
					);
					idx++;
				}
			}
		}
	}
}

// --- surface density band (batch scan) -----------------------------------------
// Evaluates the SurfaceGenerator terrain-density formula for `count` world Y
// samples starting at `y0` with stride `step`:
//
//   rel = baseHeight - y
//   density = rel + baseNoise*baseAmp + overhangNoise*overhangAmp + cliffContribution
//   baseNoise     = noise(baseNoiseX, y*yFreq, baseNoiseZ)
//   overhangNoise = noise(overhangBaseX + y*0.0044, y*0.012, overhangBaseZ - y*0.0036)
//
// Out-of-influence samples (|rel| > influenceRange) return plain rel without
// touching the noise (identical to the JS getDensity fast-path).
//
// The noise evaluation reuses noise3L4 (the 4-lane twin of noise_scalar_3d),
// so every value is bit-identical to the per-sample wasm scalar path; the win
// is removing JS<->wasm boundary crossings (~64k per chunk) for the scan +
// voxel loops AND vectorizing the per-lane simplex math.

export function surface_density_band(
	out: usize,
	count: i32,
	y0: f32,
	step: f32,
	baseNoiseX: f32,
	baseNoiseZ: f32,
	overhangBaseX: f32,
	overhangBaseZ: f32,
	baseHeight: f32,
	yFreq: f32,
	cliffContribution: f32,
	baseAmp: f32,
	overhangAmp: f32,
	influenceRange: f32,
	freq: f32,
	noiseType: i32,
	fractalType: i32,
	transformType: i32,
	seed: i32,
	octaves: i32,
	lacunarity: f32,
	gain: f32,
	ws: f32,
	pp: f32,
): void {
	const aligned: i32 = count & ~3;
	const stepV: v128 = f32x4.splat(step);
	const baseHeightV: v128 = f32x4.splat(baseHeight);
	const infRangeV: v128 = f32x4.splat(influenceRange);
	const negInfRangeV: v128 = f32x4.splat(-influenceRange);
	const yFreqV: v128 = f32x4.splat(yFreq);
	const baseNoiseXV: v128 = f32x4.splat(baseNoiseX);
	const baseNoiseZV: v128 = f32x4.splat(baseNoiseZ);
	const baseAmpV: v128 = f32x4.splat(baseAmp);
	const overhangAmpV: v128 = f32x4.splat(overhangAmp);
	const cliffV: v128 = f32x4.splat(cliffContribution);
	const oh0044V: v128 = f32x4.splat(0.0044);
	const oh012V: v128 = f32x4.splat(0.012);
	const oh0036V: v128 = f32x4.splat(0.0036);
	const overhangBaseXV: v128 = f32x4.splat(overhangBaseX);
	const overhangBaseZV: v128 = f32x4.splat(overhangBaseZ);

	let i: i32 = 0;
	for (; i < aligned; i += 4) {
		const laneY: v128 = f32x4.add(
			f32x4.splat(y0 + f32(i) * step),
			f32x4.mul(f32x4(0.0, 1.0, 2.0, 3.0), stepV),
		);
		const rel: v128 = f32x4.sub(baseHeightV, laneY);
		const insideRange: v128 = v128.and(
			f32x4.le(rel, infRangeV),
			f32x4.ge(rel, negInfRangeV),
		);
		const anyInside: i32 =
			i32x4.extract_lane(insideRange, 0) |
			i32x4.extract_lane(insideRange, 1) |
			i32x4.extract_lane(insideRange, 2) |
			i32x4.extract_lane(insideRange, 3);

		let result: v128;
		if (!anyInside) {
			result = rel;
		} else {
			// PERF: lane-wise noise (noise3L4) instead of 8 scalar crossings —
			// same per-lane values as noise_scalar_3d, so bit-identical output.
			const nBase: v128 = noise3L4(
				baseNoiseXV,
				f32x4.mul(laneY, yFreqV),
				baseNoiseZV,
				freq,
				noiseType,
				fractalType,
				transformType,
				seed,
				octaves,
				lacunarity,
				gain,
				ws,
				pp,
			);

			const ohX: v128 = f32x4.add(overhangBaseXV, f32x4.mul(laneY, oh0044V));
			const ohY: v128 = f32x4.mul(laneY, oh012V);
			const ohZ: v128 = f32x4.sub(overhangBaseZV, f32x4.mul(laneY, oh0036V));

			const nOh: v128 = noise3L4(
				ohX,
				ohY,
				ohZ,
				freq,
				noiseType,
				fractalType,
				transformType,
				seed,
				octaves,
				lacunarity,
				gain,
				ws,
				pp,
			);

			const density: v128 = f32x4.add(
				f32x4.add(rel, f32x4.mul(nBase, baseAmpV)),
				f32x4.add(f32x4.mul(nOh, overhangAmpV), cliffV),
			);
			result = selectB(insideRange, density, rel);
		}
		store<v128>(out + i * 4, result);
	}
	for (; i < count; i++) {
		const y: f32 = y0 + f32(i) * step;
		const rel: f32 = baseHeight - y;
		let d: f32;
		if (rel > influenceRange || rel < -influenceRange) {
			d = rel;
		} else {
			d =
				rel +
				noise_scalar_3d(
					baseNoiseX,
					y * yFreq,
					baseNoiseZ,
					freq,
					noiseType,
					fractalType,
					transformType,
					seed,
					octaves,
					lacunarity,
					gain,
					ws,
					pp,
				) *
					baseAmp +
				noise_scalar_3d(
					overhangBaseX + y * 0.0044,
					y * 0.012,
					overhangBaseZ - y * 0.0036,
					freq,
					noiseType,
					fractalType,
					transformType,
					seed,
					octaves,
					lacunarity,
					gain,
					ws,
					pp,
				) *
					overhangAmp +
				cliffContribution;
		}
		store<f32>(out + i * 4, d);
	}
}
