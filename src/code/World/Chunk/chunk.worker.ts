/// <reference lib="webworker" />

import { WorldGenerator } from "../Generation/WorldGenerator";
import { MeshData } from "./DataStructures/MeshData";
import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";
import { ResizableTypedArray } from "./DataStructures/ResizableTypedArray";
import { WorkerInternalMeshData } from "./DataStructures/WorkerInternalMeshData";
import {
  WorkerTaskType,
  WorkerRequestData,
} from "./DataStructures/WorkerMessageType";
import { DistantTerrainGenerator } from "../Generation/DistanTerrain/DistantTerrainGenerator";
import { BlockTextures } from "../Texture/BlockTextures";
import {
  CUBE_SHAPE_INDEX,
  FACE_ALL,
  FACE_NX,
  FACE_NY,
  FACE_NZ,
  FACE_PX,
  FACE_PY,
  FACE_PZ,
  ShapeByBlockId,
  ShapeDefinitions,
} from "../Shape/BlockShapes";
import { PaletteExpander } from "./DataStructures/PaletteExpander";
import {
  BLOCK_ID_MASK,
  BLOCK_STATE_MASK,
  BLOCK_STATE_SHIFT,
  unpackBlockId,
  unpackBlockState,
} from "../BlockEncoding";

// ---------------------------------------------------------------------------
// Block classification — flat Uint8 lookup instead of Set.has() calls
// ---------------------------------------------------------------------------
// Set.has() on every block face in the inner loop is surprisingly expensive.
// Replace with a typed array lookup: O(1) with no hashing overhead.
const BLOCK_TYPE = new Uint8Array(65536); // covers all 16-bit block IDs
const BLOCK_TYPE_TRANSPARENT = 1;
// 0 = opaque/air
for (const id of [30, 60, 61]) BLOCK_TYPE[id] = BLOCK_TYPE_TRANSPARENT; // water (30) and glass (60, 61)

const WATER_BLOCK_ID = 30;

const BLOCK_PACK_MASK = BLOCK_ID_MASK | (BLOCK_STATE_MASK << BLOCK_STATE_SHIFT);
const TRANSPARENT_FLAG = 1 << 16;
const BACKFACE_FLAG = 1 << 17;
const POS_SCALE = 4;

const ROTATE_Y_FACE_MASK_1 = new Uint8Array(64);
const ROTATE_Y_FACE_MASK_2 = new Uint8Array(64);
const ROTATE_Y_FACE_MASK_3 = new Uint8Array(64);
const FLIP_Y_FACE_MASK = new Uint8Array(64);

for (let mask = 0; mask < 64; mask++) {
  const px = (mask >> 0) & 1;
  const nx = (mask >> 1) & 1;
  const py = (mask >> 2) & 1;
  const ny = (mask >> 3) & 1;
  const pz = (mask >> 4) & 1;
  const nz = (mask >> 5) & 1;

  // One 90° CW rotation around Y:
  // +X -> +Z
  // +Z -> -X
  // -X -> -Z
  // -Z -> +X
  const rot1 =
    (nz << 0) | // new +X = old -Z
    (pz << 1) | // new -X = old +Z
    (py << 2) | // +Y unchanged
    (ny << 3) | // -Y unchanged
    (px << 4) | // new +Z = old +X
    (nx << 5); // new -Z = old -X

  ROTATE_Y_FACE_MASK_1[mask] = rot1;

  // rot2 = rot1 applied again
  const px1 = (rot1 >> 0) & 1;
  const nx1 = (rot1 >> 1) & 1;
  const py1 = (rot1 >> 2) & 1;
  const ny1 = (rot1 >> 3) & 1;
  const pz1 = (rot1 >> 4) & 1;
  const nz1 = (rot1 >> 5) & 1;

  const rot2 =
    (nz1 << 0) | (pz1 << 1) | (py1 << 2) | (ny1 << 3) | (px1 << 4) | (nx1 << 5);

  ROTATE_Y_FACE_MASK_2[mask] = rot2;

  // rot3 = rot2 applied again
  const px2 = (rot2 >> 0) & 1;
  const nx2 = (rot2 >> 1) & 1;
  const py2 = (rot2 >> 2) & 1;
  const ny2 = (rot2 >> 3) & 1;
  const pz2 = (rot2 >> 4) & 1;
  const nz2 = (rot2 >> 5) & 1;

  const rot3 =
    (nz2 << 0) | (pz2 << 1) | (py2 << 2) | (ny2 << 3) | (px2 << 4) | (nx2 << 5);

  ROTATE_Y_FACE_MASK_3[mask] = rot3;

  // Flip Y: swap +Y and -Y
  FLIP_Y_FACE_MASK[mask] =
    (px << 0) |
    (nx << 1) |
    (ny << 2) | // new +Y = old -Y
    (py << 3) | // new -Y = old +Y
    (pz << 4) |
    (nz << 5);
}

const paletteExpander = new PaletteExpander();
type WaterSurfaceSample = {
  worldX: number;
  worldY: number;
  worldZ: number;
  width: number;
  depth: number;
  packedLight: number;
};

type WaterLODArgs = {
  chunk_size: number;
  getBlock: (x: number, y: number, z: number, fallback?: number) => number;
  getLight: (x: number, y: number, z: number, fallback?: number) => number;
  step: number;
};
class ChunkWorkerMesher {
  private static toCompactNeighborIndex(fullIndex: number): number {
    return fullIndex > 13 ? fullIndex - 1 : fullIndex;
  }

  private static createEmptyMeshData(): WorkerInternalMeshData {
    return {
      faceDataA: new ResizableTypedArray(Uint8Array),
      faceDataB: new ResizableTypedArray(Uint8Array),
      faceDataC: new ResizableTypedArray(Uint8Array),
      faceCount: 0,
    };
  }

  /**
   * Calculate packed AO (2 bits × 4 corners = 8 bits) for one face.
   *
   * OPTIMIZATION: Pre-compute the six axis offsets once per call rather than
   * recomputing the ternary `(axis === N ? ±1 : 0)` expressions 12× inside
   * the corner loop. This cuts ~72 conditional evaluations down to 6.
   */
  private static calculateAOPacked(
    ax: number,
    ay: number,
    az: number,
    u: number,
    v: number,
    getBlock: (x: number, y: number, z: number) => number,
  ): number {
    // Unit offsets for the face plane axes.
    const ux = u === 0 ? 1 : 0;
    const uy = u === 1 ? 1 : 0;
    const uz = u === 2 ? 1 : 0;

    const vx = v === 0 ? 1 : 0;
    const vy = v === 1 ? 1 : 0;
    const vz = v === 2 ? 1 : 0;

    let packed = 0;

    // Corner order: (0,0), (1,0), (1,1), (0,1)
    for (let i = 0; i < 4; i++) {
      const du = i === 1 || i === 2 ? 1 : -1;
      const dv = i === 2 || i === 3 ? 1 : -1;

      const side1 = this.isAOOccluder(
        getBlock(ax + vx * dv, ay + vy * dv, az + vz * dv),
      );

      const side2 = this.isAOOccluder(
        getBlock(ax + ux * du, ay + uy * du, az + uz * du),
      );

      const corner = this.isAOOccluder(
        getBlock(
          ax + ux * du + vx * dv,
          ay + uy * du + vy * dv,
          az + uz * du + vz * dv,
        ),
      );

      const ao =
        (side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner && side1 && side2 ? 1 : 0);

      packed |= ao << (i * 2);
    }

    return packed;
  }
  private static isAOOccluder(value: number): boolean {
    const id = unpackBlockId(value);
    if (id === 0) return false;

    const shapeIndex = ShapeByBlockId[id];
    if (!this.isGreedyCompatibleShape(shapeIndex)) return false;

    const state = unpackBlockState(value);
    return ((state >>> 3) & 7) === 0;
  }
  private static isFullCubeOccluder(value: number): boolean {
    const id = unpackBlockId(value);
    if (id === 0) return false;

    const shapeIndex = ShapeByBlockId[id];
    if (!this.isGreedyCompatibleShape(shapeIndex)) return false;

    const state = unpackBlockState(value);
    return ((state >>> 3) & 7) === 0;
  }

  private static getSliceAxis(rotation: number): number {
    const sliceAxisRaw = rotation & 3;

    switch (sliceAxisRaw) {
      case 1:
        return 0; // X
      case 2:
        return 2; // Z
      default:
        return 1; // Y
    }
  }

  private static isGreedyCompatibleShape(shapeIndex: number): boolean {
    if (shapeIndex === CUBE_SHAPE_INDEX) return true;
    const shape = ShapeDefinitions[shapeIndex];
    if (!shape) return false;
    if (!shape.usesSliceState) return false;
    if (shape.boxes.length !== 1) return false;
    const box = shape.boxes[0];
    return (
      box.faceMask === FACE_ALL &&
      box.min[0] === 0 &&
      box.min[1] === 0 &&
      box.min[2] === 0 &&
      box.max[0] === 1 &&
      box.max[1] === 1 &&
      box.max[2] === 1
    );
  }

  private static isFaceFull(
    state: number,
    axis: number,
    isBackFace: boolean,
  ): boolean {
    const slice = (state >>> 3) & 7;
    if (slice === 0) {
      return true;
    }

    const rotation = state & 7;
    const sliceAxis = this.getSliceAxis(rotation);
    if (sliceAxis !== axis) {
      return false;
    }

    const flip = (rotation & 4) !== 0;
    return isBackFace ? !flip : flip;
  }

  static generateMesh(data: {
    block_array: Uint8Array | Uint16Array;
    chunk_size: number;
    light_array?: Uint8Array;
    neighbors: (Uint8Array | Uint16Array | undefined)[];
    neighborLights?: (Uint8Array | undefined)[];
  }): {
    opaque: WorkerInternalMeshData;
    transparent: WorkerInternalMeshData;
  } {
    const opaqueMeshData = this.createEmptyMeshData();
    const transparentMeshData = this.createEmptyMeshData();

    if (!data.block_array) {
      return {
        opaque: opaqueMeshData,
        transparent: transparentMeshData,
      };
    }

    const {
      block_array,
      light_array,
      chunk_size: size,
      neighbors,
      neighborLights,
    } = data;

    const size2 = size * size;
    const fullBright = 15 << 4;

    // ---------------------------------------------------------------------------
    // getBlock / getLight — fast in-bounds access, neighbor lookup only when
    // sampling outside this chunk.
    // ---------------------------------------------------------------------------
    const getBlock = (
      x: number,
      y: number,
      z: number,
      fallback = 0,
    ): number => {
      if (x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size) {
        return block_array[x + y * size + z * size2];
      }

      const dx = x < 0 ? -1 : x >= size ? 1 : 0;
      const dy = y < 0 ? -1 : y >= size ? 1 : 0;
      const dz = z < 0 ? -1 : z >= size ? 1 : 0;

      const neighbor =
        neighbors[
          this.toCompactNeighborIndex(dx + 1 + (dy + 1) * 3 + (dz + 1) * 9)
        ];

      if (!neighbor) return fallback;

      return neighbor[
        x - dx * size + (y - dy * size) * size + (z - dz * size) * size2
      ];
    };

    const getLight = (
      x: number,
      y: number,
      z: number,
      fallback = 0,
    ): number => {
      if (!light_array) {
        return fullBright;
      }

      if (x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size) {
        return light_array[x + y * size + z * size2];
      }

      const dx = x < 0 ? -1 : x >= size ? 1 : 0;
      const dy = y < 0 ? -1 : y >= size ? 1 : 0;
      const dz = z < 0 ? -1 : z >= size ? 1 : 0;

      const neighbor = neighborLights
        ? neighborLights[
            this.toCompactNeighborIndex(dx + 1 + (dy + 1) * 3 + (dz + 1) * 9)
          ]
        : undefined;

      if (!neighbor) return fallback;

      return neighbor[
        x - dx * size + (y - dy * size) * size + (z - dz * size) * size2
      ];
    };

    const direction = [0, 0, 0];
    const mask = new Uint32Array(size * size);
    const maskLight = new Uint16Array(size * size);
    const maskBack = new Uint32Array(size * size);
    const maskBackLight = new Uint16Array(size * size);

    for (let axis = 0; axis < 3; axis++) {
      direction[0] = axis === 0 ? 1 : 0;
      direction[1] = axis === 1 ? 1 : 0;
      direction[2] = axis === 2 ? 1 : 0;

      const faceNamePositive = this.getFaceName(direction, false);
      const faceNameNegative = this.getFaceName(direction, true);

      for (let slice = 0; slice < size; slice++) {
        this.computeSliceMask(
          size,
          axis,
          slice,
          direction,
          block_array,
          getBlock,
          getLight,
          mask,
          maskLight,
          maskBack,
          maskBackLight,
        );

        this.meshSlice(
          size,
          axis,
          slice,
          mask,
          maskLight,
          opaqueMeshData,
          transparentMeshData,
          faceNamePositive,
          faceNameNegative,
        );

        this.meshSlice(
          size,
          axis,
          slice,
          maskBack,
          maskBackLight,
          opaqueMeshData,
          transparentMeshData,
          faceNamePositive,
          faceNameNegative,
        );
      }
    }

    // Skip the expensive custom-shape pass entirely if this chunk contains
    // only greedy-compatible blocks.
    if (this.chunkHasCustomShapes(block_array)) {
      this.emitCustomShapes(
        size,
        block_array,
        getBlock,
        getLight,
        opaqueMeshData,
        transparentMeshData,
      );
    }

    return {
      opaque: opaqueMeshData,
      transparent: transparentMeshData,
    };
  }

  private static chunkHasCustomShapes(
    block_array: Uint8Array | Uint16Array,
  ): boolean {
    for (let i = 0; i < block_array.length; i++) {
      const packed = block_array[i];
      const blockId = unpackBlockId(packed);
      if (blockId === 0) continue;

      const shapeIndex = ShapeByBlockId[blockId];
      if (!this.isGreedyCompatibleShape(shapeIndex)) {
        return true;
      }
    }

    return false;
  }

  private static computeSliceMask(
    size: number,
    axis: number,
    slice: number,
    direction: number[],
    block_array: Uint8Array | Uint16Array,
    getBlock: (x: number, y: number, z: number, fallback?: number) => number,
    getLight: (x: number, y: number, z: number, fallback?: number) => number,
    mask: Uint32Array,
    maskLight: Uint16Array,
    maskBack: Uint32Array,
    maskBackLight: Uint16Array,
  ) {
    const u_axis = (axis + 1) % 3;
    const v_axis = (axis + 2) % 3;
    const size2 = size * size;

    let maskIndex = 0;
    const position = [0, 0, 0];
    position[axis] = slice;

    const dx = direction[0];
    const dy = direction[1];
    const dz = direction[2];

    for (position[v_axis] = 0; position[v_axis] < size; position[v_axis]++) {
      for (position[u_axis] = 0; position[u_axis] < size; position[u_axis]++) {
        const bx = position[0];
        const by = position[1];
        const bz = position[2];

        const currentIndex = bx + by * size + bz * size2;
        const blockCurrent = block_array[currentIndex];
        const blockNeighbor = getBlock(bx + dx, by + dy, bz + dz, blockCurrent);

        // Fast path: both air => no faces.
        if (blockCurrent === 0 && blockNeighbor === 0) {
          mask[maskIndex] = 0;
          maskLight[maskIndex] = 0;
          maskBack[maskIndex] = 0;
          maskBackLight[maskIndex] = 0;
          maskIndex++;
          continue;
        }

        const currentIdRaw = unpackBlockId(blockCurrent);
        const neighborIdRaw = unpackBlockId(blockNeighbor);
        const currentStateRaw = unpackBlockState(blockCurrent);
        const neighborStateRaw = unpackBlockState(blockNeighbor);

        const currentShape = ShapeByBlockId[currentIdRaw];
        const neighborShape = ShapeByBlockId[neighborIdRaw];

        const currentIsCustom = !this.isGreedyCompatibleShape(currentShape);
        const neighborIsCustom = !this.isGreedyCompatibleShape(neighborShape);

        const currentId = currentIsCustom ? 0 : currentIdRaw;
        const neighborId = neighborIsCustom ? 0 : neighborIdRaw;
        const currentState = currentIsCustom ? 0 : currentStateRaw;
        const neighborState = neighborIsCustom ? 0 : neighborStateRaw;

        const curType = BLOCK_TYPE[currentId];
        const nbrType = BLOCK_TYPE[neighborId];

        const isCurrentTransparent = curType !== 0;
        const isNeighborTransparent = nbrType !== 0;
        const isCurrentSolid = currentId !== 0;
        const isNeighborSolid = neighborId !== 0;

        const currentFaceFull = this.isFaceFull(currentState, axis, false);
        const neighborFaceFull = this.isFaceFull(neighborState, axis, true);

        if (
          currentId === neighborId &&
          currentState === neighborState &&
          currentFaceFull &&
          neighborFaceFull
        ) {
          mask[maskIndex] = 0;
          maskLight[maskIndex] = 0;
          maskBack[maskIndex] = 0;
          maskBackLight[maskIndex] = 0;
          maskIndex++;
          continue;
        }

        const neighborOccludesCurrent =
          isNeighborSolid && currentFaceFull && neighborFaceFull;

        const currentOccludesNeighbor =
          isCurrentSolid && currentFaceFull && neighborFaceFull;

        const currentPartial = ((currentState >> 3) & 7) !== 0;
        const neighborPartial = ((neighborState >> 3) & 7) !== 0;

        const emitCurrent =
          isCurrentSolid &&
          (!isNeighborSolid ||
            (isNeighborTransparent && !isCurrentTransparent) ||
            !neighborOccludesCurrent);

        const emitNeighbor =
          isNeighborSolid &&
          (!isCurrentSolid ||
            (isCurrentTransparent && !isNeighborTransparent) ||
            !currentOccludesNeighbor);

        if (emitCurrent) {
          const currentLightPacked = getLight(bx, by, bz, 15 << 4);
          const neighborLightPacked = getLight(
            bx + dx,
            by + dy,
            bz + dz,
            currentLightPacked,
          );

          // Face of current is lit from the open space on the neighbor side.
          // If current is partial and neighbor is not, its own cell may contribute.
          const lightPacked =
            currentPartial && !neighborPartial
              ? Math.max(currentLightPacked, neighborLightPacked)
              : neighborLightPacked;

          const packedAO = this.calculateAOPacked(
            bx + dx,
            by + dy,
            bz + dz,
            u_axis,
            v_axis,
            getBlock,
          );

          const packedIdState = currentIsCustom
            ? 0
            : blockCurrent & BLOCK_PACK_MASK;

          mask[maskIndex] =
            packedIdState | (isCurrentTransparent ? TRANSPARENT_FLAG : 0);

          maskLight[maskIndex] = packedAO | (lightPacked << 8);
        } else {
          mask[maskIndex] = 0;
          maskLight[maskIndex] = 0;
        }

        if (emitNeighbor) {
          const currentLightPacked = getLight(bx, by, bz);
          const neighborLightPacked = getLight(
            bx + dx,
            by + dy,
            bz + dz,
            currentLightPacked,
          );

          // Face of neighbor is lit from the open space on the current side.
          const lightPacked =
            neighborPartial && !currentPartial
              ? Math.max(currentLightPacked, neighborLightPacked)
              : currentLightPacked;

          const packedAO = this.calculateAOPacked(
            bx,
            by,
            bz,
            u_axis,
            v_axis,
            getBlock,
          );

          const packedIdState = neighborIsCustom
            ? 0
            : blockNeighbor & BLOCK_PACK_MASK;

          maskBack[maskIndex] =
            packedIdState |
            (isNeighborTransparent ? TRANSPARENT_FLAG : 0) |
            BACKFACE_FLAG;

          maskBackLight[maskIndex] = packedAO | (lightPacked << 8);
        } else {
          maskBack[maskIndex] = 0;
          maskBackLight[maskIndex] = 0;
        }

        maskIndex++;
      }
    }
  }

  private static meshSlice(
    size: number,
    axis: number,
    axisSlice: number,
    mask: Uint32Array,
    maskLight: Uint16Array,
    opaqueMeshData: WorkerInternalMeshData,
    transparentMeshData: WorkerInternalMeshData,
    faceNamePositive: string,
    faceNameNegative: string,
  ) {
    const axisPos = axisSlice + 1;
    const u_axis = (axis + 1) % 3;
    const v_axis = (axis + 2) % 3;

    let maskIndex = 0;

    for (let v_coord = 0; v_coord < size; v_coord++) {
      for (let u_coord = 0; u_coord < size; ) {
        const currentMaskValue = mask[maskIndex];

        if (currentMaskValue === 0) {
          u_coord++;
          maskIndex++;
          continue;
        }

        const currentMaskLight = maskLight[maskIndex];
        const packedIdStateForGreedy = currentMaskValue & BLOCK_PACK_MASK;
        const stateForGreedy = packedIdStateForGreedy >>> BLOCK_STATE_SHIFT;
        const sliceForGreedy = (stateForGreedy >>> 3) & 7;

        let allowGreedyMerge = sliceForGreedy === 0;
        if (!allowGreedyMerge) {
          const rotationForGreedy = stateForGreedy & 7;
          const sliceAxisForGreedy = this.getSliceAxis(rotationForGreedy);

          // Slice faces are only guaranteed coplanar when the slice axis matches
          // the face normal axis. If slice axis is on u/v, merged quads would
          // stretch the per-block slice transform across neighbors.
          allowGreedyMerge = sliceAxisForGreedy === axis;
        }

        const canMergeWidth =
          allowGreedyMerge && !(sliceForGreedy > 0 && u_axis === 1);

        const canMergeHeight =
          allowGreedyMerge && !(sliceForGreedy > 0 && v_axis === 1);

        // Greedy width
        let width = 1;
        if (canMergeWidth) {
          while (u_coord + width < size) {
            const idx = maskIndex + width;
            if (
              mask[idx] !== currentMaskValue ||
              maskLight[idx] !== currentMaskLight
            ) {
              break;
            }
            width++;
          }
        }

        // Greedy height
        let height = 1;
        if (canMergeHeight) {
          outer: while (v_coord + height < size) {
            const rowStart = maskIndex + height * size;
            for (let w = 0; w < width; w++) {
              const idx = rowStart + w;
              if (
                mask[idx] !== currentMaskValue ||
                maskLight[idx] !== currentMaskLight
              ) {
                break outer;
              }
            }
            height++;
          }
        }

        const isBackFace = (currentMaskValue & BACKFACE_FLAG) !== 0;
        const isTransparent = (currentMaskValue & TRANSPARENT_FLAG) !== 0;
        const packedIdState = currentMaskValue & BLOCK_PACK_MASK;

        const blockId = packedIdState & BLOCK_ID_MASK;
        const state = packedIdState >>> BLOCK_STATE_SHIFT;

        const packedAO = currentMaskLight & 0xff;
        const lightPacked = (currentMaskLight >>> 8) & 0xff;

        const faceName = isBackFace ? faceNameNegative : faceNamePositive;
        const targetMesh = isTransparent ? transparentMeshData : opaqueMeshData;

        const shapeIndex = ShapeByBlockId[blockId];
        const shape = ShapeDefinitions[shapeIndex];

        let boxMin: [number, number, number] = [0, 0, 0];
        let boxMax: [number, number, number] = [1, 1, 1];
        if (shape && shape.boxes.length > 0) {
          const sourceBox = shape.boxes[0];
          const rotationForBox = shape.rotateY ? state & 3 : 0;
          const flipYForBox = !!(shape.allowFlipY && (state & 4) !== 0);
          const transformedBox = this.transformBox(
            sourceBox.min,
            sourceBox.max,
            sourceBox.faceMask ?? FACE_ALL,
            rotationForBox,
            flipYForBox,
          );
          if (shape.usesSliceState) {
            const slicedBox = this.applySliceStateToBox(
              transformedBox.min,
              transformedBox.max,
              state,
            );
            boxMin = slicedBox.min;
            boxMax = slicedBox.max;
          } else {
            boxMin = transformedBox.min;
            boxMax = transformedBox.max;
          }
        }

        const axisOffset = isBackFace ? boxMin[axis] : boxMax[axis] - 1;
        const origin: [number, number, number] = [0, 0, 0];
        origin[axis] = axisPos + axisOffset;
        origin[u_axis] = u_coord + boxMin[u_axis];
        origin[v_axis] = v_coord + boxMin[v_axis];

        const faceWidth = width * (boxMax[u_axis] - boxMin[u_axis]);
        const faceHeight = height * (boxMax[v_axis] - boxMin[v_axis]);

        this.addQuad(
          origin[0],
          origin[1],
          origin[2],
          axis,
          faceWidth,
          faceHeight,
          blockId,
          isBackFace,
          faceName,
          lightPacked,
          packedAO,
          targetMesh,
        );

        // Zero out processed mask region.
        for (let h = 0; h < height; h++) {
          const rowStart = maskIndex + h * size;
          for (let w = 0; w < width; w++) {
            const idx = rowStart + w;
            mask[idx] = 0;
            maskLight[idx] = 0;
          }
        }

        u_coord += width;
        maskIndex += width;
      }
    }
  }

  private static transformBox(
    min: [number, number, number],
    max: [number, number, number],
    faceMask: number,
    rotation: number,
    flipY: boolean,
  ): {
    min: [number, number, number];
    max: [number, number, number];
    faceMask: number;
  } {
    let minX = min[0];
    let minY = min[1];
    let minZ = min[2];
    let maxX = max[0];
    let maxY = max[1];
    let maxZ = max[2];

    switch (rotation & 3) {
      case 1: {
        const oldMinX = minX;
        const oldMaxX = maxX;
        const oldMinZ = minZ;
        const oldMaxZ = maxZ;

        minX = 1 - oldMaxZ;
        maxX = 1 - oldMinZ;
        minZ = oldMinX;
        maxZ = oldMaxX;

        faceMask = ROTATE_Y_FACE_MASK_1[faceMask];
        break;
      }

      case 2: {
        const oldMinX = minX;
        const oldMaxX = maxX;
        const oldMinZ = minZ;
        const oldMaxZ = maxZ;

        minX = 1 - oldMaxX;
        maxX = 1 - oldMinX;
        minZ = 1 - oldMaxZ;
        maxZ = 1 - oldMinZ;

        faceMask = ROTATE_Y_FACE_MASK_2[faceMask];
        break;
      }

      case 3: {
        const oldMinX = minX;
        const oldMaxX = maxX;
        const oldMinZ = minZ;
        const oldMaxZ = maxZ;

        minX = oldMinZ;
        maxX = oldMaxZ;
        minZ = 1 - oldMaxX;
        maxZ = 1 - oldMinX;

        faceMask = ROTATE_Y_FACE_MASK_3[faceMask];
        break;
      }
    }

    if (flipY) {
      const oldMinY = minY;
      const oldMaxY = maxY;

      minY = 1 - oldMaxY;
      maxY = 1 - oldMinY;

      faceMask = FLIP_Y_FACE_MASK[faceMask];
    }

    return {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      faceMask,
    };
  }

  private static applySliceStateToBox(
    min: [number, number, number],
    max: [number, number, number],
    state: number,
  ): {
    min: [number, number, number];
    max: [number, number, number];
  } {
    const slice = (state >>> 3) & 7;
    if (slice === 0) {
      return { min, max };
    }

    const rotation = state & 7;
    const sliceAxis = this.getSliceAxis(rotation);
    const flip = (rotation & 4) !== 0;
    const heightScale = slice / 8;
    const outMin: [number, number, number] = [min[0], min[1], min[2]];
    const outMax: [number, number, number] = [max[0], max[1], max[2]];

    if (flip) {
      outMin[sliceAxis] = 1 - (1 - min[sliceAxis]) * heightScale;
      outMax[sliceAxis] = 1 - (1 - max[sliceAxis]) * heightScale;
    } else {
      outMin[sliceAxis] = min[sliceAxis] * heightScale;
      outMax[sliceAxis] = max[sliceAxis] * heightScale;
    }

    if (outMin[sliceAxis] > outMax[sliceAxis]) {
      const tmp = outMin[sliceAxis];
      outMin[sliceAxis] = outMax[sliceAxis];
      outMax[sliceAxis] = tmp;
    }

    return {
      min: outMin,
      max: outMax,
    };
  }

  private static emitCustomShapes(
    size: number,
    block_array: Uint8Array | Uint16Array,
    getBlock: (x: number, y: number, z: number, fallback?: number) => number,
    getLight: (x: number, y: number, z: number, fallback?: number) => number,
    opaqueMeshData: WorkerInternalMeshData,
    transparentMeshData: WorkerInternalMeshData,
  ) {
    const size2 = size * size;

    // Resolve face names once instead of rebuilding direction arrays repeatedly.
    const faceNamePX = this.getFaceName([1, 0, 0], false);
    const faceNameNX = this.getFaceName([1, 0, 0], true);
    const faceNamePY = this.getFaceName([0, 1, 0], false);
    const faceNameNY = this.getFaceName([0, 1, 0], true);
    const faceNamePZ = this.getFaceName([0, 0, 1], false);
    const faceNameNZ = this.getFaceName([0, 0, 1], true);

    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        for (let x = 0; x < size; x++) {
          const packed = block_array[x + y * size + z * size2];
          const blockId = unpackBlockId(packed);
          if (blockId === 0) continue;

          const shapeIndex = ShapeByBlockId[blockId];
          if (this.isGreedyCompatibleShape(shapeIndex)) continue;

          const shape = ShapeDefinitions[shapeIndex];
          if (!shape) continue;

          const state = unpackBlockState(packed);
          const rotation = shape.rotateY ? state & 3 : 0;
          const flipY = !!(shape.allowFlipY && (state & 4) !== 0);
          const meshData =
            BLOCK_TYPE[blockId] !== 0 ? transparentMeshData : opaqueMeshData;

          const baseLight = getLight(x, y, z);

          const emitFace = (
            axis: number,
            isBackFace: boolean,
            faceName: string,
            ox: number,
            oy: number,
            oz: number,
            width: number,
            height: number,
            nx: number,
            ny: number,
            nz: number,
            onBoundary: boolean,
          ) => {
            if (width <= 0 || height <= 0) return;

            if (
              onBoundary &&
              this.isFullCubeOccluder(getBlock(nx, ny, nz, 0))
            ) {
              return;
            }

            const lightPacked = onBoundary
              ? getLight(nx, ny, nz, baseLight)
              : baseLight;

            const u_axis = (axis + 1) % 3;
            const v_axis = (axis + 2) % 3;

            const packedAO = onBoundary
              ? this.calculateAOPacked(nx, ny, nz, u_axis, v_axis, getBlock)
              : 0;

            this.addQuad(
              ox,
              oy,
              oz,
              axis,
              width,
              height,
              blockId,
              isBackFace,
              faceName,
              lightPacked,
              packedAO,
              meshData,
            );
          };

          for (const box of shape.boxes) {
            const transformed = this.transformBox(
              box.min,
              box.max,
              box.faceMask ?? FACE_ALL,
              rotation,
              flipY,
            );

            const faceMask = transformed.faceMask;
            const slicedBox = shape.usesSliceState
              ? this.applySliceStateToBox(
                  transformed.min,
                  transformed.max,
                  state,
                )
              : { min: transformed.min, max: transformed.max };

            const slicedMin = slicedBox.min;
            const slicedMax = slicedBox.max;

            if (
              slicedMax[0] <= slicedMin[0] ||
              slicedMax[1] <= slicedMin[1] ||
              slicedMax[2] <= slicedMin[2]
            ) {
              continue;
            }

            const x0 = x + slicedMin[0];
            const y0 = y + slicedMin[1];
            const z0 = z + slicedMin[2];
            const x1 = x + slicedMax[0];
            const y1 = y + slicedMax[1];
            const z1 = z + slicedMax[2];

            // +X / -X
            if (faceMask & FACE_PX) {
              emitFace(
                0,
                false,
                faceNamePX,
                x1,
                y0,
                z0,
                y1 - y0,
                z1 - z0,
                x + 1,
                y,
                z,
                slicedMax[0] >= 1,
              );
            }

            if (faceMask & FACE_NX) {
              emitFace(
                0,
                true,
                faceNameNX,
                x0,
                y0,
                z0,
                y1 - y0,
                z1 - z0,
                x - 1,
                y,
                z,
                slicedMin[0] <= 0,
              );
            }

            // +Y / -Y
            if (faceMask & FACE_PY) {
              emitFace(
                1,
                false,
                faceNamePY,
                x0,
                y1,
                z0,
                z1 - z0,
                x1 - x0,
                x,
                y + 1,
                z,
                slicedMax[1] >= 1,
              );
            }

            if (faceMask & FACE_NY) {
              emitFace(
                1,
                true,
                faceNameNY,
                x0,
                y0,
                z0,
                z1 - z0,
                x1 - x0,
                x,
                y - 1,
                z,
                slicedMin[1] <= 0,
              );
            }

            // +Z / -Z
            if (faceMask & FACE_PZ) {
              emitFace(
                2,
                false,
                faceNamePZ,
                x0,
                y0,
                z1,
                x1 - x0,
                y1 - y0,
                x,
                y,
                z + 1,
                slicedMax[2] >= 1,
              );
            }

            if (faceMask & FACE_NZ) {
              emitFace(
                2,
                true,
                faceNameNZ,
                x0,
                y0,
                z0,
                x1 - x0,
                y1 - y0,
                x,
                y,
                z - 1,
                slicedMin[2] <= 0,
              );
            }
          }
        }
      }
    }
  }

  private static getFaceName(dir: number[], isBackFace: boolean): string {
    const [dx, dy, dz] = dir;
    if (dx === 1) return isBackFace ? "east" : "west";
    if (dy === 1) return isBackFace ? "bottom" : "top";
    if (dz === 1) return isBackFace ? "north" : "south";
    throw new Error("Invalid direction");
  }

  public static addQuad(
    x: number,
    y: number,
    z: number,
    axis: number,
    width: number,
    height: number,
    blockId: number,
    isBackFace: boolean,
    faceName: string,
    lightLevel: number,
    packedAO: number,
    meshData: WorkerInternalMeshData,
  ) {
    const tex = BlockTextures[blockId];
    if (!tex) return;

    const ao0 = packedAO & 3;
    const ao1 = (packedAO >> 2) & 3;
    const ao2 = (packedAO >> 4) & 3;
    const ao3 = (packedAO >> 6) & 3;

    // Determine material type: 1 = water (blockId 30), 0 = glass (blockId 60, 61)
    const materialType = blockId === 30 ? 1 : 0;

    const tile = tex[faceName] ?? tex.all!;
    const tx = tile[0],
      ty = tile[1];

    // OPTIMIZATION: look up corner config from pre-built table — eliminates
    // Packed per-face payload consumed by instanced vertex reconstruction.
    const flip = ao0 + ao2 < ao1 + ao3;

    const axisFace = axis * 2 + (isBackFace ? 1 : 0);

    // Packed metadata consumed by the shader
    const meta = (flip ? 1 : 0) | ((materialType & 1) << 1);

    const sx = Math.round(x * POS_SCALE);
    const sy = Math.round(y * POS_SCALE);
    const sz = Math.round(z * POS_SCALE);
    const sw = Math.round(width * POS_SCALE);
    const sh = Math.round(height * POS_SCALE);

    meshData.faceDataA.push4(sx, sy, sz, axisFace);
    meshData.faceDataB.push4(sw, sh, tx, ty);
    meshData.faceDataC.push4(packedAO, lightLevel, 0, meta);
    meshData.faceCount++;
  }

  private static isWaterPacked(packed: number): boolean {
    return unpackBlockId(packed) === WATER_BLOCK_ID;
  }

  private static packMaxLightInCell(
    getLight: (x: number, y: number, z: number, fallback?: number) => number,
    baseX: number,
    baseY: number,
    baseZ: number,
    step: number,
    size: number,
  ): number {
    let maxBlock = 0;
    let maxSky = 0;

    for (let dz = 0; dz < step && baseZ + dz < size; dz++) {
      for (let dy = 0; dy < step && baseY + dy < size; dy++) {
        for (let dx = 0; dx < step && baseX + dx < size; dx++) {
          const packedLight = getLight(baseX + dx, baseY + dy, baseZ + dz, 0);
          const blockLight = packedLight & 0x0f;
          const skyLight = (packedLight >>> 4) & 0x0f;

          if (blockLight > maxBlock) maxBlock = blockLight;
          if (skyLight > maxSky) maxSky = skyLight;
        }
      }
    }

    return (maxSky << 4) | maxBlock;
  }

  /**
   * Sample one coarse LOD cell and decide whether it should emit a water top surface.
   *
   * Current policy:
   * - If the coarse cell contains any visible water surface, emit ONE top quad.
   * - Height is chosen from the highest water voxel in the cell that is exposed upward.
   * - Lighting is the max packed light across the cell.
   *
   * You can later extend this to also emit side walls.
   */
  public static sampleCoarseWaterSurface(
    args: WaterLODArgs,
    coarseX: number,
    coarseY: number,
    coarseZ: number,
  ): WaterSurfaceSample | null {
    const { chunk_size: size, getBlock, getLight, step } = args;

    let highestSurfaceY = -1;
    let foundWaterSurface = false;

    for (let dz = 0; dz < step && coarseZ + dz < size; dz++) {
      for (let dy = 0; dy < step && coarseY + dy < size; dy++) {
        for (let dx = 0; dx < step && coarseX + dx < size; dx++) {
          const x = coarseX + dx;
          const y = coarseY + dy;
          const z = coarseZ + dz;

          const packed = getBlock(x, y, z, 0);
          if (!this.isWaterPacked(packed)) {
            continue;
          }

          const above = getBlock(x, y + 1, z, 0);

          // Emit only if the water voxel is exposed upward to non-water.
          if (!this.isWaterPacked(above)) {
            foundWaterSurface = true;
            if (y > highestSurfaceY) {
              highestSurfaceY = y;
            }
          }
        }
      }
    }

    if (!foundWaterSurface || highestSurfaceY < 0) {
      return null;
    }

    const packedLight = this.packMaxLightInCell(
      getLight,
      coarseX,
      coarseY,
      coarseZ,
      step,
      size,
    );

    return {
      worldX: coarseX,
      // +1 because top quads in your mesher are emitted at the upper face plane
      worldY: highestSurfaceY + 1,
      worldZ: coarseZ,
      width: Math.min(step, size - coarseX),
      depth: Math.min(step, size - coarseZ),
      packedLight,
    };
  }

  /**
   * Generate a transparent-only water LOD mesh.
   *
   * Version 1:
   * - emits top water surfaces only
   * - does NOT emit water side walls yet
   * - uses packedLight from the sampled coarse cell
   * - AO is forced to 0 for now (you can add custom distant-water AO later if desired)
   */
  public static generateLODWaterMesh(
    args: WaterLODArgs,
  ): WorkerInternalMeshData {
    const mesh = this.createEmptyMeshData();
    const { chunk_size: size, step } = args;

    const cellsX = Math.ceil(size / step);
    const cellsZ = Math.ceil(size / step);

    // Process one coarse Y band at a time.
    for (let coarseY = 0; coarseY < size; coarseY += step) {
      const samples: (WaterSurfaceSample | null)[] = new Array(
        cellsX * cellsZ,
      ).fill(null);
      const used = new Uint8Array(cellsX * cellsZ);

      // Build a 2D sample grid for this coarse Y band.
      for (let cellZ = 0; cellZ < cellsZ; cellZ++) {
        const z = cellZ * step;
        if (z >= size) continue;

        for (let cellX = 0; cellX < cellsX; cellX++) {
          const x = cellX * step;
          if (x >= size) continue;

          const sample = this.sampleCoarseWaterSurface(args, x, coarseY, z);
          samples[cellX + cellZ * cellsX] = sample;
        }
      }

      // Greedy merge on the X/Z coarse-cell grid.
      for (let cellZ = 0; cellZ < cellsZ; cellZ++) {
        for (let cellX = 0; cellX < cellsX; cellX++) {
          const startIndex = cellX + cellZ * cellsX;
          if (used[startIndex]) continue;

          const sample = samples[startIndex];
          if (!sample) continue;

          // Merge rule: same water plane height + same packed light + same cell dimensions.
          const baseWorldY = sample.worldY;
          const basePackedLight = sample.packedLight;
          const baseCellWidth = sample.width; // X span of one coarse cell
          const baseCellDepth = sample.depth; // Z span of one coarse cell

          // Greedy width in X direction
          let mergeWidthCells = 1;
          while (cellX + mergeWidthCells < cellsX) {
            const idx = cellX + mergeWidthCells + cellZ * cellsX;
            if (used[idx]) break;

            const s = samples[idx];
            if (
              !s ||
              s.worldY !== baseWorldY ||
              s.packedLight !== basePackedLight ||
              s.width !== baseCellWidth ||
              s.depth !== baseCellDepth
            ) {
              break;
            }

            mergeWidthCells++;
          }

          // Greedy height in Z direction
          let mergeHeightCells = 1;
          outer: while (cellZ + mergeHeightCells < cellsZ) {
            for (let w = 0; w < mergeWidthCells; w++) {
              const idx = cellX + w + (cellZ + mergeHeightCells) * cellsX;
              if (used[idx]) {
                break outer;
              }

              const s = samples[idx];
              if (
                !s ||
                s.worldY !== baseWorldY ||
                s.packedLight !== basePackedLight ||
                s.width !== baseCellWidth ||
                s.depth !== baseCellDepth
              ) {
                break outer;
              }
            }

            mergeHeightCells++;
          }

          // Mark merged rectangle as used
          for (let dz = 0; dz < mergeHeightCells; dz++) {
            for (let dx = 0; dx < mergeWidthCells; dx++) {
              const idx = cellX + dx + (cellZ + dz) * cellsX;
              used[idx] = 1;
            }
          }

          // Convert merged cell counts to actual block-space size.
          const mergedWidthX = mergeWidthCells * baseCellWidth;
          const mergedDepthZ = mergeHeightCells * baseCellDepth;

          // NOTE:
          // For axis = 1 (top face), your addQuad convention uses:
          // width  = Z extent
          // height = X extent
          this.addQuad(
            sample.worldX,
            sample.worldY,
            sample.worldZ,
            1,
            mergedDepthZ, // Z span
            mergedWidthX, // X span
            WATER_BLOCK_ID,
            false,
            "top",
            sample.packedLight,
            0, // packedAO = 0 for distant water
            mesh,
          );
        }
      }
    }

    return mesh;
  }
  public static appendMeshData(
    target: WorkerInternalMeshData,
    source: WorkerInternalMeshData,
  ): void {
    if (source.faceCount === 0) {
      return;
    }

    const srcA = source.faceDataA.finalArray;
    const srcB = source.faceDataB.finalArray;
    const srcC = source.faceDataC.finalArray;

    // faceDataA/B/C are encoded as groups of 4 values per face
    for (let i = 0; i < srcA.length; i += 4) {
      target.faceDataA.push4(srcA[i], srcA[i + 1], srcA[i + 2], srcA[i + 3]);
    }

    for (let i = 0; i < srcB.length; i += 4) {
      target.faceDataB.push4(srcB[i], srcB[i + 1], srcB[i + 2], srcB[i + 3]);
    }

    for (let i = 0; i < srcC.length; i += 4) {
      target.faceDataC.push4(srcC[i], srcC[i + 1], srcC[i + 2], srcC[i + 3]);
    }

    target.faceCount += source.faceCount;
  }
}
// ---------------------------------------------------------------------------
// Block compression
// ---------------------------------------------------------------------------

function compressBlocks(blocks: Uint8Array): {
  isUniform: boolean;
  uniformBlockId: number;
  palette: Uint16Array | null;
  packedBlocks: Uint8Array | Uint16Array | null;
} {
  // OPTIMIZATION: scan with early-exit rather than collecting into a Set.
  // We only need to know: uniform? ≤16 unique? or >16 unique?
  // This avoids allocating a Set object on every terrain generation call.
  const seen = new Uint8Array(65536);
  let uniqueCount = 0;
  const firstId = blocks[0];

  for (let i = 0; i < blocks.length; i++) {
    const id = blocks[i];
    if (!seen[id]) {
      seen[id] = 1;
      uniqueCount++;
      if (uniqueCount > 16) break;
    }
  }

  if (uniqueCount === 1) {
    return {
      isUniform: true,
      uniformBlockId: firstId,
      palette: null,
      packedBlocks: null,
    };
  }

  if (uniqueCount <= 16) {
    // Build palette from the seen[] flags (preserves insertion order isn't needed)
    const palette = new Uint16Array(uniqueCount);
    let pi = 0;
    for (let id = 0; id < 65536 && pi < uniqueCount; id++) {
      if (seen[id]) palette[pi++] = id;
    }

    // Build a reverse lookup: blockId → palette index
    // Re-use seen[] as a scratch buffer (values 0..15 now mean palette index)
    for (let i = 0; i < palette.length; i++) seen[palette[i]] = i;

    const len = (blocks.length + 1) >> 1;
    const buffer =
      typeof SharedArrayBuffer !== "undefined"
        ? new SharedArrayBuffer(len)
        : new ArrayBuffer(len);
    const packedArray = new Uint8Array(buffer);

    for (let i = 0; i < blocks.length; i++) {
      const nibble = seen[blocks[i]];
      const byteIndex = i >> 1;
      if (i & 1) {
        packedArray[byteIndex] =
          (packedArray[byteIndex] & 0x0f) | ((nibble & 0xf) << 4);
      } else {
        packedArray[byteIndex] =
          (packedArray[byteIndex] & 0xf0) | (nibble & 0xf);
      }
    }

    return {
      isUniform: false,
      uniformBlockId: 0,
      palette,
      packedBlocks: packedArray,
    };
  }

  // >16 unique blocks — store raw
  return {
    isUniform: false,
    uniformBlockId: 0,
    palette: null,
    packedBlocks: blocks,
  };
}

// ---------------------------------------------------------------------------
// Worker message handler
// ---------------------------------------------------------------------------

const generator = new WorldGenerator(GenerationParams);

// In chunk_worker.ts, refactor the full-remesh handler:
const onMessageHandler = (event: MessageEvent<WorkerRequestData>) => {
  const { type } = event.data;

  // --- Full Remesh ---
  if (type === WorkerTaskType.GenerateFullMesh) {
    const request = event.data;
    const { chunk_size, chunkId } = request;
    const totalBlocks = chunk_size ** 3;
    const lod = request.lod ?? 0;

    let needsUint16 = paletteExpander.isUint16(request.palette);
    if (!needsUint16 && typeof request.uniformBlockId === "number") {
      needsUint16 = request.uniformBlockId > 255;
    }
    if (!needsUint16 && request.neighborUniformIds) {
      for (let i = 0; i < request.neighborUniformIds.length; i++) {
        const v = request.neighborUniformIds[i];
        if (v !== undefined && v > 255) {
          needsUint16 = true;
          break;
        }
      }
    }

    // -----------------------------
    // Expand center chunk data
    // -----------------------------
    if (!request.block_array && typeof request.uniformBlockId === "number") {
      const uniformValue = request.uniformBlockId;
      request.block_array = needsUint16
        ? new Uint16Array(totalBlocks)
        : new Uint8Array(totalBlocks);
      request.block_array.fill(uniformValue);
    } else if (request.palette && request.block_array instanceof Uint8Array) {
      request.block_array = paletteExpander.expandPalette(
        request.block_array,
        request.palette,
        totalBlocks,
      );
    }

    // -----------------------------
    // Expand neighbor chunk data
    // -----------------------------
    const { neighbors, neighborUniformIds, neighborPalettes } = request;

    if (neighborUniformIds) {
      for (let i = 0; i < neighbors.length; i++) {
        const neighbor = neighbors[i];
        const uniformId = neighborUniformIds[i];
        const palette = neighborPalettes?.[i];

        if (
          (neighbor === undefined || neighbor === null) &&
          typeof uniformId === "number"
        ) {
          const expandedNeighbor = needsUint16
            ? new Uint16Array(totalBlocks)
            : new Uint8Array(totalBlocks);

          expandedNeighbor.fill(uniformId);
          neighbors[i] = expandedNeighbor;
          continue;
        }

        if (neighbor instanceof Uint8Array && palette) {
          neighbors[i] = paletteExpander.expandPalette(
            neighbor,
            palette,
            totalBlocks,
          );
        }
      }
    }

    const clearLargeReferences = () => {
      request.block_array = undefined;
      request.palette = undefined;

      for (let i = 0; i < request.neighbors.length; i++) {
        request.neighbors[i] = undefined;
      }

      if (request.neighborLights) {
        for (let i = 0; i < request.neighborLights.length; i++) {
          request.neighborLights[i] = undefined;
        }
      }

      if (request.neighborPalettes) {
        for (let i = 0; i < request.neighborPalettes.length; i++) {
          request.neighborPalettes[i] = undefined;
        }
      }
    };

    // -----------------------------
    // Validate expanded center array
    // -----------------------------
    const expandedCenterBlockArray = request.block_array;
    if (
      !(expandedCenterBlockArray instanceof Uint8Array) &&
      !(expandedCenterBlockArray instanceof Uint16Array)
    ) {
      throw new Error(
        "GenerateFullMesh: block_array was not expanded before meshing.",
      );
    }

    // -----------------------------
    // Shared block/light sampling helpers
    // Used by the water LOD pass so chunk borders work correctly.
    // -----------------------------
    const size = chunk_size;
    const size2 = size * size;
    const fullBright = 15 << 4;

    const toCompactNeighborIndex = (fullIndex: number): number =>
      fullIndex > 13 ? fullIndex - 1 : fullIndex;

    const getBlock = (
      x: number,
      y: number,
      z: number,
      fallback = 0,
    ): number => {
      if (x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size) {
        return expandedCenterBlockArray[x + y * size + z * size2];
      }

      const dx = x < 0 ? -1 : x >= size ? 1 : 0;
      const dy = y < 0 ? -1 : y >= size ? 1 : 0;
      const dz = z < 0 ? -1 : z >= size ? 1 : 0;

      const neighborIndex = toCompactNeighborIndex(
        dx + 1 + (dy + 1) * 3 + (dz + 1) * 9,
      );

      const neighbor = request.neighbors[neighborIndex];
      if (
        !(neighbor instanceof Uint8Array) &&
        !(neighbor instanceof Uint16Array)
      ) {
        return fallback;
      }

      const nx = x - dx * size;
      const ny = y - dy * size;
      const nz = z - dz * size;

      return neighbor[nx + ny * size + nz * size2];
    };

    const getLight = (
      x: number,
      y: number,
      z: number,
      fallback = fullBright,
    ): number => {
      const centerLight = request.light_array;

      if (!(centerLight instanceof Uint8Array)) {
        return fullBright;
      }

      if (x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size) {
        return centerLight[x + y * size + z * size2];
      }

      const dx = x < 0 ? -1 : x >= size ? 1 : 0;
      const dy = y < 0 ? -1 : y >= size ? 1 : 0;
      const dz = z < 0 ? -1 : z >= size ? 1 : 0;

      const neighborIndex = toCompactNeighborIndex(
        dx + 1 + (dy + 1) * 3 + (dz + 1) * 9,
      );

      const neighborLight = request.neighborLights?.[neighborIndex];
      if (!(neighborLight instanceof Uint8Array)) {
        return fallback;
      }

      const nx = x - dx * size;
      const ny = y - dy * size;
      const nz = z - dz * size;

      return neighborLight[nx + ny * size + nz * size2];
    };

    // -----------------------------
    // LOD1 simplification path
    // -----------------------------
    if (lod >= 1) {
      const step = 2;

      const createBlockArray = (): Uint8Array | Uint16Array =>
        needsUint16
          ? new Uint16Array(totalBlocks)
          : new Uint8Array(totalBlocks);

      const simplifyBlockArray = (
        source: Uint8Array | Uint16Array,
      ): Uint8Array | Uint16Array => {
        const simplified = createBlockArray();

        // Local getBlock for this source array only
        const localGetBlock = (
          x: number,
          y: number,
          z: number,
          fallback = 0,
        ): number => {
          if (x < 0 || x >= size || y < 0 || y >= size || z < 0 || z >= size) {
            return fallback;
          }
          return source[x + y * size + z * size2];
        };

        for (let z = 0; z < size; z += step) {
          for (let y = 0; y < size; y += step) {
            for (let x = 0; x < size; x += step) {
              // If this coarse cell contains a visible water surface,
              // reserve the cell for the separate transparent water LOD mesh.
              const waterSurface = ChunkWorkerMesher.sampleCoarseWaterSurface(
                {
                  chunk_size: size,
                  getBlock: localGetBlock,
                  getLight: () => 0,
                  step,
                },
                x,
                y,
                z,
              );

              let chosen = 0;

              if (!waterSurface) {
                // No visible water here -> choose opaque terrain as before
                outer: for (let dz = 0; dz < step && z + dz < size; dz++) {
                  for (let dy = 0; dy < step && y + dy < size; dy++) {
                    for (let dx = 0; dx < step && x + dx < size; dx++) {
                      const idx = x + dx + (y + dy) * size + (z + dz) * size2;

                      const packed = source[idx];
                      const blockId = unpackBlockId(packed);

                      if (blockId === 0) continue;
                      if (BLOCK_TYPE[blockId] !== 0) continue; // skip transparent

                      chosen = packed;
                      break outer;
                    }
                  }
                }
              }

              // Fill the whole coarse cell
              for (let dz = 0; dz < step && z + dz < size; dz++) {
                for (let dy = 0; dy < step && y + dy < size; dy++) {
                  for (let dx = 0; dx < step && x + dx < size; dx++) {
                    const idx = x + dx + (y + dy) * size + (z + dz) * size2;
                    simplified[idx] = chosen;
                  }
                }
              }
            }
          }
        }

        return simplified;
      };

      const simplifyLightArray = (source: Uint8Array): Uint8Array => {
        const simplified = new Uint8Array(totalBlocks);

        for (let z = 0; z < size; z += step) {
          for (let y = 0; y < size; y += step) {
            for (let x = 0; x < size; x += step) {
              let maxSky = 0;
              let maxBlock = 0;

              for (let dz = 0; dz < step && z + dz < size; dz++) {
                for (let dy = 0; dy < step && y + dy < size; dy++) {
                  for (let dx = 0; dx < step && x + dx < size; dx++) {
                    const idx = x + dx + (y + dy) * size + (z + dz) * size2;

                    const packedLight = source[idx];
                    const blockLight = packedLight & 0x0f;
                    const skyLight = (packedLight >>> 4) & 0x0f;

                    if (blockLight > maxBlock) maxBlock = blockLight;
                    if (skyLight > maxSky) maxSky = skyLight;
                  }
                }
              }

              const packedOut = maxBlock | (maxSky << 4);

              for (let dz = 0; dz < step && z + dz < size; dz++) {
                for (let dy = 0; dy < step && y + dy < size; dy++) {
                  for (let dx = 0; dx < step && x + dx < size; dx++) {
                    const idx = x + dx + (y + dy) * size + (z + dz) * size2;
                    simplified[idx] = packedOut;
                  }
                }
              }
            }
          }
        }

        return simplified;
      };

      const simplifiedCenter = simplifyBlockArray(expandedCenterBlockArray);

      const simplifiedNeighbors: (Uint8Array | Uint16Array | undefined)[] =
        request.neighbors.map((neighbor) =>
          neighbor instanceof Uint8Array || neighbor instanceof Uint16Array
            ? simplifyBlockArray(neighbor)
            : undefined,
        );

      const simplifiedCenterLight =
        request.light_array instanceof Uint8Array
          ? simplifyLightArray(request.light_array)
          : undefined;

      const simplifiedNeighborLights: (Uint8Array | undefined)[] | undefined =
        request.neighborLights
          ? request.neighborLights.map((light) =>
              light instanceof Uint8Array
                ? simplifyLightArray(light)
                : undefined,
            )
          : undefined;

      // Solid terrain LOD mesh
      const solidResult = ChunkWorkerMesher.generateMesh({
        block_array: simplifiedCenter,
        chunk_size: size,
        light_array: simplifiedCenterLight,
        neighbors: simplifiedNeighbors,
        neighborLights: simplifiedNeighborLights,
      });

      // Separate transparent water LOD mesh generated from the ORIGINAL
      // expanded block/light field, not the simplified solid field.
      const waterResult = ChunkWorkerMesher.generateLODWaterMesh({
        chunk_size: size,
        getBlock,
        getLight,
        step,
      });
      ChunkWorkerMesher.appendMeshData(solidResult.transparent, waterResult);

      console.log(
        "[LOD water merge]",
        "water=",
        waterResult.faceCount,
        "transparentAfter=",
        solidResult.transparent.faceCount,
      );

      clearLargeReferences();
      postFullMeshResult(chunkId, solidResult.opaque, solidResult.transparent);
      return;
    }

    // -----------------------------
    // Full-quality LOD0 path
    // -----------------------------
    const fullNeighbors: (Uint8Array | Uint16Array | undefined)[] =
      request.neighbors.map((neighbor) =>
        neighbor instanceof Uint8Array || neighbor instanceof Uint16Array
          ? neighbor
          : undefined,
      );

    const { opaque, transparent } = ChunkWorkerMesher.generateMesh({
      block_array: expandedCenterBlockArray,
      chunk_size: request.chunk_size,
      light_array: request.light_array,
      neighbors: fullNeighbors,
      neighborLights: request.neighborLights,
    });

    clearLargeReferences();
    postFullMeshResult(chunkId, opaque, transparent);
    return;
  }

  // --- Terrain generation ---
  if (type === WorkerTaskType.GenerateTerrain) {
    const { chunkId, chunkX, chunkY, chunkZ } = event.data;
    const { blocks, light } = generator.generateChunkData(
      chunkX,
      chunkY,
      chunkZ,
    );
    const { isUniform, uniformBlockId, palette, packedBlocks } =
      compressBlocks(blocks);

    const transferables: Transferable[] = [];
    if (
      packedBlocks &&
      !(
        packedBlocks.buffer instanceof
        (typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : Object)
      )
    ) {
      transferables.push(packedBlocks.buffer);
    }
    if (
      !(
        light.buffer instanceof
        (typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : Object)
      )
    ) {
      transferables.push(light.buffer);
    }

    self.postMessage(
      {
        chunkId,
        type: WorkerTaskType.GenerateTerrain,
        block_array: packedBlocks,
        light_array: light,
        isUniform,
        uniformBlockId,
        palette,
      },
      transferables,
    );
    return;
  }

  // --- Distant terrain ---
  if (type === WorkerTaskType.GenerateDistantTerrain) {
    const {
      centerChunkX,
      centerChunkZ,
      radius,
      renderDistance,
      gridStep,
      oldData,
      oldCenterChunkX,
      oldCenterChunkZ,
    } = event.data;
    const data = DistantTerrainGenerator.generate(
      centerChunkX,
      centerChunkZ,
      radius,
      renderDistance,
      gridStep,
      oldData,
      oldCenterChunkX,
      oldCenterChunkZ,
    );
    self.postMessage(
      {
        type: WorkerTaskType.GenerateDistantTerrain_Generated,
        centerChunkX,
        centerChunkZ,
        ...data,
      },
      [data.positions.buffer, data.normals.buffer, data.surfaceTiles.buffer],
    );
    return;
  }
};

self.onmessage = onMessageHandler;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTransferable(data: WorkerInternalMeshData): MeshData {
  return {
    faceDataA: data.faceDataA.finalArray,
    faceDataB: data.faceDataB.finalArray,
    faceDataC: data.faceDataC.finalArray,
    faceCount: data.faceCount,
  };
}

function postFullMeshResult(
  chunkId: bigint,
  opaque: WorkerInternalMeshData,
  transparent: WorkerInternalMeshData,
) {
  const opaqueMeshData = toTransferable(opaque);
  const transparentMeshData = toTransferable(transparent);

  self.postMessage(
    {
      chunkId,
      type: WorkerTaskType.GenerateFullMesh,
      opaque: opaqueMeshData,
      transparent: transparentMeshData,
    },
    [
      opaqueMeshData.faceDataA.buffer,
      opaqueMeshData.faceDataB.buffer,
      opaqueMeshData.faceDataC.buffer,
      transparentMeshData.faceDataA.buffer,
      transparentMeshData.faceDataB.buffer,
      transparentMeshData.faceDataC.buffer,
    ],
  );
}
