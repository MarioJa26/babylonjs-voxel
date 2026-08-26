import type { Vec3 } from "@babylonjs/lite";

/**
 * Segment vs yaw-oriented box (OBB) hit test for projectiles.
 *
 * The segment is transformed into the mob's local frame (yaw rotated around
 * its center), tested against the axis-aligned local box, and the returned
 * point stays in local space — the caller rotates it back with the mob's
 * current yaw. `t` is the normalized entry distance along the segment, so
 * multiple mobs can be compared for the NEAREST hit.
 *
 * Returns null on miss. Zero-length segments never hit (no sweep direction).
 */
export function segmentMobHit(
	startX: number,
	startY: number,
	startZ: number,
	endX: number,
	endY: number,
	endZ: number,
	center: Vec3,
	yaw: number,
	halfExtents: Vec3,
): { t: number; lx: number; ly: number; lz: number } | null {
	// World → mob-local: translate, then apply R(-yaw) around Y.
	// R(y) maps local→world as wx = cos·lx + sin·lz, wz = −sin·lx + cos·lz
	// (same convention as the instance matrices), so its inverse is
	// lx = cos·wx − sin·wz, lz = sin·wx + cos·wz.
	const c = Math.cos(yaw);
	const s = Math.sin(yaw);
	const rx = startX - center.x;
	const rz = startZ - center.z;
	const lsx = c * rx - s * rz;
	const lsy = startY - center.y;
	const lsz = s * rx + c * rz;

	const rdx = endX - center.x;
	const rdz = endZ - center.z;
	const lex = c * rdx - s * rdz;
	const ley = endY - center.y;
	const lez = s * rdx + c * rdz;

	const ldx = lex - lsx;
	const ldy = ley - lsy;
	const ldz = lez - lsy;

	if (ldx * ldx + ldy * ldy + ldz * ldz < 1e-10) {
		return null;
	}

	let tMin = 0;
	let tMax = 1;

	// Per-axis slab clip.
	for (let axis = 0; axis < 3; axis++) {
		const origin = axis === 0 ? lsx : axis === 1 ? lsy : lsz;
		const dir = axis === 0 ? ldx : axis === 1 ? ldy : ldz;
		const half =
			axis === 0 ? halfExtents.x : axis === 1 ? halfExtents.y : halfExtents.z;

		if (Math.abs(dir) < 1e-8) {
			if (origin < -half || origin > half) return null;
			continue;
		}

		const inv = 1 / dir;
		let t1 = (-half - origin) * inv;
		let t2 = (half - origin) * inv;
		if (t1 > t2) {
			const tmp = t1;
			t1 = t2;
			t2 = tmp;
		}

		if (t1 > tMin) tMin = t1;
		if (t2 < tMax) tMax = t2;
		if (tMin > tMax) return null;
	}

	return {
		t: tMin,
		lx: lsx + ldx * tMin,
		ly: lsy + ldy * tMin,
		lz: lsz + ldz * tMin,
	};
}

/** Rotate a mob-local point back to world space (mob center + current yaw). */
export function mobLocalToWorld(
	center: Vec3,
	yaw: number,
	lx: number,
	ly: number,
	lz: number,
): { x: number; y: number; z: number } {
	const c = Math.cos(yaw);
	const s = Math.sin(yaw);
	return {
		x: center.x + c * lx + s * lz,
		y: center.y + ly,
		z: center.z - s * lx + c * lz,
	};
}
