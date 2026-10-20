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

const NON_CUBE_MASK = 0x40000000;
const BACK_FACE_MASK = 0x80000000;

const PACKED_ID_STATE_MASK = 0x0000ffff;
const BLOCK_ID_MASK = 0x03ff;

const WATER_ABOVE_MASK = 0x00010000;
const WATER_LEVEL_PAIR_MASK = 0x00020000;

const WATER_LEVEL_SHIFT = 10;
const WATER_SHALLOWER_SHIFT = 13;
const WATER_LEVEL_MASK_4 = 0x0f;
const WATER_LEVEL_MASK_3 = 0x07;

const WATER_LEVEL_BITS =
	(WATER_LEVEL_MASK_3 << WATER_LEVEL_SHIFT) |
	(WATER_LEVEL_MASK_3 << WATER_SHALLOWER_SHIFT);

const WATER_PAIR_LEVEL_CLEAR = ~WATER_LEVEL_BITS;

type WritableNumberArray = number[] | Int32Array | Uint16Array | Uint32Array;

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
	const bankLength = (gridSize + 1) * area;

	maskBank.fill(0, 0, bankLength);

	const occupancy = session.ensureSliceOccupancy(gridSize + 1);
	occupancy.fill(0, 0, gridSize + 1);

	const hasPositiveNeighbor = session.hasNeighborChunk(1, 0, 0);
	const hasNegativeNeighbor = session.hasNeighborChunk(-1, 0, 0);

	const downsampled = step > 1;
	const borderSkirtSides = session.borderSkirtSides;

	const skirtOwnsPositive = downsampled && (borderSkirtSides & 2) !== 0;
	const skirtOwnsNegative = downsampled && (borderSkirtSides & 1) !== 0;

	const block = session.block;
	const light = session.light;
	const opaque = session.opaque;
	const disableAO = session.disableAO;

	const ps = session.ps;
	const ps2 = session.ps2;

	const blocksChanged = session.blocksChangedThisBuild;

	if (blocksChanged && !hasNegativeNeighbor && !skirtOwnsNegative) {
		let occupied = 0;

		for (let cz = 0, vz = 0; cz < gridSize; cz++, vz += step) {
			const zBase = (vz + 1) * ps2;
			const outputRow = cz * gridSize;

			for (let cy = 0, vy = 0; cy < gridSize; cy++, vy += step) {
				const currentIndex = 1 + (vy + 1) * ps + zBase;
				const neighborIndex = currentIndex - 1;
				const outputIndex = outputRow + cy;

				if ((opaque[currentIndex] & opaque[neighborIndex]) !== 0) {
					continue;
				}

				processCell(
					session,
					block,
					light,
					disableAO,
					-1,
					vy,
					vz,
					0,
					vy,
					vz,
					neighborIndex,
					currentIndex,
					1,
					2,
					FACE_PX,
					FACE_NX,
					outputIndex,
					maskBank,
					lightBank,
				);

				occupied |= maskBank[outputIndex];
			}
		}

		occupancy[0] = occupied !== 0 ? 1 : 0;
	}

	const emitPositiveBoundary =
		(blocksChanged || hasPositiveNeighbor) && !skirtOwnsPositive;

	for (let cz = 0, vz = 0; cz < gridSize; cz++, vz += step) {
		const zBase = (vz + 1) * ps2;
		const outputCell = cz * gridSize;

		for (let cy = 0, vy = 0; cy < gridSize; cy++, vy += step) {
			const rowBase = (vy + 1) * ps + zBase + 1;

			for (let slice = 0, bx = 0; slice < gridSize - 1; slice++, bx += step) {
				const currentIndex = rowBase + bx;
				const neighborIndex = currentIndex + step;
				const outputIndex = (slice + 1) * area + outputCell + cy;

				if ((opaque[currentIndex] & opaque[neighborIndex]) !== 0) {
					continue;
				}

				processCell(
					session,
					block,
					light,
					disableAO,
					bx,
					vy,
					vz,
					bx + step,
					vy,
					vz,
					currentIndex,
					neighborIndex,
					1,
					2,
					FACE_PX,
					FACE_NX,
					outputIndex,
					maskBank,
					lightBank,
				);

				if (maskBank[outputIndex] !== 0) {
					occupancy[slice + 1] = 1;
				}
			}

			if (!emitPositiveBoundary) {
				continue;
			}

			const bx = (gridSize - 1) * step;
			const currentIndex = rowBase + bx;
			const neighborIndex = currentIndex + step;
			const outputIndex = gridSize * area + outputCell + cy;

			if ((opaque[currentIndex] & opaque[neighborIndex]) !== 0) {
				continue;
			}

			processCell(
				session,
				block,
				light,
				disableAO,
				bx,
				vy,
				vz,
				size,
				vy,
				vz,
				currentIndex,
				neighborIndex,
				1,
				2,
				FACE_PX,
				FACE_NX,
				outputIndex,
				maskBank,
				lightBank,
			);

			if (maskBank[outputIndex] !== 0) {
				occupancy[gridSize] = 1;
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

	const block = session.block;
	const light = session.light;
	const opaque = session.opaque;
	const disableAO = session.disableAO;

	const ps = session.ps;
	const ps2 = session.ps2;
	const yStep = ps * step;

	for (let slice = 0, by = 0; slice < gridSize - 1; slice++, by += step) {
		const neighborY = by + step;
		const inputYBase = (by + 1) * ps;
		const outputSliceBase = (slice + 1) * area;

		let occupied = 0;

		for (let cz = 0, vz = 0; cz < gridSize; cz++, vz += step) {
			const inputBase = inputYBase + (vz + 1) * ps2 + 1;
			let outputIndex = outputSliceBase + cz;

			for (let cx = 0, vx = 0; cx < gridSize; cx++, vx += step) {
				const currentIndex = inputBase + vx;
				const neighborIndex = currentIndex + yStep;

				if ((opaque[currentIndex] & opaque[neighborIndex]) === 0) {
					processCell(
						session,
						block,
						light,
						disableAO,
						vx,
						by,
						vz,
						vx,
						neighborY,
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

					occupied |= maskBank[outputIndex];
				}

				outputIndex += gridSize;
			}
		}

		occupancy[slice + 1] = occupied !== 0 ? 1 : 0;
	}

	if (!session.blocksChangedThisBuild && !session.hasNeighborChunk(0, 1, 0)) {
		return;
	}

	const by = (gridSize - 1) * step;
	const inputYBase = (by + 1) * ps;
	const outputSliceBase = gridSize * area;

	let occupied = 0;

	for (let cz = 0, vz = 0; cz < gridSize; cz++, vz += step) {
		const inputBase = inputYBase + (vz + 1) * ps2 + 1;
		let outputIndex = outputSliceBase + cz;

		for (let cx = 0, vx = 0; cx < gridSize; cx++, vx += step) {
			const currentIndex = inputBase + vx;
			const neighborIndex = currentIndex + yStep;

			if ((opaque[currentIndex] & opaque[neighborIndex]) === 0) {
				processCell(
					session,
					block,
					light,
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

				occupied |= maskBank[outputIndex];
			}

			outputIndex += gridSize;
		}
	}

	occupancy[gridSize] = occupied !== 0 ? 1 : 0;
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
	const bankLength = (gridSize + 1) * area;

	maskBank.fill(0, 0, bankLength);

	const occupancy = session.ensureSliceOccupancy(gridSize + 1);
	occupancy.fill(0, 0, gridSize + 1);

	const hasPositiveNeighbor = session.hasNeighborChunk(0, 0, 1);
	const hasNegativeNeighbor = session.hasNeighborChunk(0, 0, -1);

	const downsampled = step > 1;
	const borderSkirtSides = session.borderSkirtSides;

	const skirtOwnsPositive = downsampled && (borderSkirtSides & 8) !== 0;
	const skirtOwnsNegative = downsampled && (borderSkirtSides & 4) !== 0;

	const block = session.block;
	const light = session.light;
	const opaque = session.opaque;
	const disableAO = session.disableAO;

	const ps = session.ps;
	const ps2 = session.ps2;
	const zStep = ps2 * step;

	const blocksChanged = session.blocksChangedThisBuild;

	if (blocksChanged && !hasNegativeNeighbor && !skirtOwnsNegative) {
		let occupied = 0;

		for (let cy = 0, vy = 0; cy < gridSize; cy++, vy += step) {
			const yBase = (vy + 1) * ps;
			const outputRow = cy * gridSize;

			for (let cx = 0, vx = 0; cx < gridSize; cx++, vx += step) {
				const currentIndex = vx + 1 + yBase + ps2;
				const neighborIndex = currentIndex - ps2;
				const outputIndex = outputRow + cx;

				if ((opaque[currentIndex] & opaque[neighborIndex]) !== 0) {
					continue;
				}

				processCell(
					session,
					block,
					light,
					disableAO,
					vx,
					vy,
					-1,
					vx,
					vy,
					0,
					neighborIndex,
					currentIndex,
					0,
					1,
					FACE_PZ,
					FACE_NZ,
					outputIndex,
					maskBank,
					lightBank,
				);

				occupied |= maskBank[outputIndex];
			}
		}

		occupancy[0] = occupied !== 0 ? 1 : 0;
	}

	const emitPositiveBoundary =
		(blocksChanged || hasPositiveNeighbor) && !skirtOwnsPositive;

	for (let cy = 0, vy = 0; cy < gridSize; cy++, vy += step) {
		const yBase = (vy + 1) * ps;
		const outputRow = cy * gridSize;

		for (let slice = 0, bz = 0; slice < gridSize - 1; slice++, bz += step) {
			const neighborZ = bz + step;
			const inputBase = yBase + (bz + 1) * ps2 + 1;
			const outputSliceBase = (slice + 1) * area + outputRow;

			let occupied = occupancy[slice + 1];

			for (let cx = 0, vx = 0; cx < gridSize; cx++, vx += step) {
				const currentIndex = inputBase + vx;
				const neighborIndex = currentIndex + zStep;
				const outputIndex = outputSliceBase + cx;

				if ((opaque[currentIndex] & opaque[neighborIndex]) !== 0) {
					continue;
				}

				processCell(
					session,
					block,
					light,
					disableAO,
					vx,
					vy,
					bz,
					vx,
					vy,
					neighborZ,
					currentIndex,
					neighborIndex,
					0,
					1,
					FACE_PZ,
					FACE_NZ,
					outputIndex,
					maskBank,
					lightBank,
				);

				occupied |= maskBank[outputIndex];
			}

			occupancy[slice + 1] = occupied !== 0 ? 1 : 0;
		}

		if (!emitPositiveBoundary) {
			continue;
		}

		const bz = (gridSize - 1) * step;
		const inputBase = yBase + (bz + 1) * ps2 + 1;
		const outputSliceBase = gridSize * area + outputRow;

		let occupied = occupancy[gridSize];

		for (let cx = 0, vx = 0; cx < gridSize; cx++, vx += step) {
			const currentIndex = inputBase + vx;
			const neighborIndex = currentIndex + zStep;
			const outputIndex = outputSliceBase + cx;

			if ((opaque[currentIndex] & opaque[neighborIndex]) !== 0) {
				continue;
			}

			processCell(
				session,
				block,
				light,
				disableAO,
				vx,
				vy,
				bz,
				vx,
				vy,
				size,
				currentIndex,
				neighborIndex,
				0,
				1,
				FACE_PZ,
				FACE_NZ,
				outputIndex,
				maskBank,
				lightBank,
			);

			occupied |= maskBank[outputIndex];
		}

		occupancy[gridSize] = occupied !== 0 ? 1 : 0;
	}
}

function processCell(
	session: MeshBuildSession,
	block: Uint16Array,
	light: Uint8Array,
	disableAO: boolean,
	bx: number,
	by: number,
	bz: number,
	nx: number,
	ny: number,
	nz: number,
	currentIndex: number,
	neighborIndex: number,
	uAxis: number,
	vAxis: number,
	currentFaceBit: number,
	neighborFaceBit: number,
	outputIndex: number,
	mask: WritableNumberArray,
	lightMask: WritableNumberArray,
): void {
	const currentPacked = block[currentIndex];
	const neighborPacked = block[neighborIndex];

	if ((currentPacked | neighborPacked) === 0) {
		return;
	}

	const currentCombined =
		currentPacked === 0 ? 0 : getCachedFlagsAndId(currentPacked);

	const neighborCombined =
		neighborPacked === 0 ? 0 : getCachedFlagsAndId(neighborPacked);

	const currentFlags = getFlagsFromCombined(currentCombined);
	const neighborFlags = getFlagsFromCombined(neighborCombined);

	const currentSolid = currentFlags & FLAG_SOLID;
	const neighborSolid = neighborFlags & FLAG_SOLID;

	if ((currentSolid | neighborSolid) === 0) {
		return;
	}

	const currentParticipates =
		currentSolid !== 0 && (currentFlags & FLAG_GREEDY) !== 0;

	const neighborParticipates =
		neighborSolid !== 0 && (neighborFlags & FLAG_GREEDY) !== 0;

	if (!currentParticipates && !neighborParticipates) {
		return;
	}

	const currentTransparent = currentFlags & FLAG_TRANSPARENT;
	const neighborTransparent = neighborFlags & FLAG_TRANSPARENT;

	const currentPartial = currentFlags & FLAG_PARTIAL;
	const neighborPartial = neighborFlags & FLAG_PARTIAL;

	const currentWaterGlass = currentFlags & FLAG_WATER_GLASS;
	const neighborWaterGlass = neighborFlags & FLAG_WATER_GLASS;

	const bothCubes =
		currentParticipates &&
		neighborParticipates &&
		currentPartial === 0 &&
		neighborPartial === 0;

	if (bothCubes && currentTransparent === 0 && neighborTransparent === 0) {
		return;
	}

	let currentId = -1;
	let neighborId = -1;

	let currentSourceId = -1;
	let neighborSourceId = -1;

	let currentLiquidLevel = -1;
	let neighborLiquidLevel = -1;

	const bothWaterGlass =
		currentSolid !== 0 &&
		neighborSolid !== 0 &&
		currentWaterGlass !== 0 &&
		neighborWaterGlass !== 0;

	let sameLiquid = false;

	if (bothWaterGlass) {
		currentId = getIdFromCombined(currentCombined);
		neighborId = getIdFromCombined(neighborCombined);

		currentSourceId = getSourceBlockId(currentId);
		neighborSourceId = getSourceBlockId(neighborId);

		const sameSource = currentSourceId === neighborSourceId;

		if (sameSource) {
			sameLiquid = isLiquidSourceId(currentSourceId);

			if (!sameLiquid) {
				return;
			}

			currentLiquidLevel =
				(currentPacked >>> WATER_LEVEL_SHIFT) & WATER_LEVEL_MASK_4;

			neighborLiquidLevel =
				(neighborPacked >>> WATER_LEVEL_SHIFT) & WATER_LEVEL_MASK_4;

			if (
				currentFaceBit === FACE_PY &&
				currentPartial === 0 &&
				neighborPartial === 0
			) {
				return;
			}

			if (currentLiquidLevel === neighborLiquidLevel) {
				return;
			}
		}
	}

	const preserveInterface =
		bothWaterGlass &&
		currentTransparent !== 0 &&
		neighborTransparent !== 0 &&
		currentSourceId !== neighborSourceId;

	let currentShape: BlockShapeInfo | null = null;
	let neighborShape: BlockShapeInfo | null = null;

	if (
		!preserveInterface &&
		!bothCubes &&
		currentSolid !== 0 &&
		neighborSolid !== 0
	) {
		currentShape = getShapeInfo(currentPacked);
		neighborShape = getShapeInfo(neighborPacked);

		if (
			(currentShape.closedFaceMask & currentFaceBit) !== 0 &&
			(neighborShape.closedFaceMask & neighborFaceBit) !== 0
		) {
			return;
		}
	}

	if (preserveInterface) {
		const preferCurrent = isGlassBlock(currentId) || !isGlassBlock(neighborId);

		let packedMask: number;
		let packedAO: number;
		let emittingSourceId: number;

		if (preferCurrent) {
			if (!currentParticipates) {
				return;
			}

			currentShape ??= getShapeInfo(currentPacked);

			packedMask =
				(currentPacked & PACKED_ID_STATE_MASK) |
				(currentShape.isCube ? 0 : NON_CUBE_MASK);

			packedAO = disableAO ? 0 : computeAO(session, nx, ny, nz, uAxis, vAxis);

			emittingSourceId = currentSourceId;
		} else {
			if (!neighborParticipates) {
				return;
			}

			neighborShape ??= getShapeInfo(neighborPacked);

			packedMask =
				(neighborPacked & PACKED_ID_STATE_MASK) |
				(neighborShape.isCube ? 0 : NON_CUBE_MASK) |
				BACK_FACE_MASK;

			packedAO = disableAO ? 0 : computeAO(session, bx, by, bz, uAxis, vAxis);

			emittingSourceId = neighborSourceId;
		}

		if (isLiquidSourceId(emittingSourceId)) {
			packedMask &= ~(WATER_LEVEL_MASK_3 << WATER_SHALLOWER_SHIFT);

			if (
				isSameLiquidAt(
					block,
					session.ps,
					session.ps2,
					bx,
					by + 1,
					bz,
					emittingSourceId,
				)
			) {
				packedMask |= WATER_ABOVE_MASK;
			}
		}

		writeOutput(
			mask,
			lightMask,
			outputIndex,
			packedMask,
			packedAO,
			light[currentIndex],
			light[neighborIndex],
			disableAO,
		);

		return;
	}

	let neighborClosesFace = 0;
	let currentClosesFace = 0;

	if (neighborSolid !== 0) {
		neighborShape ??= getShapeInfo(neighborPacked);
		neighborClosesFace = neighborShape.closedFaceMask & neighborFaceBit;
	}

	if (currentSolid !== 0) {
		currentShape ??= getShapeInfo(currentPacked);
		currentClosesFace = currentShape.closedFaceMask & currentFaceBit;
	}

	let emitCurrent =
		currentParticipates &&
		(neighborSolid === 0 ||
			(neighborTransparent !== 0 && currentTransparent === 0) ||
			neighborClosesFace === 0);

	let emitNeighbor =
		neighborParticipates &&
		(currentSolid === 0 ||
			(currentTransparent !== 0 && neighborTransparent === 0) ||
			currentClosesFace === 0);

	const unequalLiquidLevels =
		sameLiquid && currentLiquidLevel !== neighborLiquidLevel;

	if (!emitCurrent && !emitNeighbor) {
		if (!unequalLiquidLevels) {
			return;
		}

		if (currentLiquidLevel > neighborLiquidLevel) {
			emitCurrent = true;
		} else {
			emitNeighbor = true;
		}
	}

	let packedMask: number;
	let packedAO: number;
	let emittingSourceId: number;
	let emittingWaterGlass: boolean;

	if (emitCurrent) {
		if (!currentShape) {
			return;
		}

		packedMask =
			(currentPacked & PACKED_ID_STATE_MASK) |
			(currentShape.isCube ? 0 : NON_CUBE_MASK);

		packedAO = disableAO ? 0 : computeAO(session, nx, ny, nz, uAxis, vAxis);

		emittingWaterGlass = currentWaterGlass !== 0;

		emittingSourceId =
			currentSourceId !== -1
				? currentSourceId
				: getSourceBlockId(getIdFromCombined(currentCombined));
	} else {
		if (!emitNeighbor || !neighborShape) {
			return;
		}

		packedMask =
			(neighborPacked & PACKED_ID_STATE_MASK) |
			(neighborShape.isCube ? 0 : NON_CUBE_MASK) |
			BACK_FACE_MASK;

		packedAO = disableAO ? 0 : computeAO(session, bx, by, bz, uAxis, vAxis);

		emittingWaterGlass = neighborWaterGlass !== 0;

		emittingSourceId =
			neighborSourceId !== -1
				? neighborSourceId
				: getSourceBlockId(getIdFromCombined(neighborCombined));
	}

	if (emittingWaterGlass && isLiquidSourceId(emittingSourceId)) {
		packedMask &= ~(WATER_LEVEL_MASK_3 << WATER_SHALLOWER_SHIFT);

		let aboveX: number;
		let aboveY: number;
		let aboveZ: number;

		if (unequalLiquidLevels) {
			if (currentLiquidLevel > neighborLiquidLevel) {
				aboveX = nx;
				aboveY = ny;
				aboveZ = nz;
			} else {
				aboveX = bx;
				aboveY = by;
				aboveZ = bz;
			}
		} else if (emitNeighbor) {
			aboveX = nx;
			aboveY = ny;
			aboveZ = nz;
		} else {
			aboveX = bx;
			aboveY = by;
			aboveZ = bz;
		}

		if (
			isSameLiquidAt(
				block,
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

	if (unequalLiquidLevels) {
		const currentIsNumericallyLarger = currentLiquidLevel > neighborLiquidLevel;

		const tallerLevel = currentIsNumericallyLarger
			? currentLiquidLevel
			: neighborLiquidLevel;

		const shallowerLevel = currentIsNumericallyLarger
			? neighborLiquidLevel
			: currentLiquidLevel;

		packedMask =
			(packedMask & WATER_PAIR_LEVEL_CLEAR) |
			(tallerLevel << WATER_LEVEL_SHIFT) |
			(shallowerLevel << WATER_SHALLOWER_SHIFT) |
			WATER_LEVEL_PAIR_MASK;
	}

	writeOutput(
		mask,
		lightMask,
		outputIndex,
		packedMask,
		packedAO,
		light[currentIndex],
		light[neighborIndex],
		disableAO,
	);
}

function writeOutput(
	mask: WritableNumberArray,
	lightMask: WritableNumberArray,
	outputIndex: number,
	packedMask: number,
	packedAO: number,
	currentLight: number,
	neighborLight: number,
	disableAO: boolean,
): void {
	const maximumLight =
		currentLight > neighborLight ? currentLight : neighborLight;

	const packedLight = disableAO
		? quantizeByteForLOD(maximumLight)
		: maximumLight;

	mask[outputIndex] = packedMask;
	lightMask[outputIndex] = (packedAO & 0xff) | ((packedLight & 0xff) << 8);
}

function isSameLiquidAt(
	block: Uint16Array,
	ps: number,
	ps2: number,
	x: number,
	y: number,
	z: number,
	sourceId: number,
): boolean {
	const index = x + 1 + (y + 1) * ps + (z + 1) * ps2;
	const packed = block[index];

	if (packed === 0) {
		return false;
	}

	return getSourceBlockId(packed & BLOCK_ID_MASK) === sourceId;
}
