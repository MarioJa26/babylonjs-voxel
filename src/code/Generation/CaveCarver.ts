import type { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";

export const CAVE_FLAG_CARVED = 1;
export const CAVE_FLAG_TUNNEL_CORE = 1 << 1;
export const NO_SURFACE_Y = -32768;

const SURFACE_ENTRY_DEPTH = 24;
const SURFACE_CHEESE_RAMP = 40;
const SURFACE_THRESHOLD_BIAS = 0.38;
const SURFACE_TUNNEL_BOOST = 0.18;
const CONNECTIVITY_MARGIN = 0.06;

export type CaveCarveEvaluation = {
	shouldCarve: boolean;
	carveStrength: number;
	tunnelCore: boolean;
	depthBelowSurface: number;
};

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function getDepthBelowSurface(surfaceY: number, worldY: number): number {
	return surfaceY === NO_SURFACE_Y
		? Number.POSITIVE_INFINITY
		: surfaceY - worldY;
}

export function getSurfaceCarveBlend(depthBelowSurface: number): number {
	if (!Number.isFinite(depthBelowSurface)) return 1;
	return clamp01((depthBelowSurface + 3) / 18);
}

export function evaluateCaveCarve(
	params: GenerationParamsType,
	worldY: number,
	surfaceY: number,
	cheese: number,
	tunnel: number,
	detail: number,
): CaveCarveEvaluation {
	const depthBelowSurface = getDepthBelowSurface(surfaceY, worldY);
	if (Number.isFinite(depthBelowSurface) && depthBelowSurface < 0) {
		return {
			shouldCarve: false,
			carveStrength: 0,
			tunnelCore: false,
			depthBelowSurface,
		};
	}

	const fullDepthDenom = Math.max(
		1,
		params.CAVE_SURFACE_BLEND_UPPER - params.CAVE_FULL_DENSITY_DEPTH,
	);
	const depthT = clamp01(
		(worldY - params.CAVE_FULL_DENSITY_DEPTH) / fullDepthDenom,
	);
	const caveDensity =
		params.CAVE_DENSITY_MIN * (1 - depthT) + params.CAVE_DENSITY_MAX * depthT;

	const surfaceDepthT = Number.isFinite(depthBelowSurface)
		? clamp01(depthBelowSurface / SURFACE_ENTRY_DEPTH)
		: 1;
	const cheeseDepthT = Number.isFinite(depthBelowSurface)
		? clamp01((depthBelowSurface - 4) / SURFACE_CHEESE_RAMP)
		: 1;
	const thresholdBias =
		(1 - surfaceDepthT) * SURFACE_THRESHOLD_BIAS + (1 - caveDensity) * 0.18;

	const detailOffset = detail * params.CAVE_DETAIL_AMPLITUDE;
	const tunnelThreshold =
		params.CAVE_TUNNEL_THRESHOLD +
		thresholdBias +
		detailOffset -
		(1 - surfaceDepthT) * SURFACE_TUNNEL_BOOST;
	const cheeseThreshold =
		params.CAVE_CHEESE_THRESHOLD + thresholdBias + detailOffset;

	const tunnelDelta = tunnel - tunnelThreshold;
	const cheeseDelta = cheese - cheeseThreshold;

	const connectedTunnelStrength = tunnelDelta + Math.max(0, cheeseDelta) * 0.45;
	const chamberStrength = cheeseDelta * (0.15 + cheeseDepthT * 0.85);
	const bridgeStrength =
		Math.min(
			tunnelDelta + CONNECTIVITY_MARGIN,
			cheeseDelta + CONNECTIVITY_MARGIN * 0.5,
		) * 0.7;
	const carveStrength = Math.max(
		connectedTunnelStrength,
		chamberStrength,
		bridgeStrength,
	);
	const tunnelCore =
		connectedTunnelStrength > -0.015 ||
		(tunnelDelta > -0.05 && cheeseDelta > 0.02);

	return {
		shouldCarve: carveStrength > 0,
		carveStrength: carveStrength > 0 ? carveStrength : 0,
		tunnelCore,
		depthBelowSurface,
	};
}
