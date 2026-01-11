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
    if (this.points.length === 0) return 0;

    // Handle out of bounds (clamp)
    if (t <= this.points[0].t) {
      return this.points[0].v;
    }
    if (t >= this.points[this.points.length - 1].t) {
      return this.points[this.points.length - 1].v;
    }

    // Find the segment t belongs to
    for (let i = 0; i < this.points.length - 1; i++) {
      const p1 = this.points[i];
      const p2 = this.points[i + 1];

      if (t >= p1.t && t <= p2.t) {
        const range = p2.t - p1.t;
        if (range === 0) return p1.v;
        const progress = (t - p1.t) / range;
        return p1.v + (p2.v - p1.v) * progress;
      }
    }

    return this.points[this.points.length - 1].v;
  }
}
