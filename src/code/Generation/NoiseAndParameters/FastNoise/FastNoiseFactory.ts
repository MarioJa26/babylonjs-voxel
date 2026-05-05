import FastNoiseLite, { type FractalType } from "./FastNoiseLite";

const DEFAULT_FREQUENCY = 1.0;

export interface FastNoiseOptions {
	seed: number;
	fractalType?: FractalType;
	frequency?: number;
}

export type FastNoise2DResult = {
	fn: (x: number, z: number) => number;
	instance: FastNoiseLite;
};

export type FastNoise3DResult = {
	fn: (x: number, y: number, z: number) => number;
	instance: FastNoiseLite;
};

export function createFastNoise(
	seed: number,
	fractalType?: FractalType,
	frequency?: number,
): FastNoiseLite;
export function createFastNoise(options: FastNoiseOptions): FastNoiseLite;
export function createFastNoise(
	seedOrOptions: number | FastNoiseOptions,
	fractalType?: FractalType,
	frequency?: number,
): FastNoiseLite {
	let seed: number;
	let localFractalType: FractalType | undefined;
	let localFrequency: number | undefined;

	if (typeof seedOrOptions === "object") {
		seed = seedOrOptions.seed;
		localFractalType = seedOrOptions.fractalType;
		localFrequency = seedOrOptions.frequency;
	} else {
		seed = seedOrOptions;
		localFractalType = fractalType;
		localFrequency = frequency;
	}

	const noise = new FastNoiseLite(seed);
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
