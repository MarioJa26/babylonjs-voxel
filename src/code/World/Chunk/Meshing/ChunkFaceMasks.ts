import { isLiquidSourceId } from "../../Liquid/LiquidRegistry";
import {
	FACE_ALL,
	FACE_NX,
	FACE_NY,
	FACE_NZ,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
	FALLBACK_CUBE,
	getCubeShapeIndex,
	getShapeByBlockId,
	getShapeDefinitions,
} from "../../Shape/BlockShapes";
import { getSliceAxis, transformBox } from "../../Shape/BlockShapeTransforms";
import { getSourceBlockId } from "../../Texture/BlockMaterial";
import {
	unpackBlockId,
	unpackBlockState,
} from "../DataStructures/BlockEncoding";

const MAX_RECTS = 64;
const RECT_STRIDE = 4;
const EDGE_HALF = MAX_RECTS * 2 + 2;

const GLASS_01_BLOCK_ID = 60;
const GLASS_02_BLOCK_ID = 61;

const EPS = 1e-6;
const UNCACHED_MASK = 0xff;

const _rectBufs = Array.from(
	{ length: 6 },
	() => new Float32Array(MAX_RECTS * RECT_STRIDE),
);

const _rectCounts = new Uint8Array(6);
const _edgeScratch = new Float64Array(EDGE_HALF * 2);

const _sliceMin: [number, number, number] = [0, 0, 0];
const _sliceMax: [number, number, number] = [0, 0, 0];

const _sliceResult: {
	min: [number, number, number];
	max: [number, number, number];
} = {
	min: _sliceMin,
	max: _sliceMax,
};

const CLOSED_FACE_MASK_CACHE = new Uint8Array(1 << 16);
CLOSED_FACE_MASK_CACHE.fill(UNCACHED_MASK);

const _faceBitLUT = new Uint8Array([
	FACE_NX,
	FACE_PX,
	FACE_NY,
	FACE_PY,
	FACE_NZ,
	FACE_PZ,
]);

// Minimum number of air voxels on a chunk face required for connectivity.
const FACE_CONNECT_THRESHOLD = 16;

function getFaceBit(axis: number, dir: number): number {
	return _faceBitLUT[(axis << 1) + (dir >= 0 ? 1 : 0)];
}

function isAlwaysTransparentBlock(blockId: number): boolean {
	if (
		blockId === 0 ||
		isLiquidSourceId(blockId) ||
		blockId === GLASS_01_BLOCK_ID ||
		blockId === GLASS_02_BLOCK_ID
	) {
		return true;
	}

	const sourceBlockId = getSourceBlockId(blockId);

	return (
		isLiquidSourceId(sourceBlockId) ||
		sourceBlockId === GLASS_01_BLOCK_ID ||
		sourceBlockId === GLASS_02_BLOCK_ID
	);
}

function pushRectFlat(
	face: number,
	u0: number,
	u1: number,
	v0: number,
	v1: number,
): void {
	let minU: number;
	let maxU: number;
	let minV: number;
	let maxV: number;

	if (u0 < u1) {
		minU = u0;
		maxU = u1;
	} else {
		minU = u1;
		maxU = u0;
	}

	if (v0 < v1) {
		minV = v0;
		maxV = v1;
	} else {
		minV = v1;
		maxV = v0;
	}

	if (minU < 0) minU = 0;
	else if (minU > 1) minU = 1;

	if (maxU < 0) maxU = 0;
	else if (maxU > 1) maxU = 1;

	if (minV < 0) minV = 0;
	else if (minV > 1) minV = 1;

	if (maxV < 0) maxV = 0;
	else if (maxV > 1) maxV = 1;

	if (maxU - minU <= EPS || maxV - minV <= EPS) {
		return;
	}

	const count = _rectCounts[face];

	if (count >= MAX_RECTS) {
		return;
	}

	const base = count * RECT_STRIDE;
	const buffer = _rectBufs[face];

	buffer[base] = minU;
	buffer[base + 1] = maxU;
	buffer[base + 2] = minV;
	buffer[base + 3] = maxV;

	_rectCounts[face] = count + 1;
}

function insertionSortEdges(start: number, length: number): void {
	const edges = _edgeScratch;
	const end = start + length;

	for (let i = start + 1; i < end; i++) {
		const value = edges[i];
		let j = i - 1;

		while (j >= start && edges[j] > value) {
			edges[j + 1] = edges[j];
			j--;
		}

		edges[j + 1] = value;
	}
}

function dedupeEdges(start: number, length: number): number {
	const edges = _edgeScratch;

	if (length === 0 || edges[start] > EPS) {
		for (let i = length; i > 0; i--) {
			edges[start + i] = edges[start + i - 1];
		}

		edges[start] = 0;
		length++;
	}

	if (edges[start + length - 1] < 1 - EPS) {
		edges[start + length] = 1;
		length++;
	}

	let write = 1;

	for (let read = 1; read < length; read++) {
		if (Math.abs(edges[start + read] - edges[start + write - 1]) > EPS) {
			edges[start + write] = edges[start + read];
			write++;
		}
	}

	return write;
}

function doesFlatRectsCoverUnitSquare(face: number): boolean {
	const count = _rectCounts[face];

	if (count === 0) {
		return false;
	}

	const buffer = _rectBufs[face];

	let uLength = 0;
	let vLength = 0;

	for (let i = 0, base = 0; i < count; i++, base += RECT_STRIDE) {
		_edgeScratch[uLength++] = buffer[base];
		_edgeScratch[uLength++] = buffer[base + 1];

		_edgeScratch[EDGE_HALF + vLength++] = buffer[base + 2];
		_edgeScratch[EDGE_HALF + vLength++] = buffer[base + 3];
	}

	insertionSortEdges(0, uLength);
	insertionSortEdges(EDGE_HALF, vLength);

	uLength = dedupeEdges(0, uLength);
	vLength = dedupeEdges(EDGE_HALF, vLength);

	for (let uIndex = 0; uIndex < uLength - 1; uIndex++) {
		const cellMinU = _edgeScratch[uIndex];
		const cellMaxU = _edgeScratch[uIndex + 1];

		if (cellMaxU - cellMinU <= EPS) {
			continue;
		}

		for (let vIndex = 0; vIndex < vLength - 1; vIndex++) {
			const cellMinV = _edgeScratch[EDGE_HALF + vIndex];
			const cellMaxV = _edgeScratch[EDGE_HALF + vIndex + 1];

			if (cellMaxV - cellMinV <= EPS) {
				continue;
			}

			let covered = false;

			for (
				let rectIndex = 0, base = 0;
				rectIndex < count;
				rectIndex++, base += RECT_STRIDE
			) {
				if (
					buffer[base] <= cellMinU + EPS &&
					buffer[base + 1] >= cellMaxU - EPS &&
					buffer[base + 2] <= cellMinV + EPS &&
					buffer[base + 3] >= cellMaxV - EPS
				) {
					covered = true;
					break;
				}
			}

			if (!covered) {
				return false;
			}
		}
	}

	return true;
}

function applySliceStateToBoxForLight(
	min: [number, number, number],
	max: [number, number, number],
	state: number,
): {
	min: [number, number, number];
	max: [number, number, number];
} {
	const slice = (state >>> 3) & 7;

	if (slice === 0) {
		_sliceResult.min = min;
		_sliceResult.max = max;
		return _sliceResult;
	}

	const rotation = state & 7;
	const sliceAxis = getSliceAxis(rotation);
	const flip = (rotation & 4) !== 0;
	const scale = slice * 0.125;

	_sliceMin[0] = min[0];
	_sliceMin[1] = min[1];
	_sliceMin[2] = min[2];

	_sliceMax[0] = max[0];
	_sliceMax[1] = max[1];
	_sliceMax[2] = max[2];

	if (flip) {
		_sliceMin[sliceAxis] = 1 - (1 - min[sliceAxis]) * scale;
		_sliceMax[sliceAxis] = 1 - (1 - max[sliceAxis]) * scale;
	} else {
		_sliceMin[sliceAxis] = min[sliceAxis] * scale;
		_sliceMax[sliceAxis] = max[sliceAxis] * scale;
	}

	if (_sliceMin[sliceAxis] > _sliceMax[sliceAxis]) {
		const value = _sliceMin[sliceAxis];
		_sliceMin[sliceAxis] = _sliceMax[sliceAxis];
		_sliceMax[sliceAxis] = value;
	}

	_sliceResult.min = _sliceMin;
	_sliceResult.max = _sliceMax;

	return _sliceResult;
}

function getClosedFaceMaskForPacked(blockPacked: number): number {
	const cacheIndex = blockPacked & 0xffff;
	const cachedMask = CLOSED_FACE_MASK_CACHE[cacheIndex];

	if (cachedMask !== UNCACHED_MASK) {
		return cachedMask;
	}

	const blockId = unpackBlockId(blockPacked);

	if (isAlwaysTransparentBlock(blockId)) {
		CLOSED_FACE_MASK_CACHE[cacheIndex] = 0;
		return 0;
	}

	const shapeDefinitions = getShapeDefinitions();
	const cubeShapeIndex = getCubeShapeIndex();
	const shapeIndex = getShapeByBlockId()[blockId] ?? cubeShapeIndex;

	const shape =
		shapeDefinitions[shapeIndex] ??
		shapeDefinitions[cubeShapeIndex] ??
		FALLBACK_CUBE;

	if (!shape) {
		CLOSED_FACE_MASK_CACHE[cacheIndex] = FACE_ALL;
		return FACE_ALL;
	}

	const state = unpackBlockState(blockPacked);
	const rotation = shape.rotateY ? state & 3 : 0;
	const flipY = Boolean(shape.allowFlipY && (state & 4) !== 0);
	const usesSliceState = Boolean(shape.usesSliceState);

	_rectCounts.fill(0);

	const boxes = shape.boxes;

	for (let i = 0; i < boxes.length; i++) {
		const box = boxes[i];
		const transformed = transformBox(box.min, box.max, rotation, flipY);

		const sliced = usesSliceState
			? applySliceStateToBoxForLight(transformed.min, transformed.max, state)
			: transformed;

		const min = sliced.min;
		const max = sliced.max;

		if (
			max[0] - min[0] <= EPS ||
			max[1] - min[1] <= EPS ||
			max[2] - min[2] <= EPS
		) {
			continue;
		}

		const faceMask = box.faceMask ?? FACE_ALL;

		if ((faceMask & FACE_PX) !== 0 && max[0] >= 1 - EPS) {
			pushRectFlat(0, min[1], max[1], min[2], max[2]);
		}

		if ((faceMask & FACE_NX) !== 0 && min[0] <= EPS) {
			pushRectFlat(1, min[1], max[1], min[2], max[2]);
		}

		if ((faceMask & FACE_PY) !== 0 && max[1] >= 1 - EPS) {
			pushRectFlat(2, min[0], max[0], min[2], max[2]);
		}

		if ((faceMask & FACE_NY) !== 0 && min[1] <= EPS) {
			pushRectFlat(3, min[0], max[0], min[2], max[2]);
		}

		if ((faceMask & FACE_PZ) !== 0 && max[2] >= 1 - EPS) {
			pushRectFlat(4, min[0], max[0], min[1], max[1]);
		}

		if ((faceMask & FACE_NZ) !== 0 && min[2] <= EPS) {
			pushRectFlat(5, min[0], max[0], min[1], max[1]);
		}
	}

	let closedMask = 0;

	if (doesFlatRectsCoverUnitSquare(0)) closedMask |= FACE_PX;
	if (doesFlatRectsCoverUnitSquare(1)) closedMask |= FACE_NX;
	if (doesFlatRectsCoverUnitSquare(2)) closedMask |= FACE_PY;
	if (doesFlatRectsCoverUnitSquare(3)) closedMask |= FACE_NY;
	if (doesFlatRectsCoverUnitSquare(4)) closedMask |= FACE_PZ;
	if (doesFlatRectsCoverUnitSquare(5)) closedMask |= FACE_NZ;

	CLOSED_FACE_MASK_CACHE[cacheIndex] = closedMask;

	return closedMask;
}

export function isTransparent(
	blockPacked: number,
	axis?: number,
	dir?: number,
): boolean {
	const closedMask = getClosedFaceMaskForPacked(blockPacked);

	if (axis === undefined) {
		return closedMask !== FACE_ALL;
	}

	if (dir === undefined) {
		const negativeFace = getFaceBit(axis, -1);
		const positiveFace = getFaceBit(axis, 1);

		return (
			(closedMask & negativeFace) === 0 || (closedMask & positiveFace) === 0
		);
	}

	return (closedMask & getFaceBit(axis, dir)) === 0;
}

export function facePairIndex(i: number, j: number): number {
	return 4 * i - ((i * (i - 1)) >> 1) + j - 1;
}

const _connectFacesMaskLUT = new Uint32Array(64);

for (let faceMask = 0; faceMask < 64; faceMask++) {
	let connectedPairs = 0;

	for (let i = 0; i < 6; i++) {
		if ((faceMask & (1 << i)) === 0) {
			continue;
		}

		for (let j = i + 1; j < 6; j++) {
			if ((faceMask & (1 << j)) !== 0) {
				connectedPairs |= 1 << facePairIndex(i, j);
			}
		}
	}

	_connectFacesMaskLUT[faceMask] = connectedPairs;
}

function connectFacesMask(faceMask: number): number {
	return _connectFacesMaskLUT[faceMask & 0x3f];
}

export function precomputeClosedFaceMasks(): Uint8Array {
	for (let packed = 0; packed < 1 << 16; packed++) {
		getClosedFaceMaskForPacked(packed);
	}

	return CLOSED_FACE_MASK_CACHE;
}

export { connectFacesMask, EPS, FACE_CONNECT_THRESHOLD };
