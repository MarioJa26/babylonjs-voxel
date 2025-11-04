import {
  Mesh,
  VertexData,
  Effect,
  Material,
  PhysicsAggregate,
  PhysicsShapeType,
} from "@babylonjs/core";
import { Map1 } from "@/code/Maps/Map1";
import { TextureAtlasFactory } from "../Texture/TextureAtlasFactory";

import { Chunk } from "./Chunk";
import { GlobalValues } from "../GlobalValues";
import { DiffuseNormalShader } from "../Light/DiffuseNormalShader";
import { ShaderMaterial } from "@babylonjs/core";
import { MeshData } from "./MeshData";

export class ChunkMesher {
  private static atlasMaterial: Material | null = null;

  static build(chunk: Chunk) {
    // This function is now just a placeholder or can be removed
    // as the logic is initiated from Chunk.scheduleRemesh()
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

  public static createMeshFromData(chunk: Chunk, meshData: MeshData) {
    if (chunk.mesh) chunk.mesh.dispose();
    if (meshData.positions.length === 0) {
      chunk.mesh = null;
      return;
    }

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
}
