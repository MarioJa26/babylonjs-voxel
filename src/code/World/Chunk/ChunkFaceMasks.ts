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
} from "../Shape/BlockShapes";
import { getSliceAxis, transformBox } from "../Shape/BlockShapeTransforms";
import {
	unpackBlockId,
	unpackBlockState,
} from "./DataStructures/BlockEncoding";
import { WATER_BLOCK_ID } from "./Worker/ChunkMesherConstants";

// ---------------------------------------------------------------------------
// Face-rect scratch buffers (used by getClosedFaceMaskForPacked).
// ---------------------------------------------------------------------------
const MAX_RECTS = 64;
const RECT_STRIDE = 4;
const _rectBufs = Array.from(
	{ length: 6 },
	() => new Float32Array(MAX_RECTS * RECT_STRIDE),
);
const _rectCounts = new Int32Array(6);
const _edgeScratch = new Float64Array((MAX_RECTS * 2 + 4) * 2);

const _sliceMin: [number, number, number] = [0, 0, 0];
const _sliceMax: [number, number, number] = [0, 0, 0];
const _sliceResult = { min: _sliceMin, max: _sliceMax };

const GLASS_01_BLOCK_ID = 60;
const GLASS_02_BLOCK_ID = 61;
const EPS = 1e-6;

const CLOSED_FACE_MASK_CACHE: Uint8Array = (() => {
	const cache = new Uint8Array(1 << 16);
	cache.fill(255);
	return cache;
})();

const _faceBitLUT = new Uint8Array([
	FACE_NX,
	FACE_PX,
	FACE_NY,
	FACE_PY,
	FACE_NZ,
	FACE_PZ,
]);

const _faceScratch: number[] = [];

// Minimum air voxels on a chunk face for that face to count as connected.
// A 32x32 face has 1024 voxels; threshold of S/2 = 16 filters out
// single-block cracks and thin slivers while allowing real passages.
const FACE_CONNECT_THRESHOLD = 16;

function getFaceBit(axis: number, dir: number): number {
	return _faceBitLUT[axis * 2 + (dir >= 0 ? 1 : 0)];
}

function pushRectFlat(
	f: number,
	u0: number,
	u1: number,
	v0: number,
	v1: number,
): void {
	const cu0 = Math.min(1, Math.max(0, Math.min(u0, u1)));
	const cu1 = Math.min(1, Math.max(0, Math.max(u0, u1)));
	const cv0 = Math.min(1, Math.max(0, Math.min(v0, v1)));
	const cv1 = Math.min(1, Math.max(0, Math.max(v0, v1)));
	if (cu1 - cu0 <= EPS || cv1 - cv0 <= EPS) return;
	const cnt = _rectCounts[f];
	if (cnt >= MAX_RECTS) return;
	const base = cnt * RECT_STRIDE;
	const buf = _rectBufs[f];
	buf[base] = cu0;
	buf[base + 1] = cu1;
	buf[base + 2] = cv0;
	buf[base + 3] = cv1;
	_rectCounts[f] = cnt + 1;
}

function insertionSortEdges(start: number, len: number): void {
	const arr = _edgeScratch;
	for (let i = start + 1; i < start + len; i++) {
		const key = arr[i];
		let j = i - 1;
		while (j >= start && arr[j] > key) {
			arr[j + 1] = arr[j];
			j--;
		}
		arr[j + 1] = key;
	}
}

function dedupeEdges(start: number, len: number): number {
	const arr = _edgeScratch;
	if (len === 0 || arr[start] > EPS) {
		for (let i = len; i > 0; i--) arr[start + i] = arr[start + i - 1];
		arr[start] = 0;
		len++;
	}
	if (arr[start + len - 1] < 1 - EPS) {
		arr[start + len] = 1;
		len++;
	}
	let w = 1;
	for (let r = 1; r < len; r++) {
		if (Math.abs(arr[start + r] - arr[start + w - 1]) > EPS) {
			arr[start + w++] = arr[start + r];
		}
	}
	return w;
}

function doesFlatRectsCoverUnitSquare(f: number): boolean {
	const count = _rectCounts[f];
	if (count === 0) return false;

	const buf = _rectBufs[f];
	const HALF = MAX_RECTS * 2 + 2;

	let uLen = 0;
	let vLen = 0;
	for (let i = 0; i < count; i++) {
		const b = i * RECT_STRIDE;
		_edgeScratch[uLen++] = buf[b];
		_edgeScratch[uLen++] = buf[b + 1];
		_edgeScratch[HALF + vLen++] = buf[b + 2];
		_edgeScratch[HALF + vLen++] = buf[b + 3];
	}

	insertionSortEdges(0, uLen);
	insertionSortEdges(HALF, vLen);

	uLen = dedupeEdges(0, uLen);
	vLen = dedupeEdges(HALF, vLen);

	for (let ui = 0; ui < uLen - 1; ui++) {
		const u0e = _edgeScratch[ui];
		const u1e = _edgeScratch[ui + 1];
		if (u1e - u0e <= EPS) continue;
		for (let vi = 0; vi < vLen - 1; vi++) {
			const v0e = _edgeScratch[HALF + vi];
			const v1e = _edgeScratch[HALF + vi + 1];
			if (v1e - v0e <= EPS) continue;
			let covered = false;
			for (let r = 0; r < count; r++) {
				const rb = r * RECT_STRIDE;
				if (
					buf[rb] <= u0e + EPS &&
					buf[rb + 1] >= u1e - EPS &&
					buf[rb + 2] <= v0e + EPS &&
					buf[rb + 3] >= v1e - EPS
				) {
					covered = true;
					break;
				}
			}
			if (!covered) return false;
		}
	}
	return true;
}

function getClosedFaceMaskForPacked(blockPacked: number): number {
	const cacheIndex = blockPacked & 0xffff;
	const cached = CLOSED_FACE_MASK_CACHE[cacheIndex];
	if (cached !== 255) return cached;

	const blockId = unpackBlockId(blockPacked);
	if (
		blockId === 0 ||
		blockId === WATER_BLOCK_ID ||
		blockId === GLASS_01_BLOCK_ID ||
		blockId === GLASS_02_BLOCK_ID
	) {
		CLOSED_FACE_MASK_CACHE[cacheIndex] = 0;
		return 0;
	}

	const state = unpackBlockState(blockPacked);
	const shapeMap = getShapeByBlockId();
	const shapeDefs = getShapeDefinitions();
	const cubeIndex = getCubeShapeIndex();
	const shapeIndex = shapeMap[blockId] ?? cubeIndex;
	const shape = shapeDefs[shapeIndex] ?? shapeDefs[cubeIndex] ?? FALLBACK_CUBE;
	if (!shape) {
		CLOSED_FACE_MASK_CACHE[cacheIndex] = FACE_ALL;
		return FACE_ALL;
	}

	const rotation = shape.rotateY ? state & 3 : 0;
	const flipY = Boolean(shape.allowFlipY && (state & 4) !== 0);

	_rectCounts.fill(0);

	for (const box of shape.boxes) {
		const transformed = transformBox(box.min, box.max, rotation, flipY);
		const sliced = shape.usesSliceState
			? applySliceStateToBoxForLight(transformed.min, transformed.max, state)
			: transformed;

		const min = sliced.min;
		const max = sliced.max;
		const faceMask = box.faceMask ?? FACE_ALL;

		if (
			max[0] - min[0] <= EPS ||
			max[1] - min[1] <= EPS ||
			max[2] - min[2] <= EPS
		)
			continue;

		if (faceMask & FACE_PX && max[0] >= 1 - EPS)
			pushRectFlat(0, min[1], max[1], min[2], max[2]);
		if (faceMask & FACE_NX && min[0] <= EPS)
			pushRectFlat(1, min[1], max[1], min[2], max[2]);
		if (faceMask & FACE_PY && max[1] >= 1 - EPS)
			pushRectFlat(2, min[0], max[0], min[2], max[2]);
		if (faceMask & FACE_NY && min[1] <= EPS)
			pushRectFlat(3, min[0], max[0], min[2], max[2]);
		if (faceMask & FACE_PZ && max[2] >= 1 - EPS)
			pushRectFlat(4, min[0], max[0], min[1], max[1]);
		if (faceMask & FACE_NZ && min[2] <= EPS)
			pushRectFlat(5, min[0], max[0], min[1], max[1]);
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

function applySliceStateToBoxForLight(
	min: [number, number, number],
	max: [number, number, number],
	state: number,
): { min: [number, number, number]; max: [number, number, number] } {
	const slice = (state >>> 3) & 7;
	if (slice === 0) {
		_sliceResult.min = min;
		_sliceResult.max = max;
		return _sliceResult;
	}

	const rotation = state & 7;
	const sliceAxis = getSliceAxis(rotation);
	const flip = (rotation & 4) !== 0;
	const heightScale = slice / 8;
	_sliceMin[0] = min[0];
	_sliceMin[1] = min[1];
	_sliceMin[2] = min[2];
	_sliceMax[0] = max[0];
	_sliceMax[1] = max[1];
	_sliceMax[2] = max[2];

	if (flip) {
		_sliceMin[sliceAxis] = 1 - (1 - min[sliceAxis]) * heightScale;
		_sliceMax[sliceAxis] = 1 - (1 - max[sliceAxis]) * heightScale;
	} else {
		_sliceMin[sliceAxis] = min[sliceAxis] * heightScale;
		_sliceMax[sliceAxis] = max[sliceAxis] * heightScale;
	}
	if (_sliceMin[sliceAxis] > _sliceMax[sliceAxis]) {
		const tmp = _sliceMin[sliceAxis];
		_sliceMin[sliceAxis] = _sliceMax[sliceAxis];
		_sliceMax[sliceAxis] = tmp;
	}
	_sliceResult.min = _sliceMin;
	_sliceResult.max = _sliceMax;
	return _sliceResult;
}

export function isTransparent(
	blockPacked: number,
	axis?: number,
	dir?: number,
): boolean {
	const closedMask = getClosedFaceMaskForPacked(blockPacked);
	if (axis === undefined) return closedMask !== FACE_ALL;
	if (dir === undefined) {
		return (
			(closedMask & getFaceBit(axis, 1)) === 0 ||
			(closedMask & getFaceBit(axis, -1)) === 0
		);
	}
	return (closedMask & getFaceBit(axis, dir)) === 0;
}

export function facePairIndex(i: number, j: number): number {
	return 4 * i - ((i * (i - 1)) >> 1) + j - 1;
}

function connectFacesMask(faceMask: number): number {
	let result = 0;
	const faces = _faceScratch;
	faces.length = 0;
	for (let f = 0; f < 6; f++) {
		if (faceMask & (1 << f)) faces.push(f);
	}
	for (let a = 0; a < faces.length; a++) {
		for (let b = a + 1; b < faces.length; b++) {
			const i = faces[a];
			const j = faces[b];
			result |= 1 << facePairIndex(i, j);
		}
	}
	return result;
}

export function precomputeClosedFaceMasks(): Uint8Array {
	for (let i = 0; i < 1 << 16; i++) {
		getClosedFaceMaskForPacked(i);
	}
	return CLOSED_FACE_MASK_CACHE;
}

export { connectFacesMask, EPS, FACE_CONNECT_THRESHOLD };
