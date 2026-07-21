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

export const FALLBACK_CUBE: ShapeDefinition = {
	name: "cube",
	boxes: [{ min: [0, 0, 0], max: [1, 1, 1], faceMask: FACE_ALL }],
	rotateY: false,
	allowFlipY: false,
	usesSliceState: false,
};

const quantize = (value: number): number =>
	Math.round(value * SHAPE_SCALE) / SHAPE_SCALE;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const normalizeBlockId = (id: number | string): number | null => {
	if (typeof id === "number" && Number.isFinite(id)) return id;
	if (typeof id === "string") {
		const mapped = (BlockType as unknown as Record<string, number>)[id];
		if (typeof mapped === "number") return mapped;
	}
	return null;
};

const normalizeBox = (raw: RawShapeBox): ShapeBox | null => {
	if (!raw || !Array.isArray(raw.min) || !Array.isArray(raw.max)) return null;
	if (raw.min.length !== 3 || raw.max.length !== 3) return null;
	const min = raw.min.map((v) => clamp01(quantize(Number(v))));
	const max = raw.max.map((v) => clamp01(quantize(Number(v))));
	if (min.some((v) => Number.isNaN(v)) || max.some((v) => Number.isNaN(v))) {
		return null;
	}
	const minX = Math.min(min[0], max[0]);
	const minY = Math.min(min[1], max[1]);
	const minZ = Math.min(min[2], max[2]);
	const maxX = Math.max(min[0], max[0]);
	const maxY = Math.max(min[1], max[1]);
	const maxZ = Math.max(min[2], max[2]);
	if (maxX <= minX || maxY <= minY || maxZ <= minZ) return null;
	const faceMask =
		typeof raw.faceMask === "number" && Number.isFinite(raw.faceMask)
			? raw.faceMask & FACE_ALL
			: FACE_ALL;
	return {
		min: [minX, minY, minZ],
		max: [maxX, maxY, maxZ],
		faceMask,
	};
};

const loadShapeDefinitions = async (): Promise<ShapeDefinition[]> => {
	try {
		const response = await fetch(SHAPES_URL);
		if (!response.ok)
			throw new Error(`Failed to load shapes: ${response.status}`);
		const data = (await response.json()) as unknown;
		if (!Array.isArray(data)) throw new Error("Shape JSON must be an array.");

		const defs: ShapeDefinition[] = [];
		for (const entry of data as RawShapeDefinition[]) {
			if (!entry || typeof entry !== "object") continue;
			const name = typeof entry.name === "string" ? entry.name : "";
			if (!name) continue;
			const boxes: ShapeBox[] = [];
			if (Array.isArray(entry.boxes)) {
				for (const rawBox of entry.boxes) {
					const box = normalizeBox(rawBox ?? {});
					if (box) boxes.push(box);
				}
			}
			if (boxes.length === 0) continue;
			defs.push({
				name,
				boxes,
				rotateY: Boolean(entry.rotateY),
				allowFlipY: Boolean(entry.allowFlipY),
				usesSliceState: Boolean(entry.usesSliceState),
			});
		}

		if (!defs.some((def) => def.name === "cube")) {
			defs.unshift(FALLBACK_CUBE);
		}
		return defs;
	} catch (error) {
		console.warn("Block shapes failed to load:", error);
		return [FALLBACK_CUBE];
	}
};

const VIRTUAL_BLOCK_ID_START = 500;
const VIRTUAL_SHAPES = ["slab", "stairs", "half_wall", "pane", "fence"];

const loadBlockShapeMap = async (
	shapes: ShapeDefinition[],
): Promise<{ map: Uint16Array; ids: Set<number> }> => {
	const map = new Uint16Array(65536);
	const ids = new Set<number>();
	const cubeIndex = shapes.findIndex((shape) => shape.name === "cube");
	map.fill(cubeIndex === -1 ? 0 : cubeIndex);

	try {
		const response = await fetch(BLOCKS_URL);
		if (!response.ok)
			throw new Error(`Failed to load blocks: ${response.status}`);
		const data = (await response.json()) as unknown;
		if (!Array.isArray(data)) throw new Error("Blocks JSON must be an array.");

		const shapeIndexByName = new Map(
			shapes.map((shape, index) => [shape.name, index]),
		);
		for (const entry of data as RawBlockDefinition[]) {
			if (!entry || typeof entry !== "object") continue;
			const id = normalizeBlockId(entry.id);
			if (id === null) continue;
			const shapeName =
				typeof entry.shape === "string" && entry.shape.length > 0
					? entry.shape
					: "cube";
			const shapeIndex = shapeIndexByName.get(shapeName);
			if (shapeIndex === undefined) continue;
			map[id] = shapeIndex;
			ids.add(id);
		}

		// Pre-compute virtual block shape entries for mason table shape variants.
		// Uses the same deterministic ID scheme as BlockTextures.ts.
		for (const entry of data as RawBlockDefinition[]) {
			if (!entry || typeof entry !== "object") continue;
			const id = normalizeBlockId(entry.id);
			if (id === null) continue;
			const sourceShape =
				typeof entry.shape === "string" && entry.shape.length > 0
					? entry.shape
					: "cube";
			if (sourceShape !== "cube") continue;

			for (let si = 0; si < VIRTUAL_SHAPES.length; si++) {
				const targetShape = VIRTUAL_SHAPES[si];
				if (targetShape === sourceShape) continue;
				const targetIndex = shapeIndexByName.get(targetShape);
				if (targetIndex === undefined) continue;
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

const EMPTY_SHAPE_BY_BLOCK_ID = new Uint16Array(65536);

function ensureShapeInit(): Promise<void> {
	if (_shapeInitPromise === null) {
		_shapeInitPromise = (async () => {
			const defs = await loadShapeDefinitions();
			const { map, ids } = await loadBlockShapeMap(defs);
			_shapeDefinitions = defs;
			_shapeByBlockId = map;
			_registeredBlockIds = ids;
			_cubeShapeIndex = defs.findIndex((d) => d.name === "cube");
			if (_cubeShapeIndex === -1) _cubeShapeIndex = 0;
			_crossShapeIndex = defs.findIndex((d) => d.name === "cross");
			_crossDiagonalShapeIndex = defs.findIndex(
				(d) => d.name === "cross_diagonal",
			);
		})();
	}
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
 * Returns true only for ids that are explicitly registered blocks (including
 * mason-table virtual shape variants). Non-block items (tools, weapons, etc.)
 * return false even though getShapeForBlockId falls back to the cube shape.
 * This is shape-driven, so blocks added later to the data files are detected
 * automatically without touching the atlas.
 */
export function isRegisteredBlockId(id: number | null): boolean {
	if (id === null || _registeredBlockIds === null) return false;
	return _registeredBlockIds.has(id);
}

export function getCubeShapeIndex(): number {
	return _cubeShapeIndex;
}

export const getShapeForBlockId = (id: number): ShapeDefinition => {
	const defs = _shapeDefinitions;
	const map = _shapeByBlockId;
	if (!map || !defs) return FALLBACK_CUBE;
	const shapeIndex = map[id] ?? _cubeShapeIndex;
	return defs[shapeIndex] ?? defs[_cubeShapeIndex] ?? FALLBACK_CUBE;
};

export function isCrossBlockId(blockId: number): boolean {
	if (_crossShapeIndex < 0 || !_shapeByBlockId) return false;
	return _shapeByBlockId[blockId] === _crossShapeIndex;
}

export function isCrossDiagonalBlockId(blockId: number): boolean {
	if (_crossDiagonalShapeIndex < 0 || !_shapeByBlockId) return false;
	return _shapeByBlockId[blockId] === _crossDiagonalShapeIndex;
}
