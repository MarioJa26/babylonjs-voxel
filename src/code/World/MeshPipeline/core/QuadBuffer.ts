// MeshPipeline/core/QuadBuffer.ts

import type { ResizableTypedArray } from "../../Chunk/DataStructures/ResizableTypedArray";
import type { WorkerInternalMeshData } from "../../Chunk/DataStructures/WorkerInternalMeshData";
import { POS_SCALE } from "../../Chunk/Worker/ChunkMesherConstants";
import { BlockFaceTileX, BlockFaceTileY } from "../../Texture/BlockTextures";
import { FaceName } from "../../Texture/FaceName";
import { BlockTint } from "./BlockInfoCache";

const WATER_FRAC_SCALE = [8, 7, 6, 5, 4, 3, 2, 1];
const WATER_TOP_OFFSET_SCALE = [0, -1, -2, -3, -4, -5, -6, -7];
const WATER_ABOVE_MASK = 0x10000;
const WATER_LEVEL_PAIR_MASK = 0x20000;

const META_FLIP = 1;
const META_WATER = 1 << 2;
const META_POS_OFF_X = 1 << 3;
const META_DIAG = 1 << 4;
const META_DIAG_VARIANT = 1 << 5;
const META_RAW_DIM = 1 << 6;
const META_POS_OFF_Z = 1 << 7;

export class QuadBuffer {
	private data!: WorkerInternalMeshData;
	private rta!: ResizableTypedArray<Uint8Array>;
	// Interleaved face records: 12 bytes (3 u32 words) per face, one
	// contiguous stream. emitRaw writes one record per quad instead of
	// touching three separate SoA streams.
	private buf!: Uint8Array;
	private count = 0;

	/** Point this buffer at a reused output mesh and zero its face count. */
	public bind(out: WorkerInternalMeshData): void {
		this.data = out;

		const rta = out.faceData;

		this.rta = rta;
		this.buf = rta.backingArray;

		this.count = 0;

		// Keep the externally visible mesh empty immediately after bind.
		rta.length = 0;
		out.faceCount = 0;
	}

	/**
	 * Publish final byte lengths and face count after all quads have been emitted.
	 *
	 * Call this once at the end of the mesh build, before the output mesh is read,
	 * uploaded, merged, or transferred.
	 */
	public finish(): void {
		this.rta.length = this.count * 12;
		this.data.faceCount = this.count;
	}

	/**
	 * Raw face write. No bounds check and no growth check.
	 * reserveMeshCapacity must guarantee capacity up front.
	 */
	private emitRaw(
		sx: number,
		sy: number,
		sz: number,
		axisFace: number,
		sw: number,
		sh: number,
		tx: number,
		ty: number,
		ao: number,
		light: number,
		tint: number,
		meta: number,
	): void {
		const i = this.count * 12;
		const buf = this.buf;

		// Positions/dims are single bytes; emitters guarantee in-range values
		// (boundary faces encode 255 + shader sentinel, never raw 256).
		buf[i] = sx;
		buf[i + 1] = sy;
		buf[i + 2] = sz;
		buf[i + 3] = axisFace | (tint << 3);

		buf[i + 4] = sw;
		buf[i + 5] = sh;
		buf[i + 6] = tx;
		buf[i + 7] = ty;

		buf[i + 8] = ao;
		buf[i + 9] = light;
		buf[i + 10] = meta;
		buf[i + 11] = 0; // chunk-index lane, stamped by merged-group assembly

		this.count++;
	}

	/**
	 * General-purpose quad with bounds check.
	 * Used for non-water faces that can touch the chunk border.
	 */
	public emitQuad(
		x: number,
		y: number,
		z: number,
		axis: number,
		width: number,
		height: number,
		blockId: number,
		backFace: number,
		light: number,
		ao: number,
		faceName: FaceName,
		materialType: number,
		flip: number,
		diagonal: number,
		rawDim: number,
	): void {
		const xs = x * POS_SCALE;
		const ys = y * POS_SCALE;
		const zs = z * POS_SCALE;

		const sx = (xs + 0.5) | 0;
		const sy = (ys + 0.5) | 0;
		const sz = (zs + 0.5) | 0;

		if (sx < 0 || sy < 0 || sz < 0 || sx >= 256 || sy >= 256 || sz >= 256) {
			return;
		}

		const tileIdx = blockId * FaceName.Count + faceName;

		let meta =
			((materialType & 0x3) << 1) |
			(flip ? META_FLIP : 0) |
			(diagonal ? META_DIAG : 0) |
			(diagonal === 2 ? META_DIAG_VARIANT : 0) |
			(rawDim ? META_RAW_DIM : 0);

		// Usually cheaper than xs % 1 !== 0 in tight loops.
		// This preserves the intent here because positions are already bounded through sx/sy/sz.
		if (xs !== (xs | 0)) {
			meta |= META_POS_OFF_X;
		}

		if (zs !== (zs | 0)) {
			meta |= META_POS_OFF_Z;
		}

		const sw = rawDim ? width : width * POS_SCALE;
		const sh = rawDim ? height : height * POS_SCALE;

		this.emitRaw(
			sx,
			sy,
			sz,
			axis * 2 + backFace,
			sw,
			sh,
			BlockFaceTileX[tileIdx],
			BlockFaceTileY[tileIdx],
			ao,
			light,
			BlockTint[blockId],
			meta,
		);
	}

	/**
	 * Specialized unchecked cube face emitter.
	 *
	 * This is faster than the generic emitQuadUnchecked path because cube faces
	 * emitted from VoxelFaceEmitterAdapter always use:
	 * - MaterialType.Default
	 * - flip = 0
	 * - diagonal = 0
	 * - integer block-space positions
	 */
	public emitCubeQuadUnchecked(
		x: number,
		y: number,
		z: number,
		axis: number,
		width: number,
		height: number,
		blockId: number,
		backFace: number,
		light: number,
		ao: number,
		faceName: FaceName,
		rawDim: number,
	): void {
		const xs = x * POS_SCALE + 0.5;
		const ys = y * POS_SCALE + 0.5;
		const zs = z * POS_SCALE + 0.5;

		const tileIdx = blockId * FaceName.Count + faceName;

		const sw = rawDim ? width : width * POS_SCALE;
		const sh = rawDim ? height : height * POS_SCALE;

		// Cube greedy faces have no flip, no diagonal, default material.
		// Positions are integer block coords, so no META_POS_OFF_X/Z needed.
		const meta = rawDim ? META_RAW_DIM : 0;

		this.emitRaw(
			xs,
			ys,
			zs,
			axis * 2 + backFace,
			sw,
			sh,
			BlockFaceTileX[tileIdx],
			BlockFaceTileY[tileIdx],
			ao,
			light,
			BlockTint[blockId],
			meta,
		);
	}

	/**
	 * Raw-units quad emitter for downsampled builds (lodStep > 1).
	 *
	 * Positions and dimensions are whole blocks (all ≤ CHUNK_SIZE = 32), so
	 * they are written verbatim with NO POS_SCALE multiply and a fully zero
	 * meta byte — no flip, no diagonal, no posOff, no materialType sentinel,
	 * no rawDim flag. Only the dedicated LOD4+ "raw units" shader variant may
	 * consume faces written through this path.
	 */
	public emitQuadRawUnits(
		x: number,
		y: number,
		z: number,
		axis: number,
		width: number,
		height: number,
		blockId: number,
		backFace: number,
		light: number,
		ao: number,
		faceName: FaceName,
	): void {
		const tileIdx = blockId * FaceName.Count + faceName;

		this.emitRaw(
			x,
			y,
			z,
			axis * 2 + backFace,
			width,
			height,
			BlockFaceTileX[tileIdx],
			BlockFaceTileY[tileIdx],
			ao,
			light,
			BlockTint[blockId],
			0,
		);
	}

	/**
	 * General-purpose quad without bounds check.
	 * Keep this for non-cube or future callers that may use flip, diagonal,
	 * fractional positions, or non-default material types.
	 */
	public emitQuadUnchecked(
		x: number,
		y: number,
		z: number,
		axis: number,
		width: number,
		height: number,
		blockId: number,
		backFace: number,
		light: number,
		ao: number,
		faceName: FaceName,
		materialType: number,
		flip: number,
		diagonal: number,
		rawDim: number,
	): void {
		const xs = x * POS_SCALE;
		const ys = y * POS_SCALE;
		const zs = z * POS_SCALE;

		const tileIdx = blockId * FaceName.Count + faceName;

		let meta =
			((materialType & 0x3) << 1) |
			(flip ? META_FLIP : 0) |
			(diagonal ? META_DIAG : 0) |
			(diagonal === 2 ? META_DIAG_VARIANT : 0) |
			(rawDim ? META_RAW_DIM : 0);

		if (xs !== (xs | 0)) {
			meta |= META_POS_OFF_X;
		}

		if (zs !== (zs | 0)) {
			meta |= META_POS_OFF_Z;
		}

		const sw = rawDim ? width : width * POS_SCALE;
		const sh = rawDim ? height : height * POS_SCALE;

		this.emitRaw(
			(xs + 0.5) | 0,
			(ys + 0.5) | 0,
			(zs + 0.5) | 0,
			axis * 2 + backFace,
			sw,
			sh,
			BlockFaceTileX[tileIdx],
			BlockFaceTileY[tileIdx],
			ao,
			light,
			BlockTint[blockId],
			meta,
		);
	}

	/**
	 * Water-only quad emitter.
	 * Handles water-level scaling, rawDim override, and water-level Y offsets.
	 */
	public emitWaterQuad(
		x: number,
		y: number,
		z: number,
		axis: number,
		width: number,
		height: number,
		blockId: number,
		backFace: number,
		light: number,
		ao: number,
		faceName: FaceName,
		materialType: number,
		packedBlock: number,
	): void {
		const sx = (x * POS_SCALE + 0.5) | 0;
		let sy = (y * POS_SCALE + 0.5) | 0;
		const sz = (z * POS_SCALE + 0.5) | 0;

		if (sx < 0 || sy < 0 || sz < 0 || sx >= 256 || sy >= 256 || sz >= 256) {
			return;
		}

		const hasLevelPair = (packedBlock & WATER_LEVEL_PAIR_MASK) !== 0;
		const neighborLevel = (packedBlock >> 10) & 0x7;
		const ownLevel = hasLevelPair
			? (packedBlock >> 13) & 0x7
			: (packedBlock >> 10) & 0xf;

		const rawDim = width > 31 || height > 31 ? 1 : 0;

		let sw: number;
		let sh: number;

		if (axis === 1) {
			if (ownLevel > 0) {
				sy += WATER_TOP_OFFSET_SCALE[ownLevel];
			}

			sw = rawDim ? width : width * POS_SCALE;
			sh = rawDim ? height : height * POS_SCALE;
		} else {
			const topScale = hasLevelPair
				? WATER_FRAC_SCALE[ownLevel]
				: (packedBlock & WATER_ABOVE_MASK) !== 0
					? POS_SCALE
					: WATER_FRAC_SCALE[ownLevel];

			const baseScale = hasLevelPair ? WATER_FRAC_SCALE[neighborLevel] : 0;
			const spanScale = topScale - baseScale;

			sy += baseScale;

			if (axis === 0) {
				sw = rawDim ? width : width * spanScale;
				sh = rawDim ? height : height * POS_SCALE;
			} else {
				sw = rawDim ? width : width * POS_SCALE;
				sh = rawDim ? height : height * spanScale;
			}
		}

		const tileIdx = blockId * FaceName.Count + faceName;
		const meta =
			((materialType & 0x3) << 1) | META_WATER | (rawDim ? META_RAW_DIM : 0);

		this.emitRaw(
			sx,
			sy,
			sz,
			axis * 2 + backFace,
			sw,
			sh,
			BlockFaceTileX[tileIdx],
			BlockFaceTileY[tileIdx],
			ao,
			light,
			BlockTint[blockId],
			meta,
		);
	}
}
