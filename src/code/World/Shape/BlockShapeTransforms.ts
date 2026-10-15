import {
	areShapesInitialized,
	FACE_NX,
	FACE_NY,
	FACE_NZ,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
	getShapeForBlockId,
} from "./BlockShapes";

export type ShapeBounds = {
	min: [number, number, number];
	max: [number, number, number];
	faceMask: number;
};

type ShapeTransformConfig = {
	rotateY: boolean;
	allowFlipY: boolean;
	usesSliceState: boolean;
};

export const getSliceAxis = (rotation: number): number => {
	switch (rotation & 3) {
		case 1:
			return 0;
		case 2:
			return 2;
		default:
			return 1;
	}
};

export const transformBox = (
	min: [number, number, number],
	max: [number, number, number],
	rotation: number,
	flipY: boolean,
): {
	min: [number, number, number];
	max: [number, number, number];
} => {
	let minX = min[0];
	let minY = min[1];
	let minZ = min[2];
	let maxX = max[0];
	let maxY = max[1];
	let maxZ = max[2];

	switch (rotation & 3) {
		case 1: {
			const sourceMinX = minX;
			const sourceMaxX = maxX;

			minX = 1 - maxZ;
			maxX = 1 - minZ;
			minZ = sourceMinX;
			maxZ = sourceMaxX;
			break;
		}

		case 2:
			minX = 1 - maxX;
			maxX = 1 - min[0];
			minZ = 1 - maxZ;
			maxZ = 1 - min[2];
			break;

		case 3: {
			const sourceMinX = minX;
			const sourceMaxX = maxX;

			minX = minZ;
			maxX = maxZ;
			minZ = 1 - sourceMaxX;
			maxZ = 1 - sourceMinX;
			break;
		}
	}

	if (flipY) {
		const sourceMinY = minY;
		minY = 1 - maxY;
		maxY = 1 - sourceMinY;
	}

	return {
		min: [minX, minY, minZ],
		max: [maxX, maxY, maxZ],
	};
};

/**
 * Transforms a face mask using the same rotation and vertical flip applied
 * to its corresponding geometry.
 *
 * This function is only used to initialize FACE_MASK_TRANSFORM_LUT.
 */
const transformFaceMaskSlow = (
	faceMask: number,
	rotation: number,
	flipY: boolean,
): number => {
	let px = (faceMask & FACE_PX) !== 0;
	let nx = (faceMask & FACE_NX) !== 0;
	let py = (faceMask & FACE_PY) !== 0;
	let ny = (faceMask & FACE_NY) !== 0;
	let pz = (faceMask & FACE_PZ) !== 0;
	let nz = (faceMask & FACE_NZ) !== 0;

	switch (rotation & 3) {
		case 1: {
			const sourcePx = px;
			const sourceNx = nx;
			const sourcePz = pz;
			const sourceNz = nz;

			px = sourceNz;
			nx = sourcePz;
			pz = sourcePx;
			nz = sourceNx;
			break;
		}

		case 2: {
			const sourcePx = px;
			const sourceNx = nx;
			const sourcePz = pz;
			const sourceNz = nz;

			px = sourceNx;
			nx = sourcePx;
			pz = sourceNz;
			nz = sourcePz;
			break;
		}

		case 3: {
			const sourcePx = px;
			const sourceNx = nx;
			const sourcePz = pz;
			const sourceNz = nz;

			px = sourcePz;
			nx = sourceNz;
			pz = sourceNx;
			nz = sourcePx;
			break;
		}
	}

	if (flipY) {
		const sourcePy = py;
		py = ny;
		ny = sourcePy;
	}

	return (
		(px ? FACE_PX : 0) |
		(nx ? FACE_NX : 0) |
		(py ? FACE_PY : 0) |
		(ny ? FACE_NY : 0) |
		(pz ? FACE_PZ : 0) |
		(nz ? FACE_NZ : 0)
	);
};

const FACE_MASK_TRANSFORM_LUT = new Uint8Array(64 * 4 * 2);

for (let flip = 0; flip < 2; flip++) {
	for (let rotation = 0; rotation < 4; rotation++) {
		const offset = (rotation << 6) | (flip << 8);

		for (let mask = 0; mask < 64; mask++) {
			FACE_MASK_TRANSFORM_LUT[offset | mask] = transformFaceMaskSlow(
				mask,
				rotation,
				flip === 1,
			);
		}
	}
}

const transformedShapeCache = new Map<number, ShapeBounds[]>();

const getRelevantStateForShape = (
	blockState: number,
	shape: ShapeTransformConfig,
): number => {
	let relevantState = 0;

	if (shape.rotateY) {
		relevantState |= blockState & 3;
	}

	if (shape.allowFlipY) {
		relevantState |= blockState & 4;
	}

	if (shape.usesSliceState) {
		relevantState |= blockState & 0x38;
	}

	return relevantState;
};

export const getTransformedShapeBoxes = (
	blockId: number,
	blockState: number,
): ShapeBounds[] => {
	const shape = getShapeForBlockId(blockId);
	const relevantState = getRelevantStateForShape(blockState, shape);
	const canCache = areShapesInitialized();

	/*
	 * Multiplication avoids the collisions caused by truncating blockId to
	 * 16 bits. This remains an exact integer while blockId is comfortably
	 * below Number.MAX_SAFE_INTEGER / 64.
	 */
	const cacheKey = blockId * 64 + relevantState;

	if (canCache) {
		const cached = transformedShapeCache.get(cacheKey);

		if (cached !== undefined) {
			return cached;
		}
	}

	const rotation = shape.rotateY ? blockState & 3 : 0;
	const flipY = shape.allowFlipY && (blockState & 4) !== 0;
	const usesSliceState = shape.usesSliceState;
	const sourceBoxes = shape.boxes;

	if (rotation === 0 && !flipY && !usesSliceState) {
		const result = new Array<ShapeBounds>(sourceBoxes.length);

		for (let i = 0; i < sourceBoxes.length; i++) {
			const box = sourceBoxes[i];

			result[i] = {
				min: box.min,
				max: box.max,
				faceMask: box.faceMask,
			};
		}

		if (canCache) {
			transformedShapeCache.set(cacheKey, result);
		}

		return result;
	}

	const slice = usesSliceState ? (blockState >> 3) & 7 : 0;
	const hasSlice = slice !== 0;
	const sliceScale = slice * 0.125;

	/*
	 * Preserve the existing behavior: slice orientation is based on the raw
	 * state bits rather than the shape-gated rotation and flip settings.
	 */
	const sliceRotation = blockState & 7;
	const sliceAxis = hasSlice ? getSliceAxis(sliceRotation) : 1;
	const sliceFlipped = hasSlice && (sliceRotation & 4) !== 0;

	const faceMaskOffset = (rotation << 6) | ((flipY ? 1 : 0) << 8);

	const result = new Array<ShapeBounds>(sourceBoxes.length);
	let resultLength = 0;

	for (let i = 0; i < sourceBoxes.length; i++) {
		const box = sourceBoxes[i];

		let minX = box.min[0];
		let minY = box.min[1];
		let minZ = box.min[2];
		let maxX = box.max[0];
		let maxY = box.max[1];
		let maxZ = box.max[2];

		if (hasSlice) {
			switch (sliceAxis) {
				case 0:
					if (sliceFlipped) {
						minX = 1 - (1 - minX) * sliceScale;
						maxX = 1 - (1 - maxX) * sliceScale;
					} else {
						minX *= sliceScale;
						maxX *= sliceScale;
					}

					if (minX > maxX) {
						const temporary = minX;
						minX = maxX;
						maxX = temporary;
					}
					break;

				case 1:
					if (sliceFlipped) {
						minY = 1 - (1 - minY) * sliceScale;
						maxY = 1 - (1 - maxY) * sliceScale;
					} else {
						minY *= sliceScale;
						maxY *= sliceScale;
					}

					if (minY > maxY) {
						const temporary = minY;
						minY = maxY;
						maxY = temporary;
					}
					break;

				case 2:
					if (sliceFlipped) {
						minZ = 1 - (1 - minZ) * sliceScale;
						maxZ = 1 - (1 - maxZ) * sliceScale;
					} else {
						minZ *= sliceScale;
						maxZ *= sliceScale;
					}

					if (minZ > maxZ) {
						const temporary = minZ;
						minZ = maxZ;
						maxZ = temporary;
					}
					break;
			}
		}

		switch (rotation) {
			case 1: {
				const sourceMinX = minX;
				const sourceMaxX = maxX;

				minX = 1 - maxZ;
				maxX = 1 - minZ;
				minZ = sourceMinX;
				maxZ = sourceMaxX;
				break;
			}

			case 2: {
				const sourceMinX = minX;
				const sourceMinZ = minZ;

				minX = 1 - maxX;
				maxX = 1 - sourceMinX;
				minZ = 1 - maxZ;
				maxZ = 1 - sourceMinZ;
				break;
			}

			case 3: {
				const sourceMinX = minX;
				const sourceMaxX = maxX;

				minX = minZ;
				maxX = maxZ;
				minZ = 1 - sourceMaxX;
				maxZ = 1 - sourceMinX;
				break;
			}
		}

		if (flipY) {
			const sourceMinY = minY;
			minY = 1 - maxY;
			maxY = 1 - sourceMinY;
		}

		if (maxX <= minX || maxY <= minY || maxZ <= minZ) {
			continue;
		}

		result[resultLength++] = {
			min: [minX, minY, minZ],
			max: [maxX, maxY, maxZ],
			faceMask: FACE_MASK_TRANSFORM_LUT[faceMaskOffset | (box.faceMask & 63)],
		};
	}

	result.length = resultLength;

	if (canCache) {
		transformedShapeCache.set(cacheKey, result);
	}

	return result;
};
