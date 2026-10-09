/**
 * Column-ring ordering helpers (streaming re-arch phase 1).
 *
 * Pure functions with no engine dependencies so the ordering policy can be
 * unit-tested and tuned without touching the controller.
 */

export type ColumnEntry = {
	x: number;
	z: number;
	hDist: number;
	ahead: boolean;
};

/**
 * True when column (x, z) lies in the approach half-space of movement
 * (dx, dz) relative to center (cx, cz). Zero movement returns false.
 */
export function isAheadColumn(
	x: number,
	z: number,
	cx: number,
	cz: number,
	dx: number,
	dz: number,
): boolean {
	return (dx !== 0 || dz !== 0) && (x - cx) * dx + (z - cz) * dz > 0;
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
	if (radius < 0) {
		return [];
	}

	const diameter = Math.floor(radius * 2) + 1;
	const out = new Array<ColumnEntry>(diameter * diameter);

	const minX = cx - radius;
	const maxX = cx + radius;
	const minZ = cz - radius;
	const maxZ = cz + radius;
	const hasMovement = dx !== 0 || dz !== 0;

	let index = 0;

	for (let x = minX; x <= maxX; x++) {
		const offsetX = x - cx;
		const absX = Math.abs(offsetX);

		for (let z = minZ; z <= maxZ; z++) {
			const offsetZ = z - cz;

			out[index++] = {
				x,
				z,
				hDist: Math.max(absX, Math.abs(offsetZ)),
				ahead: hasMovement && offsetX * dx + offsetZ * dz > 0,
			};
		}
	}

	return out;
}

/**
 * Order columns for scanning:
 * 1. Nearer rings first.
 * 2. Approaching columns first within a ring.
 *
 * The sub-ring bonus ensures a nearer-behind column still precedes a
 * farther-ahead column when aheadRingBonus is between 0 and 1.
 *
 * Mutates and returns the supplied array.
 */
export function sortColumnsAheadFirst(
	columns: ColumnEntry[],
	aheadRingBonus = 0.5,
): ColumnEntry[] {
	columns.sort((a, b) => {
		const aPriority = a.hDist - (a.ahead ? aheadRingBonus : 0);
		const bPriority = b.hDist - (b.ahead ? aheadRingBonus : 0);

		return aPriority - bPriority;
	});

	return columns;
}
