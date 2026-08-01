// MeshPipeline/core/AOPipeline.ts

import {
	FLAG_PARTIAL,
	FLAG_SOLID,
	getCachedFlagsAndId,
} from "./BlockInfoCache";
import type { MeshBuildSession } from "./WorkerMeshHelpers";

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
 *
 * Stateless: all reads go through the session's padded grid.
 */
// Axis unit-vector LUTs (avoids per-axis ternary/branch in computeAO).
const AXIS_DX = [1, 0, 0];
const AXIS_DY = [0, 1, 0];
const AXIS_DZ = [0, 0, 1];

export function computeAO(
	session: MeshBuildSession,
	faceX: number,
	faceY: number,
	faceZ: number,
	uAxis: number,
	vAxis: number,
): number {
	const blockArr = session.block;
	const padIndex = session.padIndex;

	const ux = AXIS_DX[uAxis];
	const uy = AXIS_DY[uAxis];
	const uz = AXIS_DZ[uAxis];

	const vx = AXIS_DX[vAxis];
	const vy = AXIS_DY[vAxis];
	const vz = AXIS_DZ[vAxis];

	// 8 unique positions — edge-adjacent cells shared by two corners each,
	// plus four corner-diagonal cells. Fetched once, reused across all corners.
	// Each read indexes the padded grid directly (no getBlock closure) and uses
	// the combined flags+id cache; only the low flags bits are needed for AO.
	const fMu = getCachedFlagsAndId(
		blockArr[padIndex(faceX - ux, faceY - uy, faceZ - uz)],
	);
	const fPu = getCachedFlagsAndId(
		blockArr[padIndex(faceX + ux, faceY + uy, faceZ + uz)],
	);
	const fMv = getCachedFlagsAndId(
		blockArr[padIndex(faceX - vx, faceY - vy, faceZ - vz)],
	);
	const fPv = getCachedFlagsAndId(
		blockArr[padIndex(faceX + vx, faceY + vy, faceZ + vz)],
	);
	const fMumv = getCachedFlagsAndId(
		blockArr[padIndex(faceX - ux - vx, faceY - uy - vy, faceZ - uz - vz)],
	);
	const fPumv = getCachedFlagsAndId(
		blockArr[padIndex(faceX + ux - vx, faceY + uy - vy, faceZ + uz - vz)],
	);
	const fPupv = getCachedFlagsAndId(
		blockArr[padIndex(faceX + ux + vx, faceY + uy + vy, faceZ + uz + vz)],
	);
	const fMupv = getCachedFlagsAndId(
		blockArr[padIndex(faceX - ux + vx, faceY - uy + vy, faceZ - uz + vz)],
	);

	const occ = (f: number) =>
		(f & FLAG_SOLID) !== 0 && (f & FLAG_PARTIAL) === 0 ? 1 : 0;
	const oMu = occ(fMu);
	const oPu = occ(fPu);
	const oMv = occ(fMv);
	const oPv = occ(fPv);
	const oMumv = occ(fMumv);
	const oPumv = occ(fPumv);
	const oPupv = occ(fPupv);
	const oMupv = occ(fMupv);

	let packedAO = 0;

	// Corner 0: (-u, -v)
	{
		const occU = oMu;
		const occV = oMv;
		let ao = occU + occV;
		if (occU && occV && oMumv) ao++;
		packedAO |= ao;
	}

	// Corner 1: (+u, -v)
	{
		const occU = oPu;
		const occV = oMv;
		let ao = occU + occV;
		if (occU && occV && oPumv) ao++;
		packedAO |= ao << 2;
	}

	// Corner 2: (+u, +v)
	{
		const occU = oPu;
		const occV = oPv;
		let ao = occU + occV;
		if (occU && occV && oPupv) ao++;
		packedAO |= ao << 4;
	}

	// Corner 3: (-u, +v)
	{
		const occU = oMu;
		const occV = oPv;
		let ao = occU + occV;
		if (occU && occV && oMupv) ao++;
		packedAO |= ao << 6;
	}

	return packedAO;
}
