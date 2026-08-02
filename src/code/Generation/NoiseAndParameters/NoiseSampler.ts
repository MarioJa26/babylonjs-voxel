export type NoiseCellParams = {
	cellX: number;
	cellY: number;
	cellZ: number;
	fx: number;
	fy: number;
	fz: number;
};

// Module-level scratch: params are fully consumed within each get()/getFrom()
// call, so sharing across instances and callers is safe.
const _cellScratch: NoiseCellParams = {
	cellX: 0,
	cellY: 0,
	cellZ: 0,
	fx: 0,
	fy: 0,
	fz: 0,
};

export class NoiseSampler {
	private noiseSamples: Float32Array;
	private sampleRate: number;
	private pointsPerDim: number;
	private noiseFunction: (x: number, y: number, z: number) => number;
	private scale: number;
	private xzFactor: number;

	// PERF (#3): When sampleRate is a power of two (the common case, 4), the
	// hot per-voxel get() can replace `/` and `%` with a shift and a mask.
	private readonly isPow2: boolean;
	private readonly rateShift: number;
	private readonly rateMask: number;
	private readonly invSampleRate: number;
	private readonly pointsPerDimSq: number;

	constructor(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		chunkSize: number,
		sampleRate: number,
		scale: number,
		xzFactor: number,
		noiseFunction: (x: number, y: number, z: number) => number,
	) {
		this.sampleRate = sampleRate;
		this.noiseFunction = noiseFunction;
		this.scale = scale;
		this.xzFactor = xzFactor;
		this.isPow2 = sampleRate > 0 && (sampleRate & (sampleRate - 1)) === 0;
		this.rateShift = Math.log2(sampleRate) | 0;
		this.rateMask = sampleRate - 1;
		this.invSampleRate = 1 / sampleRate;
		const sampleCount = chunkSize / sampleRate;
		this.pointsPerDim = sampleCount + 1;
		this.pointsPerDimSq = this.pointsPerDim * this.pointsPerDim;
		this.noiseSamples = new Float32Array(this.pointsPerDim ** 3);

		this.sampleNoise(chunkX, chunkY, chunkZ, chunkSize);
	}

	public reset(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		chunkSize: number,
	): void {
		this.sampleNoise(chunkX, chunkY, chunkZ, chunkSize);
	}

	private sampleNoise(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		chunkSize: number,
	): void {
		const sampleRate = this.sampleRate;
		const pointsPerDim = this.pointsPerDim;
		const noiseSamples = this.noiseSamples;
		const noiseFunction = this.noiseFunction;
		const scale = this.scale;
		const xzFactor = this.xzFactor;

		const chunkWorldX = chunkX * chunkSize;
		const chunkWorldY = chunkY * chunkSize;
		const chunkWorldZ = chunkZ * chunkSize;

		// Generate noise samples at grid points
		for (let y = 0; y < pointsPerDim; y++) {
			const wy = chunkWorldY + y * sampleRate;
			for (let z = 0; z < pointsPerDim; z++) {
				const wz = chunkWorldZ + z * sampleRate;
				for (let x = 0; x < pointsPerDim; x++) {
					const wx = chunkWorldX + x * sampleRate;
					const val = noiseFunction(
						wx * scale * xzFactor,
						wy * scale,
						wz * scale * xzFactor,
					);
					noiseSamples[x + z * pointsPerDim + y * pointsPerDim * pointsPerDim] =
						val;
				}
			}
		}
	}

	public get(localX: number, localY: number, localZ: number): number {
		this.getCellParams(localX, localY, localZ, _cellScratch);
		return this.getFrom(_cellScratch);
	}

	public getCellParams(
		localX: number,
		localY: number,
		localZ: number,
		out: NoiseCellParams,
	): void {
		const inv = this.invSampleRate;
		if (this.isPow2) {
			const shift = this.rateShift;
			const mask = this.rateMask;
			out.cellX = localX >> shift;
			out.cellY = localY >> shift;
			out.cellZ = localZ >> shift;
			out.fx = (localX & mask) * inv;
			out.fy = (localY & mask) * inv;
			out.fz = (localZ & mask) * inv;
		} else {
			const rate = this.sampleRate;
			out.cellX = (localX / rate) | 0;
			out.cellY = (localY / rate) | 0;
			out.cellZ = (localZ / rate) | 0;
			out.fx = (localX % rate) * inv;
			out.fy = (localY % rate) * inv;
			out.fz = (localZ % rate) * inv;
		}
	}

	/** Trilinear sample at precomputed cell/fraction params (see getCellParams). */
	public getFrom(p: NoiseCellParams): number {
		const ppd = this.pointsPerDim;
		const ppd2 = this.pointsPerDimSq;
		const idx = p.cellX + p.cellZ * ppd + p.cellY * ppd2;

		const i000 = idx;
		const i100 = idx + 1;
		const i001 = idx + ppd;
		const i101 = idx + ppd + 1;
		const i010 = idx + ppd2;
		const i110 = idx + ppd2 + 1;
		const i011 = idx + ppd2 + ppd;
		const i111 = idx + ppd2 + ppd + 1;

		const s = this.noiseSamples;
		const n000 = s[i000];
		const n100 = s[i100];
		const n001 = s[i001];
		const n101 = s[i101];
		const n010 = s[i010];
		const n110 = s[i110];
		const n011 = s[i011];
		const n111 = s[i111];

		const fy = p.fy;
		const fz = p.fz;
		const n00 = n000 + (n010 - n000) * fy;
		const n10 = n100 + (n110 - n100) * fy;
		const n01 = n001 + (n011 - n001) * fy;
		const n11 = n101 + (n111 - n101) * fy;

		const n0 = n00 + (n01 - n00) * fz;
		const n1 = n10 + (n11 - n10) * fz;

		return n0 + (n1 - n0) * p.fx;
	}
}
