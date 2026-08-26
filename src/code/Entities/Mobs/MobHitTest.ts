/**
 * Segment vs yaw-oriented box (OBB) hit test for projectiles.
 *
 * Scalar-only and allocation-free: the segment is transformed into the mob's
 * local frame (yaw rotated around its center), tested against the axis-aligned
 * local box, and the normalized entry distance `t` along the segment is
 * returned. `t` is invariant under the rotation, so callers derive the world
 * impact point as `lerp(start, end, t)` — no local→world round trip.
 *
 * A cheap broad-phase sphere reject skips mobs that cannot possibly intersect.
 * Returns null on miss. Zero-length segments never hit.
 */
export function segmentMobHit(
	startX: number,
	startY: number,
	startZ: number,
	endX: number,
	endY: number,
	endZ: number,
	centerX: number,
	centerY: number,
	centerZ: number,
	yaw: number,
	halfX: number,
	halfY: number,
	halfZ: number,
): number | null {
	const dxs = endX - startX;
	const dys = endY - startY;
	const dzs = endZ - startZ;

	// Broad phase: distance from the box center to the segment midpoint vs
	// half segment length + worst-case box radius.
	const midX = startX + dxs * 0.5 - centerX;
	const midY = startY + dys * 0.5 - centerY;
	const midZ = startZ + dzs * 0.5 - centerZ;
	const segHalf = Math.sqrt(dxs * dxs + dys * dys + dzs * dzs) * 0.5;
	const reach = segHalf + Math.max(halfX, halfY, halfZ);
	if (midX * midX + midY * midY + midZ * midZ > reach * reach) {
		return null;
	}

	// World → mob-local: translate, then apply R(-yaw) around Y.
	// R(y) maps local→world as wx = cos·lx + sin·lz, wz = −sin·lx + cos·lz
	// (same convention as the instance matrices), so its inverse is
	// lx = cos·wx − sin·wz, lz = sin·wx + cos·wz.
	const c = Math.cos(yaw);
	const s = Math.sin(yaw);
	const rx = startX - centerX;
	const rz = startZ - centerZ;
	const lsx = c * rx - s * rz;
	const lsy = startY - centerY;
	const lsz = s * rx + c * rz;

	const ldx = c * dxs - s * dzs;
	const ldy = dys;
	const ldz = s * dxs + c * dzs;

	let tMin = 0;
	let tMax = 1;

	// Per-axis slab clip.
	for (let axis = 0; axis < 3; axis++) {
		const origin = axis === 0 ? lsx : axis === 1 ? lsy : lsz;
		const dir = axis === 0 ? ldx : axis === 1 ? ldy : ldz;
		const half = axis === 0 ? halfX : axis === 1 ? halfY : halfZ;

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

	return tMin;
}
