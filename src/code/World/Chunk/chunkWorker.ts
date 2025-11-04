/// <reference lib="webworker" />

import { BlockTextures } from "../Texture/BlockTextures";

// This function contains the core greedy meshing logic, extracted from ChunkMesher.build
function generateMesh(block_array: Uint8Array, CHUNK_SIZE: number) {
  const positions: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  const tangents: number[] = [];
  const uvs: number[] = [];
  const uvs2: number[] = [];
  const uvs3: number[] = [];

  let indexOffset = 0;

  const getBlock = (x: number, y: number, z: number) => {
    return block_array[x + y * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE];
  };

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;

    const x = [0, 0, 0];
    const q = [0, 0, 0];
    q[d] = 1;
    const mask = new Int32Array(CHUNK_SIZE * CHUNK_SIZE);

    for (x[d] = -1; x[d] < CHUNK_SIZE; ) {
      let n = 0;
      for (x[v] = 0; x[v] < CHUNK_SIZE; x[v]++) {
        for (x[u] = 0; x[u] < CHUNK_SIZE; x[u]++) {
          const block1 = x[d] >= 0 ? getBlock(x[0], x[1], x[2]) : 0;
          const block2 =
            x[d] < CHUNK_SIZE - 1
              ? getBlock(x[0] + q[0], x[1] + q[1], x[2] + q[2])
              : 0;

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

      x[d]++;
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

            const p1 = [x[0], x[1], x[2]];
            const p2 = [x[0] + du[0], x[1] + du[1], x[2] + du[2]];
            const p3 = [
              x[0] + du[0] + dv[0],
              x[1] + du[1] + dv[1],
              x[2] + du[2] + dv[2],
            ];
            const p4 = [x[0] + dv[0], x[1] + dv[1], x[2] + dv[2]];

            if (isBackFace) {
              positions.push(...p2, ...p1, ...p4, ...p3);
            } else {
              positions.push(...p1, ...p2, ...p3, ...p4);
            }

            const normal = isBackFace ? [-q[0], -q[1], -q[2]] : q;
            normals.push(...normal, ...normal, ...normal, ...normal);

            const tangent = [0, 0, 0];
            tangent[u] = 1;
            const handedness = isBackFace ? -1 : 1;
            for (let vtx = 0; vtx < 4; vtx++)
              tangents.push(tangent[0], tangent[1], tangent[2], handedness);

            const faceName =
              d === 0
                ? isBackFace
                  ? "east"
                  : "west"
                : d === 1
                ? isBackFace
                  ? "bottom"
                  : "top"
                : isBackFace
                ? "south"
                : "north";
            const tex = BlockTextures[blockId]!;
            const tile = tex[faceName] ?? tex.all!;

            const u_base = tile[0];
            const v_base = tile[1];
            uvs2.push(
              u_base,
              v_base,
              u_base,
              v_base,
              u_base,
              v_base,
              u_base,
              v_base
            );

            const tilingData = [w, h];
            uvs3.push(
              ...tilingData,
              ...tilingData,
              ...tilingData,
              ...tilingData
            );

            if (isBackFace) {
              uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
            } else {
              uvs.push(1, 0, 0, 0, 0, 1, 1, 1);
            }

            indices.push(
              indexOffset,
              indexOffset + 1,
              indexOffset + 2,
              indexOffset,
              indexOffset + 2,
              indexOffset + 3
            );
            indexOffset += 4;

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

  return { positions, indices, normals, tangents, uvs, uvs2, uvs3 };
}

self.onmessage = (event) => {
  const { block_array, CHUNK_SIZE } = event.data;
  const meshData = generateMesh(block_array, CHUNK_SIZE);

  // Post the generated data back to the main thread
  // The second argument is a list of "Transferable" objects.
  // This transfers ownership of the ArrayBuffers, avoiding a slow copy.
  self.postMessage(meshData, [
    new Float32Array(meshData.positions).buffer,
    new Uint32Array(meshData.indices).buffer,
    new Float32Array(meshData.normals).buffer,
    new Float32Array(meshData.tangents).buffer,
    new Float32Array(meshData.uvs).buffer,
    new Float32Array(meshData.uvs2).buffer,
    new Float32Array(meshData.uvs3).buffer,
  ]);
};
