import type { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";

export const CAVE_FLAG_CARVED = 1;
export const CAVE_FLAG_TUNNEL_CORE = 1 << 1;
export const NO_SURFACE_Y = -32768;

const SURFACE_ENTRY_DEPTH = 24;
const SURFACE_CHEESE_RAMP = 40;
const SURFACE_CHEESE_START = 8;
const SURFACE_THRESHOLD_BIAS = 0.12;
const SURFACE_TUNNEL_BOOST = 0.18;
const SURFACE_BREAKOUT_ABOVE = 6;
const SURFACE_TUNNEL_CORE_DEPTH = 8;
const CONNECTIVITY_MARGIN = 0.06;

export type CaveCarveEvaluation = {
	shouldCarve: boolean;
	carveStrength: number;
	tunnelCore: boolean;
	depthBelowSurface: number;
};

/**
 * PERF: Pre-allocated scratch object reused across all evaluateCaveCarve calls.
 * Eliminates ~32K object allocations per chunk during cave generation.
 * Callers must read all fields before the next call.
 */
export const caveCarveScratch: CaveCarveEvaluation = {
	shouldCarve: false,
	carveStrength: 0,
	tunnelCore: false,
	depthBelowSurface: 0,
};

export function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function getDepthBelowSurface(surfaceY: number, worldY: number): number {
	return surfaceY === NO_SURFACE_Y
		? Number.POSITIVE_INFINITY
		: surfaceY - worldY;
}

export function getSurfaceCarveBlend(depthBelowSurface: number): number {
	if (depthBelowSurface === Number.POSITIVE_INFINITY) return 1;
	return clamp01(
		(depthBelowSurface + SURFACE_BREAKOUT_ABOVE) / SURFACE_BREAKOUT_ABOVE,
	);
}

function rejectNearSurface(
	out: CaveCarveEvaluation,
	depthBelowSurface: number,
): CaveCarveEvaluation {
	out.shouldCarve = false;
	out.carveStrength = 0;
	out.tunnelCore = false;
	out.depthBelowSurface = depthBelowSurface;
	return out;
}

export function evaluateCaveCarve(
	params: GenerationParamsType,
	worldY: number,
	surfaceY: number,
	cheese: number,
	tunnel: number,
	detail: number,
	out?: CaveCarveEvaluation,
	precomputedCaveDensity?: number,
): CaveCarveEvaluation {
	const o = out ?? caveCarveScratch;
	const depthBelowSurface = getDepthBelowSurface(surfaceY, worldY);
	const depthFinite = depthBelowSurface !== Number.POSITIVE_INFINITY;

	if (depthFinite) {
		const underwater = surfaceY < params.SEA_LEVEL;
		if (underwater) {
			if (depthBelowSurface < SURFACE_TUNNEL_CORE_DEPTH) {
				return rejectNearSurface(o, depthBelowSurface);
			}
		} else if (depthBelowSurface < -SURFACE_BREAKOUT_ABOVE) {
			return rejectNearSurface(o, depthBelowSurface);
		}
	}

	// fullDepthDenom/depthT/caveDensity depend only on params + worldY, so
	// callers that loop over a layer hoist them and pass caveDensity in.
	let caveDensity: number;
	if (precomputedCaveDensity !== undefined) {
		caveDensity = precomputedCaveDensity;
	} else {
		const fullDepthDenom = Math.max(
			1,
			params.CAVE_SURFACE_BLEND_UPPER - params.CAVE_FULL_DENSITY_DEPTH,
		);
		const depthT = clamp01(
			(worldY - params.CAVE_FULL_DENSITY_DEPTH) / fullDepthDenom,
		);
		caveDensity =
			params.CAVE_DENSITY_MIN * (1 - depthT) + params.CAVE_DENSITY_MAX * depthT;
	}

	const surfaceDepthT = depthFinite
		? clamp01(depthBelowSurface / SURFACE_ENTRY_DEPTH)
		: 1;
	const cheeseDepthT = depthFinite
		? clamp01((depthBelowSurface - SURFACE_CHEESE_START) / SURFACE_CHEESE_RAMP)
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

	const connectedTunnelStrength = tunnelDelta + Math.max(0, cheeseDelta) * 0.25;
	const chamberStrength = cheeseDelta * (0.15 + cheeseDepthT * 0.4);
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

	const nearSurfaceBreakout =
		depthFinite && depthBelowSurface < SURFACE_TUNNEL_CORE_DEPTH;
	const shouldCarve = carveStrength > 0 && (!nearSurfaceBreakout || tunnelCore);

	o.shouldCarve = shouldCarve;
	o.carveStrength = shouldCarve ? carveStrength : 0;
	o.tunnelCore = tunnelCore;
	o.depthBelowSurface = depthBelowSurface;
	return o;
}
