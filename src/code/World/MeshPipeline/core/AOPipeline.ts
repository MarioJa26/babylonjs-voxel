// MeshPipeline/core/AOPipeline.ts

import type { BlockShapeInfo, MeshContext } from "../types/MeshTypes";
import { FLAG_PARTIAL, FLAG_SOLID, getCachedFlags } from "./BlockFlags";

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
	uAxis: number,
	vAxis: number,
): number {
	const getBlock = ctx.getBlock;

	const ux = uAxis === 0 ? 1 : 0;
	const uy = uAxis === 1 ? 1 : 0;
	const uz = uAxis === 2 ? 1 : 0;

	const vx = vAxis === 0 ? 1 : 0;
	const vy = vAxis === 1 ? 1 : 0;
	const vz = vAxis === 2 ? 1 : 0;

	// 8 unique positions — edge-adjacent cells shared by two corners each,
	// plus four corner-diagonal cells. Fetched once, reused across all corners.
	const fMu = getCachedFlags(getBlock(faceX - ux, faceY - uy, faceZ - uz, 0));
	const fPu = getCachedFlags(getBlock(faceX + ux, faceY + uy, faceZ + uz, 0));
	const fMv = getCachedFlags(getBlock(faceX - vx, faceY - vy, faceZ - vz, 0));
	const fPv = getCachedFlags(getBlock(faceX + vx, faceY + vy, faceZ + vz, 0));
	const fMumv = getCachedFlags(
		getBlock(faceX - ux - vx, faceY - uy - vy, faceZ - uz - vz, 0),
	);
	const fPumv = getCachedFlags(
		getBlock(faceX + ux - vx, faceY + uy - vy, faceZ + uz - vz, 0),
	);
	const fPupv = getCachedFlags(
		getBlock(faceX + ux + vx, faceY + uy + vy, faceZ + uz + vz, 0),
	);
	const fMupv = getCachedFlags(
		getBlock(faceX - ux + vx, faceY - uy + vy, faceZ - uz + vz, 0),
	);

	const isSolid = (f: number) => f & FLAG_SOLID && !(f & FLAG_PARTIAL);

	let packedAO = 0;

	// Corner 0: (-u, -v)
	{
		const occU = isSolid(fMu) ? 1 : 0;
		const occV = isSolid(fMv) ? 1 : 0;
		let ao = occU + occV;
		if (occU && occV && isSolid(fMumv)) ao++;
		packedAO |= ao;
	}

	// Corner 1: (+u, -v)
	{
		const occU = isSolid(fPu) ? 1 : 0;
		const occV = isSolid(fMv) ? 1 : 0;
		let ao = occU + occV;
		if (occU && occV && isSolid(fPumv)) ao++;
		packedAO |= ao << 2;
	}

	// Corner 2: (+u, +v)
	{
		const occU = isSolid(fPu) ? 1 : 0;
		const occV = isSolid(fPv) ? 1 : 0;
		let ao = occU + occV;
		if (occU && occV && isSolid(fPupv)) ao++;
		packedAO |= ao << 4;
	}

	// Corner 3: (-u, +v)
	{
		const occU = isSolid(fMu) ? 1 : 0;
		const occV = isSolid(fPv) ? 1 : 0;
		let ao = occU + occV;
		if (occU && occV && isSolid(fMupv)) ao++;
		packedAO |= ao << 6;
	}

	return packedAO;
}
