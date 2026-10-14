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

function isWaterPacked(packed: number): boolean {
	return getSourceBlockId(unpackBlockId(packed & 0xffff)) === WATER_BLOCK_ID;
}

function emitSkirt(
	out: QuadBuffer,
	yTop: number,
	packedBlockId: number,
	blockId: number,
	light: number,
	axis: number,
	back: number,
	x: number,
	yBottomRaw: number,
	z: number,
	span: number,
	face: FaceName,
): void {
	/*
	 * Callers only pass decoded, non-water solid blocks. Retaining the packed
	 * ID parameter makes the relationship explicit for future tint or material
	 * metadata use without decoding it again here.
	 */
	void packedBlockId;

	if (blockId <= 0) {
		return;
	}

	// Positions are unsigned bytes, so deep skirts must not wrap below zero.
	const yBottom = yBottomRaw > 0 ? yBottomRaw : 0;
	const vertical = yTop + 1 - yBottom;

	if (vertical <= 0) {
		return;
	}

	const quantizedLight = quantizeByteForLOD(light) & 0xff;

	/*
	 * Axis 0, ±X: width=Y, height=Z.
	 * Axis 2, ±Z: width=X, height=Y.
	 */
	out.emitQuadRawUnits(
		x,
		yBottom,
		z,
		axis,
		axis === 0 ? vertical : span,
		axis === 0 ? span : vertical,
		blockId,
		back,
		quantizedLight,
		0,
		face,
	);
}

/**
 * One border column, single top-to-bottom pass: finds the top, then emits
 * one skirt segment per contiguous same-block run down to stopY.
 *
 * Optimized hot path:
 * - reads block and opacity arrays only once per voxel;
 * - decodes each solid block only once;
 * - avoids repeated session and grid property lookups;
 * - consolidates repeated segment-closing logic;
 * - preserves fresh air-side lighting during light-only rebuilds.
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
	const step = session.lodStep;
	const ps = session.ps;
	const ps2 = session.ps2;

	const blocks = session.block;
	const opaque = session.opaque;
	const lights = session.light;
	const grids = session.activeGrids;

	/*
	 * Offset from a border voxel to the adjacent voxel outside the chunk:
	 * slot 0=-X, 1=+X, 2=-Z, 3=+Z.
	 */
	let outwardOffset: number;

	switch (slot) {
		case 0:
			outwardOffset = -1;
			break;
		case 1:
			outwardOffset = 1;
			break;
		case 2:
			outwardOffset = -ps2;
			break;
		default:
			outwardOffset = ps2;
			break;
	}

	const cacheIndex = slot * size + col;

	let startY = size - 1;
	let cacheHit = false;

	if (
		grids !== undefined &&
		!session.blocksChangedThisBuild &&
		grids.borderTopY !== undefined &&
		grids.borderTopPacked !== undefined &&
		grids.borderTopSize === size &&
		grids.borderTopStep === step
	) {
		const cachedTopY = grids.borderTopY[cacheIndex];

		if (cachedTopY === TOP_NONE) {
			return;
		}

		if (cachedTopY !== TOP_UNKNOWN) {
			startY = cachedTopY;
			cacheHit = true;
		}
	}

	let firstY = TOP_NONE;
	let firstPacked = 0;
	let stopY = 0;

	let runTop = TOP_NONE;
	let runPacked = 0;
	let runBlockId = 0;
	let runLight = 0;

	let index = cx + 1 + (startY + 1) * ps + (cz + 1) * ps2;

	for (let y = startY; y >= 0; y--, index -= ps) {
		/*
		 * Once the scan reaches the skirt depth, close the current run at the
		 * exact depth boundary. No cells below that boundary affect output.
		 */
		if (firstY >= 0 && y < stopY) {
			if (runTop >= 0) {
				emitSkirt(
					out,
					runTop,
					runPacked,
					runBlockId,
					runLight,
					axis,
					back,
					qx,
					stopY,
					qz,
					span,
					face,
				);

				runTop = TOP_NONE;
			}

			break;
		}

		const packed = blocks[index];

		let solid = opaque[index] !== 0;

		/*
		 * Opaque cells are necessarily solid. Only non-opaque, non-air cells
		 * need the more expensive cached flag lookup.
		 */
		if (!solid && packed !== 0) {
			const flags = getCachedFlagsAndId(packed) & 0xffff;
			solid = (flags & FLAG_SOLID) !== 0;
		}

		if (!solid || packed === 0) {
			if (runTop >= 0) {
				emitSkirt(
					out,
					runTop,
					runPacked,
					runBlockId,
					runLight,
					axis,
					back,
					qx,
					y + 1,
					qz,
					span,
					face,
				);

				runTop = TOP_NONE;
			}

			continue;
		}

		/*
		 * Decode once per solid voxel. The decoded ID is reused for water
		 * classification, run comparison, and final emission.
		 */
		const blockId = unpackBlockId(packed);
		const sourceBlockId = getSourceBlockId(blockId);

		if (sourceBlockId === WATER_BLOCK_ID) {
			/*
			 * A water surface at the top suppresses the complete opaque skirt
			 * for this column. Water below an opaque top only splits the run.
			 */
			if (firstY < 0) {
				break;
			}

			if (runTop >= 0) {
				emitSkirt(
					out,
					runTop,
					runPacked,
					runBlockId,
					runLight,
					axis,
					back,
					qx,
					y + 1,
					qz,
					span,
					face,
				);

				runTop = TOP_NONE;
			}

			continue;
		}

		if (firstY < 0) {
			firstY = y;
			firstPacked = packed;
			stopY = y + 1 - depth;
		}

		if (runTop < 0) {
			runTop = y;
			runPacked = packed;
			runBlockId = blockId;

			const aboveLight = lights[index + ps];
			const outwardLight = lights[index + outwardOffset];

			runLight = aboveLight > outwardLight ? aboveLight : outwardLight;

			continue;
		}

		if (blockId !== runBlockId) {
			emitSkirt(
				out,
				runTop,
				runPacked,
				runBlockId,
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

			const aboveLight = lights[index + ps];
			const outwardLight = lights[index + outwardOffset];

			runLight = aboveLight > outwardLight ? aboveLight : outwardLight;

			continue;
		}

		/*
		 * Above-light is sampled only at the top of a run. Deeper cells need
		 * only outward-facing light, preserving the original lighting model.
		 */
		const outwardLight = lights[index + outwardOffset];

		if (outwardLight > runLight) {
			runLight = outwardLight;
		}
	}

	if (runTop >= 0) {
		emitSkirt(
			out,
			runTop,
			runPacked,
			runBlockId,
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

	if (grids === undefined || cacheHit) {
		return;
	}

	ensureBorderCache(grids, size, step);

	const topYCache = grids.borderTopY;
	const packedCache = grids.borderTopPacked;

	if (topYCache === undefined || packedCache === undefined) {
		return;
	}

	if (firstY < 0) {
		topYCache[cacheIndex] = TOP_NONE;
		packedCache[cacheIndex] = 0;
		return;
	}

	topYCache[cacheIndex] = firstY;
	packedCache[cacheIndex] = firstPacked;
}
