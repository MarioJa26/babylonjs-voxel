/// <reference lib="webworker" />

import { BlockTextures } from "../Texture/BlockTextures";
import { TextureAtlasFactory } from "../Texture/TextureAtlasFactory";
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
};

// Define which block IDs are transparent. Water is ID 30.
const TRANSPARENT_BLOCKS = new Set([30]);

class ChunkWorkerMesher {
  static generateMesh(
    block_array: Uint8Array,
    CHUNK_SIZE: number
  ): { opaque: WorkerInternalMeshData; transparent: WorkerInternalMeshData } {
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

    const getBlock = (x: number, y: number, z: number) => {
      if (
        x < 0 ||
        x >= CHUNK_SIZE ||
        y < 0 ||
        y >= CHUNK_SIZE ||
        z < 0 ||
        z >= CHUNK_SIZE
      )
        return 0;
      return block_array[x + y * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE];
    };

    // We perform two passes: one for opaque blocks and one for transparent blocks.
    for (const isTransparentPass of [false, true]) {
      const currentMeshData = isTransparentPass
        ? transparentMeshData
        : opaqueMeshData;

      for (let d = 0; d < 3; d++) {
        const u = (d + 1) % 3;
        const v = (d + 2) % 3;

        const x = [0, 0, 0];
        const q = [0, 0, 0];
        q[d] = 1;
        const mask = new Int32Array(CHUNK_SIZE * CHUNK_SIZE);

        // By starting at 0 and ending at CHUNK_SIZE - 1, we naturally process only the internal faces,
        // skipping the chunk borders that will be handled by a later neighbor-aware pass.
        for (x[d] = 0; x[d] < CHUNK_SIZE - 1; x[d]++) {
          let n = 0;
          for (x[v] = 0; x[v] < CHUNK_SIZE; x[v]++) {
            for (x[u] = 0; x[u] < CHUNK_SIZE; x[u]++) {
              const block1 = getBlock(x[0], x[1], x[2]);
              const block2 = getBlock(x[0] + q[0], x[1] + q[1], x[2] + q[2]);

              const isBlock1Transparent = TRANSPARENT_BLOCKS.has(block1);
              const isBlock2Transparent = TRANSPARENT_BLOCKS.has(block2);

              // In the opaque pass, we only care about opaque blocks.
              // In the transparent pass, we only care about transparent blocks.
              const isBlock1Active = isBlock1Transparent === isTransparentPass;
              const isBlock2Active = isBlock2Transparent === isTransparentPass;

              // Treat non-active blocks (and air) as empty space.
              const type1 = block1 !== 0 && isBlock1Active ? block1 : 0;
              const type2 = block2 !== 0 && isBlock2Active ? block2 : 0;

              if (type1 && !type2) {
                mask[n++] = type1; // Forward face
              } else if (!type1 && type2) {
                mask[n++] = -type2; // Backward face
              } else {
                mask[n++] = 0; // No face needed
              }
            }
          }

          n = 0;

          for (let j = 0; j < CHUNK_SIZE; j++) {
            for (let i = 0; i < CHUNK_SIZE; ) {
              if (mask[n] !== 0) {
                const blockId = Math.abs(mask[n]);
                const isBackFace = mask[n] < 0;

                let w = 1;
                while (i + w < CHUNK_SIZE && mask[n + w] === mask[n]) w++;

                let h = 1;
                let done = false;
                while (j + h < CHUNK_SIZE) {
                  for (let k = 0; k < w; k++) {
                    if (mask[n + k + h * CHUNK_SIZE] !== mask[n]) {
                      done = true;
                      break;
                    }
                  }
                  if (done) break;
                  h++;
                }

                x[u] = i;
                x[v] = j;

                const currentPos = [x[0], x[1], x[2]];
                currentPos[d]++; // Move into the current slice for vertex positions

                this.addQuad(
                  currentPos,
                  q,
                  u,
                  v,
                  w,
                  h,
                  blockId,
                  isBackFace,
                  currentMeshData
                );

                for (let l = 0; l < h; l++) {
                  for (let k = 0; k < w; k++) {
                    mask[n + k + l * CHUNK_SIZE] = 0;
                  }
                }
                i += w;
                n += w;
              } else {
                i++;
                n++;
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

    const normalize3 = (a: number[]) => {
      const len = Math.hypot(a[0], a[1], a[2]);
      return len > 0 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 0];
    };

    const N = normal;
    const T = normalize3(duVec);
    const B = normalize3(dvVec);

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

/**
 * Generates the mesh for the boundary between two chunks.
 * It calculates the faces for BOTH sides of the boundary.
 */
function generateBorderMesh(data: {
  chunkBlockArray: Uint8Array;
  neighborBlockArray: Uint8Array;
  direction: [number, number, number];
  CHUNK_SIZE: number;
}) {
  const { chunkBlockArray, neighborBlockArray, direction, CHUNK_SIZE } = data;

  // Mesh data for the primary chunk's border face
  const opaqueMeshData: WorkerInternalMeshData = {
    positions: [],
    indices: [],
    normals: [],
    tangents: [],
    uvs: [],
    uvs2: [],
    uvs3: [],
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

  // Mesh data for the neighbor chunk's border face
  const neighborOpaqueMeshData: WorkerInternalMeshData = {
    positions: [],
    indices: [],
    normals: [],
    tangents: [],
    uvs: [],
    uvs2: [],
    uvs3: [],
    indexOffset: 0,
  };
  const neighborTransparentMeshData: WorkerInternalMeshData = {
    positions: [],
    indices: [],
    normals: [],
    tangents: [],
    uvs: [],
    uvs2: [],
    uvs3: [],
    indexOffset: 0,
  };

  const d = direction.findIndex((v) => v !== 0);
  const u = (d + 1) % 3;
  const v = (d + 2) % 3;

  const q = [0, 0, 0];
  q[d] = 1;

  const getBlock = (arr: Uint8Array, lx: number, ly: number, lz: number) => {
    return arr[lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE];
  };

  for (const isTransparentPass of [false, true]) {
    const currentMeshData = isTransparentPass
      ? transparentMeshData
      : opaqueMeshData;
    const neighborCurrentMeshData = isTransparentPass
      ? neighborTransparentMeshData
      : neighborOpaqueMeshData;
    const mask = new Int32Array(CHUNK_SIZE * CHUNK_SIZE);
    let n = 0;

    const x = [0, 0, 0];
    for (x[v] = 0; x[v] < CHUNK_SIZE; x[v]++) {
      for (x[u] = 0; x[u] < CHUNK_SIZE; x[u]++) {
        // block1 is on the edge of the main chunk.
        // block2 is on the edge of the neighbor chunk.
        const chunkCoords = [...x];
        chunkCoords[d] = direction[d] > 0 ? CHUNK_SIZE - 1 : 0;
        const block1 = getBlock(
          chunkBlockArray,
          chunkCoords[0],
          chunkCoords[1],
          chunkCoords[2]
        );

        const neighborCoords = [...x];
        neighborCoords[d] = direction[d] > 0 ? 0 : CHUNK_SIZE - 1;
        const block2 = getBlock(
          neighborBlockArray,
          neighborCoords[0],
          neighborCoords[1],
          neighborCoords[2]
        );

        const isBlock1Transparent = TRANSPARENT_BLOCKS.has(block1);
        const isBlock2Transparent = TRANSPARENT_BLOCKS.has(block2);

        const isBlock1Active = isBlock1Transparent === isTransparentPass;
        const isBlock2Active = isBlock2Transparent === isTransparentPass;

        const type1 = block1 !== 0 && isBlock1Active ? block1 : 0;
        const type2 = block2 !== 0 && isBlock2Active ? block2 : 0;

        if (type1 && !type2) {
          mask[n++] = type1; // Create a face for block1
        } else if (!type1 && type2) {
          mask[n++] = -type2; // Create a face for block2 (negative indicates it's for the neighbor)
        } else {
          mask[n++] = 0;
        }
      }
    }

    n = 0;
    for (let j = 0; j < CHUNK_SIZE; j++) {
      for (let i = 0; i < CHUNK_SIZE; ) {
        if (mask[n] !== 0) {
          const blockId = Math.abs(mask[n]);
          const isForNeighbor = mask[n] < 0;

          let w = 1;
          while (i + w < CHUNK_SIZE && mask[n + w] === mask[n]) w++;

          let h = 1;
          let done = false;
          while (j + h < CHUNK_SIZE) {
            for (let k = 0; k < w; k++) {
              if (mask[n + k + h * CHUNK_SIZE] !== mask[n]) {
                done = true;
                break;
              }
            }
            if (done) break;
            h++;
          }

          const quadPos = [0, 0, 0];
          quadPos[u] = i;
          quadPos[v] = j;
          quadPos[d] = direction[d] > 0 ? CHUNK_SIZE - 1 : 0;

          const finalPos = [...quadPos];
          finalPos[d]++;

          const meshDataToUse = isForNeighbor
            ? neighborCurrentMeshData
            : currentMeshData;
          const isBackFace = isForNeighbor;

          ChunkWorkerMesher.addQuad(
            finalPos,
            q,
            u,
            v,
            w,
            h,
            blockId,
            isBackFace,
            meshDataToUse
          );

          for (let l = 0; l < h; l++) {
            for (let k = 0; k < w; k++) {
              mask[n + k + l * CHUNK_SIZE] = 0;
            }
          }
          i += w;
          n += w;
        } else {
          i++;
          n++;
        }
      }
    }
  }

  return {
    opaque: opaqueMeshData,
    transparent: transparentMeshData,
    neighborOpaque: neighborOpaqueMeshData,
    neighborTransparent: neighborTransparentMeshData,
  };
}

self.onmessage = (event: MessageEvent) => {
  const { type } = event.data;

  if (type === "border-remesh") {
    const { opaque, transparent, neighborOpaque, neighborTransparent } =
      generateBorderMesh(event.data);
    postBorderMeshResult(
      event.data.chunkId,
      event.data.direction,
      opaque,
      transparent,
      neighborOpaque,
      neighborTransparent
    );
    return;
  }

  // --- Default Full Remesh ---
  const { chunkId, block_array, CHUNK_SIZE } = event.data as {
    chunkId: string;
    block_array: Uint8Array;
    CHUNK_SIZE: number;
  };
  const { opaque, transparent } = ChunkWorkerMesher.generateMesh(
    block_array,
    CHUNK_SIZE
  );
  postFullMeshResult(chunkId, opaque, transparent);
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

function postBorderMeshResult(
  chunkId: string,
  direction: [number, number, number],
  opaque: WorkerInternalMeshData,
  transparent: WorkerInternalMeshData,
  neighborOpaque: WorkerInternalMeshData,
  neighborTransparent: WorkerInternalMeshData
) {
  const opaqueMeshData = toTransferable(opaque);
  const transparentMeshData = toTransferable(transparent);
  const neighborOpaqueMeshData = toTransferable(neighborOpaque);
  const neighborTransparentMeshData = toTransferable(neighborTransparent);

  const transferableMessage = {
    chunkId,
    direction,
    type: "border-mesh",
    opaque: opaqueMeshData,
    transparent: transparentMeshData,
    neighborOpaque: neighborOpaqueMeshData,
    neighborTransparent: neighborTransparentMeshData,
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
    neighborOpaqueMeshData.positions.buffer,
    neighborOpaqueMeshData.indices.buffer,
    neighborOpaqueMeshData.normals.buffer,
    neighborOpaqueMeshData.tangents.buffer,
    neighborOpaqueMeshData.uvs.buffer,
    neighborOpaqueMeshData.uvs2.buffer,
    neighborOpaqueMeshData.uvs3.buffer,
    neighborTransparentMeshData.positions.buffer,
    neighborTransparentMeshData.indices.buffer,
    neighborTransparentMeshData.normals.buffer,
    neighborTransparentMeshData.tangents.buffer,
    neighborTransparentMeshData.uvs.buffer,
    neighborTransparentMeshData.uvs2.buffer,
    neighborTransparentMeshData.uvs3.buffer,
  ];

  self.postMessage(transferableMessage, transferList);
}
