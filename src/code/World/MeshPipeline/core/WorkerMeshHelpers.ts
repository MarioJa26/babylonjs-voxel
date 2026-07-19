import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { MeshData } from "../../Chunk/DataStructures/MeshData";
import { ResizableTypedArray } from "../../Chunk/DataStructures/ResizableTypedArray";
import type { WorkerInternalMeshData } from "../../Chunk/DataStructures/WorkerInternalMeshData";
import type { MeshContext } from "../types/MeshTypes";
import {
	FLAG_GREEDY,
	FLAG_PARTIAL,
	FLAG_SOLID,
	FLAG_TRANSPARENT,
	getCachedFlagsAndId,
	getFlagsFromCombined,
} from "./BlockFlags";

export type WorkerMeshBaseContext = {
	size: number;
	lod: number;
};

export type WorkerMeshInput = {
	block_array: Uint8Array | Uint16Array;
	light_array?: Uint8Array;
	neighbors: (Uint16Array | undefined)[];
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

// ── Padded block/light grids ──────────────────────────────────────────────────
// PERF: Pre-allocate scratch buffers for the (size+2)^3 padded grids.
// These are reused across all createMeshContextFromPayload calls (worker is
// single-threaded for this path). Sized for the max expected chunk size (64).
const MAX_PADDED = GenerationParams.CHUNK_SIZE + 2; // 64 + 2
const MAX_PADDED_VOL = MAX_PADDED * MAX_PADDED * MAX_PADDED;
let _paddedBlocks = new Uint16Array(MAX_PADDED_VOL);
let _paddedLights = new Uint8Array(MAX_PADDED_VOL);
// PERF: One bit per padded cell — "opaque, greedy-participating, solid cube
// with no transparency/partial-shape complications". VoxelMaskExtractor was
// re-deriving this exact condition from raw flags up to 6x per voxel per
// remesh (once as "current" and once as "neighbor", for each of 3 axes).
// Classifying every cell once here — in a single sequential pass over the
// padded grid we already built — lets the axis loops fast-reject the
// overwhelming majority of interior cell-pairs with one AND of two bytes,
// with zero flag re-derivation and zero call into processCell.
let _paddedOpaque: Uint8Array<ArrayBufferLike> = new Uint8Array(MAX_PADDED_VOL);

// ── Shared hot closures ──────────────────────────────────────────────────────
// PERF: getBlock/getLight/hasNeighborChunk are invoked on the meshing hot path
// (hasNeighborChunk fires per negative-boundary slice, getBlock/getLight per
// voxel during AO/light sampling). Instead of re-creating these closures on
// every chunk build, they are defined once here and read the per-chunk state
// from the module-level refs below. This mirrors the _paddedBlocks reuse
// assumption (worker is single-threaded; fullCtx is never retained across
// builds).
let _ctxPadded = _paddedBlocks;
let _ctxPaddedLight = _paddedLights;
let _ctxPaddedOpaque = _paddedOpaque;
let _ctxPs = 0;
let _ctxPs2 = 0;
let _ctxNeighbors: (Uint8Array | Uint16Array | undefined)[] = [];

// PERF: Exposed for the hot meshing loops (processCell / computeAO) so they can
// index the padded grid directly instead of paying a per-voxel closure-call
// for getBlock/getLight. Single-threaded worker: these are valid only for the
// duration of the current build.
export const PaddedGrid = {
	get block(): Uint16Array {
		return _ctxPadded;
	},
	get light(): Uint8Array {
		return _ctxPaddedLight;
	},
	get opaque(): Uint8Array {
		return _ctxPaddedOpaque;
	},
	get ps(): number {
		return _ctxPs;
	},
	get ps2(): number {
		return _ctxPs2;
	},
};

// Inline padded-grid index (flattened, with the +1 border offset baked in).
export function paddedIndex(x: number, y: number, z: number): number {
	return x + 1 + (y + 1) * _ctxPs + (z + 1) * _ctxPs2;
}

const _readBlock = (x: number, y: number, z: number, _fallback = 0): number => {
	return _ctxPadded[x + 1 + (y + 1) * _ctxPs + (z + 1) * _ctxPs2];
};

const _readLight = (x: number, y: number, z: number, _fallback = 0): number => {
	return _ctxPaddedLight[x + 1 + (y + 1) * _ctxPs + (z + 1) * _ctxPs2];
};

const _hasNeighborChunk = (dx: number, dy: number, dz: number): boolean => {
	if (dx === 0 && dy === 0 && dz === 0) return false;

	const linear = dx + 1 + (dy + 1) * 3 + (dz + 1) * 9;
	const neighborIndex = linear < 13 ? linear : linear - 1;

	// A neighbor "exists" iff the main thread sent a border slab for it.
	return _ctxNeighbors[neighborIndex] !== undefined;
};

// ── Precomputed neighbor offset table ─────────────────────────────────────────
// PERF: The (ox, oy, oz) offset for each of the 26 neighbor slots is fixed and
// independent of chunk size. Decoding it via Math.floor/modulo on every
// neighbor for every chunk build (26 * every mesh rebuild) is pure repeated
// work for a value that never changes. Compute it once at module load and
// index into it instead.
type NeighborOffset = readonly [ox: number, oy: number, oz: number];
const NEIGHBOR_OFFSETS: NeighborOffset[] = (() => {
	const table: NeighborOffset[] = new Array(26);
	for (let ni = 0; ni < 26; ni++) {
		const linear = ni < 13 ? ni : ni + 1;
		const oz = Math.floor(linear / 9) - 1;
		const oy = Math.floor((linear % 9) / 3) - 1;
		const ox = (linear % 3) - 1;
		table[ni] = [ox, oy, oz];
	}
	return table;
})();

const OPAQUE_REQUIRED = FLAG_SOLID | FLAG_GREEDY;
const OPAQUE_FORBIDDEN = FLAG_TRANSPARENT | FLAG_PARTIAL;

/**
 * PERF: Classify every cell in the padded grid exactly once, immediately
 * after the grid is assembled. A cell is "opaque" here iff it is solid,
 * greedy-participating, and has neither the transparent nor partial-shape
 * flag — i.e. exactly the condition VoxelMaskExtractor's bothCube fast path
 * checks. Doing it here means the flags for a given voxel are derived once
 * per chunk build instead of up to 6 times (as current + as neighbor, for
 * each of the 3 mesh axes) inside the per-cell hot loop.
 */
function buildOpaqueClassification(
	padded: Uint16Array,
	psVol: number,
): Uint8Array {
	const bits = _paddedOpaque;
	for (let i = 0; i < psVol; i++) {
		const flags = getFlagsFromCombined(getCachedFlagsAndId(padded[i]));
		bits[i] =
			(flags & OPAQUE_REQUIRED) === OPAQUE_REQUIRED &&
			(flags & OPAQUE_FORBIDDEN) === 0
				? 1
				: 0;
	}
	return bits;
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

	const lod = base.lod;

	// Ensure padded buffers are large enough.
	if (psVol > _paddedBlocks.length) {
		_paddedBlocks = new Uint16Array(psVol);
		_paddedLights = new Uint8Array(psVol);
		_paddedOpaque = new Uint8Array(psVol);
	}
	const padded = _paddedBlocks;
	const paddedLight = _paddedLights;

	// ── Determine whether the zero-clear is actually needed ──
	// PERF: The center chunk (indices 1..size on every axis) is always fully
	// overwritten below, so it never needs clearing. The 1-voxel padding shell
	// is only "at risk" of holding stale data from a previous build if some
	// neighbor slab is missing (e.g. at the edge of loaded terrain) — when all
	// 26 neighbor slabs are present, the border-copy loop below writes every
	// shell cell itself. In the common interior-of-loaded-world case this lets
	// us skip an O(ps^3) fill entirely.
	let needBlockClear = false;
	for (let i = 0; i < 26; i++) {
		if (!neighbors[i]) {
			needBlockClear = true;
			break;
		}
	}

	let needLightClear = !lightArray;
	if (!needLightClear) {
		if (!neighborLights) {
			needLightClear = true;
		} else {
			for (let i = 0; i < 26; i++) {
				if (!neighborLights[i]) {
					needLightClear = true;
					break;
				}
			}
		}
	}

	if (needBlockClear) padded.fill(0, 0, psVol);
	if (needLightClear) paddedLight.fill(0, 0, psVol);

	// ── Fill center chunk (indices 1..size in each axis) ──
	// PERF: x is the fastest-varying axis in both the source (block_array) and
	// destination (padded) layouts, so each x-row is a contiguous run in both
	// arrays. Use TypedArray#set (native memcpy-ish) per row instead of a
	// scalar per-voxel loop — collapses the innermost loop from `size`
	// individual writes to a single bulk copy.
	for (let z = 0; z < size; z++) {
		const pZ = (z + 1) * ps2;
		const cZ = z * size2;
		for (let y = 0; y < size; y++) {
			const pIdx = (y + 1) * ps + pZ;
			const cIdx = y * size + cZ;
			padded.set(blockArray.subarray(cIdx, cIdx + size), 1 + pIdx);
		}
	}

	if (lightArray) {
		for (let z = 0; z < size; z++) {
			const pZ = (z + 1) * ps2;
			const cZ = z * size2;
			for (let y = 0; y < size; y++) {
				const pIdx = (y + 1) * ps + pZ;
				const cIdx = y * size + cZ;
				paddedLight.set(lightArray.subarray(cIdx, cIdx + size), 1 + pIdx);
			}
		}
	}

	// ── Fill neighbor borders ──
	// For each of the 26 neighbors, copy the border voxels that touch the
	// center chunk into the appropriate padding positions. The main thread
	// sends only the 1-voxel-thick border slab (dense Uint16/Uint8, exactly
	// xCount*yCount*zCount elements, in (dx, dy, dz) order) per neighbor, so
	// we can trust indices without bounds-checking each element.
	const neighborCount = neighbors.length;
	for (let ni = 0; ni < neighborCount; ni++) {
		const neighbor = neighbors[ni];
		const nLight = neighborLights?.[ni];

		// No border data → leave padded as 0 (air), matching old behavior.
		if (!neighbor) continue;

		const [ox, oy, oz] = NEIGHBOR_OFFSETS[ni];

		const xCount = ox === 0 ? size : 1;
		const yCount = oy === 0 ? size : 1;
		const zCount = oz === 0 ? size : 1;

		const pXStart = ox < 0 ? 0 : ox > 0 ? size + 1 : 1;
		const pYStart = oy < 0 ? 0 : oy > 0 ? size + 1 : 1;
		const pZStart = oz < 0 ? 0 : oz > 0 ? size + 1 : 1;

		if (xCount === size) {
			// PERF: ox === 0 means every x-run for this neighbor is a full,
			// contiguous `size`-length row in both the source slab and the
			// padded destination (x is the fastest axis in both). This covers
			// every face neighbor along the x=0 plane and 4 of the 12 edge
			// neighbors — collapse the per-voxel writes into row-sized
			// TypedArray#set calls.
			let ci = 0;
			for (let dz = 0; dz < zCount; dz++) {
				const pZ = (pZStart + dz) * ps2;
				for (let dy = 0; dy < yCount; dy++) {
					const pY = (pYStart + dy) * ps;
					const destOffset = pXStart + pY + pZ;
					padded.set(neighbor.subarray(ci, ci + size), destOffset);
					if (nLight) {
						paddedLight.set(nLight.subarray(ci, ci + size), destOffset);
					}
					ci += size;
				}
			}
		} else {
			// Remaining cases (edges/corners not aligned along x) are already
			// small (at most `size` elements, often just 1), so the per-voxel
			// loop is fine here.
			let ci = 0;
			for (let dz = 0; dz < zCount; dz++) {
				const pZ = (pZStart + dz) * ps2;
				for (let dy = 0; dy < yCount; dy++) {
					const pY = (pYStart + dy) * ps;
					for (let dx = 0; dx < xCount; dx++) {
						const dest = pXStart + dx + pY + pZ;
						padded[dest] = neighbor[ci];
						if (nLight) {
							paddedLight[dest] = nLight[ci];
						}
						ci++;
					}
				}
			}
		}
	}

	// ── Classify every cell once, now that the grid (center + all neighbor
	// borders) is fully assembled ──
	const opaque = buildOpaqueClassification(padded, psVol);

	// ── Publish per-chunk state for the shared hot closures ──
	_ctxPadded = padded;
	_ctxPaddedLight = paddedLight;
	_ctxPaddedOpaque = opaque;
	_ctxPs = ps;
	_ctxPs2 = ps2;
	_ctxNeighbors = neighbors;

	return {
		size,
		lod,
		disableAO: lod >= 2,
		getBlock: _readBlock,
		getLight: _readLight,
		hasNeighborChunk: _hasNeighborChunk,
	};
}
