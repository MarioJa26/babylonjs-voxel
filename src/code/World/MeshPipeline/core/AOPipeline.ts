// MeshPipeline/core/AOPipeline.ts

import {
	BLOCK_ID_BITS,
	BLOCK_ID_MASK,
} from "../../Chunk/DataStructures/BlockEncoding";
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
// AO only needs the solid/non-partial classification. Block IDs are dense and
// the classification is independent of the packed block state for AO, so build
// this once instead of probing the combined-flags cache for every AO sample.
let AO_OPAQUE_LUT: Uint8Array | null = null;

function getAOOpaqueLut(): Uint8Array {
	if (AO_OPAQUE_LUT) return AO_OPAQUE_LUT;

	const lut = new Uint8Array(1 << BLOCK_ID_BITS);
	for (let id = 0; id <= BLOCK_ID_MASK; id++) {
		const flags = getCachedFlagsAndId(id);
		lut[id] =
			(flags & FLAG_SOLID) !== 0 && (flags & FLAG_PARTIAL) === 0 ? 1 : 0;
	}

	AO_OPAQUE_LUT = lut;
	return lut;
}

// Four 2-bit AO corner values packed into one byte, indexed by the eight
// occupancy bits: -u, +u, -v, +v, -u-v, +u-v, +u+v, -u+v.
const AO_LUT = (() => {
	const lut = new Uint8Array(256);

	for (let m = 0; m < 256; m++) {
		const oMu = (m >>> 0) & 1;
		const oPu = (m >>> 1) & 1;
		const oMv = (m >>> 2) & 1;
		const oPv = (m >>> 3) & 1;
		const oMumv = (m >>> 4) & 1;
		const oPumv = (m >>> 5) & 1;
		const oPupv = (m >>> 6) & 1;
		const oMupv = (m >>> 7) & 1;

		const ao0 = oMu + oMv + (oMu & oMv & oMumv);
		const ao1 = oPu + oMv + (oPu & oMv & oPumv);
		const ao2 = oPu + oPv + (oPu & oPv & oPupv);
		const ao3 = oMu + oPv + (oMu & oPv & oMupv);

		lut[m] = ao0 | (ao1 << 2) | (ao2 << 4) | (ao3 << 6);
	}

	return lut;
})();

export function computeAO(
	session: MeshBuildSession,
	faceX: number,
	faceY: number,
	faceZ: number,
	uAxis: number,
	vAxis: number,
): number {
	const blockArr = session.block;
	const aoOpaque = getAOOpaqueLut();

	// 8 unique positions — edge-adjacent cells shared by two corners each,
	// plus four corner-diagonal cells. Fetched once, reused across all corners.
	// Each read indexes the padded grid directly (no getBlock closure) and uses
	// the combined flags+id cache; only the low flags bits are needed for AO.
	// u/v are unit axes, so the 8 samples are baseIdx +/- uOff +/- vOff — one
	// padIndex call instead of eight.
	const baseIdx =
		faceX + 1 + (faceY + 1) * session.ps + (faceZ + 1) * session.ps2;
	const axisOffsets = session.axisOffsets;
	const uOff = axisOffsets[uAxis];
	const vOff = axisOffsets[vAxis];
	const oMu = aoOpaque[blockArr[baseIdx - uOff] & BLOCK_ID_MASK];
	const oPu = aoOpaque[blockArr[baseIdx + uOff] & BLOCK_ID_MASK];
	const oMv = aoOpaque[blockArr[baseIdx - vOff] & BLOCK_ID_MASK];
	const oPv = aoOpaque[blockArr[baseIdx + vOff] & BLOCK_ID_MASK];
	const oMumv = aoOpaque[blockArr[baseIdx - uOff - vOff] & BLOCK_ID_MASK];
	const oPumv = aoOpaque[blockArr[baseIdx + uOff - vOff] & BLOCK_ID_MASK];
	const oPupv = aoOpaque[blockArr[baseIdx + uOff + vOff] & BLOCK_ID_MASK];
	const oMupv = aoOpaque[blockArr[baseIdx - uOff + vOff] & BLOCK_ID_MASK];

	const occupancyMask =
		(oMu << 0) |
		(oPu << 1) |
		(oMv << 2) |
		(oPv << 3) |
		(oMumv << 4) |
		(oPumv << 5) |
		(oPupv << 6) |
		(oMupv << 7);

	return AO_LUT[occupancyMask];
}
