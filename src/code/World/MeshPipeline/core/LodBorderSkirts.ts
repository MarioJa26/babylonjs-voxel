import { unpackBlockId } from "../../Chunk/DataStructures/BlockEncoding";
import { type FaceName, getFaceName } from "../../Texture/FaceName";
import { FLAG_SOLID, getCachedFlagsAndId } from "./BlockInfoCache";
import { quantizeByteForLOD } from "./LightPipeline";
import type { QuadBuffer } from "./QuadBuffer";
import type { MeshBuildSession, PaddedGrids } from "./WorkerMeshHelpers";

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
 *
 * On far (+X/+Z) borders the skirt REPLACES the greedy far slice at
 * x/z=size (skipped via skirtOwnsPosX/Z in VoxelMaskExtractor) — emitting
 * both would stack two quads bit-exact coplanar with different
 * tessellation and z-fight.
 *
 * PERF notes (all behavior-preserving):
 * - One loop per owned side (not per axis with dead side checks inside).
 * - faceName/stepSpan/out hoisted out of the per-column path.
 * - topSolidAt uses the precomputed opaque[] bit to accept solid columns
 *   without a getCachedFlagsAndId decode, and a strength-reduced index.
 * - disableAO is always true here (step>1 implies lod>=4), so the LUT
 *   quantizeByteForLOD is called directly.
 * - Border tops (y + packed, topology only) are cached on the per-chunk
 *   PaddedGrids and reused on light-only relights where the block grid is
 *   provably unchanged; light is always re-read fresh.
 */

function skirtDepthFor(step: number): number {
	return Math.min(48, step * 8);
}

// PERF: hoisted out of the per-column path (getFaceName does a table
// lookup per call; these two values are constant for all skirts).
const FACE_PX: FaceName = getFaceName(0, false);
const FACE_PZ: FaceName = getFaceName(2, false);

// Border-top cache: -1 = no solid in column, -2 = unknown (not scanned).
const TOP_NONE = -1;
const TOP_UNKNOWN = -2;

// Skirts exist only on downsampled builds (see early-out above), so every
// face here is emitted through QuadBuffer.emitQuadRawUnits — whole-block
// coordinates written verbatim. The old ×8-scaled encoding could not reach
// the far border plane (255/8 = 31.875 blocks max), so it nudged the plane
// inward by a sub-block amount; raw units encode `size` exactly.

export function emitLodBorderSkirts(session: MeshBuildSession): void {
	const size = session.size;
	const step = session.lodStep;
	const grids = session.activeGrids;

	// Full rebuild: block topology may have changed — drop cached tops
	// first, before any early-out, so a build that emits no skirts
	// (step 1, no owned sides, all air) can't leave stale entries behind
	// for a later relight to reuse.
	if (session.blocksChangedThisBuild && grids) {
		invalidateBorderCache(grids, size, step);
	}

	if (step <= 1) return;

	const sides = session.borderSkirtSides;
	if (sides === 0) return;

	// All-air uniform chunk: no solid column can exist — skip every scan.
	if (session.uniformFillId === 0) return;

	const depth = skirtDepthFor(step);
	const stepSpan = step < size ? step : size;
	const out = session.quadOpaque;

	// One loop per owned side: slot 0=-X (by z), 1=+X (by z),
	// 2=-Z (by x), 3=+Z (by x).
	if (sides & 1)
		emitSideX(session, out, 0, 0, 0, 1, size, step, depth, stepSpan);
	if (sides & 2)
		emitSideX(session, out, 1, size - 1, size, 0, size, step, depth, stepSpan);
	if (sides & 4)
		emitSideZ(session, out, 2, 0, 0, 1, size, step, depth, stepSpan);
	if (sides & 8)
		emitSideZ(session, out, 3, size - 1, size, 0, size, step, depth, stepSpan);
}

interface TopSolid {
	y: number;
	packed: number;
	lightLevel: number;
}

// PERF: module-level scratch — callers consume the result synchronously
// (emitSkirt reads fields, nothing retains it across the next topSolidAt
// call), so this removes one heap allocation per border column.
const _topSolidScratch: TopSolid = { y: 0, packed: 0, lightLevel: 0 };

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

/**
 * Fast top-solid scan for one border column.
 *
 * opaque[]==1 implies FLAG_SOLID (opaque requires SOLID|GREEDY and forbids
 * TRANSPARENT|PARTIAL), so opaque-capped columns — the common terrain case —
 * return with zero flag decodes. opaque==0 still needs the decode to tell
 * transparent/partial solids (glass, leaves) apart from air.
 */
function topSolidFast(
	session: MeshBuildSession,
	x: number,
	z: number,
): TopSolid | null {
	const block = session.block;
	const light = session.light;
	const opaque = session.opaque;
	const ps = session.ps;
	const ps2 = session.ps2;
	const size = session.size;

	// Strength-reduced descent: one subtraction per row instead of two
	// multiplications. Starts at the top row (y = size-1).
	let idx = x + 1 + size * ps + (z + 1) * ps2;
	for (let y = size - 1; y >= 0; y--) {
		if (opaque[idx] === 1) {
			_topSolidScratch.y = y;
			_topSolidScratch.packed = block[idx];
			_topSolidScratch.lightLevel = light[idx];
			return _topSolidScratch;
		}

		const packed = block[idx];
		if (packed) {
			const flags = getCachedFlagsAndId(packed) & 0xffff;
			if ((flags & FLAG_SOLID) !== 0) {
				_topSolidScratch.y = y;
				_topSolidScratch.packed = packed;
				_topSolidScratch.lightLevel = light[idx];
				return _topSolidScratch;
			}
		}

		idx -= ps;
	}

	return null;
}

/**
 * Cached variant: on light-only relights (blocks provably unchanged) the
 * stored y/packed are reused and only light is re-read fresh. Unknown
 * entries (side newly owned since the full build) fall back to the scan
 * and populate the cache.
 */
function topSolidCached(
	session: MeshBuildSession,
	slot: number,
	col: number,
	x: number,
	z: number,
	size: number,
): TopSolid | null {
	const grids = session.activeGrids;
	const step = session.lodStep;

	if (
		grids &&
		!session.blocksChangedThisBuild &&
		grids.borderTopY &&
		grids.borderTopPacked &&
		grids.borderTopSize === size &&
		grids.borderTopStep === step
	) {
		const ci = slot * size + col;
		const cy = grids.borderTopY[ci];
		if (cy !== TOP_UNKNOWN) {
			if (cy === TOP_NONE) return null;
			const packed = grids.borderTopPacked[ci];
			const idx = x + 1 + (cy + 1) * session.ps + (z + 1) * session.ps2;
			_topSolidScratch.y = cy;
			_topSolidScratch.packed = packed;
			_topSolidScratch.lightLevel = session.light[idx];
			return _topSolidScratch;
		}
		// else: unknown — fall through to scan + store below.
	}

	const top = topSolidFast(session, x, z);

	if (grids) {
		ensureBorderCache(grids, size, step);
		const ci = slot * size + col;
		if (top) {
			grids.borderTopY![ci] = top.y;
			grids.borderTopPacked![ci] = top.packed;
		} else {
			grids.borderTopY![ci] = TOP_NONE;
			grids.borderTopPacked![ci] = 0;
		}
	}

	return top;
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
	if (blockId <= 0) return;

	// Positions are unsigned bytes; clamp so deep skirts never wrap.
	const yBottom = Math.max(0, yBottomUnclamped);
	if (yBottom >= top.y + 1) return;

	// Skirts only run on downsampled builds (lod>=4, disableAO always
	// true) — call the LUT directly instead of re-checking the flag.
	const quantizedLight = quantizeByteForLOD(top.lightLevel) & 0xff;
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

	out.emitQuadRawUnits(
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
	);
}

function emitSideX(
	session: MeshBuildSession,
	out: QuadBuffer,
	slot: number,
	colX: number,
	planeX: number,
	back: number,
	size: number,
	step: number,
	depth: number,
	stepSpan: number,
): void {
	for (let z = 0; z < size; z += step) {
		// Near (-X) plane sits exactly on x=0: the greedy extractor never
		// emits a slice=-1 wall (bank stays zero), so this skirt is the
		// sole wall here — no inset. It meets the neighbor's far wall
		// back-to-back on the shared world plane.
		const top = topSolidCached(session, slot, z, colX, z, size);
		if (top) {
			emitSkirt(
				out,
				top,
				0,
				back,
				planeX,
				top.y + 1 - depth,
				z,
				stepSpan,
				FACE_PX,
			);
		}
	}
}

function emitSideZ(
	session: MeshBuildSession,
	out: QuadBuffer,
	slot: number,
	colZ: number,
	planeZ: number,
	back: number,
	size: number,
	step: number,
	depth: number,
	stepSpan: number,
): void {
	for (let x = 0; x < size; x += step) {
		const top = topSolidCached(session, slot, x, x, colZ, size);
		if (top) {
			emitSkirt(
				out,
				top,
				2,
				back,
				x,
				top.y + 1 - depth,
				planeZ,
				stepSpan,
				FACE_PZ,
			);
		}
	}
}
