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
  uvs2: number[];
  uvs3: number[];
  cornerIds: number[];
  indexOffset: number;
  decorations?: { x: number; y: number; z: number; blockId: number }[];
};

const TRANSPARENT_BLOCKS = new Set([30]);

type FaceData = {
  normal: number[];
  tangent: number[];
  handedness: number;
};

const FACE_DATA_CACHE: { [key: string]: FaceData } = {};

// Pre-calculate face data for all 6 directions
for (const axis of [0, 1, 2]) {
  for (const side of [-1, 1]) {
    const normal = [0, 0, 0];
    normal[axis] = side;

    const u_axis = (axis + 1) % 3;
    const v_axis = (axis + 2) % 3;

    const tangentVec = [0, 0, 0];
    tangentVec[u_axis] = 1;

    const bitangentVec = [0, 0, 0];
    bitangentVec[v_axis] = 1;

    const crossNT = [
      normal[1] * tangentVec[2] - normal[2] * tangentVec[1],
      normal[2] * tangentVec[0] - normal[0] * tangentVec[2],
      normal[0] * tangentVec[1] - normal[1] * tangentVec[0],
    ];
    const handedness =
      crossNT[0] * bitangentVec[0] +
        crossNT[1] * bitangentVec[1] +
        crossNT[2] * bitangentVec[2] <
      0
        ? -1.0
        : 1.0;
    FACE_DATA_CACHE[normal.join(",")] = {
      normal,
      tangent: tangentVec,
      handedness,
    };
  }
}

class ChunkWorkerMesher {
  // normalize3 kept simple and safe for axis-aligned du/dv vectors
  static normalize3 = (a: number[]): number[] => {
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
    const uvs2: number[] = [];
    const uvs3: number[] = [];
    const cornerIds: number[] = [];

    const opaqueMeshData: WorkerInternalMeshData = {
      positions,
      indices,
      normals,
      tangents,
      uvs2,
      uvs3,
      cornerIds,
      indexOffset: 0,
    };

    const transparentMeshData: WorkerInternalMeshData = {
      positions: [],
      indices: [],
      normals: [],
      tangents: [],
      uvs2: [],
      uvs3: [],
      cornerIds: [],
      indexOffset: 0,
    };

    const { block_array, chunk_size: chunk_size, neighbors } = data;
    const size = chunk_size;
    const size2 = size * size;

    const getBlock = (
      x: number,
      y: number,
      z: number,
      fallback = 0
    ): number => {
      const inChunk =
        x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size;
      if (inChunk) return block_array[x + y * size + z * size2];

      if (x < 0) {
        return neighbors.nx
          ? neighbors.nx[size - 1 + y * size + z * size2]
          : fallback;
      }
      if (x >= size) {
        return neighbors.px ? neighbors.px[0 + y * size + z * size2] : fallback;
      }
      if (y < 0) {
        return neighbors.ny
          ? neighbors.ny[x + (size - 1) * size + z * size2]
          : fallback;
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
        return neighbors.pz ? neighbors.pz[x + y * size + 0 * size2] : fallback;
      }

      return fallback;
    };

    // Mask bit encoding:
    // lower 16 bits: block ID (0 means empty)
    // bit 16 (1 << 16): TRANSPARENT_FLAG
    // bit 17 (1 << 17): BACKFACE_FLAG
    const TRANSPARENT_FLAG = 1 << 16;
    const BACKFACE_FLAG = 1 << 17;
    const BLOCK_ID_MASK = 0xffff;

    // single pass across axes -- generate masks containing encoded values
    for (let axis = 0; axis < 3; axis++) {
      const u_axis = (axis + 1) % 3;
      const v_axis = (axis + 2) % 3;

      const position = [0, 0, 0];
      const direction = [0, 0, 0];
      direction[axis] = 1;

      // reuseable mask
      const mask = new Int32Array(size * size);

      // sweep slices
      for (position[axis] = 0; position[axis] < size; position[axis]++) {
        let maskIndex = 0;

        for (
          position[v_axis] = 0;
          position[v_axis] < size;
          position[v_axis]++
        ) {
          for (
            position[u_axis] = 0;
            position[u_axis] < size;
            position[u_axis]++
          ) {
            const bx = position[0];
            const by = position[1];
            const bz = position[2];

            // sample current and neighbor; pass blockCurrent as fallback when sampling neighbor
            const blockCurrent = getBlock(bx, by, bz);
            const blockNeighbor = getBlock(
              bx + direction[0],
              by + direction[1],
              bz + direction[2],
              blockCurrent // key: if neighbor missing, pretend same block to avoid border faces
            );

            const isCurrentTransparent = TRANSPARENT_BLOCKS.has(blockCurrent);
            const isNeighborTransparent = TRANSPARENT_BLOCKS.has(blockNeighbor);
            const isCurrentSolid = blockCurrent !== 0;
            const isNeighborSolid = blockNeighbor !== 0;

            // --- Face Culling Logic ---
            if (blockCurrent === blockNeighbor) {
              mask[maskIndex++] = 0;
              continue;
            }

            if (
              isCurrentSolid &&
              (!isNeighborSolid ||
                (isNeighborTransparent && !isCurrentTransparent))
            ) {
              // Current block face is visible.
              const encCurrent =
                (blockCurrent & BLOCK_ID_MASK) |
                (isCurrentTransparent ? TRANSPARENT_FLAG : 0);
              mask[maskIndex++] = encCurrent;
            } else if (
              isNeighborSolid &&
              (!isCurrentSolid ||
                (isCurrentTransparent && !isNeighborTransparent))
            ) {
              // Neighbor block face is visible (so we draw a back-face).
              const encNeighbor =
                (blockNeighbor & BLOCK_ID_MASK) |
                (isNeighborTransparent ? TRANSPARENT_FLAG : 0);
              mask[maskIndex++] = encNeighbor | BACKFACE_FLAG;
            } else {
              mask[maskIndex++] = 0;
            }
          }
        }

        maskIndex = 0;

        // Optimized Greedy merge from mask
        for (let v_coord = 0; v_coord < size; v_coord++) {
          for (let u_coord = 0; u_coord < size; ) {
            const currentMaskValue = mask[maskIndex];
            if (currentMaskValue !== 0) {
              // Greedily find width
              let width = 1;
              while (
                u_coord + width < size &&
                mask[maskIndex + width] === currentMaskValue
              ) {
                width++;
              }

              // Greedily find height
              let height = 1;
              // Scan rows below to extend the quad vertically
              for (let h = 1; v_coord + h < size; h++) {
                let canExtend = true;
                for (let w = 0; w < width; w++) {
                  if (mask[maskIndex + w + h * size] !== currentMaskValue) {
                    canExtend = false;
                    break;
                  }
                }
                if (!canExtend) break;
                height++;
              }

              // Decode mask value
              const isBackFace = (currentMaskValue & BACKFACE_FLAG) !== 0;
              const isTransparent = (currentMaskValue & TRANSPARENT_FLAG) !== 0;
              const blockId = currentMaskValue & BLOCK_ID_MASK;

              position[u_axis] = u_coord;
              position[v_axis] = v_coord;

              const quadStartPos = [position[0], position[1], position[2]];
              quadStartPos[axis]++;

              const targetMesh = isTransparent
                ? transparentMeshData
                : opaqueMeshData;

              this.addQuad(
                quadStartPos,
                direction,
                u_axis,
                v_axis,
                width,
                height,
                blockId,
                isBackFace,
                targetMesh
              );

              // Zero out the mask for the area covered by the new quad
              for (let hh = 0; hh < height; hh++) {
                for (let ww = 0; ww < width; ww++) {
                  mask[maskIndex + ww + hh * size] = 0;
                }
              }

              u_coord += width;
              maskIndex += width; // Advance mask index by the width of the quad
            } else {
              u_coord++;
              maskIndex++;
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
    cornerIds: number[],
    uvs2: number[],
    tx: number,
    ty: number,
    isBackFace: boolean
  ) {
    // avoid allocating temporary arrays; push values directly
    const u_base = tx * TextureAtlasFactory.atlasTileSize;
    const v_base_flipped =
      1 -
      (ty * TextureAtlasFactory.atlasTileSize +
        TextureAtlasFactory.atlasTileSize);

    // uvs2: repeated tile base coords for 4 vertices
    uvs2.push(
      u_base,
      v_base_flipped,
      u_base,
      v_base_flipped,
      u_base,
      v_base_flipped,
      u_base,
      v_base_flipped
    );

    // uvs: standard quad UVs (optionally flipped for back faces)
    if (isBackFace) {
      cornerIds.push(3, 2, 1, 0);
    } else {
      cornerIds.push(0, 1, 2, 3);
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
    // create du/dv
    const du = [0, 0, 0];
    du[u] = w;
    const dv = [0, 0, 0];
    dv[v] = h;

    // compute four corner positions
    const p1 = [x[0], x[1], x[2]];
    const p2 = [x[0] + du[0], x[1] + du[1], x[2] + du[2]];
    const p3 = [
      x[0] + du[0] + dv[0],
      x[1] + du[1] + dv[1],
      x[2] + du[2] + dv[2],
    ];
    const p4 = [x[0] + dv[0], x[1] + dv[1], x[2] + dv[2]];

    // positions
    meshData.positions.push(...p1, ...p2, ...p3, ...p4);

    // normal
    const normalVec = isBackFace ? [-q[0], -q[1], -q[2]] : q;
    const faceData = FACE_DATA_CACHE[normalVec.join(",")];
    const { normal, tangent, handedness } = faceData;

    meshData.normals.push(...normal, ...normal, ...normal, ...normal);

    for (let i = 0; i < 4; i++) {
      meshData.tangents.push(tangent[0], tangent[1], tangent[2], handedness);
    }

    // tile lookup and UV writes
    const faceName = this.getFaceName(q, isBackFace);
    const tex = BlockTextures[blockId]!;
    const tile = tex[faceName] ?? tex.all!;
    this.pushTileUV(
      meshData.cornerIds,
      meshData.uvs2,
      tile[0],
      tile[1],
      isBackFace
    );

    // uvs3 tiling info
    meshData.uvs3.push(...[w, h, w, h, w, h, w, h]);

    // indices
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

// Top-level world generator instance for terrain requests
let generator: WorldGenerator | null = null;

self.onmessage = (event: MessageEvent) => {
  const { type } = event.data;

  // --- Default Full Remesh ---
  if (type === "full-remesh") {
    const { opaque, transparent } = ChunkWorkerMesher.generateMesh(event.data);
    // allow GC
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
    positions: new Uint8Array(data.positions),
    indices: new Uint16Array(data.indices),
    normals: new Int8Array(data.normals),
    tangents: new Int8Array(data.tangents),
    uvs2: new Float32Array(data.uvs2),
    uvs3: new Float32Array(data.uvs3),
    cornerIds: new Uint8Array(data.cornerIds),
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
    opaqueMeshData.uvs2.buffer,
    opaqueMeshData.uvs3.buffer,
    opaqueMeshData.cornerIds.buffer,
    transparentMeshData.positions.buffer,
    transparentMeshData.indices.buffer,
    transparentMeshData.normals.buffer,
    transparentMeshData.tangents.buffer,
    transparentMeshData.uvs2.buffer,
    transparentMeshData.uvs3.buffer,
    transparentMeshData.cornerIds.buffer,
  ];

  self.postMessage(transferableMessage, transferList);
}
