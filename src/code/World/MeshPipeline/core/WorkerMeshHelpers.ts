import { MeshData } from "../../Chunk/DataStructures/MeshData";
import { ResizableTypedArray } from "../../Chunk/DataStructures/ResizableTypedArray";
import type { WorkerInternalMeshData } from "../../Chunk/DataStructures/WorkerInternalMeshData";
import type { MeshContext } from "../types/MeshTypes";

export type WorkerMeshBaseContext = {
	size: number;
	lod: number;
};

export type WorkerMeshInput = {
	block_array: Uint8Array | Uint16Array;
	light_array?: Uint8Array;
	neighbors: (Uint8Array | Uint16Array | undefined)[];
	neighborLights?: (Uint8Array | undefined)[];
	neighborPalettes?: (Uint8Array | Uint16Array | null | undefined)[];
	neighborUniformIds?: (number | undefined)[];
};

type NeighborSample = {
	neighborIndex: number;
	lx: number;
	ly: number;
	lz: number;
};

function readPackedNibble(packed: Uint8Array, index: number): number {
	const byte = packed[index >>> 1];
	return (index & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;
}

function readNeighborBlock(
	neighbor: Uint8Array | Uint16Array | undefined,
	palette: Uint8Array | Uint16Array | null | undefined,
	uniformId: number | undefined,
	index: number,
	totalBlocks: number,
	fallback: number,
): number {
	if (uniformId !== undefined) return uniformId;

	if (!neighbor || neighbor.length === 0) return 0;

	if (palette && palette.length > 1) {
		const packed = neighbor as Uint8Array;
		if (index < 0 || index >= totalBlocks) return fallback;
		const paletteIndex = readPackedNibble(packed, index);
		return palette[paletteIndex] ?? fallback;
	}

	if (index < 0 || index >= neighbor.length) return fallback;
	return neighbor[index] ?? fallback;
}

/**
 * Create an empty WorkerInternalMeshData inside the worker.
 * This must never be posted directly to main thread.
 */
export function createEmptyWorkerInternalMeshData(): WorkerInternalMeshData {
	return {
		faceDataA: new ResizableTypedArray(Uint8Array),
		faceDataB: new ResizableTypedArray(Uint8Array),
		faceDataC: new ResizableTypedArray(Uint8Array),
		faceCount: 0,
	};
}

/**
 * Convert internal mesh data (contains ResizableTypedArray instances)
 * into plain MeshData (transferable / cloneable).
 */
export function toTransferableMeshData(data: WorkerInternalMeshData): MeshData {
	const out = new MeshData();
	out.faceDataA = data.faceDataA.finalArray;
	out.faceDataB = data.faceDataB.finalArray;
	out.faceDataC = data.faceDataC.finalArray;
	out.faceCount = data.faceCount;
	return out;
}

/**
 * O(1) compact 26-neighbor index mapping.
 * Inlined for performance - called infrequently (once per out-of-bounds access).
 */
function getNeighborIndex(dx: number, dy: number, dz: number): number {
	if (dx === 0 && dy === 0 && dz === 0) return -1;
	const linear = dx + 1 + (dy + 1) * 3 + (dz + 1) * 9;
	return linear < 13 ? linear : linear - 1;
}

/**
 * Rebuild full MeshContext inside the worker from plain postMessage payload.
 * This version supports the center chunk and 26 neighbors.
 */
export function createMeshContextFromPayload(
	base: WorkerMeshBaseContext,
	input: WorkerMeshInput,
): MeshContext {
	const size = base.size;
	const size2 = size * size;

	const blockArray = input.block_array;
	const lightArray = input.light_array;

	const neighbors = input.neighbors;
	const neighborLights = input.neighborLights;
	const neighborPalettes = input.neighborPalettes;
	const neighborUniformIds = input.neighborUniformIds;

	const lod = base.lod;

	const hasNeighborChunk = (dx: number, dy: number, dz: number): boolean => {
		if (dx === 0 && dy === 0 && dz === 0) return false;

		const linear = dx + 1 + (dy + 1) * 3 + (dz + 1) * 9;
		const neighborIndex = linear < 13 ? linear : linear - 1;

		const n = neighbors[neighborIndex];
		if (n) return true;

		return (
			neighborUniformIds !== undefined &&
			neighborUniformIds[neighborIndex] !== undefined
		);
	};

	const readBlock = (x: number, y: number, z: number, fallback = 0): number => {
		// Fast in-bounds path
		if (x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size) {
			return blockArray[x + y * size + z * size2];
		}

		let ox = 0;
		let oy = 0;
		let oz = 0;

		let lx = x;
		let ly = y;
		let lz = z;

		if (x < 0) {
			ox = -1;
			lx = x + size;
		} else if (x >= size) {
			ox = 1;
			lx = x - size;
		}

		if (y < 0) {
			oy = -1;
			ly = y + size;
		} else if (y >= size) {
			oy = 1;
			ly = y - size;
		}

		if (z < 0) {
			oz = -1;
			lz = z + size;
		} else if (z >= size) {
			oz = 1;
			lz = z - size;
		}

		// More than one chunk away
		if (lx < 0 || lx >= size || ly < 0 || ly >= size || lz < 0 || lz >= size) {
			return fallback;
		}

		const linear = ox + 1 + (oy + 1) * 3 + (oz + 1) * 9;
		const nIdx = linear < 13 ? linear : linear - 1;

		if (nIdx < 0) return fallback;

		const uniformId =
			neighborUniformIds !== undefined ? neighborUniformIds[nIdx] : undefined;

		if (uniformId !== undefined) {
			return uniformId;
		}

		const neighbor = neighbors[nIdx];
		if (!neighbor || neighbor.length === 0) {
			return 0;
		}

		const idx = lx + ly * size + lz * size2;

		const palette =
			neighborPalettes !== undefined ? neighborPalettes[nIdx] : undefined;

		if (palette && palette.length > 1) {
			const packed = neighbor as Uint8Array;
			const byte = packed[idx >>> 1];
			const paletteIndex = (idx & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;

			return palette[paletteIndex] ?? fallback;
		}

		return neighbor[idx] ?? fallback;
	};

	const readLight = (x: number, y: number, z: number, fallback = 0): number => {
		const centerLight = lightArray;

		// Fast in-bounds path
		if (x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size) {
			if (!centerLight) return fallback;
			return centerLight[x + y * size + z * size2];
		}

		let ox = 0;
		let oy = 0;
		let oz = 0;

		let lx = x;
		let ly = y;
		let lz = z;

		if (x < 0) {
			ox = -1;
			lx = x + size;
		} else if (x >= size) {
			ox = 1;
			lx = x - size;
		}

		if (y < 0) {
			oy = -1;
			ly = y + size;
		} else if (y >= size) {
			oy = 1;
			ly = y - size;
		}

		if (z < 0) {
			oz = -1;
			lz = z + size;
		} else if (z >= size) {
			oz = 1;
			lz = z - size;
		}

		if (lx < 0 || lx >= size || ly < 0 || ly >= size || lz < 0 || lz >= size) {
			return fallback;
		}

		const linear = ox + 1 + (oy + 1) * 3 + (oz + 1) * 9;
		const nIdx = linear < 13 ? linear : linear - 1;

		if (nIdx < 0 || neighborLights === undefined) {
			return fallback;
		}

		const nLight = neighborLights[nIdx];
		if (!nLight) return fallback;

		return nLight[lx + ly * size + lz * size2];
	};

	return {
		size,
		lod,
		disableAO: lod >= 2,
		getBlock: readBlock,
		getLight: readLight,
		hasNeighborChunk,
	};
}
