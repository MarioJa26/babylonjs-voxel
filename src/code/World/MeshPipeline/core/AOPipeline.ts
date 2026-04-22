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

	// Axis multipliers
	const ux = uAxis === 0 ? 1 : 0;
	const uy = uAxis === 1 ? 1 : 0;
	const uz = uAxis === 2 ? 1 : 0;

	const vx = vAxis === 0 ? 1 : 0;
	const vy = vAxis === 1 ? 1 : 0;
	const vz = vAxis === 2 ? 1 : 0;

	let packedAO = 0;

	// --------------------------------------------------
	// Corner 0: (-u, -v)
	// --------------------------------------------------
	{
		const sux = faceX - ux;
		const suy = faceY - uy;
		const suz = faceZ - uz;

		const svx = faceX - vx;
		const svy = faceY - vy;
		const svz = faceZ - vz;

		const scx = faceX - ux - vx;
		const scy = faceY - uy - vy;
		const scz = faceZ - uz - vz;

		const fU = getCachedFlags(getBlock(sux, suy, suz, 0));
		const fV = getCachedFlags(getBlock(svx, svy, svz, 0));

		const occU = fU & FLAG_SOLID && !(fU & FLAG_PARTIAL) ? 1 : 0;
		const occV = fV & FLAG_SOLID && !(fV & FLAG_PARTIAL) ? 1 : 0;

		let ao = occU + occV;

		if (occU && occV) {
			const fC = getCachedFlags(getBlock(scx, scy, scz, 0));
			if (fC & FLAG_SOLID && !(fC & FLAG_PARTIAL)) ao++;
		}

		packedAO |= ao;
	}

	// --------------------------------------------------
	// Corner 1: (+u, -v)
	// --------------------------------------------------
	{
		const sux = faceX + ux;
		const suy = faceY + uy;
		const suz = faceZ + uz;

		const svx = faceX - vx;
		const svy = faceY - vy;
		const svz = faceZ - vz;

		const scx = faceX + ux - vx;
		const scy = faceY + uy - vy;
		const scz = faceZ + uz - vz;

		const fU = getCachedFlags(getBlock(sux, suy, suz, 0));
		const fV = getCachedFlags(getBlock(svx, svy, svz, 0));

		const occU = fU & FLAG_SOLID && !(fU & FLAG_PARTIAL) ? 1 : 0;
		const occV = fV & FLAG_SOLID && !(fV & FLAG_PARTIAL) ? 1 : 0;

		let ao = occU + occV;

		if (occU && occV) {
			const fC = getCachedFlags(getBlock(scx, scy, scz, 0));
			if (fC & FLAG_SOLID && !(fC & FLAG_PARTIAL)) ao++;
		}

		packedAO |= ao << 2;
	}

	// --------------------------------------------------
	// Corner 2: (+u, +v)
	// --------------------------------------------------
	{
		const sux = faceX + ux;
		const suy = faceY + uy;
		const suz = faceZ + uz;

		const svx = faceX + vx;
		const svy = faceY + vy;
		const svz = faceZ + vz;

		const scx = faceX + ux + vx;
		const scy = faceY + uy + vy;
		const scz = faceZ + uz + vz;

		const fU = getCachedFlags(getBlock(sux, suy, suz, 0));
		const fV = getCachedFlags(getBlock(svx, svy, svz, 0));

		const occU = fU & FLAG_SOLID && !(fU & FLAG_PARTIAL) ? 1 : 0;
		const occV = fV & FLAG_SOLID && !(fV & FLAG_PARTIAL) ? 1 : 0;

		let ao = occU + occV;

		if (occU && occV) {
			const fC = getCachedFlags(getBlock(scx, scy, scz, 0));
			if (fC & FLAG_SOLID && !(fC & FLAG_PARTIAL)) ao++;
		}

		packedAO |= ao << 4;
	}

	// --------------------------------------------------
	// Corner 3: (-u, +v)
	// --------------------------------------------------
	{
		const sux = faceX - ux;
		const suy = faceY - uy;
		const suz = faceZ - uz;

		const svx = faceX + vx;
		const svy = faceY + vy;
		const svz = faceZ + vz;

		const scx = faceX - ux + vx;
		const scy = faceY - uy + vy;
		const scz = faceZ - uz + vz;

		const fU = getCachedFlags(getBlock(sux, suy, suz, 0));
		const fV = getCachedFlags(getBlock(svx, svy, svz, 0));

		const occU = fU & FLAG_SOLID && !(fU & FLAG_PARTIAL) ? 1 : 0;
		const occV = fV & FLAG_SOLID && !(fV & FLAG_PARTIAL) ? 1 : 0;

		let ao = occU + occV;

		if (occU && occV) {
			const fC = getCachedFlags(getBlock(scx, scy, scz, 0));
			if (fC & FLAG_SOLID && !(fC & FLAG_PARTIAL)) ao++;
		}

		packedAO |= ao << 6;
	}

	return packedAO;
}
