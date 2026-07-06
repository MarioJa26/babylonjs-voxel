// MeshPipeline/core/VoxelMaskExtractor.ts

import { WATER_BLOCK_ID } from "../../Chunk/Worker/ChunkMesherConstants";
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
const WATER_ABOVE_MASK = 0x10000;
const WATER_LEVEL_PAIR_MASK = 0x20000; // bit 17 — indicates water level pair is set

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

		// --- participation ---
		const currParticipates = currSolid && currGreedy;
		const nbrParticipates = nbrSolid && nbrGreedy;

		// --- cube fast path ---
		// Two opaque participating cubes never produce a face. This is the
		// dominant interior case, so short-circuit before any id / interface /
		// shape lookups to keep the common path branch-light.
		const bothCube =
			currParticipates && nbrParticipates && !currPartial && !nbrPartial;
		if (bothCube && !currTransparent && !nbrTransparent) {
			mask[outIndex] = 0;
			lightMask[outIndex] = 0;
			return;
		}

		const currId = getCachedBlockId(currentPacked);
		const nbrId = getCachedBlockId(neighborPacked);

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
			if (currId !== nbrId) {
				preserveInterface = 1;
			}
		}

		if (bothCube) {
			// Water-to-water same level: no face needed
			if (currWaterGlass && nbrWaterGlass && currId === nbrId) {
				const currLevel = (currentPacked >> 10) & 0xf;
				const nbrLevel = (neighborPacked >> 10) & 0xf;
				if (currLevel === nbrLevel) {
					mask[outIndex] = 0;
					lightMask[outIndex] = 0;
					return;
				}
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

			if ((packedMask & 0x3ff) === WATER_BLOCK_ID) {
				packedMask &= ~(0x7 << 13);
				if ((ctx.getBlock(bx, by + 1, bz, 0) & 0x3ff) === WATER_BLOCK_ID) {
					packedMask |= WATER_ABOVE_MASK;
				}
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

		let emitCurrent =
			currParticipates &&
			(!nbrSolid || (nbrTransparent && !currTransparent) || !nbrClosesFace);

		let emitNeighbor =
			nbrParticipates &&
			(!currSolid || (currTransparent && !nbrTransparent) || !currClosesFace);

		let waterCurrLevel = -1;
		let waterNbrLevel = -1;
		if (
			currWaterGlass &&
			nbrWaterGlass &&
			currId === WATER_BLOCK_ID &&
			nbrId === WATER_BLOCK_ID
		) {
			waterCurrLevel = (currentPacked >> 10) & 0xf;
			waterNbrLevel = (neighborPacked >> 10) & 0xf;
		}

		if (!emitCurrent && !emitNeighbor) {
			if (waterCurrLevel >= 0 && waterCurrLevel !== waterNbrLevel) {
				if (waterCurrLevel > waterNbrLevel) {
					emitCurrent = true;
				} else {
					emitNeighbor = true;
				}
			}
		}

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

		if ((packedMask & 0x3ff) === WATER_BLOCK_ID) {
			packedMask &= ~(0x7 << 13);
			// waterAbove must reflect the block whose top defines the face.
			// For a level-pair face that is the SHALLOWER column (min level);
			// otherwise it is the emitting block (current or neighbor).
			let aboveX = bx;
			let aboveY = by;
			let aboveZ = bz;
			if (waterCurrLevel >= 0 && waterCurrLevel !== waterNbrLevel) {
				if (waterCurrLevel > waterNbrLevel) {
					aboveX = nx;
					aboveY = ny;
					aboveZ = nz;
				}
				// else current is the shallower column -> keep (bx,by,bz)
			} else if (emitNeighbor) {
				aboveX = nx;
				aboveY = ny;
				aboveZ = nz;
			}
			if (
				(ctx.getBlock(aboveX, aboveY + 1, aboveZ, 0) & 0x3ff) ===
				WATER_BLOCK_ID
			) {
				packedMask |= WATER_ABOVE_MASK;
			}
		}

		if (waterCurrLevel >= 0 && waterCurrLevel !== waterNbrLevel) {
			const tallerLevel = Math.max(waterCurrLevel, waterNbrLevel);
			const shallowerLevel = Math.min(waterCurrLevel, waterNbrLevel);
			// Bit layout (must match FaceEmitter.decode):
			//   tallerLevel   -> bits 10-12 (3 bits, 0-7)
			//   shallowerLevel -> bits 13-15 (3 bits, 0-7)
			// These ranges are adjacent and MUST NOT overlap; the decoder reads
			// tallerLevel with & 0x7 (3 bits), so bit 13 is exclusively shallowerLevel's.
			packedMask =
				(packedMask & ~(0x7 << 10) & ~(0x7 << 13)) |
				(tallerLevel << 10) |
				(shallowerLevel << 13) |
				WATER_LEVEL_PAIR_MASK;
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

		const bxVal = bxPerm[axis];
		const byVal = byPerm[axis];
		const bzVal = bzPerm[axis];

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
			const ndx = VoxelMaskExtractor._ndxDx[axis];
			const ndy = VoxelMaskExtractor._ndyDy[axis];
			const ndz = VoxelMaskExtractor._ndzDz[axis];
			const uA = axis === 0 ? 1 : axis === 2 ? 0 : 2;
			const vA = axis === 0 ? 2 : axis === 2 ? 1 : 0;
			let idx = 0;
			for (let v = 0; v < size; v++) {
				for (let u = 0; u < size; u++) {
					this.processCell(
						bxVal === 0 ? -1 : bxVal === 1 ? u : v,
						byVal === 0 ? -1 : byVal === 1 ? u : v,
						bzVal === 0 ? -1 : bzVal === 1 ? u : v,
						ndx,
						ndy,
						ndz,
						uA,
						vA,
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
					bxVal === 0 ? slice : bxVal === 1 ? u : v,
					byVal === 0 ? slice : byVal === 1 ? u : v,
					bzVal === 0 ? slice : bzVal === 1 ? u : v,
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
