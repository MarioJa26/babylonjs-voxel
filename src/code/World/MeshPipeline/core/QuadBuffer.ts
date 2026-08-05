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
const WATER_LEVEL_PAIR_MASK = 0x20000; // bit 17 — indicates water level pair is set

/**
 * P2.6: Session-owned quad emitter that owns the 3 parallel output arrays.
 *
 * Previously every face wrote through `out.faceDataA.backingArray` +
 * `out.faceDataA.length` property chains (9 property lookups + 3 length
 * writes + faceCount++ per face). The buffer binds to a WorkerInternalMeshData
 * once per build and caches direct references to the backing arrays and
 * ResizableTypedArrays, collapsing the per-face path to plain typed-array
 * stores.
 *
 * Face layout (3 u32 words per face, little-endian byte order):
 *   word0 (faceDataA): sx | sy<<8 | sz<<16 | axisFace(3)<<24 | tint(3)<<27
 *   word1 (faceDataB): sw | sh<<8 | tileX<<16 | tileY<<24
 *   word2 (faceDataC): ao | light<<8 | meta<<16 | chunkIndex(6)<<24
 * meta byte (word2 byte 2):
 *   bit0 flip · bit1-2 materialType(2) · bit3 posOffX · bit4 diag ·
 *   bit5 diagVariant · bit6 rawDim · bit7 posOffZ
 * For water faces bit 2 doubles as isWater (water's materialType=1 leaves it
 * clear otherwise; Cutout=2 faces render on the opaque pipeline, which never
 * reads meta). isWater lives at bit 2 so the vertex shader's posOffX (bit 3)
 * stays clean for water — water never sets posOffX/posOffZ.
 * The chunkIndex byte (word2 byte 3) is written as 0 here; the merged-group
 * layer ORs in the per-face local chunk index (0..63) when assembling the
 * group buffer, and PackedChunkMesh uploads it to the GPU arena verbatim.
 *
 * Bounds-check policy (P3.8):
 *  - `emitQuad` (custom shapes) keeps the bounds check: custom boxes and
 *    border blocks can produce coordinates at exactly -1 / size, which scale
 *    to sx == -8 / 256 — negative or wrapping values must be dropped.
 *  - `emitQuadUnchecked` (greedy cube path) skips the check: greedy faces
 *    only ever sit at positions 0..size-1 (front faces at slice+1 where
 *    slice <= size-2; back faces at slice where slice >= 0), so
 *    sx/sy/sz are always in [0, 248] with POS_SCALE = 8.
 *  - `emitWaterQuad` keeps its historic unchecked behavior.
 */
export class QuadBuffer {
	private data!: WorkerInternalMeshData;
	private rtaA!: ResizableTypedArray<Uint8Array>;
	private rtaB!: ResizableTypedArray<Uint8Array>;
	private rtaC!: ResizableTypedArray<Uint8Array>;
	private a!: Uint8Array;
	private b!: Uint8Array;
	private c!: Uint8Array;
	private count = 0;

	/** Point this buffer at a (reused) output mesh and zero its face count. */
	public bind(out: WorkerInternalMeshData): void {
		this.data = out;
		this.rtaA = out.faceDataA;
		this.rtaB = out.faceDataB;
		this.rtaC = out.faceDataC;
		this.a = out.faceDataA.backingArray;
		this.b = out.faceDataB.backingArray;
		this.c = out.faceDataC.backingArray;
		this.count = 0;
	}

	/**
	 * Raw face write — the single hot path shared by every quad emitter.
	 * No bounds check, no growth check (reserveMeshCapacity guarantees
	 * capacity up front).
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
		const i = this.count << 2;
		const a = this.a;
		const b = this.b;
		const c = this.c;
		a[i] = sx;
		a[i + 1] = sy;
		a[i + 2] = sz;
		a[i + 3] = axisFace | (tint << 3);
		b[i] = sw;
		b[i + 1] = sh;
		b[i + 2] = tx;
		b[i + 3] = ty;
		c[i] = ao;
		c[i + 1] = light;
		c[i + 2] = meta;
		c[i + 3] = 0;
		this.count++;
		const next = i + 4;
		this.rtaA.length = next;
		this.rtaB.length = next;
		this.rtaC.length = next;
		this.data.faceCount = this.count;
	}

	/**
	 * General-purpose quad — no water logic.
	 * Used for all non-water faces that can touch the chunk border
	 * (custom shapes, crosses, multi-box blocks) — bounds-checked.
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

		if (sx < 0 || sy < 0 || sz < 0 || sx >= 256 || sy >= 256 || sz >= 256)
			return;

		const tileIdx = blockId * FaceName.Count + faceName;
		const tx = BlockFaceTileX[tileIdx];
		const ty = BlockFaceTileY[tileIdx];

		const axisFace = axis * 2 + backFace;

		const diagEnabled = diagonal !== 0 ? 1 : 0;
		const diagVariant = diagonal === 2 ? 1 : 0;

		const posOffX = xs % 1 !== 0 ? 1 : 0;
		const posOffZ = zs % 1 !== 0 ? 1 : 0;

		const meta =
			(flip ? 1 : 0) |
			((materialType & 0x3) << 1) |
			(posOffX << 3) |
			(diagEnabled << 4) |
			(diagVariant << 5) |
			(rawDim ? 64 : 0) |
			(posOffZ << 7);

		const tint = BlockTint[blockId];

		const sw = rawDim ? width : width * POS_SCALE;
		const sh = rawDim ? height : height * POS_SCALE;

		this.emitRaw(sx, sy, sz, axisFace, sw, sh, tx, ty, ao, light, tint, meta);
	}

	/**
	 * General-purpose quad WITHOUT the bounds check — the greedy cube path
	 * only emits faces at positions 0..size-1, which can never produce
	 * out-of-range coordinates (see class doc).
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
		const tileIdx = blockId * FaceName.Count + faceName;
		const tx = BlockFaceTileX[tileIdx];
		const ty = BlockFaceTileY[tileIdx];

		const axisFace = axis * 2 + backFace;

		const diagEnabled = diagonal !== 0 ? 1 : 0;
		const diagVariant = diagonal === 2 ? 1 : 0;

		const xs = x * POS_SCALE;
		const ys = y * POS_SCALE;
		const zs = z * POS_SCALE;
		const posOffX = xs % 1 !== 0 ? 1 : 0;
		const posOffZ = zs % 1 !== 0 ? 1 : 0;

		const meta =
			(flip ? 1 : 0) |
			((materialType & 0x3) << 1) |
			(posOffX << 3) |
			(diagEnabled << 4) |
			(diagVariant << 5) |
			(rawDim ? 64 : 0) |
			(posOffZ << 7);

		const tint = BlockTint[blockId];

		const sx = (xs + 0.5) | 0;
		const sy = (ys + 0.5) | 0;
		const sz = (zs + 0.5) | 0;

		const sw = rawDim ? width : width * POS_SCALE;
		const sh = rawDim ? height : height * POS_SCALE;

		this.emitRaw(sx, sy, sz, axisFace, sw, sh, tx, ty, ao, light, tint, meta);
	}

	/**
	 * Water-only quad emitter.
	 * Handles water-level scaling, rawDim override for large faces,
	 * and waterLevelBase Y-offset — all water concerns in one place.
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

		if (sx < 0 || sy < 0 || sz < 0 || sx >= 256 || sy >= 256 || sz >= 256)
			return;

		const tileIdx = blockId * FaceName.Count + faceName;
		const tx = BlockFaceTileX[tileIdx];
		const ty = BlockFaceTileY[tileIdx];

		const axisFace = axis * 2 + backFace;

		// Check if this is a water-to-water level pair interface
		const hasLevelPair = (packedBlock & WATER_LEVEL_PAIR_MASK) !== 0;
		// neighborLevel is the TALLER column (higher level number, smaller frac) and
		// is stored in bits 10-12 (3 bits, 0-7). Must mask with 0x7, NOT 0xf: bit 13
		// belongs to shallowerLevel (<< 13) and would otherwise corrupt this read.
		const neighborLevel = (packedBlock >> 10) & 0x7; // taller side, only valid if hasLevelPair
		const ownLevel = hasLevelPair
			? (packedBlock >> 13) & 0x7
			: (packedBlock >> 10) & 0xf; // normal single-level case

		const waterAbove = (packedBlock & WATER_ABOVE_MASK) !== 0;
		const rawDim = width > 31 || height > 31 ? 1 : 0;

		const meta = ((materialType & 0x3) << 1) | (1 << 2) | (rawDim ? 64 : 0);

		const tint = BlockTint[blockId];

		let sw: number;
		let sh: number;

		if (axis === 1) {
			if (ownLevel > 0) sy += WATER_TOP_OFFSET_SCALE[ownLevel];
			sw = rawDim ? width : width * POS_SCALE;
			sh = rawDim ? height : height * POS_SCALE;
		} else {
			// For a level-pair face the sliver is strictly bounded by the two
			// column tops, so topScale is ALWAYS the shallower column's top.
			// waterAbove (meant for single-level columns) must NOT force POS_SCALE
			// here, or the sliver overdraws up to the full block top.
			const topScale = hasLevelPair
				? WATER_FRAC_SCALE[ownLevel]
				: waterAbove
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

		this.emitRaw(sx, sy, sz, axisFace, sw, sh, tx, ty, ao, light, tint, meta);
	}
}
