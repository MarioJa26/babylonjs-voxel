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
	 */
	public get3(
		localX: number,
		localY: number,
		localZ: number,
		out: Float32Array,
	): void {
		const p = this._cellScratch;
		this.cheese.getCellParams(localX, localY, localZ, p);
		out[0] = this.cheese.getFrom(p);
		out[1] = this.tunnel.getFrom(p);
		out[2] = this.detail.getFrom(p);
	}
}
