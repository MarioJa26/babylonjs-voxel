// MeshPipeline/core/VoxelMaskExtractor.ts

import { isLiquidSourceId } from "../../Liquid/LiquidRegistry";
import {
	FACE_NX,
	FACE_NY,
	FACE_NZ,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
} from "../../Shape/BlockShapes";
import { getSourceBlockId } from "../../Texture/BlockMaterial";
import type { BlockShapeInfo } from "../types/MeshTypes";
import { computeAO } from "./AOPipeline";
import {
	FLAG_GREEDY,
	FLAG_PARTIAL,
	FLAG_SOLID,
	FLAG_TRANSPARENT,
	FLAG_WATER_GLASS,
	getCachedFlagsAndId,
	getFlagsFromCombined,
	getIdFromCombined,
	getShapeInfo,
	isGlassBlock,
} from "./BlockInfoCache";
import { quantizeByteForLOD } from "./LightPipeline";
import type { MeshBuildSession } from "./WorkerMeshHelpers";

/**
 * Marker bit used so non-cube faces do not greedily merge with cube faces.
 * bit 31 is reserved for back-face sign, so we use bit 30.
 */
const NON_CUBE_MASK = 0x40000000;
const BACK_FACE_MASK = 0x80000000;
const PACKED_ID_STATE_MASK = 0x0000ffff;
const BLOCK_ID_MASK = 0x3ff;

const WATER_ABOVE_MASK = 0x10000;
const WATER_LEVEL_PAIR_MASK = 0x20000;

const WATER_LEVEL_SHIFT = 10;
const WATER_LEVEL_MASK_4 = 0xf;
const WATER_LEVEL_MASK_3 = 0x7;
const WATER_SHALLOWER_SHIFT = 13;
const WATER_PAIR_LEVEL_CLEAR = ~(
	(WATER_LEVEL_MASK_3 << WATER_LEVEL_SHIFT) |
	(WATER_LEVEL_MASK_3 << WATER_SHALLOWER_SHIFT)
);

type WritableNumberArray = number[] | Int32Array | Uint16Array | Uint32Array;

// ---------------------------------------------------------------------------
// Batched per-axis mask extraction.
//
// The per-slice extractors above re-walk the padded grid once per slice
// (33 slices × 3 axes per chunk) with strided inner loops for the X/Y axes,
// which dominated worker profiles. These sweep variants compute every slice
// mask of one axis in a SINGLE pass whose inner loop walks contiguous x,
// turning all grid reads (opaque pre-check, block/light stencil, AO samples)
// sequential. Each adjacency pair is also consumed exactly once instead of
// twice.
//
// Bank layout: slice s (-1..size-1) lives at (s+1) * area; cell order within
// each slice matches the greedy merge loop's expectations directly.
//
// PERF: banks are typed to the exact arrays produced by
// session.ensureMaskBank/ensureLightBank so every access site stays monomorphic.
//
// Boundary slices are owned by the positive-side chunk when both chunks are
// present. If a negative-side neighbor is absent, the current chunk emits a
// fallback -axis slice against its cleared air padding; the positive-side
// fallback is emitted by the current chunk at the far boundary.
// ---------------------------------------------------------------------------

export function extractAllSliceMasksX(
	session: MeshBuildSession,
	maskBank: Int32Array,
	lightBank: Uint16Array,
): void {
	const size = session.size;
	const step = session.lodStep;
	const gridSize =
		session.meshGridSize > 0 ? session.meshGridSize : size / step;
	const area = gridSize * gridSize;

	maskBank.fill(0, 0, (gridSize + 1) * area);

	// Per-slice occupancy: lets greedyMesh skip all-empty slices.
	const occ = session.ensureSliceOccupancy(gridSize + 1);
	occ.fill(0, 0, gridSize + 1);

	const hasPosNeighbor = session.hasNeighborChunk(1, 0, 0);
	const hasNegNeighbor = session.hasNeighborChunk(-1, 0, 0);
	// Downsampled builds: when this chunk owns the +X border skirt, the
	// skirt is the sole wall on that plane. Emitting the greedy far slice
	// too would place a second quad at x=size with different tessellation
	// (bit-exact coplanar → z-fighting on vertical chunk borders).
	const skirtOwnsPosX = step > 1 && (session.borderSkirtSides & 2) !== 0;
	const skirtOwnsNegX = step > 1 && (session.borderSkirtSides & 1) !== 0;

	const blockArr = session.block;
	const lightArr = session.light;
	const opaqueArr = session.opaque;
	const disableAO = session.disableAO;
	const ps = session.ps;
	const ps2 = session.ps2;

	// East (-X) is normally emitted by the chunk on the other side of the
	// border. When that chunk is absent, keep the face on this chunk instead.
	// Only full builds may use the cleared padding as a known-air neighbor;
	// light-only builds must not infer topology from a stale border cache.
	if (
		session.blocksChangedThisBuild &&
		!hasNegNeighbor &&
		!skirtOwnsNegX
	) {
		for (let cz = 0; cz < gridSize; cz++) {
			const vz = cz * step;
			const zBase = (vz + 1) * ps2;
			const outCell = cz * gridSize;

			for (let cy = 0; cy < gridSize; cy++) {
				const vy = cy * step;
				const rowIdx = (vy + 1) * ps + zBase;
				const curIdx = 1 + rowIdx;
				const nbrIdx = curIdx - 1;
				const outIndex = outCell + cy;

				if ((opaqueArr[curIdx] & opaqueArr[nbrIdx]) === 0) {
					processCell(
						session,
						blockArr,
						lightArr,
						disableAO,
						-1,
						vy,
						vz,
						0,
						vy,
						vz,
						nbrIdx,
						curIdx,
						1,
						2,
						FACE_PX,
						FACE_NX,
						outIndex,
						maskBank,
						lightBank,
					);

					if (maskBank[outIndex] !== 0) occ[0] = 1;
				}
			}
		}
	}

	// Downsampled mode: one mask cell per lodStep^3 voxel region. Interior
	// pairs sample the representative (region-origin) voxels of adjacent
	// regions.
	//
	// BORDER OWNERSHIP: each chunk emits exactly ONE boundary slice on its
	// +X side, pairing its own last region representative (voxel size-step,
	// internal) with the neighbor's FIRST region representative (voxel size,
	// available in the padding). The old -1 slice paired the padding's edge
	// voxel (-1) against region representatives of a different size, which
	// mismatched heights on both sides and opened gaps along every LOD>=4
	// border. With +X ownership every internal boundary is emitted once,
	// by the lower-side chunk, with matched representatives.
	for (let cz = 0; cz < gridSize; cz++) {
		const vz = cz * step;
		const zBase = (vz + 1) * ps2;
		const outCell = cz * gridSize;

		for (let cy = 0; cy < gridSize; cy++) {
			const vy = cy * step;
			const rowIdx = (vy + 1) * ps + zBase;

			for (let cs = 0; cs < gridSize - 1; cs++) {
				const bx = cs * step;
				const curIdx = bx + 1 + rowIdx;
				const nbrIdx = curIdx + step;
				const outIndex = (cs + 1) * area + outCell + cy;

				if ((opaqueArr[curIdx] & opaqueArr[nbrIdx]) === 0) {
					processCell(
						session,
						blockArr,
						lightArr,
						disableAO,
						bx,
						vy,
						vz,
						bx + step,
						vy,
						vz,
						curIdx,
						nbrIdx,
						1,
						2,
						FACE_PX,
						FACE_NX,
						outIndex,
						maskBank,
						lightBank,
					);

					if (maskBank[outIndex] !== 0) occ[cs + 1] = 1;
				}
			}

			// A full build clears missing block borders to air, so the +X
			// boundary can be evaluated even when the positive-X chunk is not loaded.
			// Light-only builds must keep the neighbor-presence guard because
			// their cached block padding is not revalidated here.
			if (
				(session.blocksChangedThisBuild || hasPosNeighbor) &&
				!skirtOwnsPosX
			) {
				const bx = (gridSize - 1) * step;
				const curIdx = bx + 1 + rowIdx;
				const nbrIdx = curIdx + step; // padding layer at voxel size
				const outIndex = gridSize * area + outCell + cy;

				if ((opaqueArr[curIdx] & opaqueArr[nbrIdx]) === 0) {
					processCell(
						session,
						blockArr,
						lightArr,
						disableAO,
						bx,
						vy,
						vz,
						size,
						vy,
						vz,
						curIdx,
						nbrIdx,
						1,
						2,
						FACE_PX,
						FACE_NX,
						outIndex,
						maskBank,
						lightBank,
					);

					if (maskBank[outIndex] !== 0) occ[gridSize] = 1;
				}
			}
		}
	}
}

export function extractAllSliceMasksY(
	session: MeshBuildSession,
	maskBank: Int32Array,
	lightBank: Uint16Array,
): void {
	const size = session.size;
	const step = session.lodStep;
	const gridSize =
		session.meshGridSize > 0 ? session.meshGridSize : size / step;
	const area = gridSize * gridSize;
	const bankLength = (gridSize + 1) * area;

	maskBank.fill(0, 0, bankLength);

	const occupancy = session.ensureSliceOccupancy(gridSize + 1);
	occupancy.fill(0, 0, gridSize + 1);

	const blockArr = session.block;
	const lightArr = session.light;
	const opaqueArr = session.opaque;
	const disableAO = session.disableAO;

	const ps = session.ps;
	const ps2 = session.ps2;
	const yStep = ps * step;

	/*
	 * Axis Y:
	 *   u = Z
	 *   v = X
	 *   mask cell = z + x * gridSize
	 *
	 * Keep X as the innermost loop so block, light, and opaque accesses are
	 * contiguous. The output is strided by gridSize, but the considerably
	 * larger input stencil used by processCell benefits from sequential reads.
	 */

	for (let cs = 0; cs < gridSize - 1; cs++) {
		const by = cs * step;
		const ny = by + step;
		const currentRowBase = (by + 1) * ps;
		const outputSliceBase = (cs + 1) * area;

		let sliceOccupied = 0;

		for (let cvz = 0; cvz < gridSize; cvz++) {
			const vz = cvz * step;
			const inputBase = currentRowBase + (vz + 1) * ps2 + 1;
			let outputIndex = outputSliceBase + cvz;

			for (let cvx = 0, vx = 0; cvx < gridSize; cvx++, vx += step) {
				const currentIndex = inputBase + vx;
				const neighborIndex = currentIndex + yStep;

				if ((opaqueArr[currentIndex] & opaqueArr[neighborIndex]) === 0) {
					processCell(
						session,
						blockArr,
						lightArr,
						disableAO,
						vx,
						by,
						vz,
						vx,
						ny,
						vz,
						currentIndex,
						neighborIndex,
						2,
						0,
						FACE_PY,
						FACE_NY,
						outputIndex,
						maskBank,
						lightBank,
					);

					sliceOccupied |= maskBank[outputIndex];
				}

				outputIndex += gridSize;
			}
		}

		occupancy[cs + 1] = sliceOccupied !== 0 ? 1 : 0;
	}

	//
	// The +Y boundary plane must emit even without an above-neighbor:
	// begin() clears the padded grid whenever a block neighbor is absent, so
	// the far slice pairs against guaranteed air and every top-layer block
	// (liquid surfaces especially) keeps its surface face. Light-only
	// relights reuse an unverified padded grid, so they keep needing the
	// neighbor-presence guarantee below.
	if (session.blocksChangedThisBuild || session.hasNeighborChunk(0, 1, 0)) {
		const by = (gridSize - 1) * step;
		const currentRowBase = (by + 1) * ps;
		const outputSliceBase = gridSize * area;

		let sliceOccupied = 0;

		for (let cvz = 0; cvz < gridSize; cvz++) {
			const vz = cvz * step;
			const inputBase = currentRowBase + (vz + 1) * ps2 + 1;
			let outputIndex = outputSliceBase + cvz;

			for (let cvx = 0, vx = 0; cvx < gridSize; cvx++, vx += step) {
				const currentIndex = inputBase + vx;
				const neighborIndex = currentIndex + yStep;

				if ((opaqueArr[currentIndex] & opaqueArr[neighborIndex]) === 0) {
					processCell(
						session,
						blockArr,
						lightArr,
						disableAO,
						vx,
						by,
						vz,
						vx,
						size,
						vz,
						currentIndex,
						neighborIndex,
						2,
						0,
						FACE_PY,
						FACE_NY,
						outputIndex,
						maskBank,
						lightBank,
					);

					sliceOccupied |= maskBank[outputIndex];
				}

				outputIndex += gridSize;
			}
		}

		occupancy[gridSize] = sliceOccupied !== 0 ? 1 : 0;
	}
}

export function extractAllSliceMasksZ(
	session: MeshBuildSession,
	maskBank: Int32Array,
	lightBank: Uint16Array,
): void {
	const size = session.size;
	const step = session.lodStep;
	const gridSize =
		session.meshGridSize > 0 ? session.meshGridSize : size / step;
	const area = gridSize * gridSize;

	maskBank.fill(0, 0, (gridSize + 1) * area);

	const occ = session.ensureSliceOccupancy(gridSize + 1);
	occ.fill(0, 0, gridSize + 1);

	const hasPosNeighbor = session.hasNeighborChunk(0, 0, 1);
	const hasNegNeighbor = session.hasNeighborChunk(0, 0, -1);
	// Same far-side ownership rule as the X sweep: the +Z skirt replaces
	// the greedy far slice on downsampled builds so the border plane
	// z=size is never walled twice.
	const skirtOwnsPosZ = step > 1 && (session.borderSkirtSides & 8) !== 0;
	const skirtOwnsNegZ = step > 1 && (session.borderSkirtSides & 4) !== 0;

	const blockArr = session.block;
	const lightArr = session.light;
	const opaqueArr = session.opaque;
	const disableAO = session.disableAO;
	const ps = session.ps;
	const ps2 = session.ps2;

	// Axis Z uses u = X and v = Y (mask index = y * gridSize + x). Border
	// ownership mirrors the X/Y sweeps: one +Z boundary slice.
	const zStep = ps2 * step;

	// North (-Z) is normally emitted by the chunk on the other side of the
	// border. When that chunk is absent, emit this chunk's boundary against
	// the cleared air padding. The +Z path below remains the positive owner.
	if (
		session.blocksChangedThisBuild &&
		!hasNegNeighbor &&
		!skirtOwnsNegZ
	) {
		for (let cvy = 0; cvy < gridSize; cvy++) {
			const vy = cvy * step;
			const yBase = (vy + 1) * ps;

			for (let cvx = 0; cvx < gridSize; cvx++) {
				const vx = cvx * step;
				const curIdx = vx + 1 + yBase + ps2;
				const nbrIdx = curIdx - ps2;
				const outIndex = cvy * gridSize + cvx;

				if ((opaqueArr[curIdx] & opaqueArr[nbrIdx]) === 0) {
					processCell(
						session,
						blockArr,
						lightArr,
						disableAO,
						vx,
						vy,
						-1,
						vx,
						vy,
						0,
						nbrIdx,
						curIdx,
						0,
						1,
						FACE_PZ,
						FACE_NZ,
						outIndex,
						maskBank,
						lightBank,
					);

					if (maskBank[outIndex] !== 0) occ[0] = 1;
				}
			}
		}
	}

	for (let cvy = 0; cvy < gridSize; cvy++) {
		const vy = cvy * step;
		const yBase = (vy + 1) * ps;

		for (let cs = 0; cs < gridSize - 1; cs++) {
			const nzVox = (cs + 1) * step;
			const bz = nzVox - step;
			const curZBase = (bz + 1) * ps2;
			const outSliceBase = (cs + 1) * area;

			for (let cvx = 0; cvx < gridSize; cvx++) {
				const vx = cvx * step;
				const outIndex = outSliceBase + cvy * gridSize + cvx;
				const curIdx = vx + 1 + yBase + curZBase;
				const nbrIdx = curIdx + zStep;

				if ((opaqueArr[curIdx] & opaqueArr[nbrIdx]) === 0) {
					processCell(
						session,
						blockArr,
						lightArr,
						disableAO,
						vx,
						vy,
						bz,
						vx,
						vy,
						nzVox,
						curIdx,
						nbrIdx,
						0,
						1,
						FACE_PZ,
						FACE_NZ,
						outIndex,
						maskBank,
						lightBank,
					);

					if (maskBank[outIndex] !== 0) occ[cs + 1] = 1;
				}
			}
		}

		// A full build clears missing block borders to air, so the +Z
		// boundary can be evaluated even when the positive-Z chunk is absent.
		// Light-only builds still require the neighbor-presence guard.
		if (
			(session.blocksChangedThisBuild || hasPosNeighbor) &&
			!skirtOwnsPosZ
		) {
			const bz = (gridSize - 1) * step;
			const curZBase = (bz + 1) * ps2;
			const outSliceBase = gridSize * area;

			for (let cvx = 0; cvx < gridSize; cvx++) {
				const vx = cvx * step;
				const outIndex = outSliceBase + cvy * gridSize + cvx;
				const curIdx = vx + 1 + yBase + curZBase;
				const nbrIdx = curIdx + zStep; // padding layer at voxel size

				if ((opaqueArr[curIdx] & opaqueArr[nbrIdx]) === 0) {
					processCell(
						session,
						blockArr,
						lightArr,
						disableAO,
						vx,
						vy,
						bz,
						vx,
						vy,
						size,
						curIdx,
						nbrIdx,
						0,
						1,
						FACE_PZ,
						FACE_NZ,
						outIndex,
						maskBank,
						lightBank,
					);

					if (maskBank[outIndex] !== 0) occ[gridSize] = 1;
				}
			}
		}
	}
}

/**
 * Per-voxel mask computation. Module-level free function for V8 inlining.
 */
function processCell(
	session: MeshBuildSession,
	blockArr: Uint16Array,
	lightArr: Uint8Array,
	disableAO: boolean,
	bx: number,
	by: number,
	bz: number,
	nx: number,
	ny: number,
	nz: number,
	curIdx: number,
	nbrIdx: number,
	uAxis: number,
	vAxis: number,
	currentFaceBit: number,
	neighborFaceBit: number,
	outIndex: number,
	mask: WritableNumberArray,
	lightMask: WritableNumberArray,
): void {
	const currentPacked = blockArr[curIdx];
	const neighborPacked = blockArr[nbrIdx];

	// maskBank was cleared before the sweep, so early exits do not need to
	// write mask[outIndex] = 0.
	if ((currentPacked | neighborPacked) === 0) {
		return;
	}

	const currCombined =
		currentPacked !== 0 ? getCachedFlagsAndId(currentPacked) : 0;
	const nbrCombined =
		neighborPacked !== 0 ? getCachedFlagsAndId(neighborPacked) : 0;

	const currFlags = getFlagsFromCombined(currCombined);
	const nbrFlags = getFlagsFromCombined(nbrCombined);

	const currSolid = currFlags & FLAG_SOLID;
	const nbrSolid = nbrFlags & FLAG_SOLID;

	// No solid blocks means no face.
	if ((currSolid | nbrSolid) === 0) {
		return;
	}

	const currParticipates = currSolid !== 0 && (currFlags & FLAG_GREEDY) !== 0;
	const nbrParticipates = nbrSolid !== 0 && (nbrFlags & FLAG_GREEDY) !== 0;

	// If neither solid side can be emitted through greedy meshing, only a
	// closed-face occlusion test could have mattered. Since no side emits,
	// this cell contributes nothing.
	if (!currParticipates && !nbrParticipates) {
		return;
	}

	const currTransparent = currFlags & FLAG_TRANSPARENT;
	const nbrTransparent = nbrFlags & FLAG_TRANSPARENT;
	const currPartial = currFlags & FLAG_PARTIAL;
	const nbrPartial = nbrFlags & FLAG_PARTIAL;
	const currWaterGlass = currFlags & FLAG_WATER_GLASS;
	const nbrWaterGlass = nbrFlags & FLAG_WATER_GLASS;

	const bothCube =
		currParticipates &&
		nbrParticipates &&
		currPartial === 0 &&
		nbrPartial === 0;

	// Two opaque participating full cubes never produce a visible face.
	if (bothCube && currTransparent === 0 && nbrTransparent === 0) {
		return;
	}

	let currId = -1;
	let nbrId = -1;
	let currSourceId = -1;
	let nbrSourceId = -1;

	let liquidCurrLevel = -1;
	let liquidNbrLevel = -1;

	// IDs are only needed for liquid/glass interface and liquid-level
	// behavior. Virtual variants resolve to their source for comparison so
	// glass_01 cube vs glass_01 stairs (same source) cull like the same
	// block, and any two columns of the SAME liquid compare by level.
	const bothWaterGlass =
		currSolid !== 0 &&
		nbrSolid !== 0 &&
		currWaterGlass !== 0 &&
		nbrWaterGlass !== 0;

	let bothSameLiquid = false;

	if (bothWaterGlass) {
		currId = getIdFromCombined(currCombined);
		nbrId = getIdFromCombined(nbrCombined);

		currSourceId = getSourceBlockId(currId);
		nbrSourceId = getSourceBlockId(nbrId);

		bothSameLiquid =
			currSourceId === nbrSourceId && isLiquidSourceId(currSourceId);

		if (bothSameLiquid) {
			liquidCurrLevel =
				(currentPacked >>> WATER_LEVEL_SHIFT) & WATER_LEVEL_MASK_4;
			liquidNbrLevel =
				(neighborPacked >>> WATER_LEVEL_SHIFT) & WATER_LEVEL_MASK_4;
		}

		if (currSourceId === nbrSourceId) {
			// Same-source glass (e.g. glass cube vs glass stairs) never shows
			// an internal face, at any level.
			if (!bothSameLiquid) {
				return;
			}

			// Equal-level liquid columns are hidden. Differing-level columns
			// fall through to the sliver path below.
			if (liquidCurrLevel === liquidNbrLevel) {
				return;
			}
		}
	}

	let preserveInterface = 0;

	if (
		bothWaterGlass &&
		currTransparent !== 0 &&
		nbrTransparent !== 0 &&
		currSourceId !== nbrSourceId
	) {
		preserveInterface = 1;
	}

	let currShapeInfo: BlockShapeInfo | null = null;
	let nbrShapeInfo: BlockShapeInfo | null = null;

	// Only when both sides are solid and this is not the common full-cube path
	// do we need closed-face shape tests for mutual occlusion.
	// preserveInterface always keeps the face regardless of closed-face
	// occlusion (that's the whole point of a transparent interface), so this
	// early-return path can never fire when it's set — skip the fetch
	// entirely instead of computing shape info that's discarded below.
	if (!preserveInterface && !bothCube && currSolid !== 0 && nbrSolid !== 0) {
		currShapeInfo = getShapeInfo(currentPacked);
		nbrShapeInfo = getShapeInfo(neighborPacked);

		if (
			(currShapeInfo.closedFaceMask & currentFaceBit) !== 0 &&
			(nbrShapeInfo.closedFaceMask & neighborFaceBit) !== 0
		) {
			return;
		}
	}

	// ============================================================
	// TRANSPARENT INTERFACE EMISSION
	// ============================================================

	if (preserveInterface) {
		const preferCurrent = isGlassBlock(currId)
			? 1
			: isGlassBlock(nbrId)
				? 0
				: 1;

		let packedMask = 0;
		let packedAO = 0;

		if (preferCurrent && currParticipates) {
			if (!currShapeInfo) {
				currShapeInfo = getShapeInfo(currentPacked);
			}

			packedMask =
				(currentPacked & PACKED_ID_STATE_MASK) |
				(currShapeInfo.isCube ? 0 : NON_CUBE_MASK);

			packedAO = disableAO ? 0 : computeAO(session, nx, ny, nz, uAxis, vAxis);
		} else if (!preferCurrent && nbrParticipates) {
			if (!nbrShapeInfo) {
				nbrShapeInfo = getShapeInfo(neighborPacked);
			}

			packedMask =
				(neighborPacked & PACKED_ID_STATE_MASK) |
				(nbrShapeInfo.isCube ? 0 : NON_CUBE_MASK) |
				BACK_FACE_MASK;

			packedAO = disableAO ? 0 : computeAO(session, bx, by, bz, uAxis, vAxis);
		} else {
			return;
		}

		const emitSourceId = preferCurrent ? currSourceId : nbrSourceId;

		if (isLiquidSourceId(emitSourceId)) {
			packedMask &= ~(WATER_LEVEL_MASK_3 << WATER_SHALLOWER_SHIFT);

			if (
				isSameLiquidAt(
					blockArr,
					session.ps,
					session.ps2,
					bx,
					by + 1,
					bz,
					emitSourceId,
				)
			) {
				packedMask |= WATER_ABOVE_MASK;
			}
		}

		const currLight = lightArr[curIdx];
		const nbrLight = lightArr[nbrIdx];
		const maxLight = currLight > nbrLight ? currLight : nbrLight;
		const packedLightOnly = disableAO ? quantizeByteForLOD(maxLight) : maxLight;

		mask[outIndex] = packedMask;
		lightMask[outIndex] = (packedAO & 0xff) | ((packedLightOnly & 0xff) << 8);
		return;
	}

	// ============================================================
	// NORMAL EMISSION PATH
	// ============================================================

	let nbrClosesFace = 0;
	let currClosesFace = 0;

	if (nbrSolid !== 0) {
		if (!nbrShapeInfo) {
			nbrShapeInfo = getShapeInfo(neighborPacked);
		}
		nbrClosesFace = nbrShapeInfo.closedFaceMask & neighborFaceBit;
	}

	if (currSolid !== 0) {
		if (!currShapeInfo) {
			currShapeInfo = getShapeInfo(currentPacked);
		}
		currClosesFace = currShapeInfo.closedFaceMask & currentFaceBit;
	}

	let emitCurrent =
		currParticipates &&
		(nbrSolid === 0 ||
			(nbrTransparent !== 0 && currTransparent === 0) ||
			nbrClosesFace === 0);

	let emitNeighbor =
		nbrParticipates &&
		(currSolid === 0 ||
			(currTransparent !== 0 && nbrTransparent === 0) ||
			currClosesFace === 0);

	// Special case: adjacent columns of the SAME liquid at different levels
	// need a sliver face on the shallower side of the step.
	if (!emitCurrent && !emitNeighbor) {
		if (liquidCurrLevel >= 0 && liquidCurrLevel !== liquidNbrLevel) {
			if (liquidCurrLevel > liquidNbrLevel) {
				emitCurrent = true;
			} else {
				emitNeighbor = true;
			}
		}
	}

	if (!emitCurrent && !emitNeighbor) {
		return;
	}

	let packedMask = 0;
	let packedAO = 0;

	if (emitCurrent && currShapeInfo) {
		packedMask =
			(currentPacked & PACKED_ID_STATE_MASK) |
			(currShapeInfo.isCube ? 0 : NON_CUBE_MASK);

		packedAO = disableAO ? 0 : computeAO(session, nx, ny, nz, uAxis, vAxis);
	} else if (emitNeighbor && nbrShapeInfo) {
		packedMask =
			(neighborPacked & PACKED_ID_STATE_MASK) |
			(nbrShapeInfo.isCube ? 0 : NON_CUBE_MASK) |
			BACK_FACE_MASK;

		packedAO = disableAO ? 0 : computeAO(session, bx, by, bz, uAxis, vAxis);
	} else {
		return;
	}

	// Liquid state bits are only ever packed when the emitting block's source
	// is a liquid. When the opposite side is not water/glass its source ID
	// was never resolved, so fall back to a packed-value resolve for the
	// emitter.
	const emittingSourceId = emitCurrent
		? currSourceId !== -1
			? currSourceId
			: getSourceBlockId(getIdFromCombined(currCombined))
		: nbrSourceId !== -1
			? nbrSourceId
			: getSourceBlockId(getIdFromCombined(nbrCombined));

	const emittingIsLiquid =
		(emitCurrent ? currWaterGlass !== 0 : nbrWaterGlass !== 0) &&
		isLiquidSourceId(emittingSourceId);

	if (emittingIsLiquid) {
		packedMask &= ~(WATER_LEVEL_MASK_3 << WATER_SHALLOWER_SHIFT);

		// waterAbove must reflect the block whose top defines the face.
		// For a level pair the face top is the surface of the taller column
		// (smaller level number), so its above-cell decides the extension.
		let aboveX = bx;
		let aboveY = by;
		let aboveZ = bz;

		if (liquidCurrLevel >= 0 && liquidCurrLevel !== liquidNbrLevel) {
			if (liquidCurrLevel > liquidNbrLevel) {
				// Neighbor is the taller column.
				aboveX = nx;
				aboveY = ny;
				aboveZ = nz;
			}
			// else: current block is taller; keep probing (bx, by, bz).
		} else if (emitNeighbor) {
			aboveX = nx;
			aboveY = ny;
			aboveZ = nz;
		}

		if (
			isSameLiquidAt(
				blockArr,
				session.ps,
				session.ps2,
				aboveX,
				aboveY + 1,
				aboveZ,
				emittingSourceId,
			)
		) {
			packedMask |= WATER_ABOVE_MASK;
		}
	}

	if (liquidCurrLevel >= 0 && liquidCurrLevel !== liquidNbrLevel) {
		let tallerLevel: number;
		let shallowerLevel: number;

		if (liquidCurrLevel > liquidNbrLevel) {
			tallerLevel = liquidCurrLevel;
			shallowerLevel = liquidNbrLevel;
		} else {
			tallerLevel = liquidNbrLevel;
			shallowerLevel = liquidCurrLevel;
		}

		// Bit layout, must match FaceEmitter.decode:
		// tallerLevel -> bits 10-12
		// shallowerLevel -> bits 13-15
		packedMask =
			(packedMask & WATER_PAIR_LEVEL_CLEAR) |
			(tallerLevel << WATER_LEVEL_SHIFT) |
			(shallowerLevel << WATER_SHALLOWER_SHIFT) |
			WATER_LEVEL_PAIR_MASK;
	}

	const currLight = lightArr[curIdx];
	const nbrLight = lightArr[nbrIdx];
	const maxLight = currLight > nbrLight ? currLight : nbrLight;
	const packedLightOnly = disableAO ? quantizeByteForLOD(maxLight) : maxLight;

	mask[outIndex] = packedMask;
	lightMask[outIndex] = (packedAO & 0xff) | ((packedLightOnly & 0xff) << 8);
}

function isSameLiquidAt(
	blockArr: Uint16Array,
	ps: number,
	ps2: number,
	x: number,
	y: number,
	z: number,
	sourceId: number,
): boolean {
	return (
		getSourceBlockId(
			blockArr[x + 1 + (y + 1) * ps + (z + 1) * ps2] & BLOCK_ID_MASK,
		) === sourceId
	);
}
