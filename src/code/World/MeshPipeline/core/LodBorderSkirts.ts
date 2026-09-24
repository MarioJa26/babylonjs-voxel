import { unpackBlockId } from "../../Chunk/DataStructures/BlockEncoding";
import { WATER_BLOCK_ID } from "../../Chunk/Worker/ChunkMesherConstants";
import { getSourceBlockId } from "../../Texture/BlockMaterial";
import { type FaceName, getFaceName } from "../../Texture/FaceName";
import { FLAG_SOLID, getCachedFlagsAndId } from "./BlockInfoCache";
import { quantizeByteForLOD } from "./LightPipeline";
import type { QuadBuffer } from "./QuadBuffer";
import type { MeshBuildSession, PaddedGrids } from "./WorkerMeshHelpers";

/**
 * Border skirts for downsampled chunks (LOD4+).
 *
 * A coarse chunk bordering a finer one can't match it exactly (the coarse
 * mesh samples every lodStep-th voxel), so we drop an outward-facing wall
 * along owned borders, hiding cracks like geo-clipmap skirts. One skirt
 * segment is emitted per contiguous same-block run: walls never span air
 * gaps or water (canopy overhangs, tower floors, lakes), and each segment
 * keeps the texture/tint of the block it goes down from. Light is sampled
 * from the air side and maxed over the run — never from inside the solid
 * voxel, whose stored light is ~0 (that rendered every skirt black).
 *
 * Far (+X/+Z) skirts REPLACE the greedy far slice (skipped via
 * skirtOwnsPosX/Z in VoxelMaskExtractor) — emitting both would z-fight.
 */

// PERF: getFaceName does a table lookup per call; these never change.
const FACE_PX: FaceName = getFaceName(0, false);
const FACE_PZ: FaceName = getFaceName(2, false);

// Border-top cache: -1 = no solid in column, -2 = unknown (not scanned).
const TOP_NONE = -1;
const TOP_UNKNOWN = -2;

export function emitLodBorderSkirts(session: MeshBuildSession): void {
	const size = session.size;
	const step = session.lodStep;
	const grids = session.activeGrids;

	// Full rebuild may have changed topology — invalidate first, before any
	// early-out, so a skirtless build can't leave stale tops for a relight.
	if (session.blocksChangedThisBuild && grids) {
		invalidateBorderCache(grids, size, step);
	}

	if (step <= 1) return;

	const sides = session.borderSkirtSides;
	if (sides === 0) return;

	// All-air uniform chunk: no solid column can exist.
	if (session.uniformFillId === 0) return;

	const depth = Math.min(48, step * 8);
	const span = step < size ? step : size;
	const out = session.quadOpaque;

	// Slot 0=-X (by z), 1=+X (by z), 2=-Z (by x), 3=+Z (by x).
	// Near (-X/-Z) planes sit exactly on x/z=0: the greedy extractor never
	// emits a slice=-1 wall, so the skirt is the sole wall there — no
	// inset. It meets the neighbor's far wall back-to-back.
	if (sides & 1)
		emitSide(session, out, 0, 0, 0, 1, size, step, depth, span, true, FACE_PX);
	if (sides & 2)
		emitSide(
			session,
			out,
			1,
			size - 1,
			size,
			0,
			size,
			step,
			depth,
			span,
			true,
			FACE_PX,
		);
	if (sides & 4)
		emitSide(session, out, 2, 0, 0, 1, size, step, depth, span, false, FACE_PZ);
	if (sides & 8)
		emitSide(
			session,
			out,
			3,
			size - 1,
			size,
			0,
			size,
			step,
			depth,
			span,
			false,
			FACE_PZ,
		);
}

function emitSide(
	session: MeshBuildSession,
	out: QuadBuffer,
	slot: number,
	fixed: number,
	plane: number,
	back: number,
	size: number,
	step: number,
	depth: number,
	span: number,
	isX: boolean,
	face: FaceName,
): void {
	for (let i = 0; i < size; i += step) {
		emitBorderColumn(
			session,
			out,
			slot,
			i,
			isX ? fixed : i,
			isX ? i : fixed,
			isX ? 0 : 2,
			back,
			isX ? plane : i,
			isX ? i : plane,
			span,
			depth,
			face,
		);
	}
}

function ensureBorderCache(
	grids: PaddedGrids,
	size: number,
	step: number,
): void {
	const n = 4 * size;
	if (
		!grids.borderTopY ||
		!grids.borderTopPacked ||
		grids.borderTopY.length < n ||
		grids.borderTopSize !== size ||
		grids.borderTopStep !== step
	) {
		grids.borderTopY = new Int16Array(n).fill(TOP_UNKNOWN);
		grids.borderTopPacked = new Uint16Array(n);
		grids.borderTopSize = size;
		grids.borderTopStep = step;
	}
}

function invalidateBorderCache(
	grids: PaddedGrids,
	size: number,
	step: number,
): void {
	ensureBorderCache(grids, size, step);
	grids.borderTopY!.fill(TOP_UNKNOWN);
}

/** Packed block at idx if solid (opaque, or any FLAG_SOLID), else 0. */
function solidPacked(session: MeshBuildSession, idx: number): number {
	if (session.opaque[idx] === 1) return session.block[idx];
	const packed = session.block[idx];
	return packed && (getCachedFlagsAndId(packed) & 0xffff & FLAG_SOLID) !== 0
		? packed
		: 0;
}

function isWaterPacked(packed: number): boolean {
	return getSourceBlockId(unpackBlockId(packed & 0xffff)) === WATER_BLOCK_ID;
}

function emitSkirt(
	out: QuadBuffer,
	yTop: number,
	packed: number,
	light: number,
	axis: number,
	back: number,
	x: number,
	yBottomRaw: number,
	z: number,
	span: number,
	face: FaceName,
): void {
	const blockId = unpackBlockId(packed & 0xffff);
	// Water sides are culled on downsampled builds; glass/water here would
	// land an opaque wall in the wrong bucket.
	if (blockId <= 0 || isWaterPacked(packed)) return;

	// Positions are unsigned bytes; clamp so deep skirts never wrap.
	const yBottom = Math.max(0, yBottomRaw);
	if (yBottom >= yTop + 1) return;

	const vertical = yTop + 1 - yBottom;
	// Downsampled builds imply lod>=4 (disableAO always true): raw units,
	// zero meta, LUT lighting. Axis 0 (±X): w=Y, h=Z; axis 2: w=X, h=Y.
	out.emitQuadRawUnits(
		x,
		yBottom,
		z,
		axis,
		axis === 0 ? vertical : span,
		axis === 0 ? span : vertical,
		blockId,
		back,
		quantizeByteForLOD(light) & 0xff,
		0,
		face,
	);
}

/**
 * One border column, single top-to-bottom pass: finds the top, then emits
 * one skirt segment per contiguous same-block run down to stopY. Water
 * breaks runs (it never emits skirt quads); light is the max air-side
 * light seen over the run, re-read fresh on every build including
 * light-only relights (blocks provably unchanged, cached top reused).
 */
function emitBorderColumn(
	session: MeshBuildSession,
	out: QuadBuffer,
	slot: number,
	col: number,
	cx: number,
	cz: number,
	axis: number,
	back: number,
	qx: number,
	qz: number,
	span: number,
	depth: number,
	face: FaceName,
): void {
	const size = session.size;
	const ps = session.ps;
	const ps2 = session.ps2;
	const light = session.light;
	// Single-step offset from a column voxel to its outward air neighbor
	// (slot 0=-X, 1=+X, 2=-Z, 3=+Z). The wall is lit from the air side —
	// never from inside the solid, whose stored light is ~0.
	const outwardOff = slot === 0 ? -1 : slot === 1 ? 1 : slot === 2 ? -ps2 : ps2;

	let startY = size - 1;
	let cacheHit = false;
	const grids = session.activeGrids;
	if (
		grids &&
		!session.blocksChangedThisBuild &&
		grids.borderTopY &&
		grids.borderTopPacked &&
		grids.borderTopSize === size &&
		grids.borderTopStep === session.lodStep
	) {
		const cy = grids.borderTopY[slot * size + col];
		if (cy === TOP_NONE) return;
		if (cy !== TOP_UNKNOWN) {
			startY = cy;
			cacheHit = true;
		}
	}

	let firstY = -1;
	let firstPacked = 0;
	let stopY = 0;
	let runTop = -1;
	let runPacked = 0;
	let runBlockId = 0;
	let runLight = 0;

	let idx = cx + 1 + (startY + 1) * ps + (cz + 1) * ps2;
	for (let y = startY; y >= 0; y--, idx -= ps) {
		if (firstY >= 0 && y + 1 <= stopY) {
			if (runTop >= 0) {
				emitSkirt(
					out,
					runTop,
					runPacked,
					runLight,
					axis,
					back,
					qx,
					stopY,
					qz,
					span,
					face,
				);
				runTop = -1;
			}
			break;
		}
		const packed = solidPacked(session, idx);
		if (!packed) {
			if (runTop >= 0) {
				emitSkirt(
					out,
					runTop,
					runPacked,
					runLight,
					axis,
					back,
					qx,
					y + 1,
					qz,
					span,
					face,
				);
				runTop = -1;
			}
			continue;
		}
		if (isWaterPacked(packed)) {
			// Water never emits skirt quads (opaque bucket): a lake-surface
			// column keeps its prior look (no skirt below the waterline),
			// deeper water just breaks the run like an air gap.
			if (firstY < 0) break;
			if (runTop >= 0) {
				emitSkirt(
					out,
					runTop,
					runPacked,
					runLight,
					axis,
					back,
					qx,
					y + 1,
					qz,
					span,
					face,
				);
				runTop = -1;
			}
			continue;
		}
		const blockId = unpackBlockId(packed & 0xffff);
		if (firstY < 0) {
			firstY = y;
			firstPacked = packed;
			stopY = y + 1 - depth;
		}
		if (runTop < 0) {
			runTop = y;
			runPacked = packed;
			runBlockId = blockId;
			const above = light[idx + ps];
			const outward = light[idx + outwardOff];
			runLight = above > outward ? above : outward;
		} else if (blockId !== runBlockId) {
			// Different block = different texture/tint: close and reopen so
			// the wall matches the block it goes down from.
			emitSkirt(
				out,
				runTop,
				runPacked,
				runLight,
				axis,
				back,
				qx,
				y + 1,
				qz,
				span,
				face,
			);
			runTop = y;
			runPacked = packed;
			runBlockId = blockId;
			const above = light[idx + ps];
			const outward = light[idx + outwardOff];
			runLight = above > outward ? above : outward;
		} else {
			// Same texture: extend the run, keeping the brightest air-side
			// light seen so a shaded run top can't blacken a lit wall.
			const outward = light[idx + outwardOff];
			if (outward > runLight) runLight = outward;
		}
	}
	if (runTop >= 0) {
		emitSkirt(
			out,
			runTop,
			runPacked,
			runLight,
			axis,
			back,
			qx,
			stopY,
			qz,
			span,
			face,
		);
	}

	if (grids && !cacheHit) {
		ensureBorderCache(grids, size, session.lodStep);
		const ci = slot * size + col;
		if (firstY < 0) {
			grids.borderTopY![ci] = TOP_NONE;
			grids.borderTopPacked![ci] = 0;
		} else {
			grids.borderTopY![ci] = firstY;
			grids.borderTopPacked![ci] = firstPacked;
		}
	}
}
