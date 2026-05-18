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

	if (!neighbor) return fallback;

	if (neighbor.length === 0) return fallback;

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
	const size3 = size2 * size;

	const isInBounds = (x: number, y: number, z: number): boolean => {
		return x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size;
	};

	const hasNeighborChunk = (dx: number, dy: number, dz: number): boolean => {
		const neighborIndex = getNeighborIndex(dx, dy, dz);
		if (neighborIndex < 0) return false;
		const n = input.neighbors[neighborIndex];
		if (n) return true;
		return input.neighborUniformIds?.[neighborIndex] !== undefined;
	};

	// Remap to neighbor chunk - defined inline since it captures size
	const remapToNeighbor = (
		x: number,
		y: number,
		z: number,
	): NeighborSample | null => {
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

		const neighborIndex = getNeighborIndex(ox, oy, oz);
		if (neighborIndex < 0) {
			return null;
		}

		// IMPORTANT:
		// If the requested sample is still out of local bounds after a single
		// neighbor remap, it means the caller asked for a position more than one
		// chunk away. In that case we treat it as missing and return fallback.
		if (!isInBounds(lx, ly, lz)) {
			return null;
		}

		return { neighborIndex, lx, ly, lz };
	};

	const readArrayValue = (
		array: Uint8Array | Uint16Array | undefined,
		lx: number,
		ly: number,
		lz: number,
		fallback: number,
	): number => {
		if (!array) return fallback;

		const index = lx + ly * size + lz * size2;
		if (index < 0 || index >= size3) return fallback;

		return array[index] ?? fallback;
	};

	// Inlined readBlock for performance - called millions of times
	// Returns block data, with fallback for out-of-bounds
	const readBlock = (x: number, y: number, z: number, fallback = 0): number => {
		// Inline isInBounds check for fast path (most common case)
		if (x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size) {
			const idx = x + y * size + z * size2;
			return input.block_array[idx] ?? fallback;
		}

		// Slow path: out of bounds, need neighbor lookup
		let ox = 0,
			oy = 0,
			oz = 0;
		let lx = x,
			ly = y,
			lz = z;

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

		// Check if within one neighbor (not more than one chunk away)
		if (lx < 0 || lx >= size || ly < 0 || ly >= size || lz < 0 || lz >= size) {
			return fallback;
		}

		const neighborIndex = ox + 1 + (oy + 1) * 3 + (oz + 1) * 9;
		const nIdx = neighborIndex < 13 ? neighborIndex : neighborIndex - 1;

		if (nIdx < 0) return fallback;

		const uniformId = input.neighborUniformIds?.[nIdx];
		const palette = input.neighborPalettes?.[nIdx];
		const neighbor = input.neighbors[nIdx];
		const idx = lx + ly * size + lz * size2;

		return readNeighborBlock(
			neighbor,
			palette,
			uniformId,
			idx,
			size3,
			fallback,
		);
	};

	const readLight = (x: number, y: number, z: number, fallback = 0): number => {
		// Fast in-bounds path
		if (isInBounds(x, y, z)) {
			if (!input.light_array) return fallback;
			return input.light_array[x + y * size + z * size2] ?? fallback;
		}

		const sample = remapToNeighbor(x, y, z);
		if (!sample) return fallback;

		const neighborLight = input.neighborLights?.[sample.neighborIndex];
		return readArrayValue(
			neighborLight,
			sample.lx,
			sample.ly,
			sample.lz,
			fallback,
		);
	};

	return {
		size,
		lod: base.lod,
		disableAO: base.lod >= 2,
		getBlock: readBlock,
		getLight: readLight,
		hasNeighborChunk,
	};
}
