import { unpackBlockId } from "../../BlockEncoding";
import { ResizableTypedArray } from "../DataStructures/ResizableTypedArray";
import { WorkerInternalMeshData } from "../DataStructures/WorkerInternalMeshData";

export const WATER_BLOCK_ID = 30;

export type WaterSurfaceSample = {
  worldX: number;
  worldY: number;
  worldZ: number;
  width: number;
  depth: number;
  packedLight: number;
};

export type WaterLODArgs = {
  chunk_size: number;
  getBlock: (x: number, y: number, z: number, fallback?: number) => number;
  getLight: (x: number, y: number, z: number, fallback?: number) => number;
  step: number;
};

export type WaterSampleGrid = {
  samples: (WaterSurfaceSample | null)[];
  cellsX: number;
  cellsY: number;
  cellsZ: number;
  step: number;
  chunkSize: number;
  hasAnyWaterSurface: boolean;
};

export type AddQuadFn = (
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
) => void;

export class WaterLODBuilder {
  public static createEmptyMeshData(): WorkerInternalMeshData {
    return {
      faceDataA: new ResizableTypedArray(Uint8Array),
      faceDataB: new ResizableTypedArray(Uint8Array),
      faceDataC: new ResizableTypedArray(Uint8Array),
      faceCount: 0,
    };
  }

  public static isWaterPacked(packed: number): boolean {
    return unpackBlockId(packed) === WATER_BLOCK_ID;
  }

  public static waterGridIndex(
    cellX: number,
    cellY: number,
    cellZ: number,
    cellsX: number,
    cellsZ: number,
  ): number {
    return cellX + cellZ * cellsX + cellY * cellsX * cellsZ;
  }

  public static packMaxLightInCell(
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

          // Only emit if water is exposed upward to non-water.
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
      worldY: highestSurfaceY + 1, // top face plane
      worldZ: coarseZ,
      width: Math.min(step, size - coarseX),
      depth: Math.min(step, size - coarseZ),
      packedLight,
    };
  }

  public static buildCoarseWaterSampleGrid(
    args: WaterLODArgs,
  ): WaterSampleGrid {
    const { chunk_size: size, step } = args;

    const cellsX = Math.ceil(size / step);
    const cellsY = Math.ceil(size / step);
    const cellsZ = Math.ceil(size / step);

    const samples: (WaterSurfaceSample | null)[] = new Array(
      cellsX * cellsY * cellsZ,
    ).fill(null);

    let hasAnyWaterSurface = false;

    for (let cellY = 0; cellY < cellsY; cellY++) {
      const y = cellY * step;
      if (y >= size) continue;

      for (let cellZ = 0; cellZ < cellsZ; cellZ++) {
        const z = cellZ * step;
        if (z >= size) continue;

        for (let cellX = 0; cellX < cellsX; cellX++) {
          const x = cellX * step;
          if (x >= size) continue;

          const sample = this.sampleCoarseWaterSurface(args, x, y, z);
          const index = this.waterGridIndex(
            cellX,
            cellY,
            cellZ,
            cellsX,
            cellsZ,
          );
          samples[index] = sample;

          if (sample) {
            hasAnyWaterSurface = true;
          }
        }
      }
    }

    return {
      samples,
      cellsX,
      cellsY,
      cellsZ,
      step,
      chunkSize: size,
      hasAnyWaterSurface,
    };
  }

  public static generateLODWaterMeshFromGrid(
    grid: WaterSampleGrid,
    addQuad: AddQuadFn,
  ): WorkerInternalMeshData {
    const mesh = this.createEmptyMeshData();

    if (!grid.hasAnyWaterSurface) {
      return mesh;
    }

    const { samples, cellsX, cellsY, cellsZ } = grid;
    const used = new Uint8Array(samples.length);

    for (let cellY = 0; cellY < cellsY; cellY++) {
      for (let cellZ = 0; cellZ < cellsZ; cellZ++) {
        for (let cellX = 0; cellX < cellsX; cellX++) {
          const startIndex = this.waterGridIndex(
            cellX,
            cellY,
            cellZ,
            cellsX,
            cellsZ,
          );

          if (used[startIndex]) continue;

          const sample = samples[startIndex];
          if (!sample) continue;

          const baseWorldY = sample.worldY;
          const basePackedLight = sample.packedLight;
          const baseCellWidth = sample.width;
          const baseCellDepth = sample.depth;

          let mergeWidthCells = 1;
          while (cellX + mergeWidthCells < cellsX) {
            const idx = this.waterGridIndex(
              cellX + mergeWidthCells,
              cellY,
              cellZ,
              cellsX,
              cellsZ,
            );

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

          let mergeHeightCells = 1;
          outer: while (cellZ + mergeHeightCells < cellsZ) {
            for (let dx = 0; dx < mergeWidthCells; dx++) {
              const idx = this.waterGridIndex(
                cellX + dx,
                cellY,
                cellZ + mergeHeightCells,
                cellsX,
                cellsZ,
              );

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

          for (let dz = 0; dz < mergeHeightCells; dz++) {
            for (let dx = 0; dx < mergeWidthCells; dx++) {
              const idx = this.waterGridIndex(
                cellX + dx,
                cellY,
                cellZ + dz,
                cellsX,
                cellsZ,
              );
              used[idx] = 1;
            }
          }

          const mergedWidthX = mergeWidthCells * baseCellWidth;
          const mergedDepthZ = mergeHeightCells * baseCellDepth;

          // axis = 1 (top face)
          // width  = Z span
          // height = X span
          addQuad(
            sample.worldX,
            sample.worldY,
            sample.worldZ,
            1,
            mergedDepthZ,
            mergedWidthX,
            WATER_BLOCK_ID,
            false,
            "top",
            sample.packedLight,
            0,
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
