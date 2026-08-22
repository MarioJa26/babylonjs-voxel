import { unpackBlockId } from "../../Chunk/DataStructures/BlockEncoding";
import { BlockTextures } from "../../Texture/BlockTextures";
import { type FaceName, getFaceName } from "../../Texture/FaceName";
import { FLAG_SOLID, getCachedFlagsAndId } from "./BlockInfoCache";
import { quantizeLightForLOD } from "./LightPipeline";
import type { QuadBuffer } from "./QuadBuffer";
import type { MeshBuildSession } from "./WorkerMeshHelpers";

/**
 * Border skirts for downsampled chunks (LOD4+).
 *
 * When a coarse chunk borders a finer one, the shared boundary cannot match
 * exactly (the coarse mesh samples every lodStep-th voxel). Instead of
 * stitching geometry per neighbor — which would require knowing each
 * neighbor's LOD at mesh time — we drop an outward-facing wall along the
 * chunk's four vertical borders, extending below the highest solid voxel of
 * each border column. Any crack against a finer neighbor is hidden behind
 * this wall, exactly like geo-clipmap skirts.
 */

function skirtDepthFor(step: number): number {
	return Math.min(48, step * 8);
}

// Positions are stored as x*8 in a byte (max 255 = 31.875 blocks), so the
// far border plane at `size` is nudged inward by a sub-block amount.
const PLANE_FAR_UNITS = 255;
const PLANE_FAR = PLANE_FAR_UNITS / 8;

export function emitLodBorderSkirts(session: MeshBuildSession): void {
	const step = session.lodStep;
	if (step <= 1) return;

	const sides = session.borderSkirtSides;
	if (sides === 0) return;

	const size = session.size;
	const depth = skirtDepthFor(step);

	for (let z = 0; z < size; z += step) {
		emitSkirtPairX(session, z, depth);
	}

	for (let x = 0; x < size; x += step) {
		emitSkirtPairZ(session, x, depth);
	}
}

interface TopSolid {
	y: number;
	packed: number;
	lightLevel: number;
}

function topSolidAt(
	session: MeshBuildSession,
	x: number,
	z: number,
): TopSolid | null {
	const block = session.block;
	const light = session.light;
	const ps = session.ps;
	const ps2 = session.ps2;

	for (let y = session.size - 1; y >= 0; y--) {
		const idx = x + 1 + (y + 1) * ps + (z + 1) * ps2;
		const packed = block[idx];
		if (!packed) continue;

		const flags = getCachedFlagsAndId(packed) & 0xffff;
		if ((flags & FLAG_SOLID) === 0) continue;

		return { y, packed, lightLevel: light[idx] };
	}

	return null;
}

function emitSkirt(
	out: QuadBuffer,
	top: TopSolid,
	axis: number,
	backFace: number,
	x: number,
	yBottomUnclamped: number,
	z: number,
	tangentBlocks: number,
	faceName: FaceName,
): void {
	const blockId = unpackBlockId(top.packed & 0xffff);
	if (!BlockTextures[blockId]) return;

	// Positions are unsigned bytes; clamp so deep skirts never wrap.
	const yBottom = Math.max(0, yBottomUnclamped);
	if (yBottom >= top.y + 1) return;

	const quantizedLight = quantizeLightForLOD(top.lightLevel, true) & 0xff;
	const vertical = top.y + 1 - yBottom;

	// Axis dimension convention matches QuadBuffer:
	//   axis 0 (±X): w=Y-extent, h=Z-extent
	//   axis 2 (±Z): w=X-extent, h=Y-extent
	let width: number;
	let height: number;

	if (axis === 0) {
		width = vertical;
		height = tangentBlocks;
	} else {
		width = tangentBlocks;
		height = vertical;
	}

	out.emitQuadUnchecked(
		x,
		yBottom,
		z,
		axis,
		width,
		height,
		blockId,
		backFace,
		quantizedLight,
		0,
		faceName,
		0,
		0,
		0,
		1,
	);
}

function emitSkirtPairX(
	session: MeshBuildSession,
	z: number,
	depth: number,
): void {
	const out = session.quadOpaque;
	const faceName = getFaceName(0, false);
	const stepSpan = Math.min(session.lodStep, session.size);

	if (session.borderSkirtSides & 1) {
		const neg = topSolidAt(session, 0, z);
		if (neg) {
			// Near plane: inset one block when a (finer) neighbor exists, so
			// the skirt never sits coplanar with the greedy mesher's own
			// slice=-1 boundary wall on this plane.
			const inset = session.borderSkirtNearInset & 1 ? 1 : 0;
			emitSkirt(
				out,
				neg,
				0,
				1,
				inset,
				neg.y + 1 - depth,
				z,
				stepSpan,
				faceName,
			);
		}
	}

	if (session.borderSkirtSides & 2) {
		const pos = topSolidAt(session, session.size - 1, z);
		if (pos) {
			emitSkirt(
				out,
				pos,
				0,
				0,
				PLANE_FAR,
				pos.y + 1 - depth,
				z,
				stepSpan,
				faceName,
			);
		}
	}
}

function emitSkirtPairZ(
	session: MeshBuildSession,
	x: number,
	depth: number,
): void {
	const out = session.quadOpaque;
	const faceName = getFaceName(2, false);
	const stepSpan = Math.min(session.lodStep, session.size);

	if (session.borderSkirtSides & 4) {
		const neg = topSolidAt(session, x, 0);
		if (neg) {
			const inset = session.borderSkirtNearInset & 4 ? 1 : 0;
			emitSkirt(
				out,
				neg,
				2,
				1,
				x,
				neg.y + 1 - depth,
				inset,
				stepSpan,
				faceName,
			);
		}
	}

	if (session.borderSkirtSides & 8) {
		const pos = topSolidAt(session, x, session.size - 1);
		if (pos) {
			emitSkirt(
				out,
				pos,
				2,
				0,
				x,
				pos.y + 1 - depth,
				PLANE_FAR,
				stepSpan,
				faceName,
			);
		}
	}
}
