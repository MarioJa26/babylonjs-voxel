import type {
	NoiseBackend,
	NoiseInstance,
} from "../Generation/NoiseAndParameters/FastNoise/FastNoiseFactory";
import type {
	FractalType,
	NoiseType,
	RotationType3D,
} from "../Generation/NoiseAndParameters/FastNoise/FastNoiseLite";

// ---------------------------------------------------------------------------
// WASM SIMD noise backend.
//
// Wraps the AssemblyScript kernels compiled to src/code/wasm/kernels.wasm
// (built by scripts/build-wasm.mjs). Implements NoiseInstance so it can be
// swapped in via setNoiseBackend() in FastNoiseFactory.
//
// I/O is intentionally kept out of this module: callers hand over the raw
// wasm bytes (node: fs.readFileSync; browser: fetch + arrayBuffer). This keeps
// the module free of node builtins so it typechecks and bundles cleanly.
// ---------------------------------------------------------------------------

export const NOISE_TYPE_OPEN_SIMPLEX_2 = 1;

export function transformTypeFor(
	noiseType: NoiseType,
	rotationType3D: RotationType3D,
): number {
	if (rotationType3D === 1) return 1; // ImproveXYPlanes
	if (rotationType3D === 2) return 2; // ImproveXZPlanes
	if (noiseType === 1 || noiseType === 2) return 3; // DefaultOpenSimplex2
	return 0;
}

export interface WasmKernelsExports {
	ensureScratch(n: number): number;
	noise_scalar_2d(
		x: number,
		y: number,
		freq: number,
		noiseType: number,
		fractalType: number,
		seed: number,
		octaves: number,
		lacunarity: number,
		gain: number,
		ws: number,
		pp: number,
	): number;
	noise_scalar_3d(
		x: number,
		y: number,
		z: number,
		freq: number,
		noiseType: number,
		fractalType: number,
		transformType: number,
		seed: number,
		octaves: number,
		lacunarity: number,
		gain: number,
		ws: number,
		pp: number,
	): number;
	noise_fill_2d(
		out: number,
		width: number,
		height: number,
		offsetX: number,
		offsetY: number,
		freq: number,
		noiseType: number,
		fractalType: number,
		seed: number,
		octaves: number,
		lacunarity: number,
		gain: number,
		ws: number,
		pp: number,
	): void;
	noise_fill_3d(
		out: number,
		width: number,
		height: number,
		depth: number,
		offsetX: number,
		offsetY: number,
		offsetZ: number,
		freq: number,
		noiseType: number,
		fractalType: number,
		transformType: number,
		seed: number,
		octaves: number,
		lacunarity: number,
		gain: number,
		ws: number,
		pp: number,
	): void;
	noise_fill_3d_affine(
		out: number,
		width: number,
		height: number,
		depth: number,
		x0: number,
		y0: number,
		z0: number,
		ax: number,
		bx: number,
		ay: number,
		az: number,
		bz: number,
		freq: number,
		noiseType: number,
		fractalType: number,
		transformType: number,
		seed: number,
		octaves: number,
		lacunarity: number,
		gain: number,
		ws: number,
		pp: number,
	): void;
	surface_density_band(
		out: number,
		count: number,
		startY: number,
		step: number,
		baseNoiseX: number,
		baseNoiseZ: number,
		overhangBaseX: number,
		overhangBaseZ: number,
		baseHeight: number,
		yFreq: number,
		cliffContribution: number,
		baseAmp: number,
		overhangAmp: number,
		influenceRange: number,
		freq: number,
		noiseType: number,
		fractalType: number,
		transformType: number,
		seed: number,
		octaves: number,
		lacunarity: number,
		gain: number,
		ws: number,
		pp: number,
	): void;
	memory: WebAssembly.Memory;
}

export interface WasmEnvImports {
	abort?: (
		message?: number,
		fileName?: number,
		line?: number,
		column?: number,
	) => void;
	[importName: string]: unknown;
}

export class WasmFastNoise implements NoiseInstance {
	private seed: number;
	private noiseType: NoiseType = 1;
	private rotationType3D: RotationType3D = 0;
	// PERF: Derived from noiseType + rotationType3D; recomputed only when either
	// changes (setup time) instead of on every 3D sample/fill call, where it's
	// invariant 99.9% of the time.
	private transformType: number = transformTypeFor(1, 0);
	private frequency = 1.0;
	private fractalType: FractalType = 2; // Ridged (matches factory default)
	private octaves = 3;
	private lacunarity = 2.0;
	private gain = 0.5;
	private weightedStrength = 0.0;
	private pingPongStrength = 2.0;

	// Cached full-memory view used to read batch results without allocating a
	// per-call Float32Array (hot: surface_density_band is called once per
	// column, 256x per chunk). Re-created if the wasm memory grows.
	private memF32: Float32Array | null = null;
	private memByteLength = 0;

	constructor(
		private kernels: WasmKernelsExports,
		seed: number,
	) {
		this.seed = seed;
	}

	private readBatch(ptr: number, out: Float32Array): void {
		const mem = this.kernels.memory;
		if (this.memF32 === null || this.memByteLength !== mem.buffer.byteLength) {
			this.memF32 = new Float32Array(mem.buffer);
			this.memByteLength = mem.buffer.byteLength;
		}
		out.set(this.memF32.subarray(ptr >> 2, (ptr >> 2) + out.length));
	}

	GetNoise2D(x: number, y: number): number {
		return this.kernels.noise_scalar_2d(
			x,
			y,
			this.frequency,
			this.noiseType,
			this.fractalType,
			this.seed,
			this.octaves,
			this.lacunarity,
			this.gain,
			this.weightedStrength,
			this.pingPongStrength,
		);
	}

	GetNoise3D(x: number, y: number, z: number): number {
		return this.kernels.noise_scalar_3d(
			x,
			y,
			z,
			this.frequency,
			this.noiseType,
			this.fractalType,
			this.transformType,
			this.seed,
			this.octaves,
			this.lacunarity,
			this.gain,
			this.weightedStrength,
			this.pingPongStrength,
		);
	}

	FillNoise2D(
		out: Float32Array,
		width: number,
		height: number,
		offsetX = 0,
		offsetY = 0,
	): void {
		const count = width * height;
		const ptr = this.kernels.ensureScratch(count * 4);
		this.kernels.noise_fill_2d(
			ptr,
			width,
			height,
			offsetX,
			offsetY,
			this.frequency,
			this.noiseType,
			this.fractalType,
			this.seed,
			this.octaves,
			this.lacunarity,
			this.gain,
			this.weightedStrength,
			this.pingPongStrength,
		);
		this.readBatch(ptr, out);
	}

	FillNoise3D(
		out: Float32Array,
		width: number,
		height: number,
		depth: number,
		offsetX = 0,
		offsetY = 0,
		offsetZ = 0,
	): void {
		const count = width * height * depth;
		const ptr = this.kernels.ensureScratch(count * 4);
		this.kernels.noise_fill_3d(
			ptr,
			width,
			height,
			depth,
			offsetX,
			offsetY,
			offsetZ,
			this.frequency,
			this.noiseType,
			this.fractalType,
			this.transformType,
			this.seed,
			this.octaves,
			this.lacunarity,
			this.gain,
			this.weightedStrength,
			this.pingPongStrength,
		);
		this.readBatch(ptr, out);
	}

	FillNoise3DAffine(
		out: Float32Array,
		width: number,
		height: number,
		depth: number,
		x0: number,
		y0: number,
		z0: number,
		ax: number,
		bx: number,
		ay: number,
		az: number,
		bz: number,
	): void {
		const count = width * height * depth;
		const ptr = this.kernels.ensureScratch(count * 4);
		this.kernels.noise_fill_3d_affine(
			ptr,
			width,
			height,
			depth,
			x0,
			y0,
			z0,
			ax,
			bx,
			ay,
			az,
			bz,
			this.frequency,
			this.noiseType,
			this.fractalType,
			this.transformType,
			this.seed,
			this.octaves,
			this.lacunarity,
			this.gain,
			this.weightedStrength,
			this.pingPongStrength,
		);
		this.readBatch(ptr, out);
	}

	SurfaceDensity(
		out: Float32Array,
		count: number,
		startY: number,
		step: number,
		baseNoiseX: number,
		baseNoiseZ: number,
		overhangBaseX: number,
		overhangBaseZ: number,
		baseHeight: number,
		yFreq: number,
		cliffContribution: number,
		baseAmp: number,
		overhangAmp: number,
		influenceRange: number,
	): void {
		const ptr = this.kernels.ensureScratch(count * 4);
		this.kernels.surface_density_band(
			ptr,
			count,
			startY,
			step,
			baseNoiseX,
			baseNoiseZ,
			overhangBaseX,
			overhangBaseZ,
			baseHeight,
			yFreq,
			cliffContribution,
			baseAmp,
			overhangAmp,
			influenceRange,
			this.frequency,
			this.noiseType,
			this.fractalType,
			this.transformType,
			this.seed,
			this.octaves,
			this.lacunarity,
			this.gain,
			this.weightedStrength,
			this.pingPongStrength,
		);
		this.readBatch(ptr, out);
	}

	SetSeed(seed: number): void {
		this.seed = seed;
	}

	SetFrequency(frequency: number): void {
		this.frequency = frequency;
	}

	SetNoiseType(noiseType: NoiseType): void {
		this.noiseType = noiseType;
		this.transformType = transformTypeFor(noiseType, this.rotationType3D);
	}

	SetRotationType3D(rotationType3D: RotationType3D): void {
		this.rotationType3D = rotationType3D;
		this.transformType = transformTypeFor(this.noiseType, rotationType3D);
	}

	SetFractalType(fractalType: FractalType): void {
		this.fractalType = fractalType;
	}

	SetFractalOctaves(octaves: number): void {
		this.octaves = octaves;
	}

	SetFractalLacunarity(lacunarity: number): void {
		this.lacunarity = lacunarity;
	}

	SetFractalGain(gain: number): void {
		this.gain = gain;
	}

	SetFractalWeightedStrength(weightedStrength: number): void {
		this.weightedStrength = weightedStrength;
	}

	SetFractalPingPongStrength(pingPongStrength: number): void {
		this.pingPongStrength = pingPongStrength;
	}
}

/**
 * Instantiates the kernels.wasm bytes and returns a NoiseBackend whose
 * instances are WasmFastNoise wrappers.
 */
export function createWasmNoiseBackend(bytes: Uint8Array): NoiseBackend {
	const ab = (bytes.buffer as ArrayBuffer).slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	);
	const module = new WebAssembly.Module(ab);
	const instance = new WebAssembly.Instance(module, {
		env: {
			abort: (
				message?: number,
				fileName?: number,
				line?: number,
				column?: number,
			) => {
				throw new Error(
					`wasm abort: msg=${message} file=${fileName} line=${line} col=${column}`,
				);
			},
		},
	});
	const kernels = instance.exports as unknown as WasmKernelsExports;
	return {
		create(seed: number): NoiseInstance {
			return new WasmFastNoise(kernels, seed);
		},
	};
}
