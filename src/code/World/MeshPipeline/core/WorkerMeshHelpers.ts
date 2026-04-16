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

	// O(1) compact 26-neighbor index mapping
	const getNeighborIndex = (dx: number, dy: number, dz: number): number => {
		if (dx === 0 && dy === 0 && dz === 0) return -1;
		const linear = dx + 1 + (dy + 1) * 3 + (dz + 1) * 9;
		return linear < 13 ? linear : linear - 1;
	};

	const hasNeighborChunk = (dx: number, dy: number, dz: number): boolean => {
		const neighborIndex = getNeighborIndex(dx, dy, dz);
		return neighborIndex >= 0 && !!input.neighbors[neighborIndex];
	};

	const readBlock = (x: number, y: number, z: number, fallback = 0): number => {
		// Fast in-bounds path
		if (x >>> 0 < size && y >>> 0 < size && z >>> 0 < size) {
			return input.block_array[x + y * size + z * size2] ?? fallback;
		}

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

		const neighborIndex = getNeighborIndex(ox, oy, oz);
		if (neighborIndex < 0) return fallback;

		const neighbor = input.neighbors[neighborIndex];
		if (!neighbor) return fallback;

		return neighbor[lx + ly * size + lz * size2] ?? fallback;
	};

	const readLight = (x: number, y: number, z: number, fallback = 0): number => {
		// Fast in-bounds path
		if (x >>> 0 < size && y >>> 0 < size && z >>> 0 < size) {
			if (!input.light_array) return fallback;
			return input.light_array[x + y * size + z * size2] ?? fallback;
		}

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

		const neighborIndex = getNeighborIndex(ox, oy, oz);
		if (neighborIndex < 0) return fallback;

		const neighborLight = input.neighborLights?.[neighborIndex];
		if (!neighborLight) return fallback;

		return neighborLight[lx + ly * size + lz * size2] ?? fallback;
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
