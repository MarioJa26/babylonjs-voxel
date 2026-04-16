import FastNoiseLite, { type FractalType } from "./FastNoiseLite";

const DEFAULT_FREQUENCY = 1.0;

export interface FastNoiseOptions {
	seed: number;
	fractalType?: FractalType;
	frequency?: number;
}

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
	noise.SetFrequency(localFrequency || DEFAULT_FREQUENCY);
	if (localFractalType) {
		noise.SetFractalType(localFractalType);
	} else {
		noise.SetFractalType(FastNoiseLite.FractalType.Ridged);
	}
	return noise;
}

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
	let noise: FastNoiseLite;
	if (typeof seedOrOptions === "object") {
		noise = createFastNoise(seedOrOptions);
	} else {
		noise = createFastNoise(seedOrOptions, fractalType, frequency);
	}
	return (x: number, z: number) => noise.GetNoise(x, z);
}

export function createFastNoise3D(
	options: FastNoiseOptions,
): (x: number, y: number, z: number) => number;
export function createFastNoise3D(
	seedOrOptions: number | FastNoiseOptions,
	fractalType?: FractalType,
	frequency?: number,
): (x: number, y: number, z: number) => number {
	let noise: FastNoiseLite;
	if (typeof seedOrOptions === "object") {
		noise = createFastNoise(seedOrOptions);
	} else {
		noise = createFastNoise(seedOrOptions, fractalType, frequency);
	}
	return (x: number, y: number, z: number) => noise.GetNoise(x, y, z);
}
