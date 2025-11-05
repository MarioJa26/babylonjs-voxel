import {
  Mesh,
  VertexData,
  Effect,
  Material,
  PhysicsAggregate,
  PhysicsShapeType,
  Texture,
  Tools,
} from "@babylonjs/core";
import { Map1 } from "@/code/Maps/Map1";
import { TextureAtlasFactory } from "../Texture/TextureAtlasFactory";

import { Chunk } from "./Chunk";
import { GlobalValues } from "../GlobalValues";
import { DiffuseOnlyShader } from "../Light/DiffuseOnlyShader";
import { ShaderMaterial } from "@babylonjs/core";
import { MeshData } from "./MeshData";

export class ChunkMesher {
  private static atlasMaterial: Material | null = null;

  static build(chunk: Chunk) {
    // This function is now just a placeholder or can be removed
    // as the logic is initiated from Chunk.scheduleRemesh()
  }
  static initAtlas() {
    if (!ChunkMesher.atlasMaterial) {
      let diffuseAtlasTexture: Texture | null = null;
      let normalAtlasTexture: Texture | null = null;
      const scene = Map1.mainScene;

      if (GlobalValues.CREATE_ATLAS) {
        diffuseAtlasTexture = TextureAtlasFactory.getDiffuse();
        normalAtlasTexture = TextureAtlasFactory.getNormal();

        const saveTexture = async (texture: Texture, fileName: string) => {
          // Wait for the texture to be fully ready, including for pixel reading.
          await new Promise<void>((resolve, reject) => {
            texture.onLoadObservable.addOnce(() => {
              resolve();
            });
          });

          const pixels = await texture.readPixels();
          if (pixels) {
            const size = texture.getSize();
            Tools.DumpData(
              size.width,
              size.height,
              pixels,
              undefined,
              "image/png",
              fileName,
              true
            );
          }
        };

        if (diffuseAtlasTexture) {
          saveTexture(diffuseAtlasTexture, "diffuseAtlas.png").catch((err) =>
            console.error("Failed to save diffuse atlas:", err)
          );
        }
        if (normalAtlasTexture) {
          saveTexture(normalAtlasTexture, "normalAtlas.png").catch((err) =>
            console.error("Failed to save normal atlas:", err)
          );
        }
      } else {
        diffuseAtlasTexture = new Texture("/texture/diffuseAtlas.png", scene, {
          noMipmap: false,
          samplingMode: Texture.NEAREST_SAMPLINGMODE,
        });
        normalAtlasTexture = new Texture("/texture/normalAtlas.png", scene, {
          noMipmap: false,
          samplingMode: Texture.NEAREST_SAMPLINGMODE,
        });
      }

      if (diffuseAtlasTexture) {
        // Register the shader with Babylon's Effect system
        Effect.ShadersStore["chunkVertexShader"] =
          DiffuseOnlyShader.chunkVertexShader;
        Effect.ShadersStore["chunkFragmentShader"] =
          DiffuseOnlyShader.chunkFragmentShader;

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
        mat.setPrePassRenderer(scene.prePassRenderer!);
        mat.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);

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

    // Apply the vertex data to the mesh. Setting 'updatable' to false is a performance
    // optimization for static geometry like chunks, as it allows the GPU to store
    // the data in a more efficient way for rendering.
    vertexData.applyToMesh(mesh, false);

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
      { mass: 0 },
      Map1.mainScene
    );

    chunk.mesh = mesh;
  }
}
