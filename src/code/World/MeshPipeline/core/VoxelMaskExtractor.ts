// MeshPipeline/core/VoxelMaskExtractor.ts

import { WATER_BLOCK_ID } from "../../Chunk/Worker/ChunkMesherConstants";
import {
	FACE_NX,
	FACE_NY,
	FACE_NZ,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
} from "../../Shape/BlockShapes";
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
import { quantizeLightForLOD } from "./LightPipeline";
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

function clearMask(mask: WritableNumberArray, size: number): void {
	mask.fill(0, 0, size * size);
}

export function extractSliceMaskX(
	session: MeshBuildSession,
	slice: number,
	mask: WritableNumberArray,
	lightMask: WritableNumberArray,
): void {
	const size = session.size;

	if (slice === -1) {
		if (!session.hasNeighborChunk(-1, 0, 0)) {
			clearMask(mask, size);
			return;
		}

		const blockArr = session.block;
		const lightArr = session.light;
		const opaqueArr = session.opaque;
		const disableAO = session.disableAO;
		const ps = session.ps;
		const ps2 = session.ps2;
		const nbrDelta = 1;

		let outIndex = 0;

		for (let z = 0; z < size; z++) {
			const zBase = (z + 1) * ps2;

			for (let y = 0; y < size; y++) {
				const curIdx = (y + 1) * ps + zBase;
				const nbrIdx = curIdx + nbrDelta;

				if (opaqueArr[curIdx] & opaqueArr[nbrIdx]) {
					mask[outIndex++] = 0;
					continue;
				}

				processCell(
					session,
					blockArr,
					lightArr,
					disableAO,
					-1,
					y,
					z,
					0,
					y,
					z,
					curIdx,
					nbrIdx,
					1,
					2,
					FACE_PX,
					FACE_NX,
					outIndex,
					mask,
					lightMask,
				);

				outIndex++;
			}
		}

		return;
	}

	if (slice === size - 1) {
		clearMask(mask, size);
		return;
	}

	const blockArr = session.block;
	const lightArr = session.light;
	const opaqueArr = session.opaque;
	const disableAO = session.disableAO;
	const ps = session.ps;
	const ps2 = session.ps2;
	const x = slice;
	const nx = slice + 1;
	const xOffset = slice + 1;
	const nbrDelta = 1;

	let outIndex = 0;

	for (let z = 0; z < size; z++) {
		const zBase = (z + 1) * ps2;

		for (let y = 0; y < size; y++) {
			const curIdx = xOffset + (y + 1) * ps + zBase;
			const nbrIdx = curIdx + nbrDelta;

			if (opaqueArr[curIdx] & opaqueArr[nbrIdx]) {
				mask[outIndex++] = 0;
				continue;
			}

			processCell(
				session,
				blockArr,
				lightArr,
				disableAO,
				x,
				y,
				z,
				nx,
				y,
				z,
				curIdx,
				nbrIdx,
				1,
				2,
				FACE_PX,
				FACE_NX,
				outIndex,
				mask,
				lightMask,
			);

			outIndex++;
		}
	}
}

export function extractSliceMaskY(
	session: MeshBuildSession,
	slice: number,
	mask: WritableNumberArray,
	lightMask: WritableNumberArray,
): void {
	const size = session.size;

	if (slice === -1) {
		if (!session.hasNeighborChunk(0, -1, 0)) {
			clearMask(mask, size);
			return;
		}

		const blockArr = session.block;
		const lightArr = session.light;
		const opaqueArr = session.opaque;
		const disableAO = session.disableAO;
		const ps = session.ps;
		const ps2 = session.ps2;
		const nbrDelta = ps;

		let outIndex = 0;

		// Axis Y uses u = Z and v = X, matching the original permutation.
		for (let x = 0; x < size; x++) {
			const xOffset = x + 1;

			for (let z = 0; z < size; z++) {
				const curIdx = xOffset + (z + 1) * ps2;
				const nbrIdx = curIdx + nbrDelta;

				if (opaqueArr[curIdx] & opaqueArr[nbrIdx]) {
					mask[outIndex++] = 0;
					continue;
				}

				processCell(
					session,
					blockArr,
					lightArr,
					disableAO,
					x,
					-1,
					z,
					x,
					0,
					z,
					curIdx,
					nbrIdx,
					2,
					0,
					FACE_PY,
					FACE_NY,
					outIndex,
					mask,
					lightMask,
				);

				outIndex++;
			}
		}

		return;
	}

	if (slice === size - 1) {
		clearMask(mask, size);
		return;
	}

	const blockArr = session.block;
	const lightArr = session.light;
	const opaqueArr = session.opaque;
	const disableAO = session.disableAO;
	const ps = session.ps;
	const ps2 = session.ps2;
	const y = slice;
	const ny = slice + 1;
	const yOffset = (slice + 1) * ps;
	const nbrDelta = ps;

	let outIndex = 0;

	// Axis Y uses u = Z and v = X, matching the original permutation.
	for (let x = 0; x < size; x++) {
		const xOffset = x + 1;

		for (let z = 0; z < size; z++) {
			const curIdx = xOffset + yOffset + (z + 1) * ps2;
			const nbrIdx = curIdx + nbrDelta;

			if (opaqueArr[curIdx] & opaqueArr[nbrIdx]) {
				mask[outIndex++] = 0;
				continue;
			}

			processCell(
				session,
				blockArr,
				lightArr,
				disableAO,
				x,
				y,
				z,
				x,
				ny,
				z,
				curIdx,
				nbrIdx,
				2,
				0,
				FACE_PY,
				FACE_NY,
				outIndex,
				mask,
				lightMask,
			);

			outIndex++;
		}
	}
}

export function extractSliceMaskZ(
	session: MeshBuildSession,
	slice: number,
	mask: WritableNumberArray,
	lightMask: WritableNumberArray,
): void {
	const size = session.size;

	if (slice === -1) {
		if (!session.hasNeighborChunk(0, 0, -1)) {
			clearMask(mask, size);
			return;
		}

		const blockArr = session.block;
		const lightArr = session.light;
		const opaqueArr = session.opaque;
		const disableAO = session.disableAO;
		const ps = session.ps;
		const ps2 = session.ps2;
		const nbrDelta = ps2;

		let outIndex = 0;

		for (let y = 0; y < size; y++) {
			const yBase = (y + 1) * ps;

			for (let x = 0; x < size; x++) {
				const curIdx = x + 1 + yBase;
				const nbrIdx = curIdx + nbrDelta;

				if (opaqueArr[curIdx] & opaqueArr[nbrIdx]) {
					mask[outIndex++] = 0;
					continue;
				}

				processCell(
					session,
					blockArr,
					lightArr,
					disableAO,
					x,
					y,
					-1,
					x,
					y,
					0,
					curIdx,
					nbrIdx,
					0,
					1,
					FACE_PZ,
					FACE_NZ,
					outIndex,
					mask,
					lightMask,
				);

				outIndex++;
			}
		}

		return;
	}

	if (slice === size - 1) {
		clearMask(mask, size);
		return;
	}

	const blockArr = session.block;
	const lightArr = session.light;
	const opaqueArr = session.opaque;
	const disableAO = session.disableAO;
	const ps = session.ps;
	const ps2 = session.ps2;
	const z = slice;
	const nz = slice + 1;
	const zOffset = (slice + 1) * ps2;
	const nbrDelta = ps2;

	let outIndex = 0;

	for (let y = 0; y < size; y++) {
		const yBase = (y + 1) * ps;

		for (let x = 0; x < size; x++) {
			const curIdx = x + 1 + yBase + zOffset;
			const nbrIdx = curIdx + nbrDelta;

			if (opaqueArr[curIdx] & opaqueArr[nbrIdx]) {
				mask[outIndex++] = 0;
				continue;
			}

			processCell(
				session,
				blockArr,
				lightArr,
				disableAO,
				x,
				y,
				z,
				x,
				y,
				nz,
				curIdx,
				nbrIdx,
				0,
				1,
				FACE_PZ,
				FACE_NZ,
				outIndex,
				mask,
				lightMask,
			);

			outIndex++;
		}
	}
}

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
// a slice matches the corresponding extractSliceMask* exactly so greedyMesh's
// merge loop is unchanged apart from the base offset.
//
// Slice -1 compares the padded border layer against the first interior layer
// and is only computed when the neighbor chunk exists; slice size-1 never
// emits (no chunk beyond the +axis boundary). Both stay zero via pre-fill.
// ---------------------------------------------------------------------------

export function extractAllSliceMasksX(
	session: MeshBuildSession,
	maskBank: WritableNumberArray,
	lightBank: WritableNumberArray,
): void {
	const size = session.size;
	const step = session.lodStep;
	const gridSize =
		session.meshGridSize > 0 ? session.meshGridSize : size / step;
	const area = gridSize * gridSize;

	maskBank.fill(0, 0, (gridSize + 1) * area);
	lightBank.fill(0, 0, (gridSize + 1) * area);

	const hasNegNeighbor = session.hasNeighborChunk(-1, 0, 0);

	const blockArr = session.block;
	const lightArr = session.light;
	const opaqueArr = session.opaque;
	const disableAO = session.disableAO;
	const ps = session.ps;
	const ps2 = session.ps2;

	// Downsampled mode: one mask cell per lodStep^3 voxel region. Each
	// adjacency pair samples the representative (region-origin) voxels of
	// the current and neighboring regions; padded-grid reads stay exact so
	// chunk-border faces remain correct.
	for (let cz = 0; cz < gridSize; cz++) {
		const vz = cz * step;
		const zBase = (vz + 1) * ps2;
		const outCell = cz * gridSize;

		for (let cy = 0; cy < gridSize; cy++) {
			const vy = cy * step;
			const rowIdx = (vy + 1) * ps + zBase;

			for (let cs = -1; cs < gridSize - 1; cs++) {
				if (cs === -1 && !hasNegNeighbor) continue;

				const bx = cs * step;
				const curIdx = bx + 1 + rowIdx;
				const nbrIdx = curIdx + step;

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
						(cs + 1) * area + outCell + cy,
						maskBank,
						lightBank,
					);
				}
			}
		}
	}
}

export function extractAllSliceMasksY(
	session: MeshBuildSession,
	maskBank: WritableNumberArray,
	lightBank: WritableNumberArray,
): void {
	const size = session.size;
	const step = session.lodStep;
	const gridSize =
		session.meshGridSize > 0 ? session.meshGridSize : size / step;
	const area = gridSize * gridSize;

	maskBank.fill(0, 0, (gridSize + 1) * area);
	lightBank.fill(0, 0, (gridSize + 1) * area);

	const hasNegNeighbor = session.hasNeighborChunk(0, -1, 0);

	const blockArr = session.block;
	const lightArr = session.light;
	const opaqueArr = session.opaque;
	const disableAO = session.disableAO;
	const ps = session.ps;
	const ps2 = session.ps2;

	// Axis Y uses u = Z and v = X (mask index = x * gridSize + z), matching
	// the per-slice extractor's permutation. Downsampled pairs sample the
	// region-origin voxels one y-step apart.
	const yStep = ps * step;

	for (let cvx = 0; cvx < gridSize; cvx++) {
		const vx = cvx * step;
		const xOffset = vx + 1;

		for (let cs = -1; cs < gridSize - 1; cs++) {
			if (cs === -1 && !hasNegNeighbor) continue;

			const nyVox = (cs + 1) * step;
			const by = nyVox - step;
			const curRowBase = (by + 1) * ps;
			const outSliceBase = (cs + 1) * area;

			for (let cvz = 0; cvz < gridSize; cvz++) {
				const vz = cvz * step;
				const zBase = (vz + 1) * ps2;
				const curIdx = xOffset + curRowBase + zBase;
				const nbrIdx = curIdx + yStep;

				if ((opaqueArr[curIdx] & opaqueArr[nbrIdx]) === 0) {
					processCell(
						session,
						blockArr,
						lightArr,
						disableAO,
						vx,
						by,
						vz,
						vx,
						nyVox,
						vz,
						curIdx,
						nbrIdx,
						2,
						0,
						FACE_PY,
						FACE_NY,
						outSliceBase + cvz + cvx * gridSize,
						maskBank,
						lightBank,
					);
				}
			}
		}
	}
}

export function extractAllSliceMasksZ(
	session: MeshBuildSession,
	maskBank: WritableNumberArray,
	lightBank: WritableNumberArray,
): void {
	const size = session.size;
	const step = session.lodStep;
	const gridSize =
		session.meshGridSize > 0 ? session.meshGridSize : size / step;
	const area = gridSize * gridSize;

	maskBank.fill(0, 0, (gridSize + 1) * area);
	lightBank.fill(0, 0, (gridSize + 1) * area);

	const hasNegNeighbor = session.hasNeighborChunk(0, 0, -1);

	const blockArr = session.block;
	const lightArr = session.light;
	const opaqueArr = session.opaque;
	const disableAO = session.disableAO;
	const ps = session.ps;
	const ps2 = session.ps2;

	// Axis Z uses u = X and v = Y (mask index = y * gridSize + x).
	const zStep = ps2 * step;

	for (let cvy = 0; cvy < gridSize; cvy++) {
		const vy = cvy * step;
		const yBase = (vy + 1) * ps;

		for (let cs = -1; cs < gridSize - 1; cs++) {
			if (cs === -1 && !hasNegNeighbor) continue;

			const nzVox = (cs + 1) * step;
			const bz = nzVox - step;
			const curZBase = (bz + 1) * ps2;
			const outSliceBase = (cs + 1) * area;

			for (let cvx = 0; cvx < gridSize; cvx++) {
				const vx = cvx * step;
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
						outSliceBase + cvy * gridSize + cvx,
						maskBank,
						lightBank,
					);
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

	// Air-air.
	if ((currentPacked | neighborPacked) === 0) {
		mask[outIndex] = 0;
		return;
	}

	const currCombined = currentPacked ? getCachedFlagsAndId(currentPacked) : 0;
	const nbrCombined = neighborPacked ? getCachedFlagsAndId(neighborPacked) : 0;

	const currFlags = getFlagsFromCombined(currCombined);
	const nbrFlags = getFlagsFromCombined(nbrCombined);

	const currSolid = currFlags & FLAG_SOLID;
	const nbrSolid = nbrFlags & FLAG_SOLID;

	// No solid blocks means no face.
	if ((currSolid | nbrSolid) === 0) {
		mask[outIndex] = 0;
		return;
	}

	const currGreedy = currFlags & FLAG_GREEDY;
	const nbrGreedy = nbrFlags & FLAG_GREEDY;

	const currParticipates = currSolid !== 0 && currGreedy !== 0;
	const nbrParticipates = nbrSolid !== 0 && nbrGreedy !== 0;

	// If neither solid side can be emitted through greedy meshing, only a
	// closed-face occlusion test could have mattered. Since no side emits,
	// this cell contributes nothing.
	if (!currParticipates && !nbrParticipates) {
		mask[outIndex] = 0;
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
		mask[outIndex] = 0;
		return;
	}

	let currId = -1;
	let nbrId = -1;

	// IDs are only needed for water/glass interface and water-level behavior.
	if (
		currSolid !== 0 &&
		nbrSolid !== 0 &&
		currWaterGlass !== 0 &&
		nbrWaterGlass !== 0
	) {
		currId = getIdFromCombined(currCombined);
		nbrId = getIdFromCombined(nbrCombined);

		// Same water/glass cube state with same level is hidden.
		if (bothCube && currId === nbrId) {
			const currLevel =
				(currentPacked >>> WATER_LEVEL_SHIFT) & WATER_LEVEL_MASK_4;
			const nbrLevel =
				(neighborPacked >>> WATER_LEVEL_SHIFT) & WATER_LEVEL_MASK_4;

			if (currLevel === nbrLevel) {
				mask[outIndex] = 0;
				return;
			}
		}
	}

	let preserveInterface = 0;

	if (
		currSolid !== 0 &&
		nbrSolid !== 0 &&
		currTransparent !== 0 &&
		nbrTransparent !== 0 &&
		currWaterGlass !== 0 &&
		nbrWaterGlass !== 0
	) {
		if (currId < 0) currId = getIdFromCombined(currCombined);
		if (nbrId < 0) nbrId = getIdFromCombined(nbrCombined);

		if (currId !== nbrId) {
			preserveInterface = 1;
		}
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
			mask[outIndex] = 0;
			return;
		}
	}

	// ============================================================
	// TRANSPARENT INTERFACE EMISSION
	// ============================================================

	if (preserveInterface) {
		if (currId < 0) currId = getIdFromCombined(currCombined);
		if (nbrId < 0) nbrId = getIdFromCombined(nbrCombined);

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
			mask[outIndex] = 0;
			return;
		}

		if ((packedMask & BLOCK_ID_MASK) === WATER_BLOCK_ID) {
			packedMask &= ~(WATER_LEVEL_MASK_3 << WATER_SHALLOWER_SHIFT);

			if (isWaterAt(blockArr, session.ps, session.ps2, bx, by + 1, bz)) {
				packedMask |= WATER_ABOVE_MASK;
			}
		}

		const currLight = lightArr[curIdx];
		const nbrLight = lightArr[nbrIdx];
		const maxLight = currLight > nbrLight ? currLight : nbrLight;
		const packedLightOnly = disableAO
			? quantizeLightForLOD(maxLight, true)
			: maxLight & 0xff;

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

	let waterCurrLevel = -1;
	let waterNbrLevel = -1;

	if (
		currWaterGlass !== 0 &&
		nbrWaterGlass !== 0 &&
		currSolid !== 0 &&
		nbrSolid !== 0
	) {
		if (currId < 0) currId = getIdFromCombined(currCombined);
		if (nbrId < 0) nbrId = getIdFromCombined(nbrCombined);

		if (currId === WATER_BLOCK_ID && nbrId === WATER_BLOCK_ID) {
			waterCurrLevel =
				(currentPacked >>> WATER_LEVEL_SHIFT) & WATER_LEVEL_MASK_4;
			waterNbrLevel =
				(neighborPacked >>> WATER_LEVEL_SHIFT) & WATER_LEVEL_MASK_4;
		}
	}

	// Special case: adjacent water columns of different levels need a sliver.
	if (!emitCurrent && !emitNeighbor) {
		if (waterCurrLevel >= 0 && waterCurrLevel !== waterNbrLevel) {
			if (waterCurrLevel > waterNbrLevel) {
				emitCurrent = true;
			} else {
				emitNeighbor = true;
			}
		}
	}

	if (!emitCurrent && !emitNeighbor) {
		mask[outIndex] = 0;
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
		mask[outIndex] = 0;
		return;
	}

	if ((packedMask & BLOCK_ID_MASK) === WATER_BLOCK_ID) {
		packedMask &= ~(WATER_LEVEL_MASK_3 << WATER_SHALLOWER_SHIFT);

		// waterAbove must reflect the block whose top defines the face.
		// For a level-pair face that is the shallower column.
		// Otherwise it is the emitting block.
		let aboveX = bx;
		let aboveY = by;
		let aboveZ = bz;

		if (waterCurrLevel >= 0 && waterCurrLevel !== waterNbrLevel) {
			if (waterCurrLevel > waterNbrLevel) {
				aboveX = nx;
				aboveY = ny;
				aboveZ = nz;
			}
		} else if (emitNeighbor) {
			aboveX = nx;
			aboveY = ny;
			aboveZ = nz;
		}

		if (
			isWaterAt(blockArr, session.ps, session.ps2, aboveX, aboveY + 1, aboveZ)
		) {
			packedMask |= WATER_ABOVE_MASK;
		}
	}

	if (waterCurrLevel >= 0 && waterCurrLevel !== waterNbrLevel) {
		let tallerLevel: number;
		let shallowerLevel: number;

		if (waterCurrLevel > waterNbrLevel) {
			tallerLevel = waterCurrLevel;
			shallowerLevel = waterNbrLevel;
		} else {
			tallerLevel = waterNbrLevel;
			shallowerLevel = waterCurrLevel;
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
	const packedLightOnly = disableAO
		? quantizeLightForLOD(maxLight, true)
		: maxLight & 0xff;

	mask[outIndex] = packedMask;
	lightMask[outIndex] = (packedAO & 0xff) | ((packedLightOnly & 0xff) << 8);
}

function isWaterAt(
	blockArr: Uint16Array,
	ps: number,
	ps2: number,
	x: number,
	y: number,
	z: number,
): boolean {
	return (
		(blockArr[x + 1 + (y + 1) * ps + (z + 1) * ps2] & BLOCK_ID_MASK) ===
		WATER_BLOCK_ID
	);
}
