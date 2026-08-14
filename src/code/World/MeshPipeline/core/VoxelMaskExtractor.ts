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

/**
 * Extracts the 2D slice mask for greedy meshing on one axis.
 *
 * IMPORTANT:
 * - only greedy-compatible blocks may emit through this path
 * - non-greedy custom shapes may still occlude neighboring faces
 * - custom shapes themselves should be emitted in a separate custom-shape pass
 *
 * Stateless: all state lives on the MeshBuildSession passed in.
 */
export function extractSliceMask(
	session: MeshBuildSession,
	axis: number,
	slice: number,
	mask: WritableNumberArray,
	lightMask: WritableNumberArray,
): void {
	if (axis === 0) {
		extractSliceMaskX(session, slice, mask, lightMask);
	} else if (axis === 1) {
		extractSliceMaskY(session, slice, mask, lightMask);
	} else {
		extractSliceMaskZ(session, slice, mask, lightMask);
	}
}

function clearMask(mask: WritableNumberArray, size: number): void {
	mask.fill(0, 0, size * size);
}

function extractSliceMaskX(
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

function extractSliceMaskY(
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

function extractSliceMaskZ(
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
	if (!currentPacked && !neighborPacked) {
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
	if (!(currSolid | nbrSolid)) {
		mask[outIndex] = 0;
		return;
	}

	const currTransparent = currFlags & FLAG_TRANSPARENT;
	const nbrTransparent = nbrFlags & FLAG_TRANSPARENT;

	const currGreedy = currFlags & FLAG_GREEDY;
	const nbrGreedy = nbrFlags & FLAG_GREEDY;

	const currPartial = currFlags & FLAG_PARTIAL;
	const nbrPartial = nbrFlags & FLAG_PARTIAL;

	const currWaterGlass = currFlags & FLAG_WATER_GLASS;
	const nbrWaterGlass = nbrFlags & FLAG_WATER_GLASS;

	const currParticipates = currSolid && currGreedy;
	const nbrParticipates = nbrSolid && nbrGreedy;

	// Two opaque participating full cubes never produce a visible face.
	const bothCube =
		currParticipates && nbrParticipates && !currPartial && !nbrPartial;

	if (bothCube && !currTransparent && !nbrTransparent) {
		mask[outIndex] = 0;
		return;
	}

	const currId = getIdFromCombined(currCombined);
	const nbrId = getIdFromCombined(nbrCombined);

	// Preserve only transparent water/glass interfaces with different IDs.
	let preserveInterface = 0;

	if (
		currSolid &&
		nbrSolid &&
		currTransparent &&
		nbrTransparent &&
		currWaterGlass &&
		nbrWaterGlass &&
		currId !== nbrId
	) {
		preserveInterface = 1;
	}

	// Same water level against same water block produces no face.
	if (bothCube && currWaterGlass && nbrWaterGlass && currId === nbrId) {
		const currLevel = (currentPacked >> WATER_LEVEL_SHIFT) & WATER_LEVEL_MASK_4;
		const nbrLevel = (neighborPacked >> WATER_LEVEL_SHIFT) & WATER_LEVEL_MASK_4;

		if (currLevel === nbrLevel) {
			mask[outIndex] = 0;
			return;
		}
	}

	let currShapeInfo: BlockShapeInfo | null = null;
	let nbrShapeInfo: BlockShapeInfo | null = null;

	// Shape lookup is skipped for the common cube/cube path.
	if (!bothCube) {
		let currCloses = 0;
		let nbrCloses = 0;

		if (currSolid) {
			currShapeInfo = getShapeInfo(currentPacked);
			currCloses = currShapeInfo.closedFaceMask & currentFaceBit;
		}

		if (nbrSolid) {
			nbrShapeInfo = getShapeInfo(neighborPacked);
			nbrCloses = nbrShapeInfo.closedFaceMask & neighborFaceBit;
		}

		if (!preserveInterface && currCloses && nbrCloses) {
			mask[outIndex] = 0;
			return;
		}
	}

	const currLight = lightArr[curIdx];
	const nbrLight = lightArr[nbrIdx];
	const maxLight = currLight > nbrLight ? currLight : nbrLight;

	const packedLightOnly = disableAO
		? quantizeLightForLOD(maxLight, true)
		: maxLight & 0xff;

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
			if (!currShapeInfo && currSolid) {
				currShapeInfo = getShapeInfo(currentPacked);
			}

			if (!currShapeInfo) {
				mask[outIndex] = 0;
				return;
			}

			packedMask =
				(currentPacked & PACKED_ID_STATE_MASK) |
				(currShapeInfo.isCube ? 0 : NON_CUBE_MASK);

			packedAO = disableAO ? 0 : computeAO(session, nx, ny, nz, uAxis, vAxis);
		} else if (!preferCurrent && nbrParticipates) {
			if (!nbrShapeInfo && nbrSolid) {
				nbrShapeInfo = getShapeInfo(neighborPacked);
			}

			if (!nbrShapeInfo) {
				mask[outIndex] = 0;
				return;
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

		mask[outIndex] = packedMask;
		lightMask[outIndex] = (packedAO & 0xff) | ((packedLightOnly & 0xff) << 8);
		return;
	}

	// ============================================================
	// NORMAL EMISSION PATH
	// ============================================================

	if (!nbrShapeInfo && nbrSolid) {
		nbrShapeInfo = getShapeInfo(neighborPacked);
	}

	if (!currShapeInfo && currSolid) {
		currShapeInfo = getShapeInfo(currentPacked);
	}

	const nbrClosesFace =
		nbrSolid && nbrShapeInfo && nbrShapeInfo.closedFaceMask & neighborFaceBit;

	const currClosesFace =
		currSolid && currShapeInfo && currShapeInfo.closedFaceMask & currentFaceBit;

	let emitCurrent =
		currParticipates &&
		(!nbrSolid || (nbrTransparent && !currTransparent) || !nbrClosesFace);

	let emitNeighbor =
		nbrParticipates &&
		(!currSolid || (currTransparent && !nbrTransparent) || !currClosesFace);

	let waterCurrLevel = -1;
	let waterNbrLevel = -1;

	if (
		currWaterGlass &&
		nbrWaterGlass &&
		currId === WATER_BLOCK_ID &&
		nbrId === WATER_BLOCK_ID
	) {
		waterCurrLevel = (currentPacked >> WATER_LEVEL_SHIFT) & WATER_LEVEL_MASK_4;
		waterNbrLevel = (neighborPacked >> WATER_LEVEL_SHIFT) & WATER_LEVEL_MASK_4;
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
		//   tallerLevel    -> bits 10-12
		//   shallowerLevel -> bits 13-15
		packedMask =
			(packedMask & WATER_PAIR_LEVEL_CLEAR) |
			(tallerLevel << WATER_LEVEL_SHIFT) |
			(shallowerLevel << WATER_SHALLOWER_SHIFT) |
			WATER_LEVEL_PAIR_MASK;
	}

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
