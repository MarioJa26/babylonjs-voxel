export interface SplinePoint {
	t: number;
	v: number;
}

export class Spline {
	private points: SplinePoint[];

	constructor(points: SplinePoint[]) {
		// Ensure points are sorted by t
		this.points = points.sort((a, b) => a.t - b.t);
	}

	public getValue(t: number): number {
		const pts = this.points;
		const len = pts.length;
		if (len === 0) return 0;

		// Handle out of bounds (clamp)
		if (t <= pts[0].t) {
			return pts[0].v;
		}
		if (t >= pts[len - 1].t) {
			return pts[len - 1].v;
		}

		// Binary search for the segment containing t
		let lo = 0;
		let hi = len - 2;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const p1 = pts[mid];
			const p2 = pts[mid + 1];
			if (t < p1.t) {
				hi = mid - 1;
			} else if (t > p2.t) {
				lo = mid + 1;
			} else {
				const range = p2.t - p1.t;
				if (range === 0) return p1.v;
				const progress = (t - p1.t) / range;
				return p1.v + (p2.v - p1.v) * progress;
			}
		}

		return pts[len - 1].v;
	}
}
