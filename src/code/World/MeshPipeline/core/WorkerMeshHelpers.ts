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
} from "./BlockInfoCache";
import { QuadBuffer } from "./QuadBuffer";
import type { VoxelPipeline } from "./VoxelPipeline";

export type WorkerMeshBaseContext = {
	size: number;
	lod: number;
};

export type WorkerMeshInput = {
	block_array?: Uint8Array | Uint16Array | null;
	// Uniform chunks carry only the fill id — the padded grid is filled
	// directly, skipping the dense intermediate array (64-512 KiB alloc).
	uniformFill?: number;
	light_array?: Uint8Array;
	neighbors: (Uint16Array | undefined)[];
	neighborLights?: (Uint8Array | undefined)[];
};

/**
 * Padded-grid buffer set. A relight-cache entry owns one of these so a
 * light-only remesh can skip the block fill + opacity classification entirely:
 * the session binds to the entry's arrays instead of copying into its own.
 */
export type PaddedGrids = {
	block: Uint16Array<ArrayBuffer>;
	light: Uint8Array<ArrayBuffer>;
	opaque: Uint8Array<ArrayBuffer>;
	needsCustom: Uint8Array<ArrayBuffer>;
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
 * A single build-time context for the voxel meshing pipeline.
 *
 * Before this refactor the pipeline carried its mutable per-build state in
 * module-level globals (`PaddedGrid`, `_ctxPadded*`, greedy scratch buffers,
 * the shared face descriptor, the emitter origin scratch). That made the
 * pipeline non-re-entrant, untestable, and made `MeshContext` a half-truth
 * (its getBlock/getLight/hasNeighborChunk were bypassed by the hot loops,
 * which read the hidden globals directly).
 *
 * MeshBuildSession is the single source of truth for one chunk build:
 *
 *  - the (size+2)^3 padded block/light grids + the one-shot opaque
 *    classification, so all getBlock/getLight/padded-index reads are plain
 *    array loads with zero branching;
 *  - the greedy scratch masks/lights and the shared face descriptor, so
 *    `greedyMesh` never allocates per slice;
 *  - the emitter origin scratch;
 *  - the cached VoxelPipeline instance, so the per-axis closures are created
 *    once per worker instead of once per build.
 *
 * The worker keeps one session and calls `begin()` per task: buffers are
 * reused across builds (single-threaded worker), while the session object
 * itself can be passed explicitly everywhere, making every pipeline stage
 * re-entrant and testable.
 */
export class MeshBuildSession implements MeshContext {
	// --- context (per build) ---
	public size = 0;
	public lod = 0;
	public disableAO = false;

	// --- padded grids (reused across builds) ---
	public block = new Uint16Array(0);
	public light = new Uint8Array(0);
	public opaque = new Uint8Array(0);
	public needsCustom = new Uint8Array(0);
	public ps = 0;
	public ps2 = 0;
	public neighbors: (Uint16Array | undefined)[] = [];

	// --- quad output buffers (bound per build via buildVoxelMesh) ---
	public quadOpaque = new QuadBuffer();
	public quadTransparent = new QuadBuffer();

	// --- greedy scratch (reused across builds) ---
	public scratchMask = new Int32Array(0);
	public scratchLights = new Uint16Array(0);

	// --- shared face descriptor handed to the emit callback ---
	public faceScratch = {
		slice: 0,
		uStart: 0,
		vStart: 0,
		width: 0,
		height: 0,
		idState: 0,
		light: 0,
	};

	// --- emitter origin scratch ---
	public origin = { ox: 0, oy: 0, oz: 0 };

	// --- cached pipeline (closures created once per worker) ---
	public pipeline: VoxelPipeline | null = null;

	/**
	 * Inline padded-grid index (flattened, with the +1 border offset baked in).
	 *
	 * NOTE: arrow-property, not a prototype method — callers detach it
	 * (`const padIndex = session.padIndex`), and a prototype method would lose
	 * `this` (→ "Cannot read properties of undefined (reading 'ps')").
	 */
	public padIndex = (x: number, y: number, z: number): number =>
		x + 1 + (y + 1) * this.ps + (z + 1) * this.ps2;

	public getBlock = (x: number, y: number, z: number, _fallback = 0): number =>
		this.block[this.padIndex(x, y, z)];

	public getLight = (x: number, y: number, z: number, _fallback = 0): number =>
		this.light[this.padIndex(x, y, z)];

	public hasNeighborChunk = (dx: number, dy: number, dz: number): boolean => {
		if (dx === 0 && dy === 0 && dz === 0) return false;

		const linear = dx + 1 + (dy + 1) * 3 + (dz + 1) * 9;
		const neighborIndex = linear < 13 ? linear : linear - 1;

		// A neighbor "exists" iff the main thread sent a border slab for it.
		return this.neighbors[neighborIndex] !== undefined;
	};

	/**
	 * Reset the session for a new chunk build: fills the padded grids from the
	 * center chunk + 26 neighbor border slabs and re-classifies opacity.
	 *
	 * When `grids` is provided (a relight-cache entry's padded buffers) the
	 * session binds to those arrays instead of its own — and when
	 * `skipBlockFill` is set, the block content + opacity classification are
	 * known-valid from the entry's previous full build, so only the light
	 * grid is refilled.
	 */
	public begin(
		base: WorkerMeshBaseContext,
		input: WorkerMeshInput,
		grids?: PaddedGrids,
		skipBlockFill = false,
	): void {
		const size = base.size;
		const size2 = size * size;
		const ps = size + 2; // padded size
		const ps2 = ps * ps;
		const psVol = ps * ps * ps;

		const blockArray = input.block_array;
		const lightArray = input.light_array;

		const neighbors = input.neighbors;
		const neighborLights = input.neighborLights;

		this.size = size;
		this.lod = base.lod;
		this.disableAO = base.lod >= 2;

		// Ensure padded buffers are large enough (grow the caller-provided
		// grids in place so they persist across relights).
		if (grids) {
			if (psVol > grids.block.length) {
				grids.block = new Uint16Array(psVol);
				grids.light = new Uint8Array(psVol);
				grids.opaque = new Uint8Array(psVol);
				grids.needsCustom = new Uint8Array(psVol);
			}
			this.block = grids.block;
			this.light = grids.light;
			this.opaque = grids.opaque;
			this.needsCustom = grids.needsCustom;
		} else {
			// NOTE: the voxel worker always passes `grids` (a relight-cache
			// entry's buffers). This fallback must not reuse the session's
			// existing arrays in that scenario — after a grid-bound build,
			// `this.block` aliases the cache entry's arrays, and writing a
			// different chunk into them would corrupt the entry. Allocating
			// fresh is the safe default for any non-cache caller.
			this.block = new Uint16Array(psVol);
			this.light = new Uint8Array(psVol);
			this.opaque = new Uint8Array(psVol);
			this.needsCustom = new Uint8Array(psVol);
		}
		const padded = this.block;
		const paddedLight = this.light;
		this.ps = ps;
		this.ps2 = ps2;

		// ── Determine whether the zero-clear is actually needed ──
		// PERF: The center chunk (indices 1..size on every axis) is always fully
		// overwritten below, so it never needs clearing. The 1-voxel padding shell
		// is only "at risk" of holding stale data from a previous build if some
		// neighbor slab is missing (e.g. at the edge of loaded terrain) — when all
		// 26 neighbor slabs are present, the border-copy loop below writes every
		// shell cell itself. In the common interior-of-loaded-world case this lets
		// us skip an O(ps^3) fill entirely. On a light-only rebuild the block grid
		// is already valid, so only the light clear is ever needed.
		let needBlockClear = false;
		if (!skipBlockFill) {
			for (let i = 0; i < 26; i++) {
				if (!neighbors[i]) {
					needBlockClear = true;
					break;
				}
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

		if (!skipBlockFill) {
			// ── Fill center chunk (indices 1..size in each axis) ──
			// PERF: x is the fastest-varying axis in both the source (block_array)
			// and destination (padded) layouts, so each x-row is a contiguous run
			// in both arrays. A tight store loop beats TypedArray#set(subarray)
			// here: the subarray would allocate a fresh view per row (~2 * size^2
			// tiny allocations per build).
			if (input.uniformFill !== undefined) {
				const fillId = input.uniformFill;
				for (let z = 0; z < size; z++) {
					const pZ = (z + 1) * ps2;
					for (let y = 0; y < size; y++) {
						const start = 1 + (y + 1) * ps + pZ;
						padded.fill(fillId, start, start + size);
					}
				}
			} else if (blockArray) {
				for (let z = 0; z < size; z++) {
					const pZ = (z + 1) * ps2;
					const cZ = z * size2;
					for (let y = 0; y < size; y++) {
						const pIdx = 1 + (y + 1) * ps + pZ;
						const cIdx = y * size + cZ;
						for (let x = 0; x < size; x++) {
							padded[pIdx + x] = blockArray[cIdx + x];
						}
					}
				}
			}
		}

		if (lightArray) {
			for (let z = 0; z < size; z++) {
				const pZ = (z + 1) * ps2;
				const cZ = z * size2;
				for (let y = 0; y < size; y++) {
					const pIdx = 1 + (y + 1) * ps + pZ;
					const cIdx = y * size + cZ;
					for (let x = 0; x < size; x++) {
						paddedLight[pIdx + x] = lightArray[cIdx + x];
					}
				}
			}
		}

		// ── Fill neighbor borders ──
		// For each of the 26 neighbors, copy the border voxels that touch the
		// center chunk into the appropriate padding positions. The main thread
		// sends only the 1-voxel-thick border slab (dense Uint16/Uint8, exactly
		// xCount*yCount*zCount elements, in (dx, dy, dz) order) per neighbor, so
		// we can trust indices without bounds-checking each element. On a
		// light-only rebuild the block borders are already baked into the grid;
		// only the light borders are copied.
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
				// neighbors — store loops, same rationale as the center fill.
				let ci = 0;
				for (let dz = 0; dz < zCount; dz++) {
					const pZ = (pZStart + dz) * ps2;
					for (let dy = 0; dy < yCount; dy++) {
						const pY = (pYStart + dy) * ps;
						const destOffset = pXStart + pY + pZ;
						if (!skipBlockFill) {
							for (let x = 0; x < size; x++) {
								padded[destOffset + x] = neighbor[ci + x];
							}
						}
						if (nLight) {
							for (let x = 0; x < size; x++) {
								paddedLight[destOffset + x] = nLight[ci + x];
							}
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
							if (!skipBlockFill) {
								padded[dest] = neighbor[ci];
							}
							if (nLight) {
								paddedLight[dest] = nLight[ci];
							}
							ci++;
						}
					}
				}
			}
		}

		this.neighbors = neighbors;

		// ── Classify every cell once, now that the grid (center + all neighbor
		// borders) is fully assembled. A light-only rebuild reuses the entry's
		// classification (block content is version-validated unchanged).
		if (!skipBlockFill) {
			this.buildOpaqueClassification(psVol);
		}
	}

	/**
	 * PERF: Classify every cell in the padded grid exactly once, immediately
	 * after the grid is assembled. A cell is "opaque" here iff it is solid,
	 * greedy-participating, and has neither the transparent nor partial-shape
	 * flag — i.e. exactly the condition VoxelMaskExtractor's bothCube fast path
	 * checks. Doing it here means the flags for a given voxel are derived once
	 * per chunk build instead of up to 6 times (as current + as neighbor, for
	 * each of the 3 mesh axes) inside the per-cell hot loop.
	 */
	private buildOpaqueClassification(psVol: number): void {
		const bits = this.opaque;
		const customBits = this.needsCustom;
		const padded = this.block;
		for (let i = 0; i < psVol; i++) {
			const flags = getFlagsFromCombined(getCachedFlagsAndId(padded[i]));
			bits[i] =
				(flags & OPAQUE_REQUIRED) === OPAQUE_REQUIRED &&
				(flags & OPAQUE_FORBIDDEN) === 0
					? 1
					: 0;
			// P3.7: custom-shape pass only visits cells that can possibly
			// contribute custom geometry: solid blocks that are NOT
			// greedy-participating (crosses, fences, multi-box shapes).
			customBits[i] =
				(flags & FLAG_SOLID) !== 0 && (flags & FLAG_GREEDY) === 0 ? 1 : 0;
		}
	}
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
 * The max padded volume this session may be asked to allocate for, used to
 * size the initial buffers. Kept for reference; buffers grow on demand.
 */
export const MAX_PADDED = GenerationParams.CHUNK_SIZE + 2; // 32 + 2
export const MAX_PADDED_VOL = MAX_PADDED * MAX_PADDED * MAX_PADDED;
