import blockShapesRaw from "../../../data/block-shapes.json";
import blocksRaw from "../../../data/blocks.json";
import { BlockType } from "../Texture/BlockType";

// Face mask bits: +X=0, -X=1, +Y=2, -Y=3, +Z=4, -Z=5
export const FACE_PX = 1 << 0;
export const FACE_NX = 1 << 1;
export const FACE_PY = 1 << 2;
export const FACE_NY = 1 << 3;
export const FACE_PZ = 1 << 4;
export const FACE_NZ = 1 << 5;

export const FACE_ALL =
	FACE_PX | FACE_NX | FACE_PY | FACE_NY | FACE_PZ | FACE_NZ;

export type ShapeBox = {
	min: [number, number, number];
	max: [number, number, number];

	/** Bitmask of faces that should be rendered. Defaults to FACE_ALL. */
	faceMask: number;
};

export type ShapeDefinition = {
	name: string;
	boxes: ShapeBox[];
	rotateY: boolean;
	allowFlipY: boolean;
	usesSliceState: boolean;
};

type RawShapeBox = {
	min?: unknown;
	max?: unknown;
	faceMask?: unknown;
};

type RawShapeDefinition = {
	name?: unknown;
	boxes?: unknown;
	rotateY?: unknown;
	allowFlipY?: unknown;
	usesSliceState?: unknown;
};

type RawBlockDefinition = {
	id?: unknown;
	shape?: unknown;
};

const SHAPE_SCALE = 16;
const BLOCK_ID_CAPACITY = 65536;
const VIRTUAL_BLOCK_ID_START = 500;

const VIRTUAL_SHAPES = [
	"slab",
	"stairs",
	"half_wall",
	"pane",
	"fence",
] as const;

const BLOCK_TYPE_BY_NAME = BlockType as unknown as Readonly<
	Record<string, number>
>;

const EMPTY_SHAPE_BY_BLOCK_ID = new Uint16Array(BLOCK_ID_CAPACITY);

export const FALLBACK_CUBE: ShapeDefinition = {
	name: "cube",
	boxes: [
		{
			min: [0, 0, 0],
			max: [1, 1, 1],
			faceMask: FACE_ALL,
		},
	],
	rotateY: false,
	allowFlipY: false,
	usesSliceState: false,
};

const quantizeClamp01 = (value: unknown): number => {
	const n = Math.round(Number(value) * SHAPE_SCALE) / SHAPE_SCALE;
	return n < 0 ? 0 : n > 1 ? 1 : n;
};

const normalizeBlockId = (id: unknown): number | null => {
	if (typeof id === "number") {
		return Number.isFinite(id) ? id : null;
	}

	if (typeof id !== "string") {
		return null;
	}

	const mapped = BLOCK_TYPE_BY_NAME[id];
	return typeof mapped === "number" && Number.isFinite(mapped) ? mapped : null;
};

const normalizeBox = (raw: RawShapeBox): ShapeBox | null => {
	const rawMin = raw.min;
	const rawMax = raw.max;

	if (
		!Array.isArray(rawMin) ||
		!Array.isArray(rawMax) ||
		rawMin.length !== 3 ||
		rawMax.length !== 3
	) {
		return null;
	}

	const aX = quantizeClamp01(rawMin[0]);
	const aY = quantizeClamp01(rawMin[1]);
	const aZ = quantizeClamp01(rawMin[2]);
	const bX = quantizeClamp01(rawMax[0]);
	const bY = quantizeClamp01(rawMax[1]);
	const bZ = quantizeClamp01(rawMax[2]);

	if (
		Number.isNaN(aX) ||
		Number.isNaN(aY) ||
		Number.isNaN(aZ) ||
		Number.isNaN(bX) ||
		Number.isNaN(bY) ||
		Number.isNaN(bZ)
	) {
		return null;
	}

	const minX = aX < bX ? aX : bX;
	const minY = aY < bY ? aY : bY;
	const minZ = aZ < bZ ? aZ : bZ;
	const maxX = aX > bX ? aX : bX;
	const maxY = aY > bY ? aY : bY;
	const maxZ = aZ > bZ ? aZ : bZ;

	if (maxX <= minX || maxY <= minY || maxZ <= minZ) {
		return null;
	}

	const rawFaceMask = raw.faceMask;
	const faceMask =
		typeof rawFaceMask === "number" && Number.isFinite(rawFaceMask)
			? rawFaceMask & FACE_ALL
			: FACE_ALL;

	return {
		min: [minX, minY, minZ],
		max: [maxX, maxY, maxZ],
		faceMask,
	};
};

const loadShapeDefinitions = (): ShapeDefinition[] => {
	try {
		const data: unknown = blockShapesRaw;

		if (!Array.isArray(data)) {
			throw new Error("Shape JSON must be an array.");
		}

		const definitions: ShapeDefinition[] = [];
		let hasCube = false;

		for (let i = 0; i < data.length; i++) {
			const rawDefinition = data[i];

			if (rawDefinition === null || typeof rawDefinition !== "object") {
				continue;
			}

			const entry = rawDefinition as RawShapeDefinition;
			const name = entry.name;

			if (typeof name !== "string" || name.length === 0) {
				continue;
			}

			const rawBoxes = entry.boxes;

			if (!Array.isArray(rawBoxes) || rawBoxes.length === 0) {
				continue;
			}

			const boxes: ShapeBox[] = [];

			for (let j = 0; j < rawBoxes.length; j++) {
				const rawBox = rawBoxes[j];

				if (rawBox === null || typeof rawBox !== "object") {
					continue;
				}

				const box = normalizeBox(rawBox as RawShapeBox);

				if (box !== null) {
					boxes.push(box);
				}
			}

			if (boxes.length === 0) {
				continue;
			}

			if (name === "cube") {
				hasCube = true;
			}

			definitions.push({
				name,
				boxes,
				rotateY: entry.rotateY === true,
				allowFlipY: entry.allowFlipY === true,
				usesSliceState: entry.usesSliceState === true,
			});
		}

		if (!hasCube) {
			definitions.unshift(FALLBACK_CUBE);
		}

		return definitions;
	} catch (error) {
		console.warn("Block shapes failed to load:", error);
		return [FALLBACK_CUBE];
	}
};

type BlockShapeMapResult = {
	map: Uint16Array;
	ids: Set<number>;
};

const loadBlockShapeMap = (
	shapes: readonly ShapeDefinition[],
): BlockShapeMapResult => {
	const map = new Uint16Array(BLOCK_ID_CAPACITY);
	const ids = new Set<number>();
	const shapeIndexByName = new Map<string, number>();

	let cubeIndex = 0;

	for (let i = 0; i < shapes.length; i++) {
		const name = shapes[i].name;

		shapeIndexByName.set(name, i);

		if (name === "cube") {
			cubeIndex = i;
		}
	}

	map.fill(cubeIndex);

	try {
		const data: unknown = blocksRaw;

		if (!Array.isArray(data)) {
			throw new Error("Blocks JSON must be an array.");
		}

		for (let i = 0; i < data.length; i++) {
			const rawEntry = data[i];

			if (rawEntry === null || typeof rawEntry !== "object") {
				continue;
			}

			const entry = rawEntry as RawBlockDefinition;
			const id = normalizeBlockId(entry.id);

			if (id === null) {
				continue;
			}

			const rawShapeName = entry.shape;
			const shapeName =
				typeof rawShapeName === "string" && rawShapeName.length > 0
					? rawShapeName
					: "cube";

			const shapeIndex = shapeIndexByName.get(shapeName);

			if (shapeIndex === undefined) {
				continue;
			}

			// Preserve registration behavior for every finite resolved ID.
			ids.add(id);

			// Typed-array indices must be non-negative integers in range.
			if (Number.isInteger(id) && id >= 0 && id < BLOCK_ID_CAPACITY) {
				map[id] = shapeIndex;
			}

			if (shapeName !== "cube") {
				continue;
			}

			const virtualBase =
				VIRTUAL_BLOCK_ID_START + (id - 1) * VIRTUAL_SHAPES.length;

			for (
				let shapeOffset = 0;
				shapeOffset < VIRTUAL_SHAPES.length;
				shapeOffset++
			) {
				const targetIndex = shapeIndexByName.get(VIRTUAL_SHAPES[shapeOffset]);

				if (targetIndex === undefined) {
					continue;
				}

				const virtualId = virtualBase + shapeOffset;
				ids.add(virtualId);

				if (virtualId >= 0 && virtualId < BLOCK_ID_CAPACITY) {
					map[virtualId] = targetIndex;
				}
			}
		}
	} catch (error) {
		console.warn("Block shape map failed to load:", error);
	}

	return { map, ids };
};

let _shapeDefinitions: ShapeDefinition[] | null = null;
let _shapeByBlockId: Uint16Array | null = null;
let _registeredBlockIds: Set<number> | null = null;
let _shapeInitPromise: Promise<void> | null = null;

let _cubeShapeIndex = 0;
let _crossShapeIndex = -1;
let _crossDiagonalShapeIndex = -1;

function ensureShapeInit(): Promise<void> {
	if (_shapeInitPromise !== null) {
		return _shapeInitPromise;
	}

	const definitions = loadShapeDefinitions();
	const { map, ids } = loadBlockShapeMap(definitions);

	let cubeShapeIndex = 0;
	let crossShapeIndex = -1;
	let crossDiagonalShapeIndex = -1;

	for (let i = 0; i < definitions.length; i++) {
		switch (definitions[i].name) {
			case "cube":
				cubeShapeIndex = i;
				break;
			case "cross":
				crossShapeIndex = i;
				break;
			case "cross_diagonal":
				crossDiagonalShapeIndex = i;
				break;
		}
	}

	_shapeDefinitions = definitions;
	_shapeByBlockId = map;
	_registeredBlockIds = ids;
	_cubeShapeIndex = cubeShapeIndex;
	_crossShapeIndex = crossShapeIndex;
	_crossDiagonalShapeIndex = crossDiagonalShapeIndex;

	_shapeInitPromise = Promise.resolve();
	return _shapeInitPromise;
}

export const shapeInitPromise: Promise<void> = ensureShapeInit();

export function getShapeDefinitions(): ShapeDefinition[] {
	return _shapeDefinitions ?? [];
}

export function getShapeByBlockId(): Uint16Array {
	return _shapeByBlockId ?? EMPTY_SHAPE_BY_BLOCK_ID;
}

export function areShapesInitialized(): boolean {
	return _shapeDefinitions !== null && _shapeByBlockId !== null;
}

/**
 * Returns true only for IDs that are explicitly registered blocks, including
 * mason-table virtual shape variants. Non-block items return false even though
 * getShapeForBlockId falls back to the cube shape.
 */
export function isRegisteredBlockId(id: number | null): boolean {
	return id !== null && _registeredBlockIds?.has(id) === true;
}

export function getCubeShapeIndex(): number {
	return _cubeShapeIndex;
}

export const getShapeForBlockId = (id: number): ShapeDefinition => {
	const definitions = _shapeDefinitions;
	const shapeByBlockId = _shapeByBlockId;

	if (definitions === null || shapeByBlockId === null) {
		return FALLBACK_CUBE;
	}

	const isValidIndex = id >= 0 && id < shapeByBlockId.length;

	const shapeIndex = isValidIndex ? shapeByBlockId[id] : _cubeShapeIndex;

	return (
		definitions[shapeIndex] ?? definitions[_cubeShapeIndex] ?? FALLBACK_CUBE
	);
};

export function isCrossBlockId(blockId: number): boolean {
	const shapeByBlockId = _shapeByBlockId;

	return (
		_crossShapeIndex >= 0 &&
		shapeByBlockId !== null &&
		shapeByBlockId[blockId] === _crossShapeIndex
	);
}

export function isCrossDiagonalBlockId(blockId: number): boolean {
	const shapeByBlockId = _shapeByBlockId;

	return (
		_crossDiagonalShapeIndex >= 0 &&
		shapeByBlockId !== null &&
		shapeByBlockId[blockId] === _crossDiagonalShapeIndex
	);
}
