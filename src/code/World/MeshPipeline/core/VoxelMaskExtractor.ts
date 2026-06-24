// MeshPipeline/core/VoxelMaskExtractor.ts

import {
	FACE_NX,
	FACE_NY,
	FACE_NZ,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
} from "../../Shape/BlockShapes";
import type { BlockShapeInfo, MeshContext } from "../types/MeshTypes";
import { computeAO } from "./AOPipeline";
import {
	FLAG_GREEDY,
	FLAG_PARTIAL,
	FLAG_SOLID,
	FLAG_TRANSPARENT,
	FLAG_WATER_GLASS,
	getCachedBlockId,
	getCachedFlags,
	getCachedIsCube,
} from "./BlockFlags";
import { quantizeLightForLOD } from "./LightPipeline";
import { getShapeInfo } from "./ShapePipeline";

/**
 * Marker bit used so non-cube faces do not greedily merge with cube faces.
 * bit 31 is reserved for back-face sign, so we use bit 30.
 */
const NON_CUBE_MASK = 0x40000000;
const BACK_FACE_MASK = 0x80000000;
const PACKED_ID_STATE_MASK = 0x0000ffff;

type WritableNumberArray = number[] | Int32Array | Uint16Array | Uint32Array;

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

	/** PERF: Update context reference instead of creating a new instance. */
	public setCtx(ctx: MeshContext): void {
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
		const disableAO = ctx.disableAO;

		const nx = bx + dx;
		const ny = by + dy;
		const nz = bz + dz;

		// --- inline samplePacked ---
		const currentPacked = ctx.getBlock(bx, by, bz, 0);
		const neighborPacked = ctx.getBlock(nx, ny, nz, currentPacked);

		// --- early out: air-air (before flags) ---
		if (!currentPacked && !neighborPacked) {
			mask[outIndex] = 0;
			lightMask[outIndex] = 0;
			return;
		}

		// --- flags (optimized: avoid function call for air) ---
		const currFlags = currentPacked ? getCachedFlags(currentPacked) : 0;
		const nbrFlags = neighborPacked ? getCachedFlags(neighborPacked) : 0;

		const currSolid = currFlags & FLAG_SOLID;
		const nbrSolid = nbrFlags & FLAG_SOLID;

		// --- early out: no solid blocks ---
		if (!(currSolid | nbrSolid)) {
			mask[outIndex] = 0;
			lightMask[outIndex] = 0;
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
				mask[outIndex] = 0;
				lightMask[outIndex] = 0;
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
				mask[outIndex] = 0;
				lightMask[outIndex] = 0;
				return;
			}
		}

		// --- light (inline pickLight) ---
		const currLight = ctx.getLight(bx, by, bz, 0);
		const nbrLight = ctx.getLight(nx, ny, nz, currLight);
		const maxLight = currLight > nbrLight ? currLight : nbrLight;
		const packedLightOnly = disableAO
			? quantizeLightForLOD(maxLight, true)
			: maxLight & 0xff;

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

				packedAO = disableAO ? 0 : computeAO(ctx, nx, ny, nz, uAxis, vAxis);
			} else if (!preferCurrent && nbrParticipates) {
				if (!nbrShapeInfo && nbrSolid) {
					nbrShapeInfo = getShapeInfo(neighborPacked);
				}
				if (!nbrShapeInfo) {
					mask[outIndex] = 0;
					lightMask[outIndex] = 0;
					return;
				}

				const nbrIsCube = getCachedIsCube(neighborPacked);
				packedMask =
					(neighborPacked & PACKED_ID_STATE_MASK) |
					(nbrIsCube ? 0 : NON_CUBE_MASK) |
					BACK_FACE_MASK;

				packedAO = disableAO ? 0 : computeAO(ctx, bx, by, bz, uAxis, vAxis);
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
			mask[outIndex] = 0;
			lightMask[outIndex] = 0;
			return;
		}

		let packedMask = 0;
		let packedAO = 0;

		if (emitCurrent && currShapeInfo) {
			packedMask =
				(currentPacked & PACKED_ID_STATE_MASK) |
				(currShapeInfo.isCube ? 0 : NON_CUBE_MASK);

			packedAO = disableAO ? 0 : computeAO(ctx, nx, ny, nz, uAxis, vAxis);
		} else if (nbrShapeInfo) {
			const nbrIsCube = getCachedIsCube(neighborPacked);
			packedMask =
				(neighborPacked & PACKED_ID_STATE_MASK) |
				(nbrIsCube ? 0 : NON_CUBE_MASK) |
				BACK_FACE_MASK;

			packedAO = disableAO ? 0 : computeAO(ctx, bx, by, bz, uAxis, vAxis);
		} else {
			mask[outIndex] = 0;
			lightMask[outIndex] = 0;
			return;
		}

		mask[outIndex] = packedMask;
		lightMask[outIndex] = (packedAO & 0xff) | ((packedLightOnly & 0xff) << 8);
	}

	// PERF: Axis permutation tables for extractSliceMaskAxis.
	// Maps (slice_or_m1, u, v) → (bx, by, bz) for each axis.
	// [0]=slice, [1]=u, [2]=v
	private static readonly _bxPerm = [0, 2, 1];
	private static readonly _byPerm = [1, 0, 2];
	private static readonly _bzPerm = [2, 1, 0];
	// Neighbor direction for negative boundary check.
	private static readonly _ndxDx = [1, 0, 0];
	private static readonly _ndyDy = [0, 1, 0];
	private static readonly _ndzDz = [0, 0, 1];
	// hasNeighborChunk args for negative boundary.
	private static readonly _negNbrDx = [-1, 0, 0];
	private static readonly _negNbrDy = [0, -1, 0];
	private static readonly _negNbrDz = [0, 0, -1];

	public extractSliceMask(
		axis: number,
		slice: number,
		mask: WritableNumberArray,
		lightMask: WritableNumberArray,
	): void {
		const size = this.ctx.size;
		const currentFaceBit = this.getCurrentFaceBit(axis);
		const neighborFaceBit = this.getNeighborFaceBit(axis);
		const bxPerm = VoxelMaskExtractor._bxPerm;
		const byPerm = VoxelMaskExtractor._byPerm;
		const bzPerm = VoxelMaskExtractor._bzPerm;

		// Negative boundary: face at position 0.
		if (slice === -1) {
			if (
				!this.ctx.hasNeighborChunk(
					VoxelMaskExtractor._negNbrDx[axis],
					VoxelMaskExtractor._negNbrDy[axis],
					VoxelMaskExtractor._negNbrDz[axis],
				)
			) {
				this.clearSlice(mask, lightMask, size);
				return;
			}
			let idx = 0;
			for (let v = 0; v < size; v++) {
				for (let u = 0; u < size; u++) {
					this.processCell(
						bxPerm[axis] === 0 ? -1 : bxPerm[axis] === 1 ? u : v,
						byPerm[axis] === 0 ? -1 : byPerm[axis] === 1 ? u : v,
						bzPerm[axis] === 0 ? -1 : bzPerm[axis] === 1 ? u : v,
						VoxelMaskExtractor._ndxDx[axis],
						VoxelMaskExtractor._ndyDy[axis],
						VoxelMaskExtractor._ndzDz[axis],
						axis === 0 ? 1 : axis === 2 ? 0 : 2,
						axis === 0 ? 2 : axis === 2 ? 1 : 0,
						currentFaceBit,
						neighborFaceBit,
						idx,
						mask,
						lightMask,
					);
					idx++;
				}
			}
			return;
		}

		// Positive boundary: faces at position size overflow.
		// The next chunk renders these faces at its position 0.
		if (slice === size - 1) {
			this.clearSlice(mask, lightMask, size);
			return;
		}

		const uAxis = axis === 0 ? 1 : axis === 2 ? 0 : 2;
		const vAxis = axis === 0 ? 2 : axis === 2 ? 1 : 0;
		const dx = axis === 0 ? 1 : 0;
		const dy = axis === 1 ? 1 : 0;
		const dz = axis === 2 ? 1 : 0;

		let idx = 0;
		for (let v = 0; v < size; v++) {
			for (let u = 0; u < size; u++) {
				this.processCell(
					bxPerm[axis] === 0 ? slice : bxPerm[axis] === 1 ? u : v,
					byPerm[axis] === 0 ? slice : byPerm[axis] === 1 ? u : v,
					bzPerm[axis] === 0 ? slice : bzPerm[axis] === 1 ? u : v,
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
}
