// MeshPipeline/core/AOPipeline.ts

import { BlockShapeInfo, MeshContext } from "../types/MeshTypes";

/**
 * Utility: determine if a block occludes light for AO.
 *
 * AO should only treat a block as an occluder if it fully closes the relevant voxel face,
 * which for ordinary full cubes means all faces are closed.
 *
 * IMPORTANT:
 * Do NOT require isSliceCompatible here — normal cubes are not slice-compatible,
 * but they absolutely should occlude AO.
 */
export function isOccluder(
  packedBlock: number,
  shape: BlockShapeInfo,
): boolean {
  if (!packedBlock) return false;

  // For now keep AO conservative:
  // only fully closed cube-like blocks count as AO occluders.
  return shape.isCube && shape.closedFaceMask !== 0;
}

/**
 * Compute packed AO value for the 4 corners of a face.
 *
 * faceX/faceY/faceZ = the OUTSIDE cell coordinates immediately in front of the emitted face
 * axis              = face normal axis (0=x, 1=y, 2=z)
 * isBackFace        = whether the face is the negative-direction face
 *
 * uAxis / vAxis are the two in-plane axes for the face.
 *
 * This version fixes the directional 1-off issue by explicitly anchoring the AO samples
 * on the outside side of the face, exactly like the geometry fix did for quad placement.
 */
export function computeAO(
  ctx: MeshContext,
  faceX: number,
  faceY: number,
  faceZ: number,
  axis: number,
  isBackFace: boolean,
  uAxis: number,
  vAxis: number,
  getShapeInfo: (packedBlock: number) => BlockShapeInfo,
): number {
  const getBlock = ctx.getBlock;
  let packedAO = 0;

  for (let i = 0; i < 4; i++) {
    // Corner pattern:
    // 0 = (-u, -v)
    // 1 = (+u, -v)
    // 2 = (+u, +v)
    // 3 = (-u, +v)
    const du = i === 1 || i === 2 ? 1 : -1;
    const dv = i === 2 || i === 3 ? 1 : -1;

    // Side sample along U
    const sux = faceX + (uAxis === 0 ? du : 0);
    const suy = faceY + (uAxis === 1 ? du : 0);
    const suz = faceZ + (uAxis === 2 ? du : 0);

    // Side sample along V
    const svx = faceX + (vAxis === 0 ? dv : 0);
    const svy = faceY + (vAxis === 1 ? dv : 0);
    const svz = faceZ + (vAxis === 2 ? dv : 0);

    // Corner sample along U+V
    const scx = faceX + (uAxis === 0 ? du : 0) + (vAxis === 0 ? dv : 0);
    const scy = faceY + (uAxis === 1 ? du : 0) + (vAxis === 1 ? dv : 0);
    const scz = faceZ + (uAxis === 2 ? du : 0) + (vAxis === 2 ? dv : 0);

    const sideU = getBlock(sux, suy, suz, 0);
    const sideV = getBlock(svx, svy, svz, 0);
    const corner = getBlock(scx, scy, scz, 0);

    const occU = isOccluder(sideU, getShapeInfo(sideU)) ? 1 : 0;
    const occV = isOccluder(sideV, getShapeInfo(sideV)) ? 1 : 0;
    const occCorner =
      occU && occV && isOccluder(corner, getShapeInfo(corner)) ? 1 : 0;

    const aoLevel = occU + occV + occCorner;

    packedAO |= aoLevel << (i * 2);
  }

  return packedAO;
}
