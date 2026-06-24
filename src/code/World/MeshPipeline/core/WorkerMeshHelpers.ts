import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { MeshData } from "../../Chunk/DataStructures/MeshData";
import { ResizableTypedArray } from "../../Chunk/DataStructures/ResizableTypedArray";
import type { WorkerInternalMeshData } from "../../Chunk/DataStructures/WorkerInternalMeshData";
import { SETTING_PARAMS } from "../../SETTINGS_PARAMS";
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

// ── Padded block/light grids ──────────────────────────────────────────────────
// PERF: Pre-allocate scratch buffers for the (size+2)^3 padded grids.
// These are reused across all createMeshContextFromPayload calls (worker is
// single-threaded for this path). Sized for the max expected chunk size (64).
const MAX_PADDED = GenerationParams.CHUNK_SIZE + 2; // 64 + 2
const MAX_PADDED_VOL = MAX_PADDED * MAX_PADDED * MAX_PADDED;
let _paddedBlocks = new Uint16Array(MAX_PADDED_VOL);
let _paddedLights = new Uint8Array(MAX_PADDED_VOL);

/**
 * Resolve a neighbor chunk's local coordinate to a packed block value,
 * handling palette expansion and uniform IDs.
 */
function resolveNeighborBlock(
	neighbor: Uint8Array | Uint16Array | undefined,
	palette: Uint8Array | Uint16Array | null | undefined,
	uniformId: number | undefined,
	lx: number,
	ly: number,
	lz: number,
	size: number,
	size2: number,
): number {
	if (uniformId !== undefined) return uniformId;
	if (!neighbor || neighbor.length === 0) return 0;

	const idx = lx + ly * size + lz * size2;

	if (palette && palette.length > 1) {
		const packed = neighbor as Uint8Array;
		const byte = packed[idx >>> 1];
		const paletteIndex = (idx & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;
		return palette[paletteIndex] ?? 0;
	}

	return neighbor[idx] ?? 0;
}

/**
 * Rebuild full MeshContext inside the worker from plain postMessage payload.
 * This version supports the center chunk and 26 neighbors.
 *
 * PERF: Builds a (size+2)^3 padded block grid so all getBlock/getLight calls
 * become simple array index operations with zero branching.
 */
export function createMeshContextFromPayload(
	base: WorkerMeshBaseContext,
	input: WorkerMeshInput,
): MeshContext {
	const size = base.size;
	const size2 = size * size;
	const ps = size + 2; // padded size
	const ps2 = ps * ps;
	const psVol = ps * ps * ps;

	const blockArray = input.block_array;
	const lightArray = input.light_array;

	const neighbors = input.neighbors;
	const neighborLights = input.neighborLights;
	const neighborPalettes = input.neighborPalettes;
	const neighborUniformIds = input.neighborUniformIds;

	const lod = base.lod;

	// Ensure padded buffers are large enough.
	if (psVol > _paddedBlocks.length) {
		_paddedBlocks = new Uint16Array(psVol);
		_paddedLights = new Uint8Array(psVol);
	}
	const padded = _paddedBlocks;
	const paddedLight = _paddedLights;

	// Zero out the padded buffers.
	padded.fill(0, 0, psVol);
	paddedLight.fill(0, 0, psVol);

	// ── Fill center chunk (indices 1..size in each axis) ──
	for (let z = 0; z < size; z++) {
		const pZ = (z + 1) * ps2;
		const cZ = z * size2;
		for (let y = 0; y < size; y++) {
			const pIdx = (y + 1) * ps + pZ;
			const cIdx = y * size + cZ;
			for (let x = 0; x < size; x++) {
				padded[x + 1 + pIdx] = blockArray[cIdx + x];
			}
		}
	}

	if (lightArray) {
		for (let z = 0; z < size; z++) {
			const pZ = (z + 1) * ps2;
			const cZ = z * size2;
			for (let y = 0; y < size; y++) {
				const pIdx = (y + 1) * ps + pZ;
				const cIdx = y * size + cZ;
				for (let x = 0; x < size; x++) {
					paddedLight[x + 1 + pIdx] = lightArray[cIdx + x];
				}
			}
		}
	}

	// ── Fill neighbor borders ──
	// For each of the 26 neighbors, copy the face/edge/corner voxels that
	// border the center chunk into the appropriate padding positions.
	const neighborCount = neighbors.length;
	for (let ni = 0; ni < neighborCount; ni++) {
		const neighbor = neighbors[ni];
		const nLight = neighborLights?.[ni];
		const nPalette = neighborPalettes?.[ni];
		const nUniform = neighborUniformIds?.[ni];

		// Skip neighbors with no data and no uniform ID.
		if (!neighbor && nUniform === undefined) continue;

		// Decode (ox, oy, oz) from linear neighbor index.
		// The mapping is: linear = ox+1 + (oy+1)*3 + (oz+1)*9
		// with linear >= 13 → linear - 1.
		const linear = ni < 13 ? ni : ni + 1;
		const oz = Math.floor(linear / 9) - 1;
		const oy = Math.floor((linear % 9) / 3) - 1;
		const ox = (linear % 3) - 1;

		// Determine which local coords in the neighbor map to the border.
		// neighborLocal = ox<0 ? size-1 : ox>0 ? 0 : [0..size-1]
		// paddedCoord   = ox<0 ? 0     : ox>0 ? size+1 : [1..size]
		const xCount = ox === 0 ? size : 1;
		const yCount = oy === 0 ? size : 1;
		const zCount = oz === 0 ? size : 1;

		const nLxStart = ox < 0 ? size - 1 : 0;
		const nLyStart = oy < 0 ? size - 1 : 0;
		const nLzStart = oz < 0 ? size - 1 : 0;

		const pXStart = ox < 0 ? 0 : ox > 0 ? size + 1 : 1;
		const pYStart = oy < 0 ? 0 : oy > 0 ? size + 1 : 1;
		const pZStart = oz < 0 ? 0 : oz > 0 ? size + 1 : 1;

		for (let dz = 0; dz < zCount; dz++) {
			const nLz = nLzStart + dz;
			const pZ = (pZStart + dz) * ps2;
			for (let dy = 0; dy < yCount; dy++) {
				const nLy = nLyStart + dy;
				const pY = (pYStart + dy) * ps;
				for (let dx = 0; dx < xCount; dx++) {
					const nLx = nLxStart + dx;
					const val = resolveNeighborBlock(
						neighbor,
						nPalette,
						nUniform,
						nLx,
						nLy,
						nLz,
						size,
						size2,
					);
					padded[pXStart + dx + pY + pZ] = val;

					// Also copy light data if available.
					if (nLight) {
						const lIdx = nLx + nLy * size + nLz * size2;
						paddedLight[pXStart + dx + pY + pZ] = nLight[lIdx] ?? 0;
					}
				}
			}
		}
	}

	// ── Fast lookups via padded grid ──
	const readBlock = (
		x: number,
		y: number,
		z: number,
		_fallback = 0,
	): number => {
		return padded[x + 1 + (y + 1) * ps + (z + 1) * ps2];
	};

	const readLight = (
		x: number,
		y: number,
		z: number,
		_fallback = 0,
	): number => {
		return paddedLight[x + 1 + (y + 1) * ps + (z + 1) * ps2];
	};

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

	return {
		size,
		lod,
		disableAO: lod >= 2,
		getBlock: readBlock,
		getLight: readLight,
		hasNeighborChunk,
	};
}
