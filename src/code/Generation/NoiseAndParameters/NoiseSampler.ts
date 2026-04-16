import type { createNoise3D } from "simplex-noise";

export class NoiseSampler {
	private noiseSamples: Float32Array;
	private sampleRate: number;
	private pointsPerDim: number;

	constructor(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		chunkSize: number,
		sampleRate: number,
		scale: number,
		xzFactor: number,
		noiseFunction: ReturnType<typeof createNoise3D>,
	) {
		this.sampleRate = sampleRate;
		const sampleCount = chunkSize / sampleRate;
		this.pointsPerDim = sampleCount + 1;
		this.noiseSamples = new Float32Array(this.pointsPerDim ** 3);

		const chunkWorldX = chunkX * chunkSize;
		const chunkWorldY = chunkY * chunkSize;
		const chunkWorldZ = chunkZ * chunkSize;

		// Generate noise samples at grid points
		for (let y = 0; y < this.pointsPerDim; y++) {
			const wy = chunkWorldY + y * sampleRate;
			for (let z = 0; z < this.pointsPerDim; z++) {
				const wz = chunkWorldZ + z * sampleRate;
				for (let x = 0; x < this.pointsPerDim; x++) {
					const wx = chunkWorldX + x * sampleRate;
					const val = noiseFunction(
						wx * scale * xzFactor,
						wy * scale,
						wz * scale * xzFactor,
					);
					this.noiseSamples[
						x +
							z * this.pointsPerDim +
							y * this.pointsPerDim * this.pointsPerDim
					] = val;
				}
			}
		}
	}

	public get(localX: number, localY: number, localZ: number): number {
		const cellX = (localX / this.sampleRate) | 0;
		const cellY = (localY / this.sampleRate) | 0;
		const cellZ = (localZ / this.sampleRate) | 0;

		const fx = (localX % this.sampleRate) / this.sampleRate;
		const fy = (localY % this.sampleRate) / this.sampleRate;
		const fz = (localZ % this.sampleRate) / this.sampleRate;

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
