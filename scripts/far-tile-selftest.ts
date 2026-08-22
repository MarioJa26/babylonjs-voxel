/**
 * Standalone self-test for the far-tile face pipeline:
 *   packFace -> decodeFarTileFace -> expandTileFaces
 *
 * Zero game dependencies (FarTileFaceFormat is intentionally import-free).
 * Run via scripts/far-tile-selftest.cmd
 */
import {
	decodeFarTileFace,
	expandTileFaces,
	KIND_OPAQUE,
	KIND_WATER,
	LIGHT_FULL,
	LIGHT_SIDE,
	packFace,
} from "../src/code/World/FarTiles/FarTileFaceFormat.js";

let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
	if (cond) {
		console.log(`PASS ${name}`);
	} else {
		failures++;
		console.error(`FAIL ${name} ${detail}`);
	}
}

function approx(a: number, b: number): boolean {
	return Math.abs(a - b) < 1e-6;
}

// ---------------------------------------------------------------------------
// 1. Round-trip: every axis/backFace combo survives encode->decode exactly
// ---------------------------------------------------------------------------
for (let axis = 0; axis < 3; axis++) {
	for (let back = 0; back < 2; back++) {
		const faces: number[] = [];
		packFace(
			faces,
			511,
			-1024 + 7,
			256,
			300,
			17,
			axis,
			back,
			13,
			42,
			LIGHT_SIDE,
			KIND_OPAQUE,
		);
		const f = new Uint32Array(faces);
		const d = decodeFarTileFace(f, 0);

		const label = `roundtrip axis=${axis} back=${back}`;
		check(
			label,
			d.x === 511 &&
				d.y === -1017 &&
				d.z === 256 &&
				d.w === 300 &&
				d.h === 17 &&
				d.axis === axis &&
				d.backFace === back &&
				d.tileX === 13 &&
				d.tileY === 42 &&
				d.kind === KIND_OPAQUE,
			JSON.stringify(d),
		);
	}
}

// ---------------------------------------------------------------------------
// 2. Expansion geometry: no shear, right plane, right extents (w != h!)
// ---------------------------------------------------------------------------
function triNormal(
	p: Float32Array,
	i0: number,
	i1: number,
	i2: number,
): [number, number, number] {
	const ax = p[i1 * 3] - p[i0 * 3];
	const ay = p[i1 * 3 + 1] - p[i0 * 3 + 1];
	const az = p[i1 * 3 + 2] - p[i0 * 3 + 2];
	const bx = p[i2 * 3] - p[i0 * 3];
	const by = p[i2 * 3 + 1] - p[i0 * 3 + 1];
	const bz = p[i2 * 3 + 2] - p[i0 * 3 + 2];
	return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

const ORIGIN_X = 1536;
const ORIGIN_Z = -1024;

interface FaceSpec {
	x: number;
	y: number;
	z: number;
	w: number;
	h: number;
	axis: number;
	back: number;
}

// Non-square sizes everywhere so any w/h mixup shows up as shear/misextent.
const SPECS: FaceSpec[] = [
	{ x: 10, y: 64, z: 20, w: 16, h: 8, axis: 0, back: 0 }, // +X wall
	{ x: 30, y: 40, z: 22, w: 24, h: 12, axis: 0, back: 1 }, // -X wall
	{ x: 44, y: 70, z: 26, w: 48, h: 28, axis: 1, back: 0 }, // top
	{ x: 46, y: 30, z: 28, w: 52, h: 36, axis: 1, back: 1 }, // bottom
	{ x: 50, y: 60, z: 32, w: 56, h: 40, axis: 2, back: 0 }, // +Z wall
	{ x: 52, y: 62, z: 34, w: 60, h: 44, axis: 2, back: 1 }, // -Z wall
];

{
	const faces: number[] = [];
	for (const s of SPECS) {
		packFace(
			faces,
			s.x,
			s.y,
			s.z,
			s.w,
			s.h,
			s.axis,
			s.back,
			1,
			1,
			LIGHT_FULL,
			KIND_OPAQUE,
		);
	}
	const expanded = expandTileFaces(
		new Uint32Array(faces),
		new Uint32Array(0),
		ORIGIN_X,
		ORIGIN_Z,
	);
	const v = expanded.opaque!;
	const p = v.positions;

	SPECS.forEach((s, fi) => {
		const o = fi * 4 * 3;
		const px = [p[o], p[o + 3], p[o + 6], p[o + 9]].map((q) => q - ORIGIN_X);
		const py = [p[o + 1], p[o + 4], p[o + 7], p[o + 10]];
		const pz = [p[o + 2], p[o + 5], p[o + 8], p[o + 11]].map(
			(q) => q - ORIGIN_Z,
		);

		// All four verts share the fixed-axis coordinate == face plane.
		const planeCoord = s.axis === 0 ? px : s.axis === 1 ? py : pz;
		const wantPlane = s.axis === 0 ? s.x : s.axis === 1 ? s.y : s.z;
		const onPlane = planeCoord.every((c) => approx(c, wantPlane));

		// Extents along the two varying axes are EXACTLY (w,h) — no shear.
		// Axis semantics (must match FarTileFaceFormat bases):
		//   axis0: w spans Y, h spans Z | axis1: w spans Z, h spans X
		//   axis2: w spans X, h spans Y
		const uOf = (k: number): number =>
			s.axis === 0 ? py[k] : s.axis === 1 ? pz[k] : px[k];
		const vOf = (k: number): number =>
			s.axis === 0 ? pz[k] : s.axis === 1 ? px[k] : py[k];

		let loU = Infinity;
		let hiU = -Infinity;
		let loV = Infinity;
		let hiV = -Infinity;
		for (let k = 0; k < 4; k++) {
			const u = uOf(k);
			const vv = vOf(k);
			loU = Math.min(loU, u);
			hiU = Math.max(hiU, u);
			loV = Math.min(loV, vv);
			hiV = Math.max(hiV, vv);
		}
		const spanUok = approx(hiU - loU, s.w);
		const spanVok = approx(hiV - loV, s.h);

		// Rectangle (not parallelogram): each vertex is a corner of bbox.
		const cornersOk = [0, 1, 2, 3].every((k) => {
			const u = uOf(k);
			const vv = vOf(k);
			const atCorner =
				(approx(u, loU) || approx(u, hiU)) &&
				(approx(vv, loV) || approx(vv, hiV));
			return atCorner;
		});

		check(
			`expand axis=${s.axis} back=${s.back} on-plane`,
			onPlane,
			JSON.stringify({ planeCoord, wantPlane }),
		);
		check(
			`expand axis=${s.axis} back=${s.back} extents`,
			spanUok && spanVok && cornersOk,
			`u[${loU},${hiU}] v[${loV},${hiV}] want ${s.w}x${s.h}`,
		);

		// Winding invariant, measured THROUGH THE INDEX BUFFER (the rendered
		// triangle order is what matters): first-tri cross must OPPOSE the
		// intent normal — negative along `axis` for back=0, positive for 1.
		const idx = v.indices;
		const i0 = idx[fi * 6];
		const i1 = idx[fi * 6 + 1];
		const i2 = idx[fi * 6 + 2];
		const n = triNormal(p, i0, i1, i2);
		const comp = n[s.axis];
		const othersZero = n
			.filter((_, q) => q !== s.axis)
			.every((q) => approx(q, 0));
		const signOk = s.back === 1 ? comp > 0 : comp < 0;
		check(
			`winding axis=${s.axis} back=${s.back}`,
			othersZero && signOk,
			JSON.stringify(n),
		);
	});
}

// ---------------------------------------------------------------------------
// 3. Water quads: ORDER A walk, top-up winding (first-tri cross = -Y)
// ---------------------------------------------------------------------------
{
	const faces: number[] = [];
	packFace(faces, 7, 96, 9, 32, 32, 1, 0, 0, 0, LIGHT_FULL, KIND_WATER);
	const expanded = expandTileFaces(
		new Uint32Array(0),
		new Uint32Array(faces),
		ORIGIN_X,
		ORIGIN_Z,
	);
	const wp = expanded.waterPositions!;

	const okCorners =
		approx(wp[0], ORIGIN_X + 7) &&
		approx(wp[1], 96) &&
		approx(wp[2], ORIGIN_Z + 9) &&
		approx(wp[5], ORIGIN_Z + 9 + 32) &&
		approx(wp[6], ORIGIN_X + 7 + 32) &&
		approx(wp[11], ORIGIN_Z + 9);

	// Water indices are generated main-thread side with the documented
	// reversed pattern (0,2,1)(0,3,2) for the ORDER-A walk — replicate it
	// here so this test locks the expected top-up orientation.
	const t0 = 0;
	const t1 = 2;
	const t2 = 1;
	const e1 = [
		wp[t1 * 3] - wp[t0 * 3],
		wp[t1 * 3 + 1] - wp[t0 * 3 + 1],
		wp[t1 * 3 + 2] - wp[t0 * 3 + 2],
	];
	const e2 = [
		wp[t2 * 3] - wp[t0 * 3],
		wp[t2 * 3 + 1] - wp[t0 * 3 + 1],
		wp[t2 * 3 + 2] - wp[t0 * 3 + 2],
	];
	const ny = e1[2] * e2[0] - e1[0] * e2[2];

	check("water corners", okCorners, JSON.stringify(Array.from(wp)));
	check("water top-up winding", ny < 0, `cross_y=${ny}`);
}

// ---------------------------------------------------------------------------
// 4. Light factor mapping
// ---------------------------------------------------------------------------
{
	const faces: number[] = [];
	packFace(faces, 0, 0, 0, 4, 4, 1, 0, 0, 0, LIGHT_FULL, KIND_OPAQUE);
	packFace(faces, 8, 0, 0, 4, 4, 1, 0, 0, 0, LIGHT_SIDE, KIND_OPAQUE);
	const ex = expandTileFaces(new Uint32Array(faces), new Uint32Array(0), 0, 0)
		.opaque!;
	check("light full=1.0", approx(ex.colors[0], 1));
	check("light side=0.8", approx(ex.colors[16], 0.8));
}

if (failures > 0) {
	console.error(`\n${failures} FAILURE(S)`);
	(globalThis as { process?: { exitCode: number } }).process!.exitCode = 1;
} else {
	console.log("\nALL CHECKS PASSED");
}
