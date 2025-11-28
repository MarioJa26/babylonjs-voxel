/// <reference lib="webworker" />

import { BlockTextures } from "../Texture/BlockTextures";
import { TextureAtlasFactory } from "../Texture/TextureAtlasFactory";
import { WorldGenerator } from "../Generation/WorldGenerator";
import { MeshData } from "./MeshData";

type WorkerInternalMeshData = {
  positions: number[];
  indices: number[];
  normals: number[];
  tangents: number[];
  uvs: number[];
  uvs2: number[];
  uvs3: number[];
  indexOffset: number;
  decorations?: { x: number; y: number; z: number; blockId: number }[];
};

const TRANSPARENT_BLOCKS = new Set([30]);

class ChunkWorkerMesher {
  static normalize3 = (a: number[]): number[] => {
    // Since we are only normalizing axis-aligned vectors (duVec, dvVec),
    // the length is simply the sum of the absolute values.
    const len = Math.abs(a[0]) + Math.abs(a[1]) + Math.abs(a[2]);
    return len > 0 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 0];
  };

  static generateMesh(data: {
    block_array: Uint8Array;
    chunk_size: number;
    neighbors: {
      px?: Uint8Array;
      nx?: Uint8Array;
      py?: Uint8Array;
      ny?: Uint8Array;
      pz?: Uint8Array;
      nz?: Uint8Array;
    };
  }): { opaque: WorkerInternalMeshData; transparent: WorkerInternalMeshData } {
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const tangents: number[] = [];
    const uvs: number[] = [];
    const uvs2: number[] = [];
    const uvs3: number[] = [];

    const opaqueMeshData: WorkerInternalMeshData = {
      positions,
      indices,
      normals,
      tangents,
      uvs,
      uvs2,
      uvs3,
      indexOffset: 0,
    };

    const transparentMeshData: WorkerInternalMeshData = {
      positions: [],
      indices: [],
      normals: [],
      tangents: [],
      uvs: [],
      uvs2: [],
      uvs3: [],
      indexOffset: 0,
    };

    const { block_array, chunk_size: chunk_size, neighbors } = data;
    const size = chunk_size;
    const size2 = size * size;
    const getBlock = (
      x: number,
      y: number,
      z: number,
      fallback = 0 // ← Use this when neighbor chunk does not exist
    ): number => {
      // Inside this chunk
      if (x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size) {
        return block_array[x + y * size + z * size2];
      }

      // Neighbor lookups
      if (x < 0) {
        const arr = neighbors.nx;
        return arr ? arr[size - 1 + y * size + z * size2] : fallback;
      }
      if (x >= size) {
        const arr = neighbors.px;
        return arr ? arr[0 + y * size + z * size2] : fallback;
      }

      if (y < 0) {
        const arr = neighbors.ny;
        return arr ? arr[x + (size - 1) * size + z * size2] : fallback;
      }
      if (y >= size) {
        const arr = neighbors.py;
        return arr ? arr[x + 0 * size + z * size2] : fallback;
      }

      if (z < 0) {
        const arr = neighbors.nz;
        return arr ? arr[x + y * size + (size - 1) * size2] : fallback;
      }
      if (z >= size) {
        const arr = neighbors.pz;
        return arr ? arr[x + y * size + 0 * size2] : fallback;
      }

      // Should never hit here — but fallback is fastest
      return fallback;
    };

    // We perform two passes: one for opaque blocks and one for transparent blocks.
    for (const isTransparentPass of [false, true]) {
      const currentMeshData = isTransparentPass
        ? transparentMeshData
        : opaqueMeshData;

      // Iterate over the 3 axes (x, y, z)
      for (let axis = 0; axis < 3; axis++) {
        const u_axis = (axis + 1) % 3; // The first perpendicular axis
        const v_axis = (axis + 2) % 3; // The second perpendicular axis

        const position = [0, 0, 0];
        const direction = [0, 0, 0];
        direction[axis] = 1;
        const mask = new Int32Array(chunk_size * chunk_size);

        // Sweep through the chunk axis to create 2D slices
        for (
          position[axis] = 0;
          position[axis] < chunk_size;
          position[axis]++
        ) {
          let maskIndex = 0;
          for (
            position[v_axis] = 0;
            position[v_axis] < chunk_size;
            position[v_axis]++
          ) {
            for (
              position[u_axis] = 0;
              position[u_axis] < chunk_size;
              position[u_axis]++
            ) {
              const blockCurrent = getBlock(
                position[0],
                position[1],
                position[2]
              );
              const blockNeighbor = getBlock(
                position[0] + direction[0],
                position[1] + direction[1],
                position[2] + direction[2],
                blockCurrent
              );

              const isCurrentBlockTransparent =
                TRANSPARENT_BLOCKS.has(blockCurrent);
              const isNeighborBlockTransparent =
                TRANSPARENT_BLOCKS.has(blockNeighbor);

              // Determine if the block is part of the current rendering pass (opaque or transparent)
              const isCurrentInPass =
                isCurrentBlockTransparent === isTransparentPass;
              const isNeighborInPass =
                isNeighborBlockTransparent === isTransparentPass;

              // A block is considered "solid" for culling if it's not air (0).
              // This includes normal blocks, transparent blocks, and our new barrier blocks.
              const isCurrentSolid = blockCurrent !== 0;
              const isNeighborSolid = blockNeighbor !== 0;

              const blockTypeCurrent =
                isCurrentSolid && isCurrentInPass ? blockCurrent : 0;
              const blockTypeNeighbor =
                isNeighborSolid && isNeighborInPass ? blockNeighbor : 0;

              if (blockTypeCurrent && !blockTypeNeighbor) {
                mask[maskIndex++] = blockTypeCurrent; // Forward face
              } else if (!blockTypeCurrent && blockTypeNeighbor) {
                mask[maskIndex++] = -blockTypeNeighbor; // Backward face
              } else {
                mask[maskIndex++] = 0; // No face needed
              }
            }
          }

          maskIndex = 0;

          // Generate quads from the mask
          for (let v_coord = 0; v_coord < chunk_size; v_coord++) {
            for (let u_coord = 0; u_coord < chunk_size; ) {
              if (mask[maskIndex] !== 0) {
                const blockId = Math.abs(mask[maskIndex]);
                const isBackFace = mask[maskIndex] < 0;

                // Greedily find the width of the quad
                let width = 1;
                while (
                  u_coord + width < chunk_size &&
                  mask[maskIndex + width] === mask[maskIndex]
                ) {
                  width++;
                }

                // Greedily find the height of the quad
                let height = 1;
                let done = false;
                while (v_coord + height < chunk_size) {
                  for (let width_iter = 0; width_iter < width; width_iter++) {
                    if (
                      mask[maskIndex + width_iter + height * chunk_size] !==
                      mask[maskIndex]
                    ) {
                      done = true;
                      break;
                    }
                  }
                  if (done) break;
                  height++;
                }

                position[u_axis] = u_coord;
                position[v_axis] = v_coord;

                const quadStartPos = [position[0], position[1], position[2]];
                quadStartPos[axis]++; // Move into the current slice for vertex positions

                this.addQuad(
                  quadStartPos,
                  direction,
                  u_axis,
                  v_axis,
                  width,
                  height,
                  blockId,
                  isBackFace,
                  currentMeshData
                );

                // Zero out the mask for the area covered by the quad
                for (let height_iter = 0; height_iter < height; height_iter++) {
                  for (let width_iter = 0; width_iter < width; width_iter++) {
                    mask[maskIndex + width_iter + height_iter * chunk_size] = 0;
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
      }
    }

    return { opaque: opaqueMeshData, transparent: transparentMeshData };
  }

  private static getFaceName(dir: number[], isBackFace: boolean): string {
    const [dx, dy, dz] = dir;
    if (dx === 1) return isBackFace ? "east" : "west";
    if (dy === 1) return isBackFace ? "bottom" : "top";
    if (dz === 1) return isBackFace ? "north" : "south";
    throw new Error("Invalid direction");
  }

  private static pushTileUV(
    uvs: number[],
    uvs2: number[],
    tx: number,
    ty: number,
    isBackFace: boolean
  ) {
    const u_base = tx * TextureAtlasFactory.atlasTileSize;
    const v_base_flipped =
      1 -
      (ty * TextureAtlasFactory.atlasTileSize +
        TextureAtlasFactory.atlasTileSize);
    const tileBaseUV = [u_base, v_base_flipped];

    uvs2.push(...tileBaseUV, ...tileBaseUV, ...tileBaseUV, ...tileBaseUV);

    const u0 = 0,
      v0 = 0,
      u1 = 1,
      v1 = 1;
    if (isBackFace) {
      uvs.push(u0, v1, u1, v1, u1, v0, u0, v0);
    } else {
      uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
    }
  }

  public static addQuad(
    x: number[],
    q: number[],
    u: number,
    v: number,
    w: number,
    h: number,
    blockId: number,
    isBackFace: boolean,
    meshData: WorkerInternalMeshData
  ) {
    const du = [0, 0, 0];
    du[u] = w;
    const dv = [0, 0, 0];
    dv[v] = h;

    const p1 = [x[0], x[1], x[2]];
    const p2 = [x[0] + du[0], x[1] + du[1], x[2] + du[2]];
    const p3 = [
      x[0] + du[0] + dv[0],
      x[1] + du[1] + dv[1],
      x[2] + du[2] + dv[2],
    ];
    const p4 = [x[0] + dv[0], x[1] + dv[1], x[2] + dv[2]];

    meshData.positions.push(...p1, ...p2, ...p3, ...p4);

    const normal = isBackFace ? [-q[0], -q[1], -q[2]] : q;
    meshData.normals.push(...normal, ...normal, ...normal, ...normal);

    const duVec = [du[0], du[1], du[2]];
    const dvVec = [dv[0], dv[1], dv[2]];

    const N = normal;
    const T = this.normalize3(duVec);
    const B = this.normalize3(dvVec);

    const crossNT = [
      N[1] * T[2] - N[2] * T[1],
      N[2] * T[0] - N[0] * T[2],
      N[0] * T[1] - N[1] * T[0],
    ];
    const handedness =
      crossNT[0] * B[0] + crossNT[1] * B[1] + crossNT[2] * B[2] < 0
        ? -1.0
        : 1.0;

    for (let i = 0; i < 4; i++) {
      meshData.tangents.push(T[0], T[1], T[2], handedness);
    }

    const faceName = this.getFaceName(q, isBackFace);
    const tex = BlockTextures[blockId]!;
    const tile = tex[faceName] ?? tex.all!;
    this.pushTileUV(meshData.uvs, meshData.uvs2, tile[0], tile[1], isBackFace);

    const tilingData = [w, h];
    meshData.uvs3.push(
      ...tilingData,
      ...tilingData,
      ...tilingData,
      ...tilingData
    );

    const { indices, indexOffset } = meshData;
    if (!isBackFace) {
      indices.push(
        indexOffset,
        indexOffset + 2,
        indexOffset + 1,
        indexOffset,
        indexOffset + 3,
        indexOffset + 2
      );
    } else {
      indices.push(
        indexOffset,
        indexOffset + 1,
        indexOffset + 2,
        indexOffset,
        indexOffset + 2,
        indexOffset + 3
      );
    }
    meshData.indexOffset += 4;
  }
}

// This needs to be at the top level of the worker script
let generator: WorldGenerator | null = null;

self.onmessage = (event: MessageEvent) => {
  const { type } = event.data;

  // --- Default Full Remesh ---
  if (type === "full-remesh") {
    const { opaque, transparent } = ChunkWorkerMesher.generateMesh(event.data);
    // We don't need the block array for meshing result, so we can help GC.
    event.data.block_array = undefined;
    event.data.neighbors = undefined;

    postFullMeshResult(event.data.chunkId, opaque, transparent);
    return;
  }

  // --- Terrain generation request ---
  if (type === "generate-terrain") {
    const { chunkId, chunkX, chunkY, chunkZ } = event.data;

    if (!generator) {
      generator = new WorldGenerator({ ...event.data });
    }

    const { blocks } = generator.generateChunkData(chunkX, chunkY, chunkZ);

    // return terrain result (transfer the buffer)
    self.postMessage(
      { chunkId, type: "terrain-generated", block_array: blocks },
      [blocks.buffer]
    );

    return;
  }
};

function toTransferable(data: WorkerInternalMeshData): MeshData {
  return {
    positions: new Float32Array(data.positions),
    indices: new Uint32Array(data.indices),
    normals: new Float32Array(data.normals),
    tangents: new Float32Array(data.tangents),
    uvs: new Float32Array(data.uvs),
    uvs2: new Float32Array(data.uvs2),
    uvs3: new Float32Array(data.uvs3),
  };
}

function postFullMeshResult(
  chunkId: string,
  opaque: WorkerInternalMeshData,
  transparent: WorkerInternalMeshData
) {
  const opaqueMeshData = toTransferable(opaque);
  const transparentMeshData = toTransferable(transparent);

  const transferableMessage = {
    chunkId,
    type: "full-mesh",
    opaque: opaqueMeshData,
    transparent: transparentMeshData,
  };

  const transferList: Transferable[] = [
    opaqueMeshData.positions.buffer,
    opaqueMeshData.indices.buffer,
    opaqueMeshData.normals.buffer,
    opaqueMeshData.tangents.buffer,
    opaqueMeshData.uvs.buffer,
    opaqueMeshData.uvs2.buffer,
    opaqueMeshData.uvs3.buffer,
    transparentMeshData.positions.buffer,
    transparentMeshData.indices.buffer,
    transparentMeshData.normals.buffer,
    transparentMeshData.tangents.buffer,
    transparentMeshData.uvs.buffer,
    transparentMeshData.uvs2.buffer,
    transparentMeshData.uvs3.buffer,
  ];

  self.postMessage(transferableMessage, transferList);
}
