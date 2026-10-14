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
 * Maps block IDs to AO opacity:
 *   1 = solid, non-partial block
 *   0 = transparent or partial block
 *
 * Initialized lazily to preserve the original initialization behavior.
 */
let AO_OPAQUE_LUT: Uint8Array | null = null;

function getAOOpaqueLut(): Uint8Array {
	const cached = AO_OPAQUE_LUT;
	if (cached !== null) return cached;

	const lut = new Uint8Array(1 << BLOCK_ID_BITS);

	for (let id = 0; id < lut.length; id++) {
		const flags = getCachedFlagsAndId(id);

		lut[id] =
			(flags & FLAG_SOLID) !== 0 && (flags & FLAG_PARTIAL) === 0 ? 1 : 0;
	}

	AO_OPAQUE_LUT = lut;
	return lut;
}

/**
 * Four 2-bit AO corner values packed into one byte.
 *
 * Occupancy-mask layout:
 *   bit 0: -u
 *   bit 1: +u
 *   bit 2: -v
 *   bit 3: +v
 *   bit 4: -u-v
 *   bit 5: +u-v
 *   bit 6: +u+v
 *   bit 7: -u+v
 */
const AO_LUT: Uint8Array = (() => {
	const lut = new Uint8Array(256);

	for (let mask = 0; mask < lut.length; mask++) {
		const oMu = mask & 1;
		const oPu = (mask >>> 1) & 1;
		const oMv = (mask >>> 2) & 1;
		const oPv = (mask >>> 3) & 1;
		const oMumv = (mask >>> 4) & 1;
		const oPumv = (mask >>> 5) & 1;
		const oPupv = (mask >>> 6) & 1;
		const oMupv = (mask >>> 7) & 1;

		const ao0 = oMu + oMv + (oMu & oMv & oMumv);
		const ao1 = oPu + oMv + (oPu & oMv & oPumv);
		const ao2 = oPu + oPv + (oPu & oPv & oPupv);
		const ao3 = oMu + oPv + (oMu & oPv & oMupv);

		lut[mask] = ao0 | (ao1 << 2) | (ao2 << 4) | (ao3 << 6);
	}

	return lut;
})();

/**
 * Computes the packed AO value for the four corners of a face.
 *
 * faceX/faceY/faceZ identify the outside cell immediately in front of the
 * emitted face. uAxis and vAxis are the two in-plane axes of that face.
 */
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
	const axisOffsets = session.axisOffsets;

	const uOff = axisOffsets[uAxis];
	const vOff = axisOffsets[vAxis];

	const baseIdx =
		faceX + 1 + (faceY + 1) * session.ps + (faceZ + 1) * session.ps2;

	// Reuse these indices for both edge and diagonal samples.
	const minusUIdx = baseIdx - uOff;
	const plusUIdx = baseIdx + uOff;

	let occupancyMask = 0;

	occupancyMask |= aoOpaque[blockArr[minusUIdx] & BLOCK_ID_MASK];

	occupancyMask |= aoOpaque[blockArr[plusUIdx] & BLOCK_ID_MASK] << 1;

	occupancyMask |= aoOpaque[blockArr[baseIdx - vOff] & BLOCK_ID_MASK] << 2;

	occupancyMask |= aoOpaque[blockArr[baseIdx + vOff] & BLOCK_ID_MASK] << 3;

	occupancyMask |= aoOpaque[blockArr[minusUIdx - vOff] & BLOCK_ID_MASK] << 4;

	occupancyMask |= aoOpaque[blockArr[plusUIdx - vOff] & BLOCK_ID_MASK] << 5;

	occupancyMask |= aoOpaque[blockArr[plusUIdx + vOff] & BLOCK_ID_MASK] << 6;

	occupancyMask |= aoOpaque[blockArr[minusUIdx + vOff] & BLOCK_ID_MASK] << 7;

	return AO_LUT[occupancyMask];
}
