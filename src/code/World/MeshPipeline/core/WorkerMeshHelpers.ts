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
};
type NeighborSample = {
	neighborIndex: number;
	lx: number;
	ly: number;
	lz: number;
};

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

	// O(1) compact 26-neighbor index mapping
	const getNeighborIndex = (dx: number, dy: number, dz: number): number => {
		if (dx === 0 && dy === 0 && dz === 0) return -1;
		const linear = dx + 1 + (dy + 1) * 3 + (dz + 1) * 9;
		return linear < 13 ? linear : linear - 1;
	};

	const isInBounds = (x: number, y: number, z: number): boolean => {
		return x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size;
	};

	const hasNeighborChunk = (dx: number, dy: number, dz: number): boolean => {
		const neighborIndex = getNeighborIndex(dx, dy, dz);
		return neighborIndex >= 0 && !!input.neighbors[neighborIndex];
	};

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

	const readBlock = (x: number, y: number, z: number, fallback = 0): number => {
		// Fast in-bounds path
		if (isInBounds(x, y, z)) {
			return input.block_array[x + y * size + z * size2] ?? fallback;
		}

		const sample = remapToNeighbor(x, y, z);
		if (!sample) return fallback;

		const neighbor = input.neighbors[sample.neighborIndex];
		// Distinguish missing vs mesh-only neighbors:
		// - undefined  => neighbor chunk truly missing, treat as air
		// - length === 0 => loaded mesh-only neighbor sentinel, keep fallback
		//                  (caller passes current block) to avoid seam walls
		if (!neighbor) return 0;
		if (neighbor.length === 0) return fallback;

		return readArrayValue(neighbor, sample.lx, sample.ly, sample.lz, fallback);
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
