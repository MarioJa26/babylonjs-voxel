// MeshPipeline/core/LightPipeline.ts

import { MeshContext } from "../types/MeshTypes";

/**
 * Quantize a single nibble (used for LOD lighting).
 */
export function quantizeNibble(v: number): number {
  if (v >= 12) return 15;
  if (v >= 8) return 11;
  if (v >= 4) return 6;
  return 0;
}

export function quantizeLightForLOD(
  packed: number,
  disableAO: boolean,
): number {
  // If AO is NOT disabled, leave the original packed light
  if (!disableAO) return packed & 0xff;

  const sky = (packed >> 4) & 0xf;
  const block = packed & 0xf;

  const qs = quantizeNibble(sky);
  const qb = quantizeNibble(block);

  return ((qs & 0xf) << 4) | (qb & 0xf);
}

/**
 * Merge light from current and neighbor blocks.
 * Matches logic in your original code: partial blocks use max().
 */
export function mergeLight(
  currLight: number,
  neighborLight: number,
  isPartialCurrent: boolean,
  isPartialNeighbor: boolean,
): number {
  return isPartialCurrent && !isPartialNeighbor
    ? Math.max(currLight, neighborLight)
    : neighborLight;
}

/**
 * Extract packed sky/block light as a single byte.
 */
export function getPackedLightByte(
  ctx: MeshContext,
  x: number,
  y: number,
  z: number,
): number {
  return ctx.getLight(x, y, z, 0) & 0xff;
}
