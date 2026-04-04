// MeshPipeline/core/ShapePipeline.ts
import { BlockShapeInfo, MaterialType } from "../types/MeshTypes";

/**
 * Placeholder implementation returning shape metadata based on packed block.
 * You will later connect this to your engine's real ShapeDefinitions.
 */
export function getShapeInfo(packedBlock: number): BlockShapeInfo {
  if (!packedBlock) {
    return {
      isCube: false,
      isSliceCompatible: false,
      sliceMask: 0,
    };
  }

  // TEMPORARY ASSUMPTION:
  // Your engine maps blockId → shapeIndex → shape data.
  // We assume all blocks are full cubes unless overridden later.
  return {
    isCube: true,
    isSliceCompatible: true,
    sliceMask: 0,
  };
}

/**
 * Your engine's tint bucket rules rewritten as strict TS.
 */
export function getMaterialTintBucket(blockId: number): number {
  // water/glass
  if (blockId === 30 || blockId === 60 || blockId === 61) return 4;

  // vegetation
  if (blockId === 15 || blockId === 43 || blockId === 44) return 3;

  // sand/dirt/soil
  if (
    blockId === 3 ||
    blockId === 8 ||
    blockId === 14 ||
    blockId === 23 ||
    blockId === 45 ||
    blockId === 46 ||
    blockId === 47
  )
    return 2;

  // wood, logs, planks
  if (
    blockId === 10 ||
    blockId === 11 ||
    blockId === 12 ||
    blockId === 13 ||
    blockId === 22 ||
    blockId === 28 ||
    blockId === 31 ||
    (blockId >= 32 && blockId <= 42)
  )
    return 5;

  // default: stone/mineral
  return 1;
}

/**
 * Whether a blockId belongs to water or transparent bucket.
 * Used by emitQuad to choose materialType.
 */
export function getMaterialType(blockId: number): MaterialType {
  return blockId === 30 || blockId === 60 || blockId === 61
    ? MaterialType.WaterOrGlass
    : MaterialType.Default;
}
