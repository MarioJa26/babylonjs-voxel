export interface SplinePoint {
	t: number;
	v: number;
}

export class Spline {
	private points: SplinePoint[];
	private tMin: number;
	private tMax: number;
	private lut: Float32Array;
	private static readonly LUT_SIZE = 2048;

	constructor(points: SplinePoint[]) {
		// Ensure points are sorted by t
		this.points = points.sort((a, b) => a.t - b.t);
		const len = this.points.length;
		this.tMin = len > 0 ? this.points[0].t : 0;
		this.tMax = len > 0 ? this.points[len - 1].t : 0;
		this.lut = new Float32Array(Spline.LUT_SIZE);
		if (len > 0) {
			const range = this.tMax - this.tMin || 1;
			for (let i = 0; i < Spline.LUT_SIZE; i++) {
				const t = this.tMin + (i / (Spline.LUT_SIZE - 1)) * range;
				this.lut[i] = this.evaluate(t);
			}
		}
	}

	private evaluate(t: number): number {
		const pts = this.points;
		const len = pts.length;
		if (len === 0) return 0;
		if (t <= pts[0].t) return pts[0].v;
		if (t >= pts[len - 1].t) return pts[len - 1].v;

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

	public getValue(t: number): number {
		const len = this.points.length;
		if (len === 0) return 0;
		if (t <= this.tMin) return this.lut[0];
		if (t >= this.tMax) return this.lut[Spline.LUT_SIZE - 1];

		const f =
			((t - this.tMin) / (this.tMax - this.tMin)) * (Spline.LUT_SIZE - 1);
		const i = f | 0;
		const frac = f - i;
		const a = this.lut[i];
		const b = this.lut[i + 1];
		return a + (b - a) * frac;
	}
}
