// MeshPipeline/core/VoxelMaskExtractor.ts

import { MeshContext, BlockShapeInfo } from "../types/MeshTypes.js";

import { getShapeInfo } from "./ShapePipeline.js";
import { quantizeLightForLOD } from "./LightPipeline.js";
import { computeAO } from "./AOPipeline.js";
import { BLOCK_TYPE } from "../../Chunk/Worker/ChunkMesherConstants.js";

/**
 * Represents a parsed block (id + state)
 */
export interface ParsedBlock {
  id: number;
  state: number;
  packedIdState: number;
  isTransparent: boolean;
  isSolid: boolean;
  isPartial: boolean;
  shape: BlockShapeInfo;
}

/**
 * Unpacks blockId + blockState from a packed block (uint16 or uint8)
 * Assumes:
 *   lower 8 bits  = blockId
 *   upper bits    = blockState
 */
function unpackBlock(packed: number): ParsedBlock {
  const id = packed & 0xff;
  const state = (packed >> 8) & 0xff;

  const shape = getShapeInfo(packed);

  const isPartial = ((state >> 3) & 7) !== 0;
  const isTransparent = BLOCK_TYPE[id] !== 0; // placeholder rule
  const isSolid = id !== 0;

  return {
    id,
    state,
    packedIdState: packed & 0xffff,
    isTransparent,
    isSolid,
    isPartial,
    shape,
  };
}

/**
 * Extracts the 2D slice mask for greedy meshing on one axis.
 *
 * This replaces your old computeSliceMask().
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

        const curr = unpackBlock(currentPacked);
        const nbr = unpackBlock(neighborPacked);

        const sameId = curr.id === nbr.id;
        const sameState = curr.state === nbr.state;
        const currFaceFull = curr.shape.isSliceCompatible;
        const nbrFaceFull = nbr.shape.isSliceCompatible;

        const bothOcclude = sameId && sameState && currFaceFull && nbrFaceFull;

        if (currentPacked === 0 && neighborPacked === 0) {
          mask[idx] = 0;
          lightMask[idx] = 0;
          idx++;
          continue;
        }

        if (bothOcclude) {
          mask[idx] = 0;
          lightMask[idx] = 0;
          idx++;
          continue;
        }

        const emitCurrent =
          curr.isSolid &&
          (!nbr.isSolid ||
            (nbr.isTransparent && !curr.isTransparent) ||
            !nbrFaceFull);

        const emitNeighbor =
          nbr.isSolid &&
          (!curr.isSolid ||
            (curr.isTransparent && !nbr.isTransparent) ||
            !currFaceFull);

        if (!emitCurrent && !emitNeighbor) {
          mask[idx] = 0;
          lightMask[idx] = 0;
          idx++;
          continue;
        }

        let packedMask = 0;
        let packedLightOnly = 0;
        let packedAO = 0;

        if (emitCurrent) {
          packedMask = curr.packedIdState;

          const currLight = this.ctx.getLight(bx, by, bz, 15 << 4);
          const nbrLight = this.ctx.getLight(nx, ny, nz, currLight);

          const merged =
            curr.isPartial && !nbr.isPartial
              ? Math.max(currLight, nbrLight)
              : nbrLight;

          packedLightOnly = quantizeLightForLOD(merged, this.ctx.disableAO);

          packedAO = this.ctx.disableAO
            ? 0
            : computeAO(this.ctx, nx, ny, nz, uAxis, vAxis, getShapeInfo);
        } else {
          packedMask = nbr.packedIdState | 0x80000000;

          const currLight = this.ctx.getLight(bx, by, bz, 0);
          const nbrLight = this.ctx.getLight(nx, ny, nz, currLight);

          const merged =
            nbr.isPartial && !curr.isPartial
              ? Math.max(currLight, nbrLight)
              : currLight;

          packedLightOnly = quantizeLightForLOD(merged, this.ctx.disableAO);

          packedAO = this.ctx.disableAO
            ? 0
            : computeAO(this.ctx, bx, by, bz, uAxis, vAxis, getShapeInfo);
        }

        mask[idx] = packedMask;
        lightMask[idx] = (packedAO & 0xff) | ((packedLightOnly & 0xff) << 8);

        idx++;
      }
    }
  }
  /**
   * Computes packed LOD light according to your engine rules.
   */
  private pickLight(
    curr: ParsedBlock,
    nbr: ParsedBlock,
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
  ): number {
    const currLight = this.ctx.getLight(x, y, z, 0);
    const nbrLight = this.ctx.getLight(x + dx, y + dy, z + dz, currLight);

    const merged =
      curr.isPartial && !nbr.isPartial
        ? Math.max(currLight, nbrLight)
        : nbrLight;

    return quantizeLightForLOD(merged, this.ctx.disableAO);
  }
}
