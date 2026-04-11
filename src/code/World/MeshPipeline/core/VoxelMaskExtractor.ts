// MeshPipeline/core/VoxelMaskExtractor.ts

import { MeshContext, MaterialType } from "../types/MeshTypes";

import { unpackBlockId } from "../../BlockEncoding";
import {
  getShapeInfo,
  getMaterialType,
  isGreedyCompatiblePackedBlock,
} from "./ShapePipeline";
import { quantizeLightForLOD } from "./LightPipeline";
import { computeAO } from "./AOPipeline";
import { BLOCK_TYPE } from "../../Chunk/Worker/ChunkMesherConstants";
import {
  FACE_PX,
  FACE_NX,
  FACE_PY,
  FACE_NY,
  FACE_PZ,
  FACE_NZ,
} from "../../Shape/BlockShapes";

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
   * Returns packed block at (x,y,z).
   * If out of bounds, checks neighbors[].
   */
  private samplePacked(
    x: number,
    y: number,
    z: number,
    fallback: number,
  ): number {
    return this.ctx.getBlock(x, y, z, fallback);
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

  /**
   * Transparent-interface preservation rule:
   * keep a visible interface between different transparent blocks
   * in the water/glass material bucket (e.g. water vs glass).
   *
   * Identical water-water or glass-glass boundaries can still be culled.
   */
  private isWaterGlassInterface(
    currPacked: number,
    currFlags: number,
    nbrPacked: number,
    nbrFlags: number,
  ): boolean {
    if ((currFlags & FLAG_SOLID) === 0 || (nbrFlags & FLAG_SOLID) === 0) {
      return false;
    }
    if (
      (currFlags & FLAG_TRANSPARENT) === 0 ||
      (nbrFlags & FLAG_TRANSPARENT) === 0
    ) {
      return false;
    }

    if (
      (currFlags & FLAG_WATER_GLASS) === 0 ||
      (nbrFlags & FLAG_WATER_GLASS) === 0
    ) {
      return false;
    }

    return getCachedBlockId(currPacked) !== getCachedBlockId(nbrPacked);
  }

  /**
   * Computes packed LOD light.
   *
   * Current behavior is effectively "take the brighter side",
   * so keep that as a tiny scalar helper.
   */
  private pickLight(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
  ): number {
    const currLight = this.ctx.getLight(x, y, z, 0);
    const nbrLight = this.ctx.getLight(x + dx, y + dy, z + dz, currLight);

    return quantizeLightForLOD(
      Math.max(currLight, nbrLight),
      this.ctx.disableAO,
    );
  }

  public extractSliceMask(
    axis: number,
    slice: number,
    mask: number[],
    lightMask: number[],
  ): void {
    const size = this.ctx.size;

    const dx = axis === 0 ? 1 : 0;
    const dy = axis === 1 ? 1 : 0;
    const dz = axis === 2 ? 1 : 0;

    const uAxis = (axis + 1) % 3;
    const vAxis = (axis + 2) % 3;

    const currentFaceBit = this.getCurrentFaceBit(axis);
    const neighborFaceBit = this.getNeighborFaceBit(axis);

    let idx = 0;

    for (let v = 0; v < size; v++) {
      for (let u = 0; u < size; u++) {
        const pos = [0, 0, 0] as [number, number, number];

        pos[axis] = slice;
        pos[uAxis] = u;
        pos[vAxis] = v;

        const bx = pos[0];
        const by = pos[1];
        const bz = pos[2];

        const nx = bx + dx;
        const ny = by + dy;
        const nz = bz + dz;

        // If this face crosses a chunk boundary and the neighbor chunk is not loaded,
        // do NOT emit anything yet. Wait for neighbor load + remesh.
        if (
          nx < 0 ||
          ny < 0 ||
          nz < 0 ||
          nx >= size ||
          ny >= size ||
          nz >= size
        ) {
          const ndx = nx < 0 ? -1 : nx >= size ? 1 : 0;
          const ndy = ny < 0 ? -1 : ny >= size ? 1 : 0;
          const ndz = nz < 0 ? -1 : nz >= size ? 1 : 0;

          if (!this.ctx.hasNeighborChunk(ndx, ndy, ndz)) {
            mask[idx] = 0;
            lightMask[idx] = 0;
            idx++;
            continue;
          }
        }

        const currentPacked = this.samplePacked(bx, by, bz, 0);
        const neighborPacked = this.samplePacked(nx, ny, nz, 0);

        const currFlags = getCachedFlags(currentPacked);
        const nbrFlags = getCachedFlags(neighborPacked);

        const currSolid = (currFlags & FLAG_SOLID) !== 0;
        const nbrSolid = (nbrFlags & FLAG_SOLID) !== 0;

        // Air vs air = no face
        if (!currSolid && !nbrSolid) {
          mask[idx] = 0;
          lightMask[idx] = 0;
          idx++;
          continue;
        }

        const preserveTransparentInterface = this.isWaterGlassInterface(
          currentPacked,
          currFlags,
          neighborPacked,
          nbrFlags,
        );

        // Participation in greedy OUTPUT is restricted to greedy-compatible shapes.
        // Non-greedy shapes may still OCCLUDE via closedFaceMask checks below.
        const currParticipates = currSolid && (currFlags & FLAG_GREEDY) !== 0;
        const nbrParticipates = nbrSolid && (nbrFlags & FLAG_GREEDY) !== 0;

        const currShape = currSolid ? getShapeInfo(currentPacked) : undefined;
        const nbrShape = nbrSolid ? getShapeInfo(neighborPacked) : undefined;

        const currCube = currParticipates && !!currShape?.isCube;
        const nbrCube = nbrParticipates && !!nbrShape?.isCube;
        const bothCube = currCube && nbrCube;

        const currTransparent = (currFlags & FLAG_TRANSPARENT) !== 0;
        const nbrTransparent = (nbrFlags & FLAG_TRANSPARENT) !== 0;

        /**
         * FAST PATH: cube vs cube
         *
         * This is the hot common case in terrain chunks.
         * If both sides are participating, solid, non-transparent full cubes,
         * the shared face is internal -> cull it.
         *
         * IMPORTANT:
         * glass/water transparent interfaces must NOT be culled here.
         */
        if (bothCube) {
          if (
            !preserveTransparentInterface &&
            currParticipates &&
            nbrParticipates &&
            !currTransparent &&
            !nbrTransparent
          ) {
            mask[idx] = 0;
            lightMask[idx] = 0;
            idx++;
            continue;
          }
        } else {
          /**
           * SLOW PATH: directional shape-aware face closure
           *
           * Cull the face only if:
           * - current closes the face toward neighbor
           * - and neighbor closes the opposite face back toward current
           *
           * IMPORTANT:
           * glass/water interfaces must not be culled here either.
           *
           * Note:
           * custom/non-greedy shapes are allowed to OCCLUDE here even though
           * they do not participate in greedy output.
           */
          const currCloses =
            currSolid &&
            !!currShape &&
            (currShape.closedFaceMask & currentFaceBit) !== 0;

          const nbrCloses =
            nbrSolid &&
            !!nbrShape &&
            (nbrShape.closedFaceMask & neighborFaceBit) !== 0;

          if (!preserveTransparentInterface && currCloses && nbrCloses) {
            mask[idx] = 0;
            lightMask[idx] = 0;
            idx++;
            continue;
          }
        }

        /**
         * Preserve a visible interface between different water/glass-type transparent blocks.
         * Emit exactly one deterministic face to avoid z-fighting.
         *
         * Only emit if the chosen side participates in the greedy path.
         * If not, the separate custom-shape pass should own that geometry.
         */
        if (preserveTransparentInterface) {
          const currId = getCachedBlockId(currentPacked);
          const nbrId = getCachedBlockId(neighborPacked);

          // Prefer glass over water if one side is glass.
          const preferCurrent =
            currId === 60 || currId === 61
              ? true
              : nbrId === 60 || nbrId === 61
                ? false
                : true;

          let packedMask = 0;
          let packedLightOnly = 0;
          let packedAO = 0;

          if (preferCurrent && currParticipates && currShape) {
            packedMask =
              (currentPacked & PACKED_ID_STATE_MASK) |
              (currShape.isCube ? 0 : NON_CUBE_MASK);

            packedLightOnly = this.pickLight(bx, by, bz, dx, dy, dz);

            packedAO = this.ctx.disableAO
              ? 0
              : computeAO(
                  this.ctx,
                  nx,
                  ny,
                  nz,
                  axis,
                  false,
                  uAxis,
                  vAxis,
                  getShapeInfo,
                );
          } else if (!preferCurrent && nbrParticipates && nbrShape) {
            packedMask =
              (neighborPacked & PACKED_ID_STATE_MASK) |
              (nbrShape.isCube ? 0 : NON_CUBE_MASK) |
              BACK_FACE_MASK;

            packedLightOnly = this.pickLight(bx, by, bz, dx, dy, dz);

            packedAO = this.ctx.disableAO
              ? 0
              : computeAO(
                  this.ctx,
                  bx,
                  by,
                  bz,
                  axis,
                  true,
                  uAxis,
                  vAxis,
                  getShapeInfo,
                );
          } else {
            // If the preferred side is non-greedy, let the custom-shape pass own it.
            mask[idx] = 0;
            lightMask[idx] = 0;
            idx++;
            continue;
          }

          mask[idx] = packedMask;
          lightMask[idx] = (packedAO & 0xff) | ((packedLightOnly & 0xff) << 8);

          idx++;
          continue;
        }

        /**
         * Decide which side emits through the GREEDY path.
         *
         * Participation rule:
         * - the emitting side must be greedy-compatible
         * - the opposing side may still be non-greedy and still occlude
         */
        const nbrClosesFace =
          nbrSolid &&
          !!nbrShape &&
          (nbrShape.closedFaceMask & neighborFaceBit) !== 0;

        const currClosesFace =
          currSolid &&
          !!currShape &&
          (currShape.closedFaceMask & currentFaceBit) !== 0;

        const emitCurrent =
          currParticipates &&
          (!nbrSolid || (nbrTransparent && !currTransparent) || !nbrClosesFace);

        const emitNeighbor =
          nbrParticipates &&
          (!currSolid ||
            (currTransparent && !nbrTransparent) ||
            !currClosesFace);

        if (!emitCurrent && !emitNeighbor) {
          mask[idx] = 0;
          lightMask[idx] = 0;
          idx++;
          continue;
        }

        let packedMask = 0;
        let packedLightOnly = 0;
        let packedAO = 0;

        // Prefer current side deterministically when both are technically open.
        if (emitCurrent && currShape) {
          packedMask =
            (currentPacked & PACKED_ID_STATE_MASK) |
            (currShape.isCube ? 0 : NON_CUBE_MASK);

          packedLightOnly = this.pickLight(bx, by, bz, dx, dy, dz);

          // Front/current face:
          // AO anchor must be the outside cell in front of the face.
          packedAO = this.ctx.disableAO
            ? 0
            : computeAO(
                this.ctx,
                nx,
                ny,
                nz,
                axis,
                false,
                uAxis,
                vAxis,
                getShapeInfo,
              );
        } else if (nbrShape) {
          packedMask =
            (neighborPacked & PACKED_ID_STATE_MASK) |
            (nbrShape.isCube ? 0 : NON_CUBE_MASK) |
            BACK_FACE_MASK;

          packedLightOnly = this.pickLight(bx, by, bz, dx, dy, dz);

          // Back/neighbor face:
          // AO anchor is the current block cell, and this IS a back face.
          packedAO = this.ctx.disableAO
            ? 0
            : computeAO(
                this.ctx,
                bx,
                by,
                bz,
                axis,
                true,
                uAxis,
                vAxis,
                getShapeInfo,
              );
        } else {
          mask[idx] = 0;
          lightMask[idx] = 0;
          idx++;
          continue;
        }

        mask[idx] = packedMask;
        lightMask[idx] = (packedAO & 0xff) | ((packedLightOnly & 0xff) << 8);

        idx++;
      }
    }
  }
}
