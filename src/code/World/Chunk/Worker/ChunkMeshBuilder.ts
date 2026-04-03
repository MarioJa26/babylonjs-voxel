import {
  BLOCK_ID_MASK,
  BLOCK_STATE_SHIFT,
  unpackBlockId,
  unpackBlockState,
} from "../../BlockEncoding";
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
} from "../../Shape/BlockShapes";
import {
  getSliceAxis,
  transformBox as transformShapeBox,
} from "../../Shape/BlockShapeTransforms";
import { BlockTextures } from "../../Texture/BlockTextures";
import { ResizableTypedArray } from "../DataStructures/ResizableTypedArray";
import { WorkerInternalMeshData } from "../DataStructures/WorkerInternalMeshData";
import {
  BLOCK_PACK_MASK,
  BLOCK_TYPE,
  TRANSPARENT_FLAG,
  BACKFACE_FLAG,
  POS_SCALE,
  ROTATE_Y_FACE_MASK_1,
  ROTATE_Y_FACE_MASK_2,
  ROTATE_Y_FACE_MASK_3,
  FLIP_Y_FACE_MASK,
} from "./ChunkMesherConstants";
import {
  ChunkSamplingContext,
  SamplingBlockArray,
} from "./ChunkSamplingContext";

export type GenerateMeshInput = {
  block_array: SamplingBlockArray;
  chunk_size: number;
  light_array?: Uint8Array;
  neighbors: (SamplingBlockArray | undefined)[];
  neighborLights?: (Uint8Array | undefined)[];
  lod: number;
};

export class ChunkMeshBuilder {
  public static createEmptyMeshData(): WorkerInternalMeshData {
    return {
      faceDataA: new ResizableTypedArray(Uint8Array),
      faceDataB: new ResizableTypedArray(Uint8Array),
      faceDataC: new ResizableTypedArray(Uint8Array),
      faceCount: 0,
    };
  }

  private static calculateAOPacked(
    ax: number,
    ay: number,
    az: number,
    u: number,
    v: number,
    getBlock: (x: number, y: number, z: number) => number,
  ): number {
    const ux = u === 0 ? 1 : 0;
    const uy = u === 1 ? 1 : 0;
    const uz = u === 2 ? 1 : 0;
    const vx = v === 0 ? 1 : 0;
    const vy = v === 1 ? 1 : 0;
    const vz = v === 2 ? 1 : 0;

    let packed = 0;

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
    if (BLOCK_TYPE[id] !== 0) return false;

    const shapeIndex = ShapeByBlockId[id];
    if (!this.isGreedyCompatibleShape(shapeIndex)) return false;

    const state = unpackBlockState(value);
    return ((state >>> 3) & 7) === 0;
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
    const sliceAxis = getSliceAxis(rotation);
    if (sliceAxis !== axis) {
      return false;
    }

    const flip = (rotation & 4) !== 0;
    return isBackFace ? !flip : flip;
  }

  public static generateMesh(data: GenerateMeshInput): {
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

    const { block_array, chunk_size: size } = data;
    const lod = data.lod;
    const disableAO = lod >= 2;
    const context = new ChunkSamplingContext(data);
    const getBlock = context.getBlock;
    const getLight = context.getLight;

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
          lod,
          disableAO,
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

    if (this.chunkHasCustomShapes(block_array)) {
      this.emitCustomShapes(
        size,
        block_array,
        getBlock,
        getLight,
        opaqueMeshData,
        transparentMeshData,
        disableAO,
      );
    }

    return {
      opaque: opaqueMeshData,
      transparent: transparentMeshData,
    };
  }

  private static chunkHasCustomShapes(
    block_array: SamplingBlockArray,
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
    block_array: SamplingBlockArray,
    getBlock: (x: number, y: number, z: number, fallback?: number) => number,
    getLight: (x: number, y: number, z: number, fallback?: number) => number,
    mask: Uint32Array,
    maskLight: Uint16Array,
    maskBack: Uint32Array,
    maskBackLight: Uint16Array,
    lod: number,
    disableAO: boolean,
  ): void {
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

        const currentPartial = ((currentState >>> 3) & 7) !== 0;
        const neighborPartial = ((neighborState >>> 3) & 7) !== 0;

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

          const lightPacked =
            currentPartial && !neighborPartial
              ? Math.max(currentLightPacked, neighborLightPacked)
              : neighborLightPacked;

          const packedAO = disableAO
            ? 0
            : this.calculateAOPacked(
                bx + dx,
                by + dy,
                bz + dz,
                u_axis,
                v_axis,
                getBlock,
              );
          const quantizedLightPacked = this.quantizePackedLightForLod(
            lightPacked,
            disableAO,
          );
          const packedIdState = currentIsCustom
            ? 0
            : blockCurrent & BLOCK_PACK_MASK;

          mask[maskIndex] =
            packedIdState | (isCurrentTransparent ? TRANSPARENT_FLAG : 0);
          maskLight[maskIndex] = packedAO | (quantizedLightPacked << 8);
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

          const quantizedLightPacked = this.quantizePackedLightForLod(
            lightPacked,
            disableAO,
          );

          const packedIdState = neighborIsCustom
            ? 0
            : blockNeighbor & BLOCK_PACK_MASK;

          maskBack[maskIndex] =
            packedIdState |
            (isNeighborTransparent ? TRANSPARENT_FLAG : 0) |
            BACKFACE_FLAG;
          maskBackLight[maskIndex] = packedAO | (quantizedLightPacked << 8);
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
  ): void {
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
          const sliceAxisForGreedy = getSliceAxis(rotationForGreedy);
          allowGreedyMerge = sliceAxisForGreedy === axis;
        }

        const canMergeWidth =
          allowGreedyMerge && !(sliceForGreedy > 0 && u_axis === 1);
        const canMergeHeight =
          allowGreedyMerge && !(sliceForGreedy > 0 && v_axis === 1);

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

          const transformedBox = transformShapeBox(
            sourceBox.min,
            sourceBox.max,
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

  private static transformFaceMask(
    faceMask: number,
    rotation: number,
    flipY: boolean,
  ): number {
    switch (rotation & 3) {
      case 1: {
        faceMask = ROTATE_Y_FACE_MASK_1[faceMask];
        break;
      }
      case 2: {
        faceMask = ROTATE_Y_FACE_MASK_2[faceMask];
        break;
      }
      case 3: {
        faceMask = ROTATE_Y_FACE_MASK_3[faceMask];
        break;
      }
    }

    if (flipY) {
      faceMask = FLIP_Y_FACE_MASK[faceMask];
    }

    return faceMask;
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
    const sliceAxis = getSliceAxis(rotation);
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
    block_array: SamplingBlockArray,
    getBlock: (x: number, y: number, z: number, fallback?: number) => number,
    getLight: (x: number, y: number, z: number, fallback?: number) => number,
    opaqueMeshData: WorkerInternalMeshData,
    transparentMeshData: WorkerInternalMeshData,
    disableAO: boolean,
  ): void {
    const size2 = size * size;

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

            const packedAO = disableAO
              ? 0
              : onBoundary
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
            const transformed = transformShapeBox(
              box.min,
              box.max,
              rotation,
              flipY,
            );

            const faceMask = this.transformFaceMask(
              box.faceMask ?? FACE_ALL,
              rotation,
              flipY,
            );
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

  private static getMaterialTintBucket(blockId: number): number {
    // 0 = neutral, 1 = stone/mineral, 2 = dirt/sand, 3 = vegetation,
    // 4 = water/glass, 5 = wood.
    if (blockId === 30 || blockId === 60 || blockId === 61) {
      return 4;
    }

    if (blockId === 15 || blockId === 43 || blockId === 44) {
      return 3;
    }

    if (
      blockId === 3 ||
      blockId === 8 ||
      blockId === 14 ||
      blockId === 23 ||
      blockId === 45 ||
      blockId === 46 ||
      blockId === 47
    ) {
      return 2;
    }

    if (
      blockId === 10 ||
      blockId === 11 ||
      blockId === 12 ||
      blockId === 13 ||
      blockId === 22 ||
      blockId === 28 ||
      blockId === 31 ||
      (blockId >= 32 && blockId <= 42)
    ) {
      return 5;
    }

    return 1;
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
  ): void {
    const tex = BlockTextures[blockId];
    if (!tex) return;

    const ao0 = packedAO & 3;
    const ao1 = (packedAO >> 2) & 3;
    const ao2 = (packedAO >> 4) & 3;
    const ao3 = (packedAO >> 6) & 3;

    const materialType = blockId === 30 ? 1 : 0;

    const tile = tex[faceName] ?? tex.all!;
    const tx = tile[0];
    const ty = tile[1];

    const flip = ao0 + ao2 < ao1 + ao3;
    const axisFace = axis * 2 + (isBackFace ? 1 : 0);
    const meta = (flip ? 1 : 0) | ((materialType & 1) << 1);
    // Use class-qualified call so addQuad can safely be passed as a callback.
    const tintBucket = ChunkMeshBuilder.getMaterialTintBucket(blockId);

    const sx = Math.round(x * POS_SCALE);
    const sy = Math.round(y * POS_SCALE);
    const sz = Math.round(z * POS_SCALE);
    const sw = Math.round(width * POS_SCALE);
    const sh = Math.round(height * POS_SCALE);

    meshData.faceDataA.push4(sx, sy, sz, axisFace);
    meshData.faceDataB.push4(sw, sh, tx, ty);
    meshData.faceDataC.push4(packedAO, lightLevel, tintBucket, meta);
    meshData.faceCount++;
  }
  private static quantizeLightNibble(value: number): number {
    if (value >= 12) return 15;
    if (value >= 8) return 11;
    if (value >= 4) return 6;
    return 0;
  }

  private static quantizePackedLightForLod(
    packedLight: number,
    disableAO: boolean,
  ): number {
    const light = packedLight & 0xff;
    if (disableAO) {
      const sky = light >>> 4;
      const block = light & 0x0f;

      const quantizedSky = this.quantizeLightNibble(sky);
      const quantizedBlock = this.quantizeLightNibble(block);

      return ((quantizedSky & 0x0f) << 4) | (quantizedBlock & 0x0f);
    }
    return light;
  }
}
