import { unpackBlockId } from "../../BlockEncoding";
import { DistantTerrainGenerator } from "../../Generation/DistanTerrain/DistantTerrainGenerator";
import { WorldGenerator } from "../../Generation/WorldGenerator";
import { PaletteExpander } from "../DataStructures/PaletteExpander";
import { WorkerInternalMeshData } from "../DataStructures/WorkerInternalMeshData";
import {
  GenerateDistantTerrainRequest,
  GenerateFullMeshRequest,
  GenerateTerrainRequest,
} from "../DataStructures/WorkerMessageType";
import { WaterLODBuilder, WaterSampleGrid } from "./WaterLODBuilder";
import { WorkerPayloadExpander } from "./WorkerPayloadExpander";

export type MeshBuilderLike = {
  generateMesh(data: {
    block_array: Uint8Array | Uint16Array;
    chunk_size: number;
    light_array?: Uint8Array;
    neighbors: (Uint8Array | Uint16Array | undefined)[];
    neighborLights?: (Uint8Array | undefined)[];
  }): {
    opaque: WorkerInternalMeshData;
    transparent: WorkerInternalMeshData;
  };
  addQuad: (
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
};

export type PostFullMeshResultFn = (
  chunkId: bigint,
  lod: number,
  opaque: WorkerInternalMeshData,
  transparent: WorkerInternalMeshData,
) => void;

export type CompressBlocksFn = (blocks: Uint8Array) => {
  isUniform: boolean;
  uniformBlockId: number;
  palette: Uint16Array | null;
  packedBlocks: Uint8Array | Uint16Array | null;
};

export class WorkerTaskHandlers {
  public static handleGenerateFullMesh(
    request: GenerateFullMeshRequest,
    deps: {
      paletteExpander: PaletteExpander;
      meshBuilder: MeshBuilderLike;
      postFullMeshResult: PostFullMeshResultFn;
    },
  ): void {
    const { paletteExpander, meshBuilder, postFullMeshResult } = deps;

    const { totalBlocks, needsUint16 } =
      WorkerPayloadExpander.expandFullMeshRequest(request, paletteExpander);

    const { chunk_size, chunkId } = request;
    const lod = request.lod ?? 0;

    const expandedCenterBlockArray = request.block_array;
    if (
      !(expandedCenterBlockArray instanceof Uint8Array) &&
      !(expandedCenterBlockArray instanceof Uint16Array)
    ) {
      throw new Error(
        "GenerateFullMesh: block_array was not expanded before meshing.",
      );
    }

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

    if (lod >= 1) {
      const step = 2;

      const createBlockArray = (): Uint8Array | Uint16Array =>
        needsUint16
          ? new Uint16Array(totalBlocks)
          : new Uint8Array(totalBlocks);

      const simplifyBlockArray = (
        source: Uint8Array | Uint16Array,
        waterGrid?: WaterSampleGrid,
      ): Uint8Array | Uint16Array => {
        const simplified = createBlockArray();

        for (let z = 0; z < size; z += step) {
          for (let y = 0; y < size; y += step) {
            for (let x = 0; x < size; x += step) {
              let waterSurface = null;

              if (waterGrid && waterGrid.hasAnyWaterSurface) {
                const cellX = Math.floor(x / step);
                const cellY = Math.floor(y / step);
                const cellZ = Math.floor(z / step);

                const waterIndex = WaterLODBuilder.waterGridIndex(
                  cellX,
                  cellY,
                  cellZ,
                  waterGrid.cellsX,
                  waterGrid.cellsZ,
                );

                waterSurface = waterGrid.samples[waterIndex];
              }

              let chosen = 0;

              if (!waterSurface) {
                outer: for (let dz = 0; dz < step && z + dz < size; dz++) {
                  for (let dy = 0; dy < step && y + dy < size; dy++) {
                    for (let dx = 0; dx < step && x + dx < size; dx++) {
                      const idx = x + dx + (y + dy) * size + (z + dz) * size2;

                      const packed = source[idx];
                      const blockId = unpackBlockId(packed);

                      if (blockId === 0) continue;
                      if (blockId === 30 || blockId === 60 || blockId === 61)
                        continue;

                      chosen = packed;
                      break outer;
                    }
                  }
                }
              }

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

      const waterGrid = WaterLODBuilder.buildCoarseWaterSampleGrid({
        chunk_size: size,
        getBlock,
        getLight,
        step,
      });

      const simplifiedCenter = simplifyBlockArray(
        expandedCenterBlockArray,
        waterGrid,
      );

      const simplifiedNeighbors: (Uint8Array | Uint16Array | undefined)[] =
        request.neighbors.map(
          (neighbor: Uint8Array | Uint16Array | null | undefined) =>
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
          ? request.neighborLights.map((light: Uint8Array | undefined) =>
              light instanceof Uint8Array
                ? simplifyLightArray(light)
                : undefined,
            )
          : undefined;

      const solidResult = meshBuilder.generateMesh({
        block_array: simplifiedCenter,
        chunk_size: size,
        light_array: simplifiedCenterLight,
        neighbors: simplifiedNeighbors,
        neighborLights: simplifiedNeighborLights,
      });

      const waterResult = WaterLODBuilder.generateLODWaterMeshFromGrid(
        waterGrid,
        meshBuilder.addQuad,
      );

      WaterLODBuilder.appendMeshData(solidResult.transparent, waterResult);

      WorkerPayloadExpander.clearLargeReferences(request);
      postFullMeshResult(
        chunkId,
        lod,
        solidResult.opaque,
        solidResult.transparent,
      );
      return;
    }

    const fullNeighbors: (Uint8Array | Uint16Array | undefined)[] =
      request.neighbors.map(
        (neighbor: Uint8Array | Uint16Array | null | undefined) =>
          neighbor instanceof Uint8Array || neighbor instanceof Uint16Array
            ? neighbor
            : undefined,
      );

    const { opaque, transparent } = meshBuilder.generateMesh({
      block_array: expandedCenterBlockArray,
      chunk_size: request.chunk_size,
      light_array: request.light_array,
      neighbors: fullNeighbors,
      neighborLights: request.neighborLights,
    });

    WorkerPayloadExpander.clearLargeReferences(request);
    postFullMeshResult(chunkId, lod, opaque, transparent);
  }

  public static handleGenerateTerrain(
    request: GenerateTerrainRequest,
    deps: {
      generator: WorldGenerator;
      compressBlocks: CompressBlocksFn;
    },
  ): {
    payload: {
      chunkId: bigint;
      type: number;
      block_array: Uint8Array | Uint16Array | null;
      light_array: Uint8Array;
      isUniform: boolean;
      uniformBlockId: number;
      palette: Uint16Array | null;
    };
    transferables: Transferable[];
  } {
    const { generator, compressBlocks } = deps;
    const { chunkId, chunkX, chunkY, chunkZ } = request;

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

    return {
      payload: {
        chunkId,
        type: 0, // caller should overwrite with WorkerTaskType.GenerateTerrain if desired
        block_array: packedBlocks,
        light_array: light,
        isUniform,
        uniformBlockId,
        palette,
      },
      transferables,
    };
  }

  public static handleGenerateDistantTerrain(
    request: GenerateDistantTerrainRequest,
  ): {
    payload: {
      type: number;
      centerChunkX: number;
      centerChunkZ: number;
      positions: Int16Array;
      normals: Int8Array;
      surfaceTiles: Uint8Array;
    };
    transferables: Transferable[];
  } {
    const {
      centerChunkX,
      centerChunkZ,
      radius,
      renderDistance,
      gridStep,
      oldData,
      oldCenterChunkX,
      oldCenterChunkZ,
    } = request;

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

    return {
      payload: {
        type: 0, // caller should overwrite with WorkerTaskType.GenerateDistantTerrain_Generated if desired
        centerChunkX,
        centerChunkZ,
        positions: data.positions,
        normals: data.normals,
        surfaceTiles: data.surfaceTiles,
      },
      transferables: [
        data.positions.buffer,
        data.normals.buffer,
        data.surfaceTiles.buffer,
      ],
    };
  }
}
