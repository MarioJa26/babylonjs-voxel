/**
 * Column-ring ordering helpers (streaming re-arch phase 1).
 *
 * Pure functions with no engine dependencies so the ordering policy can be
 * unit-tested and tuned without touching the controller. The controller owns
 * all chunk state; this module only answers "in what column order?" and
 * "is this column ahead of movement?".
 */

export type ColumnEntry = {
	x: number;
	z: number;
	hDist: number;
	ahead: boolean;
};

/**
 * True when column (x,z) lies in the approach half-space of movement
 * (dx,dz) relative to center (cx,cz). Zero movement → false everywhere.
 */
export function isAheadColumn(
	x: number,
	z: number,
	cx: number,
	cz: number,
	dx: number,
	dz: number,
): boolean {
	if (dx === 0 && dz === 0) return false;
	return (x - cx) * dx + (z - cz) * dz > 0;
}

/**
 * Build the square column shell for the initial load in iteration order.
 * Caller sorts with sortColumnsAheadFirst before scanning Y bands.
 */
export function buildInitialColumnList(
	cx: number,
	cz: number,
	radius: number,
	dx: number,
	dz: number,
): ColumnEntry[] {
	const out: ColumnEntry[] = [];
	for (let x = cx - radius; x <= cx + radius; x++) {
		for (let z = cz - radius; z <= cz + radius; z++) {
			const absX = x - cx < 0 ? cx - x : x - cx;
			const absZ = z - cz < 0 ? cz - z : z - cz;
			const hDist = absX > absZ ? absX : absZ;
			out.push({
				x,
				z,
				hDist,
				ahead: isAheadColumn(x, z, cx, cz, dx, dz),
			});
		}
	}
	return out;
}

/**
 * Order columns for scanning: nearer rings first (visible beats distant),
 * approaching columns first within a ring (fast fly loads ahead first).
 * Implemented as hDist minus a sub-ring bonus so nearer-behind still beats
 * farther-ahead — only the within-ring order flips.
 */
export function sortColumnsAheadFirst(
	columns: ColumnEntry[],
	aheadRingBonus = 0.5,
): ColumnEntry[] {
	columns.sort(
		(a, b) =>
			a.hDist -
			(a.ahead ? aheadRingBonus : 0) -
			(b.hDist - (b.ahead ? aheadRingBonus : 0)),
	);
	return columns;
}
