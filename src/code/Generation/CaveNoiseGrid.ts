import type { NoiseInstance } from "./NoiseAndParameters/FastNoise/FastNoiseFactory";
import {
	type NoiseCellParams,
	NoiseSampler,
} from "./NoiseAndParameters/NoiseSampler";

/**
 * Pre-samples 3 cave noise functions at a coarse grid (default sampleRate=4)
 * and provides trilinear interpolation for fast per-voxel lookups.
 *
 * Reduces simplex evaluations from ~295K to ~2K per chunk while maintaining
 * visual quality through trilinear interpolation.
 */
export class CaveNoiseGrid {
	private readonly cheese: NoiseSampler;
	private readonly tunnel: NoiseSampler;
	private readonly detail: NoiseSampler;
	private readonly _cellScratch: NoiseCellParams = {
		cellX: 0,
		cellY: 0,
		cellZ: 0,
		fx: 0,
		fy: 0,
		fz: 0,
	};

	constructor(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		chunkSize: number,
		sampleRate: number,
		cheeseFn: (x: number, y: number, z: number) => number,
		tunnelFn: (x: number, y: number, z: number) => number,
		detailFn: (x: number, y: number, z: number) => number,
		cheeseInstance?: NoiseInstance,
		tunnelInstance?: NoiseInstance,
		detailInstance?: NoiseInstance,
	) {
		// scale=1, xzFactor=1 → raw world coordinates, no internal rescaling.
		const s = 1;
		const xz = 1;
		this.cheese = new NoiseSampler(
			chunkX,
			chunkY,
			chunkZ,
			chunkSize,
			sampleRate,
			s,
			xz,
			cheeseFn,
			cheeseInstance,
		);
		this.tunnel = new NoiseSampler(
			chunkX,
			chunkY,
			chunkZ,
			chunkSize,
			sampleRate,
			s,
			xz,
			tunnelFn,
			tunnelInstance,
		);
		this.detail = new NoiseSampler(
			chunkX,
			chunkY,
			chunkZ,
			chunkSize,
			sampleRate,
			s,
			xz,
			detailFn,
			detailInstance,
		);
	}

	public reset(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		chunkSize: number,
	): void {
		this.cheese.reset(chunkX, chunkY, chunkZ, chunkSize);
		this.tunnel.reset(chunkX, chunkY, chunkZ, chunkSize);
		this.detail.reset(chunkX, chunkY, chunkZ, chunkSize);
	}

	public getCheese(localX: number, localY: number, localZ: number): number {
		return this.cheese.get(localX, localY, localZ);
	}

	public getTunnel(localX: number, localY: number, localZ: number): number {
		return this.tunnel.get(localX, localY, localZ);
	}

	public getDetail(localX: number, localY: number, localZ: number): number {
		return this.detail.get(localX, localY, localZ);
	}

	/**
	 * PERF: Samples all three cave noises for one voxel while computing the
	 * trilinear cell/fraction math only once (the three samplers share the
	 * same sampleRate, so cell/fraction params are identical for all three).
	 * Result is written into `out` ([cheese, tunnel, detail]).
	 *
	 * The three samplers are built with identical chunkSize/sampleRate/scale, so
	 * they also share `pointsPerDim`, `pointsPerDimSq` and therefore the flat
	 * sample index and all eight corner offsets. Deriving them once and reusing
	 * them across the three interpolations removes 2 of every 3 index
	 * derivations (2 multiplies + 11 adds + property loads) from the hottest
	 * per-voxel path in chunk generation.
	 */
	public get3(
		localX: number,
		localY: number,
		localZ: number,
		out: Float32Array,
	): void {
		const cheese = this.cheese;
		const tunnel = this.tunnel;
		const detail = this.detail;

		const p = this._cellScratch;
		const idx = cheese.getCellParamsAndIndex(localX, localY, localZ, p);
		const fx = p.fx;
		const fy = p.fy;
		const fz = p.fz;
		const ppd = cheese.pointsPerDim;
		const ppd2 = cheese.pointsPerDimSq;

		out[0] = NoiseSampler.trilinear(
			cheese.noiseSamples,
			idx,
			ppd,
			ppd2,
			fx,
			fy,
			fz,
		);
		out[1] = NoiseSampler.trilinear(
			tunnel.noiseSamples,
			idx,
			ppd,
			ppd2,
			fx,
			fy,
			fz,
		);
		out[2] = NoiseSampler.trilinear(
			detail.noiseSamples,
			idx,
			ppd,
			ppd2,
			fx,
			fy,
			fz,
		);
	}
}
