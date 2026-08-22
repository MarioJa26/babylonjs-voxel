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
	/**
	 * Border-skirt ownership (downsampled builds only). Bit per horizontal
	 * side (1=-X, 2=+X, 4=-Z, 8=+Z): a bit set means THIS chunk emits skirt
	 * walls on that border — decided main-thread-side so two neighboring
	 * chunks never both wall the same plane (coplanar z-fighting).
	 */
	borderSkirtSides?: number;
	/** Sides from borderSkirtSides whose NEAR plane is inset by one block. */
	borderSkirtNearInset?: number;
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

const NEIGHBOR_OFFSETS_FLAT: Int8Array = (() => {
	const table = new Int8Array(26 * 3);
	for (let ni = 0; ni < 26; ni++) {
		const linear = ni < 13 ? ni : ni + 1;
		const base = ni * 3;

		table[base] = (linear % 3) - 1;
		table[base + 1] = Math.floor((linear % 9) / 3) - 1;
		table[base + 2] = Math.floor(linear / 9) - 1;
	}
	return table;
})();

const OPAQUE_REQUIRED = FLAG_SOLID | FLAG_GREEDY;
const OPAQUE_FORBIDDEN = FLAG_TRANSPARENT | FLAG_PARTIAL;
// Combining required+forbidden into one mask turns the opaque test from two
// ANDs + a boolean AND into a single masked comparison: the surviving bits
// must equal exactly OPAQUE_REQUIRED (required bits set, forbidden bits clear).
const OPAQUE_TEST_MASK = OPAQUE_REQUIRED | OPAQUE_FORBIDDEN;
// Same trick for needsCustom (solid && !greedy): surviving bits under this
// mask must equal exactly FLAG_SOLID.
const CUSTOM_TEST_MASK = FLAG_SOLID | FLAG_GREEDY;

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
	// --- context per build ---
	public size = 0;
	public lod = 0;
	public disableAO = false;
	/**
	 * Geometric downsampling factor for this build: 1 for LOD<=3 (full
	 * resolution), 2 for LOD4, 4 for LOD5, ... Each mask cell then covers
	 * lodStep^3 voxels and every emitted quad spans lodStep blocks per cell.
	 */
	public lodStep = 1;
	/** Logical greedy-grid dimension: size / lodStep (mask cells per axis). */
	public meshGridSize = 0;
	/**
	 * Per-side skirt ownership mask (1=-X, 2=+X, 4=-Z, 8=+Z). Defaults to
	 * "all sides" so callers that don't know neighbor LODs keep coverage.
	 */
	public borderSkirtSides = 0xf;
	public borderSkirtNearInset = 0;

	// --- active padded grids ---
	public block = new Uint16Array(0);
	public light = new Uint8Array(0);
	public opaque = new Uint8Array(0);
	public needsCustom = new Uint8Array(0);
	public ps = 0;
	public ps2 = 0;
	public axisOffsets = new Int32Array(3);
	public neighbors: (Uint16Array | undefined)[] = [];

	// --- owned fallback grids, used only when no external relight-cache grids are supplied ---
	private ownedBlock = new Uint16Array(0);
	private ownedLight = new Uint8Array(0);
	private ownedOpaque = new Uint8Array(0);
	private ownedNeedsCustom = new Uint8Array(0);

	// --- quad output buffers ---
	public quadOpaque = new QuadBuffer();
	public quadTransparent = new QuadBuffer();
	// GPU-split transparent buckets: true water vs alpha-cutout (glass) get
	// separate meshes so the renderer can use a cheap cutout material instead
	// of forcing every non-water transparent face through the water shader.
	public quadWater = new QuadBuffer();
	public quadCutout = new QuadBuffer();

	// --- greedy scratch ---
	public scratchMask = new Int32Array(0);
	public scratchLights = new Uint16Array(0);

	// --- batched mask banks ---
	// Pre-extracted greedy masks for ALL slices of one axis, filled by a
	// single contiguous sweep per axis (VoxelMaskExtractor.extractAllSliceMasks*)
	// and consumed by greedyMesh's banked mode. Slice s (-1..size-1) lives at
	// (s+1) * area. One bank pair serves all three axes because extraction for
	// the next axis only starts after the current axis' merge completed.
	public maskBank = new Int32Array(0);
	public lightBank = new Uint16Array(0);

	public ensureMaskBank(minLength: number): Int32Array {
		if (this.maskBank.length < minLength) {
			this.maskBank = new Int32Array(minLength);
		}
		return this.maskBank;
	}

	public ensureLightBank(minLength: number): Uint16Array {
		if (this.lightBank.length < minLength) {
			this.lightBank = new Uint16Array(minLength);
		}
		return this.lightBank;
	}

	/**
	 * Per-slice occupancy for the banked greedy mode: slot s+1 is 1 when
	 * extraction wrote any nonzero mask cell into slice s. Lets greedyMesh
	 * skip all-empty slices entirely — most far chunks are majority air.
	 */
	public sliceOccupancy = new Uint8Array(0);

	public ensureSliceOccupancy(minLength: number): Uint8Array {
		if (this.sliceOccupancy.length < minLength) {
			this.sliceOccupancy = new Uint8Array(minLength);
		}
		return this.sliceOccupancy;
	}

	/** Number of needsCustom cells in the active padded grid (0 = plain). */
	public needsCustomCount = 0;

	// --- shared face descriptor ---
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

	// --- cached pipeline ---
	public pipeline: VoxelPipeline | null = null;

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

		return this.neighbors[neighborIndex] !== undefined;
	};

	public begin(
		size: number,
		lod: number,
		input: WorkerMeshInput,
		grids?: PaddedGrids,
		skipBlockFill = false,
	): void {
		const size2 = size * size;
		const ps = size + 2;
		const ps2 = ps * ps;
		const psVol = ps2 * ps;

		const blockArray = input.block_array;
		const lightArray = input.light_array;
		const neighbors = input.neighbors;
		const neighborLights = input.neighborLights;

		this.size = size;
		this.lod = lod;
		this.disableAO = lod >= 2;

		// Downsampling begins at LOD4 (user spec): LOD4 -> step 2, LOD5 -> 4...
		// Fall back to full resolution if the chunk size is not evenly
		// divisible, so the greedy grid always stays integral.
		const rawStep = lod >= 4 ? 1 << (lod - 3) : 1;
		this.lodStep = size % rawStep === 0 ? rawStep : 1;
		this.meshGridSize = size / this.lodStep;

		this.ps = ps;
		this.ps2 = ps2;

		this.axisOffsets[0] = 1;
		this.axisOffsets[1] = ps;
		this.axisOffsets[2] = ps2;

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
			this.ensureOwnedPaddedCapacity(psVol);

			this.block = this.ownedBlock;
			this.light = this.ownedLight;
			this.opaque = this.ownedOpaque;
			this.needsCustom = this.ownedNeedsCustom;
		}

		const padded = this.block;
		const paddedLight = this.light;

		let needBlockClear = false;
		if (!skipBlockFill) {
			for (let i = 0; i < 26; i++) {
				if (neighbors[i] === undefined) {
					needBlockClear = true;
					break;
				}
			}
		}

		let needLightClear = lightArray === undefined;
		if (!needLightClear) {
			if (neighborLights === undefined) {
				needLightClear = true;
			} else {
				for (let i = 0; i < 26; i++) {
					if (neighborLights[i] === undefined) {
						needLightClear = true;
						break;
					}
				}
			}
		}

		if (needBlockClear) padded.fill(0, 0, psVol);
		if (needLightClear) paddedLight.fill(0, 0, psVol);

		if (!skipBlockFill) {
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

						// Row-wise memcpy via set(subarray): both grids are x-major,
						// so each source row is contiguous and lands on a contiguous
						// padded row segment.
						padded.set(blockArray.subarray(cIdx, cIdx + size), pIdx);
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

					paddedLight.set(lightArray.subarray(cIdx, cIdx + size), pIdx);
				}
			}
		}

		for (let ni = 0; ni < 26; ni++) {
			const neighbor = neighbors[ni];
			const nLight = neighborLights?.[ni];

			// Block borders need block data. Light borders only need light data.
			// This keeps light-only remeshes from depending on block slabs being resent.
			if (neighbor === undefined && nLight === undefined) continue;

			const offsetBase = ni * 3;
			const ox = NEIGHBOR_OFFSETS_FLAT[offsetBase];
			const oy = NEIGHBOR_OFFSETS_FLAT[offsetBase + 1];
			const oz = NEIGHBOR_OFFSETS_FLAT[offsetBase + 2];

			const xCount = ox === 0 ? size : 1;
			const yCount = oy === 0 ? size : 1;
			const zCount = oz === 0 ? size : 1;

			const pXStart = ox < 0 ? 0 : ox > 0 ? size + 1 : 1;
			const pYStart = oy < 0 ? 0 : oy > 0 ? size + 1 : 1;
			const pZStart = oz < 0 ? 0 : oz > 0 ? size + 1 : 1;

			if (xCount === size) {
				let ci = 0;

				for (let dz = 0; dz < zCount; dz++) {
					const pZ = (pZStart + dz) * ps2;

					for (let dy = 0; dy < yCount; dy++) {
						const destOffset = pXStart + (pYStart + dy) * ps + pZ;

						// Face slabs store one contiguous x-row per (dz,dy) step
						// in the scratch buffers — copy row-wise.
						if (!skipBlockFill && neighbor !== undefined) {
							padded.set(neighbor.subarray(ci, ci + size), destOffset);
						}

						if (nLight !== undefined) {
							paddedLight.set(nLight.subarray(ci, ci + size), destOffset);
						}

						ci += size;
					}
				}
			} else {
				let ci = 0;

				for (let dz = 0; dz < zCount; dz++) {
					const pZ = (pZStart + dz) * ps2;

					for (let dy = 0; dy < yCount; dy++) {
						const pY = (pYStart + dy) * ps;

						for (let dx = 0; dx < xCount; dx++) {
							const dest = pXStart + dx + pY + pZ;

							if (!skipBlockFill && neighbor !== undefined) {
								padded[dest] = neighbor[ci];
							}

							if (nLight !== undefined) {
								paddedLight[dest] = nLight[ci];
							}

							ci++;
						}
					}
				}
			}
		}

		this.neighbors = neighbors;

		if (!skipBlockFill) {
			this.buildOpaqueClassification(psVol);
		}
	}

	private ensureOwnedPaddedCapacity(psVol: number): void {
		if (psVol <= this.ownedBlock.length) return;

		this.ownedBlock = new Uint16Array(psVol);
		this.ownedLight = new Uint8Array(psVol);
		this.ownedOpaque = new Uint8Array(psVol);
		this.ownedNeedsCustom = new Uint8Array(psVol);
	}

	private buildOpaqueClassification(psVol: number): void {
		const opaqueBits = this.opaque;
		const customBits = this.needsCustom;
		const padded = this.block;

		let customCount = 0;

		for (let i = 0; i < psVol; i++) {
			// getCachedFlagsAndId's low 16 bits ARE the flags, so masking the
			// combined value directly is equivalent to getFlagsFromCombined()
			// but skips a function call per cell over the whole padded volume.
			const flags = getCachedFlagsAndId(padded[i]) & 0xffff;

			opaqueBits[i] = (flags & OPAQUE_TEST_MASK) === OPAQUE_REQUIRED ? 1 : 0;
			const custom = (flags & CUSTOM_TEST_MASK) === FLAG_SOLID ? 1 : 0;
			customBits[i] = custom;
			customCount += custom;
		}

		// Lets emitCustomShapes bail out without scanning the volume for
		// plain terrain chunks (the overwhelming majority).
		this.needsCustomCount = customCount;
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
