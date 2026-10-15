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
	/**
	 * Per-chunk border-top cache for LOD skirts (4 sides × size columns:
	 * slot 0=-X indexed by z, 1=+X by z, 2=-Z by x, 3=+Z by x).
	 * borderTopY holds the top solid y, -1 = no solid, -2 = unknown.
	 * borderTopPacked holds the packed block at that y (topology only;
	 * light is always re-read fresh since relights change it).
	 * Populated during full builds, reused on light-only relights where
	 * the block grid is provably unchanged (same generation/blockRevision).
	 */
	borderTopY?: Int16Array;
	borderTopPacked?: Uint16Array;
	borderTopSize?: number;
	borderTopStep?: number;
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
	/**
	 * Uniform fill id from the build input (undefined = dense grid).
	 * 0 means all-air: LOD skirts can skip every column scan.
	 */
	public uniformFillId: number | undefined = undefined;
	/**
	 * Grids object backing this build (per-chunk relight entry, if any).
	 * Used for the border-top cache; undefined when using owned fallback
	 * grids (no cross-build reuse).
	 */
	public activeGrids: PaddedGrids | undefined = undefined;
	/**
	 * True when the block grid was (re)filled this build (full mesh).
	 * False on light-only relights where blocks are provably unchanged —
	 * cached border tops may be reused (light is still re-read fresh).
	 */
	public blocksChangedThisBuild = true;

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

	public padIndex(x: number, y: number, z: number): number {
		return x + 1 + (y + 1) * this.ps + (z + 1) * this.ps2;
	}

	public getBlock = (x: number, y: number, z: number, _fallback = 0): number =>
		this.block[this.padIndex(x, y, z)];

	public getLight = (x: number, y: number, z: number, _fallback = 0): number =>
		this.light[this.padIndex(x, y, z)];

	public hasNeighborChunk(dx: number, dy: number, dz: number): boolean {
		if (dx === 0 && dy === 0 && dz === 0) return false;

		const linear = dx + 1 + (dy + 1) * 3 + (dz + 1) * 9;
		const neighborIndex = linear < 13 ? linear : linear - 1;

		return this.neighbors[neighborIndex] !== undefined;
	}

	public begin(
		size: number,
		lod: number,
		input: WorkerMeshInput,
		grids?: PaddedGrids,
		skipBlockFill = false,
	): void {
		const ps = size + 2;
		const ps2 = ps * ps;
		const psVol = ps2 * ps;

		const blockArray = input.block_array;
		const lightArray = input.light_array;
		const neighbors = input.neighbors;
		const neighborLights = input.neighborLights;
		const uniformFill = input.uniformFill;

		this.size = size;
		this.lod = lod;
		this.disableAO = lod >= 2;
		this.uniformFillId = uniformFill;
		this.activeGrids = grids;
		this.blocksChangedThisBuild = !skipBlockFill;

		// Downsampling begins at LOD4:
		// LOD4 -> 2, LOD5 -> 4, LOD6 -> 8, ...
		//
		// Revert to full resolution if the chunk dimension is not divisible by
		// the requested step.
		const rawStep = lod >= 4 ? 1 << (lod - 3) : 1;
		const lodStep = rawStep <= size && size % rawStep === 0 ? rawStep : 1;

		this.lodStep = lodStep;
		this.meshGridSize = size / lodStep;

		this.ps = ps;
		this.ps2 = ps2;

		const axisOffsets = this.axisOffsets;
		axisOffsets[0] = 1;
		axisOffsets[1] = ps;
		axisOffsets[2] = ps2;

		// Bind either externally owned relight-cache grids or session-owned
		// fallback grids.
		if (grids !== undefined) {
			if (grids.block.length < psVol) {
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

		// Missing block neighbors leave stale border cells unless the block grid
		// is cleared before it is repopulated.
		let needBlockClear = false;

		if (!skipBlockFill) {
			for (let i = 0; i < 26; i++) {
				if (neighbors[i] === undefined) {
					needBlockClear = true;
					break;
				}
			}
		}

		// The light grid must be cleared when either the chunk light array or any
		// neighbor light slab is unavailable.
		let needLightClear =
			lightArray === undefined || neighborLights === undefined;

		if (!needLightClear) {
			// Narrow once so the hot loops below do not repeatedly evaluate the
			// optional neighborLights value.
			const lights = neighborLights as (Uint8Array | undefined)[];

			for (let i = 0; i < 26; i++) {
				if (lights[i] === undefined) {
					needLightClear = true;
					break;
				}
			}
		}

		if (needBlockClear) {
			padded.fill(0, 0, psVol);
		}

		if (needLightClear) {
			paddedLight.fill(0, 0, psVol);
		}

		// ---------------------------------------------------------------------
		// Interior block grid
		// ---------------------------------------------------------------------

		if (!skipBlockFill) {
			if (uniformFill !== undefined) {
				let paddedZBase = ps2;

				for (let z = 0; z < size; z++) {
					let destination = 1 + ps + paddedZBase;

					for (let y = 0; y < size; y++) {
						padded.fill(uniformFill, destination, destination + size);

						destination += ps;
					}

					paddedZBase += ps2;
				}
			} else if (blockArray != null) {
				// Copy manually instead of using:
				//
				//     padded.set(blockArray.subarray(...), ...)
				//
				// TypedArray.subarray() creates a new view object for every row.
				// The manual copy is allocation-free and keeps source/destination
				// indexing linear within each row.
				let source = 0;
				let paddedZBase = ps2;

				for (let z = 0; z < size; z++) {
					let destination = 1 + ps + paddedZBase;

					for (let y = 0; y < size; y++) {
						const rowEnd = source + size;

						while (source < rowEnd) {
							padded[destination++] = blockArray[source++];
						}

						// Skip the two padding cells between padded rows.
						destination += 2;
					}

					paddedZBase += ps2;
				}
			}
		}

		// ---------------------------------------------------------------------
		// Interior light grid
		// ---------------------------------------------------------------------

		if (lightArray !== undefined) {
			let source = 0;
			let paddedZBase = ps2;

			for (let z = 0; z < size; z++) {
				let destination = 1 + ps + paddedZBase;

				for (let y = 0; y < size; y++) {
					const rowEnd = source + size;

					while (source < rowEnd) {
						paddedLight[destination++] = lightArray[source++];
					}

					destination += 2;
				}

				paddedZBase += ps2;
			}
		}

		// ---------------------------------------------------------------------
		// Neighbor padding
		// ---------------------------------------------------------------------

		for (let ni = 0; ni < 26; ni++) {
			const neighbor = neighbors[ni];
			const neighborLight =
				neighborLights === undefined ? undefined : neighborLights[ni];

			// Block borders require block data. Light-only remeshes can populate
			// padding from light slabs without receiving block slabs again.
			if (neighbor === undefined && neighborLight === undefined) {
				continue;
			}

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

			let source = 0;

			if (xCount === size) {
				// Face slabs are contiguous in X. Copy each row without creating
				// temporary subarray views.
				let destinationZBase = pZStart * ps2;

				for (let dz = 0; dz < zCount; dz++) {
					let destination = pXStart + pYStart * ps + destinationZBase;

					for (let dy = 0; dy < yCount; dy++) {
						const rowEnd = source + size;

						if (!skipBlockFill && neighbor !== undefined) {
							if (neighborLight !== undefined) {
								while (source < rowEnd) {
									padded[destination] = neighbor[source];

									paddedLight[destination] = neighborLight[source];

									destination++;
									source++;
								}
							} else {
								while (source < rowEnd) {
									padded[destination++] = neighbor[source++];
								}
							}
						} else if (neighborLight !== undefined) {
							while (source < rowEnd) {
								paddedLight[destination++] = neighborLight[source++];
							}
						} else {
							// A block slab may be present during a block-fill skip,
							// but there is deliberately nothing to copy.
							source = rowEnd;
						}

						// Move from the end of this X row to the same X start in
						// the next padded Y row.
						destination += ps - size;
					}

					destinationZBase += ps2;
				}
			} else {
				// Edge and corner slabs contain one X value per logical cell.
				// Keep the original generalized loops for clarity and correctness.
				let destinationZBase = pZStart * ps2;

				for (let dz = 0; dz < zCount; dz++) {
					let destinationYBase = pYStart * ps + destinationZBase;

					for (let dy = 0; dy < yCount; dy++) {
						let destination = pXStart + destinationYBase;

						for (let dx = 0; dx < xCount; dx++) {
							if (!skipBlockFill && neighbor !== undefined) {
								padded[destination] = neighbor[source];
							}

							if (neighborLight !== undefined) {
								paddedLight[destination] = neighborLight[source];
							}

							destination++;
							source++;
						}

						destinationYBase += ps;
					}

					destinationZBase += ps2;
				}
			}
		}

		// Retain the caller-owned neighbor array without cloning it.
		this.neighbors = neighbors;

		if (!skipBlockFill) {
			this.buildOpaqueClassification(psVol, lodStep <= 1);
		}
	}

	private ensureOwnedPaddedCapacity(psVol: number): void {
		if (psVol <= this.ownedBlock.length) return;

		this.ownedBlock = new Uint16Array(psVol);
		this.ownedLight = new Uint8Array(psVol);
		this.ownedOpaque = new Uint8Array(psVol);
		this.ownedNeedsCustom = new Uint8Array(psVol);
	}

	// One classification byte per possible Uint16 packed block ID:
	//
	// bit 0: opaque full cube
	// bit 1: requires custom geometry
	private readonly blockClassification = new Uint8Array(0x1_0000);

	/*
	 * Generation stamps avoid clearing blockClassification every build.
	 * A packed block ID is recomputed only when its stamp differs from the
	 * current classification generation.
	 */
	private readonly blockClassificationStamp = new Uint32Array(0x1_0000);

	private blockClassificationGeneration = 0;
	private beginBlockClassificationGeneration(): number {
		let generation = (this.blockClassificationGeneration + 1) >>> 0;

		if (generation === 0) {
			this.blockClassificationStamp.fill(0);
			generation = 1;
		}

		this.blockClassificationGeneration = generation;
		return generation;
	}
	private classifyPackedBlock(packed: number, generation: number): number {
		/*
		 * The padded block grid is Uint16, but masking documents the indexing
		 * contract and protects this helper if called independently later.
		 */
		const blockId = packed & 0xffff;
		const stamps = this.blockClassificationStamp;

		if (stamps[blockId] === generation) {
			return this.blockClassification[blockId];
		}

		const flags = getCachedFlagsAndId(blockId) & 0xffff;

		let classification = 0;

		if ((flags & OPAQUE_TEST_MASK) === OPAQUE_REQUIRED) {
			classification |= 1;
		}

		if ((flags & CUSTOM_TEST_MASK) === FLAG_SOLID) {
			classification |= 2;
		}

		this.blockClassification[blockId] = classification;

		/*
		 * Publish the classification before its matching stamp. JavaScript workers
		 * are single-threaded and these arrays are not shared, but this order also
		 * makes the cache invariant explicit.
		 */
		stamps[blockId] = generation;

		return classification;
	}
	/**
	 * Precompute the per-cell opaque + needs-custom classification over the
	 * whole padded volume, so the hot mask/cell loops do a single byte load
	 * instead of a cache probe.
	 *
	 * `computeCustom` is false for lodStep > 1. emitCustomShapes early-outs on
	 * lodStep > 1 anyway (custom shapes are not emitted at reduced LOD), so
	 * needsCustom has no consumer at those LODs — skipping it drops one cache
	 * probe and two byte stores per cell, ~39k of each per chunk.
	 *
	 * NOTE: the opaque pass itself must stay full-resolution. emitLodBorderSkirts
	 * runs only when lodStep > 1 and reads opaque[] at EVERY y of the four border
	 * columns (LodBorderSkirts.emitBorderColumn), so striding this loop by
	 * lodStep would leave border cells unclassified and open holes along every
	 * LOD>=4 chunk boundary.
	 */
	private buildOpaqueClassification(
		psVol: number,
		computeCustom: boolean,
	): void {
		const padded = this.block;
		const opaqueBits = this.opaque;
		const customBits = this.needsCustom;
		const classifications = this.blockClassification;
		const stamps = this.blockClassificationStamp;
		const generation = this.beginBlockClassificationGeneration();

		let customCount = 0;

		if (computeCustom) {
			for (let i = 0; i < psVol; i++) {
				const blockId = padded[i];
				let classification: number;

				if (stamps[blockId] === generation) {
					classification = classifications[blockId];
				} else {
					classification = this.classifyPackedBlock(blockId, generation);
				}

				/*
				 * Classification bits are already 0 or 1 after shifting, so they
				 * can be written directly without ternaries.
				 */
				opaqueBits[i] = classification & 1;

				const custom = classification >>> 1;
				customBits[i] = custom;
				customCount += custom;
			}
		} else {
			for (let i = 0; i < psVol; i++) {
				const blockId = padded[i];
				let classification: number;

				if (stamps[blockId] === generation) {
					classification = classifications[blockId];
				} else {
					/*
					 * Custom classification is calculated too. This keeps one
					 * cache representation and usually costs nothing meaningful,
					 * since each distinct block ID is classified only once.
					 */
					classification = this.classifyPackedBlock(blockId, generation);
				}

				opaqueBits[i] = classification & 1;
			}
		}

		this.needsCustomCount = customCount;
	}
}

/**
 * Create an empty WorkerInternalMeshData inside the worker.
 * This must never be posted directly to main thread.
 */
export function createEmptyWorkerInternalMeshData(): WorkerInternalMeshData {
	return {
		faceData: new ResizableTypedArray(Uint8Array),
		faceCount: 0,
	};
}

/**
 * Convert internal mesh data (contains ResizableTypedArray instances)
 * into plain MeshData (transferable / cloneable).
 */
export function toTransferableMeshData(data: WorkerInternalMeshData): MeshData {
	const out = new MeshData();
	out.faceData = data.faceData.finalArray;
	out.faceCount = data.faceCount;
	return out;
}

/**
 * The max padded volume this session may be asked to allocate for, used to
 * size the initial buffers. Kept for reference; buffers grow on demand.
 */
export const MAX_PADDED = GenerationParams.CHUNK_SIZE + 2; // 32 + 2
export const MAX_PADDED_VOL = MAX_PADDED * MAX_PADDED * MAX_PADDED;
