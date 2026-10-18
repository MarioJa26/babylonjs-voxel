// MeshPipeline/core/QuadBuffer.ts

import type { ResizableTypedArray } from "../../Chunk/DataStructures/ResizableTypedArray";
import type { WorkerInternalMeshData } from "../../Chunk/DataStructures/WorkerInternalMeshData";
import { POS_SCALE } from "../../Chunk/Worker/ChunkMesherConstants";
import { BlockFaceTileX, BlockFaceTileY } from "../../Texture/BlockTextures";
import { FaceName } from "../../Texture/FaceName";
import { BlockTint } from "./BlockInfoCache";

const WATER_ABOVE_MASK = 0x10000;
const WATER_LEVEL_PAIR_MASK = 0x20000;

const META_FLIP = 1;
const META_WATER = 1 << 2;
const META_POS_OFF_X = 1 << 3;
const META_DIAG = 1 << 4;
const META_DIAG_VARIANT = 1 << 5;
const META_RAW_DIM = 1 << 6;
const META_POS_OFF_Z = 1 << 7;

const BYTES_PER_FACE = 12;
const WORDS_PER_FACE = 3;
const BYTE_COORD_LIMIT = 256;

export class QuadBuffer {
	private data!: WorkerInternalMeshData;
	private rta!: ResizableTypedArray<Uint8Array>;
	private buf!: Uint8Array;
	private words!: Uint32Array;
	private count = 0;

	/**
	 * Updates cached array views only when the backing storage changed.
	 *
	 * In the normal reuse path, bind() performs no allocation.
	 */
	private updateBackingViews(buf: Uint8Array): void {
		const words = this.words;

		if (
			words !== undefined &&
			words.buffer === buf.buffer &&
			words.byteOffset === buf.byteOffset &&
			words.byteLength === (buf.byteLength & ~3)
		) {
			this.buf = buf;
			return;
		}

		this.buf = buf;
		this.words = new Uint32Array(
			buf.buffer,
			buf.byteOffset,
			buf.byteLength >>> 2,
		);
	}

	/** Point this buffer at a reused output mesh and zero its face count. */
	public bind(out: WorkerInternalMeshData): void {
		const rta = out.faceData;

		this.data = out;
		this.rta = rta;
		this.updateBackingViews(rta.backingArray);
		this.count = 0;

		rta.length = 0;
		out.faceCount = 0;
	}

	/** Publish the final byte length and face count. */
	public finish(): void {
		const count = this.count;

		this.rta.length = count * BYTES_PER_FACE;
		this.data.faceCount = count;
	}

	/**
	 * Returns the block tint without allocating or creating temporary objects.
	 */
	private getTint(blockId: number): number {
		return blockId >= 0 && blockId < BlockTint.length ? BlockTint[blockId] : 1;
	}

	/**
	 * Raw face write.
	 *
	 * No allocations occur unless the resizable backing array must grow.
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
		const count = this.count;
		const byteIndex = count * BYTES_PER_FACE;
		const requiredLength = byteIndex + BYTES_PER_FACE;

		if (requiredLength > this.buf.length) {
			const rta = this.rta;

			rta.length = byteIndex;
			rta.ensureCapacity(requiredLength);
			this.updateBackingViews(rta.backingArray);
		}

		const wordIndex = count * WORDS_PER_FACE;
		const words = this.words;

		words[wordIndex] =
			sx | (sy << 8) | (sz << 16) | ((axisFace | (tint << 3)) << 24);

		words[wordIndex + 1] = sw | (sh << 8) | (tx << 16) | (ty << 24);

		words[wordIndex + 2] = ao | (light << 8) | (meta << 16);

		this.count = count + 1;
	}

	/**
	 * General-purpose quad with bounds checking.
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

		if (
			sx < 0 ||
			sy < 0 ||
			sz < 0 ||
			sx >= BYTE_COORD_LIMIT ||
			sy >= BYTE_COORD_LIMIT ||
			sz >= BYTE_COORD_LIMIT
		) {
			return;
		}

		const tileIndex = blockId * FaceName.Count + faceName;

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

		let sw = width;
		let sh = height;

		if (!rawDim) {
			sw *= POS_SCALE;
			sh *= POS_SCALE;
		}

		this.emitRaw(
			sx,
			sy,
			sz,
			axis * 2 + backFace,
			sw,
			sh,
			BlockFaceTileX[tileIndex],
			BlockFaceTileY[tileIndex],
			ao,
			light,
			this.getTint(blockId),
			meta,
		);
	}

	/**
	 * Specialized unchecked cube-face emitter.
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
		const tileIndex = blockId * FaceName.Count + faceName;

		let sw = width;
		let sh = height;

		if (!rawDim) {
			sw *= POS_SCALE;
			sh *= POS_SCALE;
		}

		this.emitRaw(
			x * POS_SCALE + 0.5,
			y * POS_SCALE + 0.5,
			z * POS_SCALE + 0.5,
			axis * 2 + backFace,
			sw,
			sh,
			BlockFaceTileX[tileIndex],
			BlockFaceTileY[tileIndex],
			ao,
			light,
			this.getTint(blockId),
			rawDim ? META_RAW_DIM : 0,
		);
	}

	/**
	 * Raw-units emitter for downsampled builds.
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
		const tileIndex = blockId * FaceName.Count + faceName;

		this.emitRaw(
			x,
			y,
			z,
			axis * 2 + backFace,
			width,
			height,
			BlockFaceTileX[tileIndex],
			BlockFaceTileY[tileIndex],
			ao,
			light,
			this.getTint(blockId),
			0,
		);
	}

	/**
	 * General-purpose quad without bounds checking.
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

		let sw = width;
		let sh = height;

		if (!rawDim) {
			sw *= POS_SCALE;
			sh *= POS_SCALE;
		}

		const tileIndex = blockId * FaceName.Count + faceName;

		this.emitRaw(
			(xs + 0.5) | 0,
			(ys + 0.5) | 0,
			(zs + 0.5) | 0,
			axis * 2 + backFace,
			sw,
			sh,
			BlockFaceTileX[tileIndex],
			BlockFaceTileY[tileIndex],
			ao,
			light,
			this.getTint(blockId),
			meta,
		);
	}

	/**
	 * Water-only quad emitter.
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
		isWaterBody: boolean,
	): void {
		const sx = (x * POS_SCALE + 0.5) | 0;
		let sy = (y * POS_SCALE + 0.5) | 0;
		const sz = (z * POS_SCALE + 0.5) | 0;

		if (
			sx < 0 ||
			sy < 0 ||
			sz < 0 ||
			sx >= BYTE_COORD_LIMIT ||
			sy >= BYTE_COORD_LIMIT ||
			sz >= BYTE_COORD_LIMIT
		) {
			return;
		}

		const hasLevelPair = (packedBlock & WATER_LEVEL_PAIR_MASK) !== 0;

		const neighborLevel = (packedBlock >>> 10) & 0x7;
		const ownLevel = hasLevelPair
			? (packedBlock >>> 13) & 0x7
			: (packedBlock >>> 10) & 0xf;

		const rawDim = width > 31 || height > 31 ? 1 : 0;

		let sw: number;
		let sh: number;

		if (axis === 1) {
			// Equivalent to WATER_TOP_OFFSET_SCALE[ownLevel].
			if (ownLevel > 0) {
				sy -= ownLevel;
			}

			sw = width;
			sh = height;

			if (!rawDim) {
				sw *= POS_SCALE;
				sh *= POS_SCALE;
			}
		} else {
			let topScale: number;

			if (!hasLevelPair && (packedBlock & WATER_ABOVE_MASK) !== 0) {
				topScale = POS_SCALE;
			} else {
				// Equivalent to WATER_FRAC_SCALE[ownLevel].
				topScale = POS_SCALE - ownLevel;
			}

			// Equivalent to WATER_FRAC_SCALE[neighborLevel].
			const baseScale = hasLevelPair ? POS_SCALE - neighborLevel : 0;

			const spanScale = topScale - baseScale;

			sy += baseScale;

			if (rawDim) {
				sw = width;
				sh = height;
			} else if (axis === 0) {
				sw = width * spanScale;
				sh = height * POS_SCALE;
			} else {
				sw = width * POS_SCALE;
				sh = height * spanScale;
			}
		}

		const tileIndex = blockId * FaceName.Count + faceName;
		// META_WATER overlaps the high bit of the 2-bit materialType field,
		// which shaders decode as the boundary sentinel. Only true water
		// bodies may carry it; other liquids (lava/oil) render through the
		// cutout bucket, which keeps the sentinel enabled.
		const meta =
			((materialType & 0x3) << 1) |
			(isWaterBody ? META_WATER : 0) |
			(rawDim ? META_RAW_DIM : 0);

		this.emitRaw(
			sx,
			sy,
			sz,
			axis * 2 + backFace,
			sw,
			sh,
			BlockFaceTileX[tileIndex],
			BlockFaceTileY[tileIndex],
			ao,
			light,
			this.getTint(blockId),
			meta,
		);
	}
}
