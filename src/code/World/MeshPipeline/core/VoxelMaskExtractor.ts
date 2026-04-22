// MeshPipeline/core/VoxelMaskExtractor.ts

import { unpackBlockId } from "../../BlockEncoding";
import { BLOCK_TYPE } from "../../Chunk/Worker/ChunkMesherConstants";
import {
	FACE_NX,
	FACE_NY,
	FACE_NZ,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
} from "../../Shape/BlockShapes";
import {
	type BlockShapeInfo,
	MaterialType,
	type MeshContext,
} from "../types/MeshTypes";
import { computeAO } from "./AOPipeline";
import { quantizeLightForLOD } from "./LightPipeline";
import {
	getMaterialType,
	getShapeInfo,
	isGreedyCompatiblePackedBlock,
} from "./ShapePipeline";

/**
 * Marker bit used so non-cube faces do not greedily merge with cube faces.
 * bit 31 is reserved for back-face sign, so we use bit 30.
 */
const NON_CUBE_MASK = 0x40000000;
const BACK_FACE_MASK = 0x80000000;
const PACKED_ID_STATE_MASK = 0x0000ffff;

/**
 * Small dense local caches to avoid rebuilding trivial runtime flags.
 *
 * This assumes your current packed-block key space is effectively <= 16 bits.
 * If a wider packed value ever appears, we fall back to direct computation.
 */
const DENSE_CACHE_SIZE = 1 << 16;
const DENSE_CACHE_MASK = DENSE_CACHE_SIZE - 1;

/**
 * Flags:
 * 1 = solid
 * 2 = transparent
 * 4 = partial (non-cube)
 * 8 = greedy-compatible
 * 16 = water/glass material bucket
 */
const FLAG_SOLID = 1 << 0;
const FLAG_TRANSPARENT = 1 << 1;
const FLAG_PARTIAL = 1 << 2;
const FLAG_GREEDY = 1 << 3;
const FLAG_WATER_GLASS = 1 << 4;

const BLOCK_FLAGS_CACHE = new Uint8Array(DENSE_CACHE_SIZE);
const BLOCK_FLAGS_READY = new Uint8Array(DENSE_CACHE_SIZE);
const BLOCK_ID_CACHE = new Uint16Array(DENSE_CACHE_SIZE);
type WritableNumberArray = number[] | Int32Array | Uint16Array | Uint32Array;
function canUseDenseCache(packed: number): boolean {
	return packed >= 0 && packed <= DENSE_CACHE_MASK;
}

function getCachedBlockId(packed: number): number {
	if (!packed) return 0;

	if (canUseDenseCache(packed)) {
		if (!BLOCK_FLAGS_READY[packed]) {
			const id = unpackBlockId(packed);
			BLOCK_ID_CACHE[packed] = id;
		}
		return BLOCK_ID_CACHE[packed];
	}

	return unpackBlockId(packed);
}

function getCachedFlags(packed: number): number {
	if (!packed) return 0;

	if (canUseDenseCache(packed)) {
		if (BLOCK_FLAGS_READY[packed]) {
			return BLOCK_FLAGS_CACHE[packed];
		}

		const id = unpackBlockId(packed);
		const shape = getShapeInfo(packed);
		const materialType = getMaterialType(id);
		const greedyCompatible = isGreedyCompatiblePackedBlock(packed);

		let flags = 0;

		if (id !== 0) flags |= FLAG_SOLID;
		if (materialType === MaterialType.WaterOrGlass || BLOCK_TYPE[id] !== 0) {
			flags |= FLAG_TRANSPARENT;
		}
		if (!shape.isCube) flags |= FLAG_PARTIAL;
		if (greedyCompatible) flags |= FLAG_GREEDY;
		if (materialType === MaterialType.WaterOrGlass) flags |= FLAG_WATER_GLASS;

		BLOCK_FLAGS_CACHE[packed] = flags;
		BLOCK_FLAGS_READY[packed] = 1;
		BLOCK_ID_CACHE[packed] = id;

		return flags;
	}

	// Sparse fallback if a packed key exceeds the dense range
	const id = unpackBlockId(packed);
	const shape = getShapeInfo(packed);
	const materialType = getMaterialType(id);
	const greedyCompatible = isGreedyCompatiblePackedBlock(packed);

	let flags = 0;
	if (id !== 0) flags |= FLAG_SOLID;
	if (materialType === MaterialType.WaterOrGlass || BLOCK_TYPE[id] !== 0) {
		flags |= FLAG_TRANSPARENT;
	}
	if (!shape.isCube) flags |= FLAG_PARTIAL;
	if (greedyCompatible) flags |= FLAG_GREEDY;
	if (materialType === MaterialType.WaterOrGlass) flags |= FLAG_WATER_GLASS;

	return flags;
}

/**
 * Extracts the 2D slice mask for greedy meshing on one axis.
 *
 * IMPORTANT:
 * - only greedy-compatible blocks may emit through this path
 * - non-greedy custom shapes may still OCCLUDE neighboring faces
 * - custom shapes themselves should be emitted in a separate custom-shape pass
 */
export class VoxelMaskExtractor {
	private ctx: MeshContext;

	constructor(ctx: MeshContext) {
		this.ctx = ctx;
	}

	/**
	 * Return the face bit on the CURRENT block that points toward the neighbor.
	 */
	private getCurrentFaceBit(axis: number): number {
		if (axis === 0) return FACE_PX;
		if (axis === 1) return FACE_PY;
		return FACE_PZ;
	}

	/**
	 * Return the OPPOSITE face bit on the NEIGHBOR block that points back toward the current block.
	 */
	private getNeighborFaceBit(axis: number): number {
		if (axis === 0) return FACE_NX;
		if (axis === 1) return FACE_NY;
		return FACE_NZ;
	}

	private clearSlice(
		mask: WritableNumberArray,
		lightMask: WritableNumberArray,
		size: number,
	): void {
		const total = size * size;
		mask.fill(0, 0, total);
		lightMask.fill(0, 0, total);
	}

	private processCell(
		bx: number,
		by: number,
		bz: number,
		dx: number,
		dy: number,
		dz: number,
		uAxis: number,
		vAxis: number,
		currentFaceBit: number,
		neighborFaceBit: number,
		outIndex: number,
		mask: WritableNumberArray,
		lightMask: WritableNumberArray,
	): void {
		const ctx = this.ctx;

		const nx = bx + dx;
		const ny = by + dy;
		const nz = bz + dz;

		// --- inline samplePacked ---
		const currentPacked = ctx.getBlock(bx, by, bz, 0);
		const neighborPacked = ctx.getBlock(nx, ny, nz, currentPacked);

		// --- flags ---
		const currFlags = getCachedFlags(currentPacked);
		const nbrFlags = getCachedFlags(neighborPacked);

		const currSolid = currFlags & FLAG_SOLID;
		const nbrSolid = nbrFlags & FLAG_SOLID;

		// --- early out: air-air ---
		if (!(currSolid | nbrSolid)) {
			if (mask[outIndex]) mask[outIndex] = 0;
			if (lightMask[outIndex]) lightMask[outIndex] = 0;
			return;
		}

		const currTransparent = currFlags & FLAG_TRANSPARENT;
		const nbrTransparent = nbrFlags & FLAG_TRANSPARENT;

		const currGreedy = currFlags & FLAG_GREEDY;
		const nbrGreedy = nbrFlags & FLAG_GREEDY;

		const currPartial = currFlags & FLAG_PARTIAL;
		const nbrPartial = nbrFlags & FLAG_PARTIAL;

		const currWaterGlass = currFlags & FLAG_WATER_GLASS;
		const nbrWaterGlass = nbrFlags & FLAG_WATER_GLASS;

		// --- transparent interface (water/glass) ---
		let preserveInterface = 0;
		if (
			currSolid &&
			nbrSolid &&
			currTransparent &&
			nbrTransparent &&
			currWaterGlass &&
			nbrWaterGlass
		) {
			if (
				getCachedBlockId(currentPacked) !== getCachedBlockId(neighborPacked)
			) {
				preserveInterface = 1;
			}
		}

		// --- participation ---
		const currParticipates = currSolid && currGreedy;
		const nbrParticipates = nbrSolid && nbrGreedy;

		// --- cube fast path ---
		const bothCube =
			currParticipates && nbrParticipates && !currPartial && !nbrPartial;

		if (bothCube) {
			if (!preserveInterface && !currTransparent && !nbrTransparent) {
				if (mask[outIndex]) mask[outIndex] = 0;
				if (lightMask[outIndex]) lightMask[outIndex] = 0;
				return;
			}
		}

		// --- lazy shape fetch (no closures) ---
		let currShapeInfo: BlockShapeInfo | null = null;
		let nbrShapeInfo: BlockShapeInfo | null = null;

		// --- slow path closure test ---
		let currCloses = 0;
		let nbrCloses = 0;

		if (!bothCube) {
			if (currSolid) {
				currShapeInfo = getShapeInfo(currentPacked);
				currCloses = currShapeInfo.closedFaceMask & currentFaceBit;
			}

			if (nbrSolid) {
				nbrShapeInfo = getShapeInfo(neighborPacked);
				nbrCloses = nbrShapeInfo.closedFaceMask & neighborFaceBit;
			}

			if (!preserveInterface && currCloses && nbrCloses) {
				if (mask[outIndex]) mask[outIndex] = 0;
				if (lightMask[outIndex]) lightMask[outIndex] = 0;
				return;
			}
		}

		// --- light (inline pickLight) ---
		const currLight = ctx.getLight(bx, by, bz, 0);
		const nbrLight = ctx.getLight(nx, ny, nz, currLight);
		const packedLightOnly = quantizeLightForLOD(
			currLight > nbrLight ? currLight : nbrLight,
			ctx.disableAO,
		);

		// ============================================================
		// TRANSPARENT INTERFACE EMISSION
		// ============================================================
		if (preserveInterface) {
			const currId = getCachedBlockId(currentPacked);
			const nbrId = getCachedBlockId(neighborPacked);

			const preferCurrent =
				currId === 60 || currId === 61
					? 1
					: nbrId === 60 || nbrId === 61
						? 0
						: 1;

			let packedMask = 0;
			let packedAO = 0;

			if (preferCurrent && currParticipates) {
				if (!currShapeInfo && currSolid) {
					currShapeInfo = getShapeInfo(currentPacked);
				}
				if (!currShapeInfo) {
					mask[outIndex] = 0;
					lightMask[outIndex] = 0;
					return;
				}

				packedMask =
					(currentPacked & PACKED_ID_STATE_MASK) |
					(currShapeInfo.isCube ? 0 : NON_CUBE_MASK);

				packedAO = ctx.disableAO ? 0 : computeAO(ctx, nx, ny, nz, uAxis, vAxis);
			} else if (!preferCurrent && nbrParticipates) {
				if (!nbrShapeInfo && nbrSolid) {
					nbrShapeInfo = getShapeInfo(neighborPacked);
				}
				if (!nbrShapeInfo) {
					mask[outIndex] = 0;
					lightMask[outIndex] = 0;
					return;
				}

				packedMask =
					(neighborPacked & PACKED_ID_STATE_MASK) |
					(nbrShapeInfo.isCube ? 0 : NON_CUBE_MASK) |
					BACK_FACE_MASK;

				packedAO = ctx.disableAO ? 0 : computeAO(ctx, bx, by, bz, uAxis, vAxis);
			} else {
				mask[outIndex] = 0;
				lightMask[outIndex] = 0;
				return;
			}

			mask[outIndex] = packedMask;
			lightMask[outIndex] = (packedAO & 0xff) | ((packedLightOnly & 0xff) << 8);

			return;
		}

		// ============================================================
		// NORMAL EMISSION PATH
		// ============================================================

		if (!nbrShapeInfo && nbrSolid) {
			nbrShapeInfo = getShapeInfo(neighborPacked);
		}
		if (!currShapeInfo && currSolid) {
			currShapeInfo = getShapeInfo(currentPacked);
		}

		const nbrClosesFace =
			nbrSolid && nbrShapeInfo && nbrShapeInfo.closedFaceMask & neighborFaceBit;

		const currClosesFace =
			currSolid &&
			currShapeInfo &&
			currShapeInfo.closedFaceMask & currentFaceBit;

		const emitCurrent =
			currParticipates &&
			(!nbrSolid || (nbrTransparent && !currTransparent) || !nbrClosesFace);

		const emitNeighbor =
			nbrParticipates &&
			(!currSolid || (currTransparent && !nbrTransparent) || !currClosesFace);

		if (!emitCurrent && !emitNeighbor) {
			if (mask[outIndex]) mask[outIndex] = 0;
			if (lightMask[outIndex]) lightMask[outIndex] = 0;
			return;
		}

		let packedMask = 0;
		let packedAO = 0;

		if (emitCurrent && currShapeInfo) {
			packedMask =
				(currentPacked & PACKED_ID_STATE_MASK) |
				(currShapeInfo.isCube ? 0 : NON_CUBE_MASK);

			packedAO = ctx.disableAO ? 0 : computeAO(ctx, nx, ny, nz, uAxis, vAxis);
		} else if (nbrShapeInfo) {
			packedMask =
				(neighborPacked & PACKED_ID_STATE_MASK) |
				(nbrShapeInfo.isCube ? 0 : NON_CUBE_MASK) |
				BACK_FACE_MASK;

			packedAO = ctx.disableAO ? 0 : computeAO(ctx, bx, by, bz, uAxis, vAxis);
		} else {
			mask[outIndex] = 0;
			lightMask[outIndex] = 0;
			return;
		}

		mask[outIndex] = packedMask;
		lightMask[outIndex] = (packedAO & 0xff) | ((packedLightOnly & 0xff) << 8);
	}

	private extractSliceMaskX(
		slice: number,
		mask: WritableNumberArray,
		lightMask: WritableNumberArray,
	): void {
		const size = this.ctx.size;
		const axis = 0;
		const dx = 1;
		const dy = 0;
		const dz = 0;

		const uAxis = 1;
		const vAxis = 2;

		const currentFaceBit = this.getCurrentFaceBit(axis);
		const neighborFaceBit = this.getNeighborFaceBit(axis);

		// Only the positive boundary can cross for this extractor.
		if (slice === size - 1 && !this.ctx.hasNeighborChunk(1, 0, 0)) {
			this.clearSlice(mask, lightMask, size);
			return;
		}

		let idx = 0;

		for (let v = 0; v < size; v++) {
			for (let u = 0; u < size; u++) {
				const bx = slice;
				const by = u;
				const bz = v;

				this.processCell(
					bx,
					by,
					bz,
					dx,
					dy,
					dz,
					uAxis,
					vAxis,
					currentFaceBit,
					neighborFaceBit,
					idx,
					mask,
					lightMask,
				);

				idx++;
			}
		}
	}

	private extractSliceMaskY(
		slice: number,
		mask: WritableNumberArray,
		lightMask: WritableNumberArray,
	): void {
		const size = this.ctx.size;
		const axis = 1;
		const dx = 0;
		const dy = 1;
		const dz = 0;

		const uAxis = 2;
		const vAxis = 0;

		const currentFaceBit = this.getCurrentFaceBit(axis);
		const neighborFaceBit = this.getNeighborFaceBit(axis);

		if (slice === size - 1 && !this.ctx.hasNeighborChunk(0, 1, 0)) {
			this.clearSlice(mask, lightMask, size);
			return;
		}

		let idx = 0;

		for (let v = 0; v < size; v++) {
			for (let u = 0; u < size; u++) {
				const bx = v;
				const by = slice;
				const bz = u;

				this.processCell(
					bx,
					by,
					bz,
					dx,
					dy,
					dz,
					uAxis,
					vAxis,
					currentFaceBit,
					neighborFaceBit,
					idx,
					mask,
					lightMask,
				);

				idx++;
			}
		}
	}

	private extractSliceMaskZ(
		slice: number,
		mask: WritableNumberArray,
		lightMask: WritableNumberArray,
	): void {
		const size = this.ctx.size;
		const axis = 2;
		const dx = 0;
		const dy = 0;
		const dz = 1;

		const uAxis = 0;
		const vAxis = 1;

		const currentFaceBit = this.getCurrentFaceBit(axis);
		const neighborFaceBit = this.getNeighborFaceBit(axis);

		if (slice === size - 1 && !this.ctx.hasNeighborChunk(0, 0, 1)) {
			this.clearSlice(mask, lightMask, size);
			return;
		}

		let idx = 0;

		for (let v = 0; v < size; v++) {
			for (let u = 0; u < size; u++) {
				const bx = u;
				const by = v;
				const bz = slice;

				this.processCell(
					bx,
					by,
					bz,
					dx,
					dy,
					dz,
					uAxis,
					vAxis,
					currentFaceBit,
					neighborFaceBit,
					idx,
					mask,
					lightMask,
				);

				idx++;
			}
		}
	}

	public extractSliceMask(
		axis: number,
		slice: number,
		mask: WritableNumberArray,
		lightMask: WritableNumberArray,
	): void {
		if (axis === 0) {
			this.extractSliceMaskX(slice, mask, lightMask);
			return;
		}

		if (axis === 1) {
			this.extractSliceMaskY(slice, mask, lightMask);
			return;
		}

		this.extractSliceMaskZ(slice, mask, lightMask);
	}
}
