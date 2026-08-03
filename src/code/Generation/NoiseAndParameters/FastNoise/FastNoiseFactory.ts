import FastNoiseLite, {
	type FractalType,
	type NoiseType,
	type RotationType3D,
} from "./FastNoiseLite";

const DEFAULT_FREQUENCY = 1.0;

export interface FastNoiseOptions {
	seed: number;
	fractalType?: FractalType;
	frequency?: number;
}

// ---------------------------------------------------------------------------
// Noise backend abstraction
//
// Every noise instance is created through the active backend. The default is
// the vendored JS FastNoiseLite; the wasm SIMD backend (WasmFastNoise) is
// swapped in via setNoiseBackend() once the wasm module is loaded. Because
// WorldGenerator and TerrainHeightMap/RiverGeneration create all their noise
// through this factory, one switch re-routes the entire generation pipeline
// (including the module-level terrain noise rebuilt by setTerrainSeed).
// ---------------------------------------------------------------------------
export interface NoiseInstance {
	GetNoise2D(x: number, y: number): number;
	GetNoise3D(x: number, y: number, z: number): number;
	FillNoise2D(
		out: Float32Array,
		width: number,
		height: number,
		offsetX?: number,
		offsetY?: number,
	): void;
	FillNoise3D(
		out: Float32Array,
		width: number,
		height: number,
		depth: number,
		offsetX?: number,
		offsetY?: number,
		offsetZ?: number,
	): void;
	/** Affine-deformed 3D batch fill: x'=x0+col*ax+row*bx, y'=y0+row*ay, z'=z0+slice*az+row*bz. */
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
	): void;
	/**
	 * Batch-evaluates the terrain-surface density formula for `count` world-Y
	 * samples starting at `startY` with stride `step` (may be negative):
	 *   rel = baseHeight - y
	 *   d = rel + base(baseNoiseX, y*yFreq, baseNoiseZ)*baseAmp
	 *         + overhang(overhangBaseX + y*0.0044, y*0.012, overhangBaseZ - y*0.0036)*overhangAmp
	 *         + cliffContribution
	 * Samples with |rel| > influenceRange return rel (no noise) — identical to
	 * the SurfaceGenerator getDensity fast path.
	 */
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
	): void;
	SetSeed(seed: number): void;
	SetFrequency(frequency: number): void;
	SetNoiseType(noiseType: NoiseType): void;
	SetRotationType3D(rotationType3D: RotationType3D): void;
	SetFractalType(fractalType: FractalType): void;
	SetFractalOctaves(octaves: number): void;
	SetFractalLacunarity(lacunarity: number): void;
	SetFractalGain(gain: number): void;
	SetFractalWeightedStrength(weightedStrength: number): void;
	SetFractalPingPongStrength(pingPongStrength: number): void;
}

export interface NoiseBackend {
	create(seed: number): NoiseInstance;
}

const jsBackend: NoiseBackend = {
	create(seed: number): NoiseInstance {
		return new FastNoiseLite(seed);
	},
};

let activeBackend: NoiseBackend = jsBackend;

export function setNoiseBackend(backend: NoiseBackend): void {
	activeBackend = backend;
}

export function getNoiseBackend(): NoiseBackend {
	return activeBackend;
}

function resolveSeed(seedOrOptions: number | FastNoiseOptions): number {
	return typeof seedOrOptions === "object" ? seedOrOptions.seed : seedOrOptions;
}

export type FastNoise2DResult = {
	fn: (x: number, z: number) => number;
	instance: NoiseInstance;
};

export type FastNoise3DResult = {
	fn: (x: number, y: number, z: number) => number;
	instance: NoiseInstance;
};

export function createFastNoise(
	seed: number,
	fractalType?: FractalType,
	frequency?: number,
): NoiseInstance;
export function createFastNoise(options: FastNoiseOptions): NoiseInstance;
export function createFastNoise(
	seedOrOptions: number | FastNoiseOptions,
	fractalType?: FractalType,
	frequency?: number,
): NoiseInstance {
	let localFractalType: FractalType | undefined;
	let localFrequency: number | undefined;

	if (typeof seedOrOptions === "object") {
		localFractalType = seedOrOptions.fractalType;
		localFrequency = seedOrOptions.frequency;
	} else {
		localFractalType = fractalType;
		localFrequency = frequency;
	}

	const noise = activeBackend.create(resolveSeed(seedOrOptions));
	noise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
	noise.SetFrequency(localFrequency ?? DEFAULT_FREQUENCY);
	if (localFractalType) {
		noise.SetFractalType(localFractalType);
	} else {
		noise.SetFractalType(FastNoiseLite.FractalType.Ridged);
	}
	return noise;
}

// ─── Legacy scalar wrappers (unchanged API) ──────────────────────────────────

export function createFastNoise2D(
	seed: number,
	fractalType?: FractalType,
	frequency?: number,
): (x: number, z: number) => number;
export function createFastNoise2D(
	options: FastNoiseOptions,
): (x: number, z: number) => number;
export function createFastNoise2D(
	seedOrOptions: number | FastNoiseOptions,
	fractalType?: FractalType,
	frequency?: number,
): (x: number, z: number) => number {
	const noise =
		typeof seedOrOptions === "object"
			? createFastNoise(seedOrOptions)
			: createFastNoise(seedOrOptions, fractalType, frequency);
	return (x: number, z: number) => noise.GetNoise2D(x, z);
}

export function createFastNoise3D(
	options: FastNoiseOptions,
): (x: number, y: number, z: number) => number;
export function createFastNoise3D(
	seed: number,
	fractalType?: FractalType,
	frequency?: number,
): (x: number, y: number, z: number) => number;
export function createFastNoise3D(
	seedOrOptions: number | FastNoiseOptions,
	fractalType?: FractalType,
	frequency?: number,
): (x: number, y: number, z: number) => number {
	const noise =
		typeof seedOrOptions === "object"
			? createFastNoise(seedOrOptions)
			: createFastNoise(seedOrOptions, fractalType, frequency);
	return (x: number, y: number, z: number) => noise.GetNoise3D(x, y, z);
}

// ─── New "with instance" variants — expose the FNL object for batch fills ────

/**
 * Like createFastNoise2D but also returns the underlying FastNoiseLite
 * instance so callers can use FillNoise2D for batch generation.
 */
export function createFastNoise2DWithInstance(
	seedOrOptions: number | FastNoiseOptions,
	fractalType?: FractalType,
	frequency?: number,
): FastNoise2DResult {
	const instance =
		typeof seedOrOptions === "object"
			? createFastNoise(seedOrOptions)
			: createFastNoise(seedOrOptions, fractalType, frequency);
	return {
		fn: (x: number, z: number) => instance.GetNoise2D(x, z),
		instance,
	};
}

/**
 * Like createFastNoise3D but also returns the underlying FastNoiseLite
 * instance so callers can use FillNoise3D for batch generation.
 */
export function createFastNoise3DWithInstance(
	seedOrOptions: number | FastNoiseOptions,
	fractalType?: FractalType,
	frequency?: number,
): FastNoise3DResult {
	const instance =
		typeof seedOrOptions === "object"
			? createFastNoise(seedOrOptions)
			: createFastNoise(seedOrOptions, fractalType, frequency);
	return {
		fn: (x: number, y: number, z: number) => instance.GetNoise3D(x, y, z),
		instance,
	};
}
