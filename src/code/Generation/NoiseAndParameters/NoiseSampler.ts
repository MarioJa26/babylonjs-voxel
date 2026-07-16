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
		let cellX: number;
		let cellY: number;
		let cellZ: number;
		let fx: number;
		let fy: number;
		let fz: number;

		const inv = this.invSampleRate;
		if (this.isPow2) {
			const shift = this.rateShift;
			const mask = this.rateMask;
			cellX = localX >> shift;
			cellY = localY >> shift;
			cellZ = localZ >> shift;
			fx = (localX & mask) * inv;
			fy = (localY & mask) * inv;
			fz = (localZ & mask) * inv;
		} else {
			const rate = this.sampleRate;
			cellX = (localX / rate) | 0;
			cellY = (localY / rate) | 0;
			cellZ = (localZ / rate) | 0;
			fx = (localX % rate) * inv;
			fy = (localY % rate) * inv;
			fz = (localZ % rate) * inv;
		}

		const idx =
			cellX +
			cellZ * this.pointsPerDim +
			cellY * this.pointsPerDim * this.pointsPerDim;

		const i000 = idx;
		const i100 = idx + 1;
		const i001 = idx + this.pointsPerDim;
		const i101 = idx + this.pointsPerDim + 1;
		const i010 = idx + this.pointsPerDim * this.pointsPerDim;
		const i110 = idx + this.pointsPerDim * this.pointsPerDim + 1;
		const i011 =
			idx + this.pointsPerDim * this.pointsPerDim + this.pointsPerDim;
		const i111 =
			idx + this.pointsPerDim * this.pointsPerDim + this.pointsPerDim + 1;

		const n000 = this.noiseSamples[i000];
		const n100 = this.noiseSamples[i100];
		const n001 = this.noiseSamples[i001];
		const n101 = this.noiseSamples[i101];
		const n010 = this.noiseSamples[i010];
		const n110 = this.noiseSamples[i110];
		const n011 = this.noiseSamples[i011];
		const n111 = this.noiseSamples[i111];

		const n00 = n000 + (n010 - n000) * fy;
		const n10 = n100 + (n110 - n100) * fy;
		const n01 = n001 + (n011 - n001) * fy;
		const n11 = n101 + (n111 - n101) * fy;

		const n0 = n00 + (n01 - n00) * fz;
		const n1 = n10 + (n11 - n10) * fz;

		return n0 + (n1 - n0) * fx;
	}
}
