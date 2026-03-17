/// <reference lib="webworker" />

import { WorldGenerator } from "../Generation/WorldGenerator";
import { MeshData } from "./DataStructures/MeshData";
import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";
import { ResizableTypedArray } from "./DataStructures/ResizableTypedArray";
import { WorkerInternalMeshData } from "./DataStructures/WorkerInternalMeshData";
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

const BLOCK_PACK_MASK = BLOCK_ID_MASK | (BLOCK_STATE_MASK << BLOCK_STATE_SHIFT);
const TRANSPARENT_FLAG = 1 << 16;
const BACKFACE_FLAG = 1 << 17;
const POS_SCALE = 4;

const paletteExpander = new PaletteExpander();

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
    const isOccluding = (value: number): boolean => {
      const id = unpackBlockId(value);
      if (id === 0) return false;
      if (ShapeByBlockId[id] !== CUBE_SHAPE_INDEX) return false;
      const state = unpackBlockState(value);
      return ((state >> 3) & 7) === 0;
    };

    // Offsets along u-axis (±1) and v-axis (±1) in world-space X/Y/Z
    const ux = u === 0 ? 1 : 0;
    const uy = u === 1 ? 1 : 0;
    const uz = u === 2 ? 1 : 0;
    const vx = v === 0 ? 1 : 0;
    const vy = v === 1 ? 1 : 0;
    const vz = v === 2 ? 1 : 0;

    // 4 corners: du/dv ∈ {0,1}×{0,1} mapped to UV-quad corners (0,0)(1,0)(1,1)(0,1)
    let packed = 0;
    for (let i = 0; i < 4; i++) {
      // du=1 for corners 1 & 2,  dv=1 for corners 2 & 3
      const du = i === 1 || i === 2 ? 1 : -1;
      const dv = i === 2 || i === 3 ? 1 : -1;

      const side1 = isOccluding(
        getBlock(ax + vx * dv, ay + vy * dv, az + vz * dv),
      );
      const side2 = isOccluding(
        getBlock(ax + ux * du, ay + uy * du, az + uz * du),
      );
      const corner = isOccluding(
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

  private static getSliceAxis(rotation: number): number {
    const sliceAxisRaw = rotation & 3;
    return sliceAxisRaw === 1 ? 0 : sliceAxisRaw === 2 ? 2 : 1;
  }

  private static isFaceFull(
    state: number,
    axis: number,
    isBackFace: boolean,
  ): boolean {
    const slice = (state >> 3) & 7;
    if (slice === 0) return true;

    const rotation = state & 7;
    const sliceAxis = this.getSliceAxis(rotation);
    if (sliceAxis !== axis) return false;

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

    // ---------------------------------------------------------------------------
    // getBlock / getLight — inlined hot path for in-bounds coords,
    // neighbor lookup only for out-of-bounds.
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
      if (!light_array) return 15 << 4;
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
    const mask = new Uint32Array(size * size); // reused across all slices
    const maskLight = new Uint16Array(size * size); // packed AO + light
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

    this.emitCustomShapes(
      size,
      block_array,
      getBlock,
      getLight,
      opaqueMeshData,
      transparentMeshData,
    );

    return {
      opaque: opaqueMeshData,
      transparent: transparentMeshData,
    };
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

    const dx = direction[0],
      dy = direction[1],
      dz = direction[2];

    for (position[v_axis] = 0; position[v_axis] < size; position[v_axis]++) {
      for (position[u_axis] = 0; position[u_axis] < size; position[u_axis]++) {
        const bx = position[0];
        const by = position[1];
        const bz = position[2];

        const blockCurrent = block_array[bx + by * size + bz * size2];
        const blockNeighbor = getBlock(bx + dx, by + dy, bz + dz, blockCurrent);

        const currentIdRaw = unpackBlockId(blockCurrent);
        const neighborIdRaw = unpackBlockId(blockNeighbor);
        const currentStateRaw = unpackBlockState(blockCurrent);
        const neighborStateRaw = unpackBlockState(blockNeighbor);
        const currentShape = ShapeByBlockId[currentIdRaw];
        const neighborShape = ShapeByBlockId[neighborIdRaw];
        const currentIsCustom = currentShape !== CUBE_SHAPE_INDEX;
        const neighborIsCustom = neighborShape !== CUBE_SHAPE_INDEX;
        const currentId = currentIsCustom ? 0 : currentIdRaw;
        const neighborId = neighborIsCustom ? 0 : neighborIdRaw;
        const currentState = currentIsCustom ? 0 : currentStateRaw;
        const neighborState = neighborIsCustom ? 0 : neighborStateRaw;

        if (currentId === neighborId && currentState === neighborState) {
          mask[maskIndex] = 0;
          maskLight[maskIndex] = 0;
          maskBack[maskIndex] = 0;
          maskBackLight[maskIndex] = 0;
          maskIndex++;
          continue;
        }

        const curType = BLOCK_TYPE[currentId];
        const nbrType = BLOCK_TYPE[neighborId];
        const isCurrentTransparent = curType !== 0;
        const isNeighborTransparent = nbrType !== 0;
        const isCurrentSolid = currentId !== 0;
        const isNeighborSolid = neighborId !== 0;
        const currentFaceFull = this.isFaceFull(currentState, axis, false);
        const neighborFaceFull = this.isFaceFull(neighborState, axis, true);
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
          // The face of `current` is lit by the open air on the neighbor side.
          // If `current` is partial (set back from the boundary), its face is
          // also partially exposed to its own cell, so take the brighter of the
          // two. The condition was previously inverted (neighborPartial instead
          // of currentPartial), which caused wrong dark faces.
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
          const packedIdState = currentId | (currentState << BLOCK_STATE_SHIFT);
          mask[maskIndex] =
            (packedIdState & BLOCK_PACK_MASK) |
            (isCurrentTransparent ? TRANSPARENT_FLAG : 0);
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
          // The face of `neighbor` is lit by the open air on the current side.
          // If `neighbor` is partial (set back from the boundary), its face is
          // also partially exposed to its own cell, so take the brighter of the
          // two. The condition was previously inverted (currentPartial instead
          // of neighborPartial), which caused wrong dark faces.
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
          const packedIdState =
            neighborId | (neighborState << BLOCK_STATE_SHIFT);
          maskBack[maskIndex] =
            (packedIdState & BLOCK_PACK_MASK) |
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
    let maskIndex = 0;

    for (let v_coord = 0; v_coord < size; v_coord++) {
      for (let u_coord = 0; u_coord < size; ) {
        const currentMaskValue = mask[maskIndex];
        const currentMaskLight = maskLight[maskIndex];
        if (currentMaskValue !== 0) {
          // Greedy width
          let width = 1;
          while (
            u_coord + width < size &&
            mask[maskIndex + width] === currentMaskValue &&
            maskLight[maskIndex + width] === currentMaskLight
          ) {
            width++;
          }

          // Greedy height
          let height = 1;
          outer: while (v_coord + height < size) {
            for (let w = 0; w < width; w++) {
              const idx = maskIndex + w + height * size;
              if (
                mask[idx] !== currentMaskValue ||
                maskLight[idx] !== currentMaskLight
              )
                break outer;
            }
            height++;
          }

          const isBackFace = (currentMaskValue & BACKFACE_FLAG) !== 0;
          const isTransparent = (currentMaskValue & TRANSPARENT_FLAG) !== 0;
          const packedIdState = currentMaskValue & BLOCK_PACK_MASK;
          const blockId = packedIdState & BLOCK_ID_MASK;
          const state = packedIdState >> BLOCK_STATE_SHIFT;
          const faceName = isBackFace ? faceNameNegative : faceNamePositive;
          const packedAO = currentMaskLight & 0xff;
          const lightPacked = (currentMaskLight >> 8) & 0xff;
          const rotation = state & 7;
          const stateSlice = (state >> 3) & 7;

          // Resolve vertex origin based on axis
          let x: number, y: number, z: number;

          if (axis === 0) {
            x = axisPos;
            y = u_coord;
            z = v_coord;
          } else if (axis === 1) {
            x = v_coord;
            y = axisPos;
            z = u_coord;
          } else {
            x = u_coord;
            y = v_coord;
            z = axisPos;
          }

          // OPTIMIZATION: replace Set.has() with flat array lookup
          let targetMesh: WorkerInternalMeshData;
          if (isTransparent) {
            targetMesh = transparentMeshData;
          } else {
            targetMesh = opaqueMeshData;
          }

          this.addQuad(
            x,
            y,
            z,
            axis,
            width,
            height,
            blockId,
            isBackFace,
            faceName,
            lightPacked,
            packedAO,
            targetMesh,
            rotation,
            stateSlice,
          );

          // Zero out the processed mask region
          for (let h = 0; h < height; h++) {
            for (let w = 0; w < width; w++) {
              const idx = maskIndex + w + h * size;
              mask[idx] = 0;
              maskLight[idx] = 0;
            }
          }

          u_coord += width;
          maskIndex += width;
        } else {
          u_coord++;
          maskIndex++;
        }
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

    if (rotation !== 0) {
      const points: [number, number][] = [
        [minX, minZ],
        [minX, maxZ],
        [maxX, minZ],
        [maxX, maxZ],
      ];
      const rotated: [number, number][] = points.map(([x, z]) => {
        switch (rotation) {
          case 1:
            return [1 - z, x];
          case 2:
            return [1 - x, 1 - z];
          case 3:
            return [z, 1 - x];
          default:
            return [x, z];
        }
      });
      minX = Math.min(...rotated.map((p) => p[0]));
      maxX = Math.max(...rotated.map((p) => p[0]));
      minZ = Math.min(...rotated.map((p) => p[1]));
      maxZ = Math.max(...rotated.map((p) => p[1]));

      // Rotate the XZ face-mask bits: +X/-X swap with +Z/-Z per 90° turn.
      // Each CW rotation maps: +X→+Z, +Z→-X, -X→-Z, -Z→+X (Y faces unchanged).
      let mask = faceMask;
      for (let r = 0; r < rotation; r++) {
        const px = (mask >> 0) & 1; // +X
        const nx = (mask >> 1) & 1; // -X
        const pz = (mask >> 4) & 1; // +Z
        const nz = (mask >> 5) & 1; // -Z
        // +X → +Z, +Z → -X, -X → -Z, -Z → +X
        mask =
          (mask & (FACE_PY | FACE_NY)) | // Y faces unchanged
          (nz << 0) | // new +X = old -Z
          (pz << 1) | // new -X = old +Z
          (px << 4) | // new +Z = old +X
          (nx << 5); // new -Z = old -X
      }
      faceMask = mask;
    }

    if (flipY) {
      const newMinY = 1 - maxY;
      const newMaxY = 1 - minY;
      minY = newMinY;
      maxY = newMaxY;

      // Swap +Y and -Y face-mask bits
      const py = (faceMask >> 2) & 1;
      const ny = (faceMask >> 3) & 1;
      faceMask = (faceMask & ~(FACE_PY | FACE_NY)) | (ny << 2) | (py << 3);
    }

    return {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      faceMask,
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
    const isFullCube = (value: number): boolean => {
      const id = unpackBlockId(value);
      if (id === 0) return false;
      if (ShapeByBlockId[id] !== CUBE_SHAPE_INDEX) return false;
      const state = unpackBlockState(value);
      return ((state >> 3) & 7) === 0;
    };

    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        for (let x = 0; x < size; x++) {
          const packed = block_array[x + y * size + z * size2];
          const blockId = unpackBlockId(packed);
          if (blockId === 0) continue;
          const shapeIndex = ShapeByBlockId[blockId];
          if (shapeIndex === CUBE_SHAPE_INDEX) continue;

          const shape = ShapeDefinitions[shapeIndex];
          if (!shape) continue;
          const state = unpackBlockState(packed);
          const rotation = shape.rotateY ? state & 3 : 0;
          const flipY = shape.allowFlipY && (state & 4) !== 0;
          const isTransparent = BLOCK_TYPE[blockId] !== 0;
          const meshData = isTransparent ? transparentMeshData : opaqueMeshData;

          for (const box of shape.boxes) {
            const { min, max, faceMask } = this.transformBox(
              box.min,
              box.max,
              box.faceMask ?? FACE_ALL,
              rotation,
              flipY,
            );

            const x0 = x + min[0];
            const y0 = y + min[1];
            const z0 = z + min[2];
            const x1 = x + max[0];
            const y1 = y + max[1];
            const z1 = z + max[2];

            const emitFace = (
              axis: number,
              isBackFace: boolean,
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
              if (onBoundary && isFullCube(getBlock(nx, ny, nz, 0))) return;

              const direction: number[] = [
                axis === 0 ? 1 : 0,
                axis === 1 ? 1 : 0,
                axis === 2 ? 1 : 0,
              ];
              const faceName = this.getFaceName(direction, isBackFace);
              const lightPacked = onBoundary
                ? getLight(nx, ny, nz, getLight(x, y, z))
                : getLight(x, y, z);
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
                0,
                0,
              );
            };

            // +X / -X
            if (faceMask & FACE_PX)
              emitFace(
                0,
                false,
                x1,
                y0,
                z0,
                y1 - y0,
                z1 - z0,
                x + 1,
                y,
                z,
                max[0] >= 1,
              );
            if (faceMask & FACE_NX)
              emitFace(
                0,
                true,
                x0,
                y0,
                z0,
                y1 - y0,
                z1 - z0,
                x - 1,
                y,
                z,
                min[0] <= 0,
              );

            // +Y / -Y
            if (faceMask & FACE_PY)
              emitFace(
                1,
                false,
                x0,
                y1,
                z0,
                z1 - z0,
                x1 - x0,
                x,
                y + 1,
                z,
                max[1] >= 1,
              );
            if (faceMask & FACE_NY)
              emitFace(
                1,
                true,
                x0,
                y0,
                z0,
                z1 - z0,
                x1 - x0,
                x,
                y - 1,
                z,
                min[1] <= 0,
              );

            // +Z / -Z
            if (faceMask & FACE_PZ)
              emitFace(
                2,
                false,
                x0,
                y0,
                z1,
                x1 - x0,
                y1 - y0,
                x,
                y,
                z + 1,
                max[2] >= 1,
              );
            if (faceMask & FACE_NZ)
              emitFace(
                2,
                true,
                x0,
                y0,
                z0,
                x1 - x0,
                y1 - y0,
                x,
                y,
                z - 1,
                min[2] <= 0,
              );
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
    rotation = 0,
    slice = 0,
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
    const meta =
      (flip ? 1 : 0) |
      ((materialType & 1) << 1) |
      ((rotation & 7) << 2) |
      ((slice & 7) << 5);

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

const onMessageHandler = (event: MessageEvent) => {
  const { type } = event.data;

  // --- Full Remesh ---
  if (type === "full-remesh") {
    const { chunk_size } = event.data;
    const totalBlocks = chunk_size ** 3;

    // ✅ Determine output type once using isUint16
    let needsUint16 = paletteExpander.isUint16(event.data.palette);

    // Also check uniform block IDs if no palette
    if (!needsUint16 && typeof event.data.uniformBlockId === "number") {
      needsUint16 = event.data.uniformBlockId > 255;
    }

    // Check neighbor uniform IDs
    if (!needsUint16 && event.data.neighborUniformIds) {
      for (let i = 0; i < event.data.neighborUniformIds.length; i++) {
        if (
          event.data.neighborUniformIds[i] !== undefined &&
          event.data.neighborUniformIds[i] > 255
        ) {
          needsUint16 = true;
          break;
        }
      }
    }

    // Rehydrate center chunk block array
    if (
      !event.data.block_array &&
      typeof event.data.uniformBlockId === "number"
    ) {
      const uniformValue = event.data.uniformBlockId;
      event.data.block_array = needsUint16
        ? new Uint16Array(totalBlocks)
        : new Uint8Array(totalBlocks);

      // ✅ Manual loop instead of .fill()
      for (let i = 0; i < totalBlocks; i++) {
        event.data.block_array[i] = uniformValue;
      }
    } else if (event.data.palette && event.data.block_array) {
      event.data.block_array = paletteExpander.expandPalette(
        event.data.block_array,
        event.data.palette,
        totalBlocks,
      );
    }

    // Rehydrate neighbors
    const { neighbors, neighborUniformIds, neighborPalettes } = event.data;
    if (neighborUniformIds) {
      for (let i = 0; i < neighbors.length; i++) {
        if (!neighbors[i] && typeof neighborUniformIds[i] === "number") {
          const uniformValue = neighborUniformIds[i]!;
          neighbors[i] = needsUint16
            ? new Uint16Array(totalBlocks)
            : new Uint8Array(totalBlocks);

          // ✅ Use cached needsUint16 type
          for (let j = 0; j < totalBlocks; j++) {
            neighbors[i]![j] = uniformValue;
          }
        } else if (neighbors[i] && neighborPalettes?.[i]) {
          neighbors[i] = paletteExpander.expandPalette(
            neighbors[i]! as Uint8Array,
            neighborPalettes[i]!,
            totalBlocks,
          );
        }
      }
    }

    const { opaque, transparent } = ChunkWorkerMesher.generateMesh(event.data);
    // Allow GC of large block arrays
    event.data.block_array = undefined;
    event.data.neighbors = undefined;

    postFullMeshResult(event.data.chunkId, opaque, transparent);
    return;
  }

  // --- Terrain generation ---
  if (type === "generate-terrain") {
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
        type: "terrain-generated",
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
  if (type === "generate-distant-terrain") {
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
        type: "distant-terrain-generated",
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
  chunkId: string,
  opaque: WorkerInternalMeshData,
  transparent: WorkerInternalMeshData,
) {
  const opaqueMeshData = toTransferable(opaque);
  const transparentMeshData = toTransferable(transparent);

  self.postMessage(
    {
      chunkId,
      type: "full-mesh",
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
