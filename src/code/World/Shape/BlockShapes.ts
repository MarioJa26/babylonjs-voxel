import { BlockType } from "../Texture/BlockType";

// Face mask bits: +X=0, -X=1, +Y=2, -Y=3, +Z=4, -Z=5
export const FACE_PX = 1 << 0; // +X right
export const FACE_NX = 1 << 1; // -X left
export const FACE_PY = 1 << 2; // +Y top
export const FACE_NY = 1 << 3; // -Y bottom
export const FACE_PZ = 1 << 4; // +Z front
export const FACE_NZ = 1 << 5; // -Z back
export const FACE_ALL =
	FACE_PX | FACE_NX | FACE_PY | FACE_NY | FACE_PZ | FACE_NZ;

export type ShapeBox = {
	min: [number, number, number];
	max: [number, number, number];
	/** Bitmask of faces that should be rendered. Defaults to FACE_ALL (0b111111). */
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
	min?: number[];
	max?: number[];
	faceMask?: number;
};

type RawShapeDefinition = {
	name?: string;
	boxes?: RawShapeBox[];
	rotateY?: boolean;
	allowFlipY?: boolean;
	usesSliceState?: boolean;
};

type RawBlockDefinition = {
	id: number | string;
	shape?: string | null;
};

const BLOCKS_URL = "/data/blocks.json";
const SHAPES_URL = "/data/block-shapes.json";

const SHAPE_SCALE = 16;
const VIRTUAL_BLOCK_ID_START = 500;
const VIRTUAL_SHAPES = [
	"slab",
	"stairs",
	"half_wall",
	"pane",
	"fence",
] as const;

const EMPTY_SHAPE_BY_BLOCK_ID = new Uint16Array(65536);

export const FALLBACK_CUBE: ShapeDefinition = {
	name: "cube",
	boxes: [{ min: [0, 0, 0], max: [1, 1, 1], faceMask: FACE_ALL }],
	rotateY: false,
	allowFlipY: false,
	usesSliceState: false,
};

// Browser: fetch from the dev server / public URL
async function loadJsonBrowser(url: string): Promise<unknown> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to load ${url}: ${response.status}`);
	}
	return response.json();
}

// Node.js: read from public/data/ on disk
async function loadJsonServer(url: string): Promise<unknown> {
	const { fileURLToPath } = await import("node:url");
	const { dirname, join } = await import("node:path");
	const { readFile } = await import("node:fs/promises");

	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);

	const filePath = join(
		__dirname,
		"..",
		"..",
		"..",
		"..",
		"public",
		url.charCodeAt(0) === 47 ? url.slice(1) : url,
	);

	return JSON.parse(await readFile(filePath, "utf-8"));
}

const loadJsonUrl =
	typeof self !== "undefined" ? loadJsonBrowser : loadJsonServer;

const quantizeClamp01 = (value: unknown): number => {
	const n = Math.round(Number(value) * SHAPE_SCALE) / SHAPE_SCALE;
	return n < 0 ? 0 : n > 1 ? 1 : n;
};

const normalizeBlockId = (id: number | string): number | null => {
	if (typeof id === "number") {
		return Number.isFinite(id) ? id : null;
	}

	const mapped = (BlockType as unknown as Record<string, number>)[id];
	return typeof mapped === "number" ? mapped : null;
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

	return {
		min: [minX, minY, minZ],
		max: [maxX, maxY, maxZ],
		faceMask:
			typeof raw.faceMask === "number" && Number.isFinite(raw.faceMask)
				? raw.faceMask & FACE_ALL
				: FACE_ALL,
	};
};

const loadShapeDefinitions = async (): Promise<ShapeDefinition[]> => {
	try {
		const data = await loadJsonUrl(SHAPES_URL);
		if (!Array.isArray(data)) {
			throw new Error("Shape JSON must be an array.");
		}

		const defs: ShapeDefinition[] = [];
		let hasCube = false;

		for (let i = 0; i < data.length; i++) {
			const entry = data[i] as RawShapeDefinition | null;
			if (entry === null || typeof entry !== "object") {
				continue;
			}

			const name = typeof entry.name === "string" ? entry.name : "";
			if (name.length === 0) {
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

				const box = normalizeBox(rawBox);
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

			defs.push({
				name,
				boxes,
				rotateY: entry.rotateY === true,
				allowFlipY: entry.allowFlipY === true,
				usesSliceState: entry.usesSliceState === true,
			});
		}

		if (!hasCube) {
			defs.unshift(FALLBACK_CUBE);
		}

		return defs;
	} catch (error) {
		console.warn("Block shapes failed to load:", error);
		return [FALLBACK_CUBE];
	}
};

const loadBlockShapeMap = async (
	shapes: ShapeDefinition[],
): Promise<{ map: Uint16Array; ids: Set<number> }> => {
	const map = new Uint16Array(65536);
	const ids = new Set<number>();

	let cubeIndex = 0;
	const shapeIndexByName = new Map<string, number>();

	for (let i = 0; i < shapes.length; i++) {
		const shape = shapes[i];
		shapeIndexByName.set(shape.name, i);

		if (shape.name === "cube") {
			cubeIndex = i;
		}
	}

	map.fill(cubeIndex);

	try {
		const data = await loadJsonUrl(BLOCKS_URL);
		if (!Array.isArray(data)) {
			throw new Error("Blocks JSON must be an array.");
		}

		for (let i = 0; i < data.length; i++) {
			const entry = data[i] as RawBlockDefinition | null;
			if (entry === null || typeof entry !== "object") {
				continue;
			}

			const id = normalizeBlockId(entry.id);
			if (id === null) {
				continue;
			}

			const shapeName =
				typeof entry.shape === "string" && entry.shape.length > 0
					? entry.shape
					: "cube";

			const shapeIndex = shapeIndexByName.get(shapeName);
			if (shapeIndex === undefined) {
				continue;
			}

			map[id] = shapeIndex;
			ids.add(id);

			// Pre-compute virtual block shape entries for mason table shape variants.
			// Uses the same deterministic ID scheme as BlockTextures.ts.
			if (shapeName !== "cube") {
				continue;
			}

			for (let si = 0; si < VIRTUAL_SHAPES.length; si++) {
				const targetIndex = shapeIndexByName.get(VIRTUAL_SHAPES[si]);
				if (targetIndex === undefined) {
					continue;
				}

				const virtualId =
					VIRTUAL_BLOCK_ID_START + (id - 1) * VIRTUAL_SHAPES.length + si;

				map[virtualId] = targetIndex;
				ids.add(virtualId);
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

	_shapeInitPromise = (async () => {
		const defs = await loadShapeDefinitions();
		const { map, ids } = await loadBlockShapeMap(defs);

		let cubeShapeIndex = 0;
		let crossShapeIndex = -1;
		let crossDiagonalShapeIndex = -1;

		for (let i = 0; i < defs.length; i++) {
			const name = defs[i].name;

			if (name === "cube") {
				cubeShapeIndex = i;
			} else if (name === "cross") {
				crossShapeIndex = i;
			} else if (name === "cross_diagonal") {
				crossDiagonalShapeIndex = i;
			}
		}

		_shapeDefinitions = defs;
		_shapeByBlockId = map;
		_registeredBlockIds = ids;
		_cubeShapeIndex = cubeShapeIndex;
		_crossShapeIndex = crossShapeIndex;
		_crossDiagonalShapeIndex = crossDiagonalShapeIndex;
	})();

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
 * Returns true only for ids that are explicitly registered blocks, including
 * mason-table virtual shape variants. Non-block items return false even though
 * getShapeForBlockId falls back to the cube shape.
 */
export function isRegisteredBlockId(id: number | null): boolean {
	return (
		id !== null && _registeredBlockIds !== null && _registeredBlockIds.has(id)
	);
}

export function getCubeShapeIndex(): number {
	return _cubeShapeIndex;
}

export const getShapeForBlockId = (id: number): ShapeDefinition => {
	const defs = _shapeDefinitions;
	const map = _shapeByBlockId;

	if (defs === null || map === null) {
		return FALLBACK_CUBE;
	}

	const shapeIndex = map[id] ?? _cubeShapeIndex;
	return defs[shapeIndex] ?? defs[_cubeShapeIndex] ?? FALLBACK_CUBE;
};

export function isCrossBlockId(blockId: number): boolean {
	return (
		_crossShapeIndex >= 0 &&
		_shapeByBlockId !== null &&
		_shapeByBlockId[blockId] === _crossShapeIndex
	);
}

export function isCrossDiagonalBlockId(blockId: number): boolean {
	return (
		_crossDiagonalShapeIndex >= 0 &&
		_shapeByBlockId !== null &&
		_shapeByBlockId[blockId] === _crossDiagonalShapeIndex
	);
}
