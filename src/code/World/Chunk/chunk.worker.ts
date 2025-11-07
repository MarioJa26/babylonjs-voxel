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
class ChunkWorkerMesher {
  static generateMesh(
    block_array: Uint8Array,
    CHUNK_SIZE: number
  ): WorkerInternalMeshData {
    const positions: number[] = []; // Use regular arrays for building
    const indices: number[] = [];
    const normals: number[] = [];
    const tangents: number[] = [];
    const uvs: number[] = [];
    const uvs2: number[] = [];
    const uvs3: number[] = [];

    const meshData: WorkerInternalMeshData = {
      positions,
      indices,
      normals,
      tangents,
      uvs,
      uvs2,
      uvs3,
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

    for (let d = 0; d < 3; d++) {
      const u = (d + 1) % 3;
      const v = (d + 2) % 3;

      const x = [0, 0, 0];
      const q = [0, 0, 0];
      q[d] = 1;
      const mask = new Int32Array(CHUNK_SIZE * CHUNK_SIZE);

      for (x[d] = -1; x[d] < CHUNK_SIZE; x[d]++) {
        let n = 0;
        for (x[v] = 0; x[v] < CHUNK_SIZE; x[v]++) {
          for (x[u] = 0; x[u] < CHUNK_SIZE; x[u]++) {
            const block1 = getBlock(x[0], x[1], x[2]);
            const block2 = getBlock(x[0] + q[0], x[1] + q[1], x[2] + q[2]);

            const isBlock1Solid = block1 > 0;
            const isBlock2Solid = block2 > 0;

            if (isBlock1Solid === isBlock2Solid) {
              mask[n++] = 0;
            } else if (isBlock1Solid) {
              mask[n++] = block1;
            } else {
              mask[n++] = -block2;
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

              const du = [0, 0, 0];
              du[u] = w;
              const dv = [0, 0, 0];
              dv[v] = h;

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
                meshData
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

    return meshData;
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

  private static addQuad(
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
self.onmessage = (event: MessageEvent) => {
  const { chunkId, block_array, CHUNK_SIZE } = event.data as {
    chunkId: string;
    block_array: Uint8Array;
    CHUNK_SIZE: number;
  };
  const internalMeshData = ChunkWorkerMesher.generateMesh(
    block_array,
    CHUNK_SIZE
  );

  const positions = new Float32Array(internalMeshData.positions);
  const indices = new Uint32Array(internalMeshData.indices);
  const normals = new Float32Array(internalMeshData.normals);
  const tangents = new Float32Array(internalMeshData.tangents);
  const uvs = new Float32Array(internalMeshData.uvs);
  const uvs2 = new Float32Array(internalMeshData.uvs2);
  const uvs3 = new Float32Array(internalMeshData.uvs3);

  const transferableMeshData: MeshData = {
    positions,
    indices,
    normals,
    tangents,
    uvs,
    uvs2,
    uvs3,
    chunkId,
  };

  self.postMessage(transferableMeshData, [
    positions.buffer,
    indices.buffer,
    normals.buffer,
    tangents.buffer,
    uvs.buffer,
    uvs2.buffer,
    uvs3.buffer,
  ] as Transferable[]);
};
