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

export const getSliceAxis = (rotation: number): number => {
	const sliceAxisRaw = rotation & 3;
	return sliceAxisRaw === 1 ? 0 : sliceAxisRaw === 2 ? 2 : 1;
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
			const oldMinX = minX;
			const oldMaxX = maxX;
			const oldMinZ = minZ;
			const oldMaxZ = maxZ;
			minX = 1 - oldMaxZ;
			maxX = 1 - oldMinZ;
			minZ = oldMinX;
			maxZ = oldMaxX;
			break;
		}
		case 2: {
			const oldMinX = minX;
			const oldMaxX = maxX;
			const oldMinZ = minZ;
			const oldMaxZ = maxZ;
			minX = 1 - oldMaxX;
			maxX = 1 - oldMinX;
			minZ = 1 - oldMaxZ;
			maxZ = 1 - oldMinZ;
			break;
		}
		case 3: {
			const oldMinX = minX;
			const oldMaxX = maxX;
			const oldMinZ = minZ;
			const oldMaxZ = maxZ;
			minX = oldMinZ;
			maxX = oldMaxZ;
			minZ = 1 - oldMaxX;
			maxZ = 1 - oldMinX;
			break;
		}
	}

	if (flipY) {
		const newMinY = 1 - maxY;
		const newMaxY = 1 - minY;
		minY = newMinY;
		maxY = newMaxY;
	}

	return {
		min: [minX, minY, minZ],
		max: [maxX, maxY, maxZ],
	};
};

/**
 * Transform the face mask together with the geometry.
 *
 * IMPORTANT:
 * - Y rotation changes horizontal faces (+X/-X/+Z/-Z)
 * - flipY swaps top/bottom (+Y/-Y)
 *
 * This is what fixes upside-down stairs:
 * the quarter-box mask must change from hiding bottom to hiding top.
 */
const transformFaceMaskSlow = (
	faceMask: number,
	rotation: number,
	flipY: boolean,
): number => {
	const has = (bit: number) => (faceMask & bit) !== 0;

	let px = has(FACE_PX);
	let nx = has(FACE_NX);
	let py = has(FACE_PY);
	let ny = has(FACE_NY);
	let pz = has(FACE_PZ);
	let nz = has(FACE_NZ);

	// Rotate horizontal faces around Y
	switch (rotation & 3) {
		case 0:
			break;

		case 1: {
			const oldPx = px;
			const oldNx = nx;
			const oldPz = pz;
			const oldNz = nz;

			px = oldNz;
			nx = oldPz;
			pz = oldPx;
			nz = oldNx;
			break;
		}

		case 2: {
			const oldPx = px;
			const oldNx = nx;
			const oldPz = pz;
			const oldNz = nz;

			px = oldNx;
			nx = oldPx;
			pz = oldNz;
			nz = oldPz;
			break;
		}

		case 3: {
			const oldPx = px;
			const oldNx = nx;
			const oldPz = pz;
			const oldNz = nz;

			px = oldPz;
			nx = oldNz;
			pz = oldNx;
			nz = oldPx;
			break;
		}
	}

	// Flip vertically: swap top/bottom
	if (flipY) {
		const oldPy = py;
		py = ny;
		ny = oldPy;
	}

	let out = 0;
	if (px) out |= FACE_PX;
	if (nx) out |= FACE_NX;
	if (py) out |= FACE_PY;
	if (ny) out |= FACE_NY;
	if (pz) out |= FACE_PZ;
	if (nz) out |= FACE_NZ;

	return out;
};

const FACE_MASK_TRANSFORM_LUT = new Uint8Array(64 * 4 * 2);
for (let mask = 0; mask < 64; mask++) {
	for (let rot = 0; rot < 4; rot++) {
		for (let flip = 0; flip < 2; flip++) {
			const index = mask | (rot << 6) | (flip << 8);
			FACE_MASK_TRANSFORM_LUT[index] = transformFaceMaskSlow(
				mask,
				rot,
				flip === 1,
			);
		}
	}
}

const transformFaceMask = (
	faceMask: number,
	rotation: number,
	flipY: boolean,
): number => {
	return FACE_MASK_TRANSFORM_LUT[
		(faceMask & 63) | ((rotation & 3) << 6) | ((flipY ? 1 : 0) << 8)
	];
};

const applySliceToBox = (
	min: [number, number, number],
	max: [number, number, number],
	state: number,
): {
	min: [number, number, number];
	max: [number, number, number];
} => {
	const slice = (state >> 3) & 7;
	if (slice === 0) {
		return { min, max };
	}

	const rotation = state & 7;
	const sliceAxis = getSliceAxis(rotation);
	const flip = (rotation & 4) !== 0;
	const heightScale = slice / 8;

	const outMin: [number, number, number] = [min[0], min[1], min[2]];
	const outMax: [number, number, number] = [max[0], max[1], max[2]];

	if (flip) {
		outMin[sliceAxis] = 1 - (1 - min[sliceAxis]) * heightScale;
		outMax[sliceAxis] = 1 - (1 - max[sliceAxis]) * heightScale;
	} else {
		outMin[sliceAxis] = min[sliceAxis] * heightScale;
		outMax[sliceAxis] = max[sliceAxis] * heightScale;
	}

	if (outMin[sliceAxis] > outMax[sliceAxis]) {
		const tmp = outMin[sliceAxis];
		outMin[sliceAxis] = outMax[sliceAxis];
		outMax[sliceAxis] = tmp;
	}

	return {
		min: outMin,
		max: outMax,
	};
};

const transformedShapeCache = new Map<number, ShapeBounds[]>();

function getRelevantStateForShape(
	blockState: number,
	shape: {
		rotateY: boolean;
		allowFlipY: boolean;
		usesSliceState: boolean;
	},
): number {
	let relevant = 0;
	if (shape.rotateY) {
		relevant |= blockState & 3;
	}
	if (shape.allowFlipY) {
		relevant |= blockState & 4;
	}
	if (shape.usesSliceState) {
		relevant |= blockState & 0x38;
	}
	return relevant;
}

export const getTransformedShapeBoxes = (
	blockId: number,
	blockState: number,
): ShapeBounds[] => {
	const shape = getShapeForBlockId(blockId);
	const relevantState = getRelevantStateForShape(blockState, shape);
	const canCache = areShapesInitialized();
	const cacheKey = ((blockId & 0xffff) << 6) | (relevantState & 63);

	if (canCache) {
		const cached = transformedShapeCache.get(cacheKey);
		if (cached !== undefined) return cached;
	}

	const rotation = shape.rotateY ? blockState & 3 : 0;
	const flipY = shape.allowFlipY && (blockState & 4) !== 0;
	const noTransform = rotation === 0 && !flipY && !shape.usesSliceState;

	const sourceBoxes = shape.boxes;
	const out: ShapeBounds[] = new Array(sourceBoxes.length);
	let outLen = 0;

	for (let i = 0; i < sourceBoxes.length; i++) {
		const box = sourceBoxes[i];

		if (noTransform) {
			out[outLen++] = {
				min: box.min,
				max: box.max,
				faceMask: box.faceMask,
			};
			continue;
		}

		let min = box.min;
		let max = box.max;

		if (shape.usesSliceState) {
			const sliced = applySliceToBox(min, max, blockState);
			min = sliced.min;
			max = sliced.max;
		}

		const transformed = transformBox(min, max, rotation, flipY);

		if (
			transformed.max[0] <= transformed.min[0] ||
			transformed.max[1] <= transformed.min[1] ||
			transformed.max[2] <= transformed.min[2]
		) {
			continue;
		}

		out[outLen++] = {
			min: transformed.min,
			max: transformed.max,
			faceMask: transformFaceMask(box.faceMask, rotation, flipY),
		};
	}

	out.length = outLen;

	if (canCache) {
		transformedShapeCache.set(cacheKey, out);
	}

	return out;
};
