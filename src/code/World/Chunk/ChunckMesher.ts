import {
  Mesh,
  VertexData,
  ShaderMaterial,
  Effect,
  Material,
  PhysicsAggregate,
  PhysicsShapeType,
} from "@babylonjs/core";
import { Map1 } from "@/code/Maps/Map1";
import { BlockTextures } from "../Texture/BlockTextures";
import { TextureAtlasFactory } from "../Texture/TextureAtlasFactory";

import { Chunk } from "./Chunk";
import { GlobalValues } from "../GlobalValues";
import { DiffuseNormalShader } from "../Light/DiffuseNormalShader";

type MeshData = {
  positions: number[];
  indices: number[];
  normals: number[];
  tangents: number[];
  uvs: number[];
  uvs2: number[];
  uvs3: number[];
  indexOffset: number;
};

export class ChunkMesher {
  private static atlasMaterial: Material | null = null;

  static build(chunk: Chunk) {
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const tangents: number[] = [];
    const uvs: number[] = [];
    const uvs2: number[] = []; // For tiling data (width, height)
    const uvs3: number[] = [];

    const meshData: MeshData = {
      positions,
      indices,
      normals,
      tangents,
      uvs,
      uvs2,
      uvs3,
      indexOffset: 0,
    };

    for (let d = 0; d < 3; d++) {
      const u = (d + 1) % 3; // u-axis
      const v = (d + 2) % 3; // v-axis

      const x = [0, 0, 0];
      const q = [0, 0, 0];
      q[d] = 1;

      // Iterate through slices of the chunk
      for (x[d] = -1; x[d] < Chunk.SIZE; ) {
        const mask = ChunkMesher.generateMask(chunk, x, d, u, v, q);

        x[d]++;

        // Generate quads from the mask
        ChunkMesher.generateQuadsFromMask(mask, x, d, u, v, q, meshData);
      }
    }

    if (chunk.mesh) chunk.mesh.dispose();
    if (meshData.positions.length === 0 || meshData.indices.length === 0) {
      chunk.mesh?.dispose();
      chunk.mesh = null;
      return;
    }
    ChunkMesher.createMeshFromData(chunk, meshData);
  }
  static initAtlas() {
    // --- 🔑 Material Application Point (NEW LOGIC) ---
    if (!ChunkMesher.atlasMaterial) {
      const diffuseAtlasTexture = TextureAtlasFactory.getDiffuse();
      const normalAtlasTexture = TextureAtlasFactory.getNormal();
      const scene = Map1.mainScene;

      if (diffuseAtlasTexture) {
        // Register the shader with Babylon's Effect system
        Effect.ShadersStore["chunkVertexShader"] =
          DiffuseNormalShader.chunkVertexShader;
        Effect.ShadersStore["chunkFragmentShader"] =
          DiffuseNormalShader.chunkFragmentShader;

        const mat = new ShaderMaterial(
          "chunkShaderMaterial",
          scene,
          {
            vertex: "chunk",
            fragment: "chunk",
          },
          {
            attributes: ["position", "normal", "uv", "uv2", "uv3", "tangent"],
            uniforms: [
              "world",
              "worldViewProjection",
              "atlasTileSize",
              "cameraPosition",
              "lightDirection",
            ],
            samplers: ["diffuseTexture", "normalTexture"],
          }
        );
        mat.backFaceCulling = true;
        mat.setFloat("atlasTileSize", 1 / TextureAtlasFactory.atlasSize);

        mat.setTexture("diffuseTexture", diffuseAtlasTexture);
        if (normalAtlasTexture) {
          mat.setTexture("normalTexture", normalAtlasTexture);
        }

        mat.onBind = (mesh) => {
          const effect = mat.getEffect();
          if (effect) {
            effect.setVector3("lightDirection", GlobalValues.skyLightDirection);
            effect.setVector3(
              "cameraPosition",
              Map1.mainScene.activeCamera!.position
            );
          }
        };

        // Cache the material
        ChunkMesher.atlasMaterial = mat;
      } else {
        console.error("Texture Atlas not yet built or available!");
      }
    }
  }

  private static generateMask(
    chunk: Chunk,
    x: number[],
    d: number,
    u: number,
    v: number,
    q: number[]
  ): Int32Array {
    const mask = new Int32Array(Chunk.SIZE * Chunk.SIZE);
    let n = 0;
    for (x[v] = 0; x[v] < Chunk.SIZE; x[v]++) {
      for (x[u] = 0; x[u] < Chunk.SIZE; x[u]++) {
        const block1 = x[d] >= 0 ? chunk.getBlock(x[0], x[1], x[2]) : 0;
        const block2 =
          x[d] < Chunk.SIZE - 1
            ? chunk.getBlock(x[0] + q[0], x[1] + q[1], x[2] + q[2])
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
    return mask;
  }

  private static generateQuadsFromMask(
    mask: Int32Array,
    x: number[],
    d: number,
    u: number,
    v: number,
    q: number[],
    meshData: MeshData
  ) {
    let n = 0;
    for (let j = 0; j < Chunk.SIZE; j++) {
      for (let i = 0; i < Chunk.SIZE; ) {
        if (mask[n] !== 0) {
          const blockId = Math.abs(mask[n]);
          const isBackFace = mask[n] < 0;

          let w = 1;
          while (i + w < Chunk.SIZE && mask[n + w] === mask[n]) w++;

          let h = 1;
          let done = false;
          while (j + h < Chunk.SIZE) {
            for (let k = 0; k < w; k++) {
              if (mask[n + k + h * Chunk.SIZE] !== mask[n]) {
                done = true;
                break;
              }
            }
            if (done) break;
            h++;
          }

          x[u] = i;
          x[v] = j;

          this.addQuad(x, q, u, v, w, h, blockId, isBackFace, meshData);

          for (let l = 0; l < h; l++) {
            for (let k = 0; k < w; k++) {
              mask[n + k + l * Chunk.SIZE] = 0;
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

  private static addQuad(
    x: number[],
    q: number[],
    u: number,
    v: number,
    w: number,
    h: number,
    blockId: number,
    isBackFace: boolean,
    meshData: MeshData
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
      crossNT[0] * B[0] + crossNT[1] * B[1] + crossNT[2] * B[2] < 0 ? -1.0 : 1;

    for (let i = 0; i < 4; i++) {
      meshData.tangents.push(T[0], T[1], T[2], handedness);
    }

    const faceName = ChunkMesher.getFaceName(q, isBackFace);
    const tex = BlockTextures[blockId]!;
    const tile = tex[faceName] ?? tex.all!;
    ChunkMesher.pushTileUV(
      meshData.uvs,
      meshData.uvs2,
      tile[0],
      tile[1],
      isBackFace
    );

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

  private static createMeshFromData(chunk: Chunk, meshData: MeshData) {
    const mesh = new Mesh("chunk", Map1.mainScene);
    mesh.material = ChunkMesher.atlasMaterial;

    const vertexData = new VertexData();
    vertexData.positions = meshData.positions;
    vertexData.indices = meshData.indices;
    vertexData.normals = meshData.normals;
    vertexData.uvs = meshData.uvs;
    vertexData.uvs2 = meshData.uvs2;
    vertexData.uvs3 = meshData.uvs3;

    vertexData.applyToMesh(mesh, true);
    mesh.setVerticesData("tangent", meshData.tangents);

    if (mesh.material) {
      (mesh.material as ShaderMaterial).wireframe = GlobalValues.DEBUG;
    }

    mesh.position.set(
      chunk.chunkX * Chunk.SIZE,
      chunk.chunkY * Chunk.SIZE,
      chunk.chunkZ * Chunk.SIZE
    );

    new PhysicsAggregate(
      mesh,
      PhysicsShapeType.MESH,
      { mass: 0, friction: 0.5, restitution: 0.1 },
      Map1.mainScene
    );

    chunk.mesh = mesh;
  }

  private static getFaceName(dir: number[], isBackFace: boolean): string {
    const [dx, dy, dz] = dir;
    if (dx === 1) return isBackFace ? "east" : "west";
    if (dy === 1) return isBackFace ? "bottom" : "top"; // A backface in +Y is bottom
    if (dz === 1) return isBackFace ? "north" : "south"; // A backface in +Z is north
    throw new Error("Invalid direction in getFaceName"); // Should not be reached
  }

  static pushTileUV(
    uvs: number[],
    uvs2: number[],
    tx: number, // Tile X index (0 to ATLAS_SIZE - 1)
    ty: number, // Tile Y index (0 to ATLAS_SIZE - 1)
    isBackFace: boolean
  ) {
    // Calculate the tile's base UV in the atlas
    const u_base = tx * TextureAtlasFactory.atlasTileSize;
    const v_base_flipped =
      1 -
      (ty * TextureAtlasFactory.atlasTileSize +
        TextureAtlasFactory.atlasTileSize); // Flipped V is bottom-left
    const tileBaseUV = [u_base, v_base_flipped];

    // Push the tile's base UV to uvs2 for all 4 vertices
    uvs2.push(...tileBaseUV, ...tileBaseUV, ...tileBaseUV, ...tileBaseUV);

    // Define the local quad UVs (0 to 1 range)
    const u0 = 0,
      v0 = 0,
      u1 = 1,
      v1 = 1;

    // Always push UVs in a consistent order to match the new consistent vertex order.
    // Corresponds to vertex order p1, p2, p3, p4
    if (isBackFace) {
      // Reversed UV order to match the reversed index winding for back faces
      uvs.push(u0, v1, u1, v1, u1, v0, u0, v0);
    } else {
      // Standard UV mapping for front faces.
      // Corresponds to vertex order p1, p2, p3, p4
      uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
    }
  }
}
