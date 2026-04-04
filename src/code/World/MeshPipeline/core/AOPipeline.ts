// MeshPipeline/core/AOPipeline.ts
import { BlockShapeInfo, MeshContext } from "../types/MeshTypes";

/**
 * Utility: determine if a block occludes light for AO.
 * AO occlusion is only applied for greedy-compatible cube-like shapes.
 */
export function isOccluder(
  packedBlock: number,
  shape: BlockShapeInfo,
): boolean {
  if (!packedBlock) return false;
  if (!shape.isCube) return false;
  if (!shape.isSliceCompatible) return false;
  return (shape.sliceMask & 7) === 0; // preserves your original rule
}

/**
 * Compute packed AO value for a quad corner arrangement.
 * ax/ay/az = target block coords
 * uAxis/vAxis = index (0|1|2) of axis used for AO sampling
 */
export function computeAO(
  ctx: MeshContext,
  ax: number,
  ay: number,
  az: number,
  uAxis: number,
  vAxis: number,
  getShapeInfo: (packedBlock: number) => BlockShapeInfo,
): number {
  const getBlock = ctx.getBlock;
  let packedAO = 0;

  for (let i = 0; i < 4; i++) {
    // Unit offsets for the AO pattern
    const du = i === 1 || i === 2 ? 1 : -1;
    const dv = i === 2 || i === 3 ? 1 : -1;

    // Compute positions relative to the corner
    const sx = ax + (uAxis === 0 ? du : 0) + (vAxis === 0 ? dv : 0);
    const sy = ay + (uAxis === 1 ? du : 0) + (vAxis === 1 ? dv : 0);
    const sz = az + (uAxis === 2 ? du : 0) + (vAxis === 2 ? dv : 0);

    const sideU = getBlock(
      ax + (uAxis === 0 ? du : 0),
      ay + (uAxis === 1 ? du : 0),
      az + (uAxis === 2 ? du : 0),
      0,
    );
    const sideV = getBlock(
      ax + (vAxis === 0 ? dv : 0),
      ay + (vAxis === 1 ? dv : 0),
      az + (vAxis === 2 ? dv : 0),
      0,
    );
    const corner = getBlock(sx, sy, sz, 0);

    const occU = isOccluder(sideU, getShapeInfo(sideU)) ? 1 : 0;
    const occV = isOccluder(sideV, getShapeInfo(sideV)) ? 1 : 0;
    const occCorner =
      occU && occV && isOccluder(corner, getShapeInfo(corner)) ? 1 : 0;

    const aoLevel = occU + occV + occCorner;

    packedAO |= aoLevel << (i * 2);
  }

  return packedAO;
}
