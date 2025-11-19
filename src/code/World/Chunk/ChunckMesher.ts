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
import { DiffuseNormalShader } from "../Light/DiffuseNormalShader";
import { TransparentNormalShader } from "../Light/TransparentNormalShader";

export type StitchedMesh = {
  opaque: MeshData;
  transparent: MeshData;
};

export class ChunkMesher {
  private static atlasMaterial: Material | null = null;
  private static transparentAtlasMaterial: Material | null = null;

  static initAtlas() {
    // Check if both materials are already initialized
    if (!ChunkMesher.atlasMaterial || !ChunkMesher.transparentAtlasMaterial) {
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
          DiffuseNormalShader.chunkVertexShader;
        Effect.ShadersStore["chunkFragmentShader"] =
          DiffuseNormalShader.chunkFragmentShader;
        // Register the new transparent shader
        Effect.ShadersStore["transparentChunkFragmentShader"] =
          TransparentNormalShader.chunkFragmentShader;

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

        ChunkMesher.atlasMaterial = mat;

        // Create a separate material for transparent meshes
        const transparentMat = new ShaderMaterial(
          "transparentChunkShaderMaterial",
          scene,
          {
            vertex: "chunk", // Reuse the same vertex shader
            fragment: "transparentChunk", // Use our new fragment shader
          },
          {
            attributes: ["position", "normal", "uv", "uv2", "uv3", "tangent"],
            uniforms: [
              "world",
              "worldViewProjection",
              "atlasTileSize",
              "cameraPosition",
              "lightDirection",
              "time", // Add time for animation
            ],
            samplers: ["diffuseTexture", "normalTexture"],
          }
        );

        transparentMat.backFaceCulling = false; // Render both sides for water surface
        transparentMat.forceDepthWrite = false; // Don't write to depth buffer
        transparentMat.needAlphaBlending = () => true; // Enable alpha blending

        // --- Z-Fighting Fix ---
        // Apply a small negative offset to the depth value of the transparent material.
        // This "pulls" the water surface slightly closer to the camera, ensuring it wins the depth test against the opaque block face behind it.
        transparentMat.zOffset = -1;

        // Set its textures and properties, just like the opaque material
        transparentMat.setFloat(
          "atlasTileSize",
          TextureAtlasFactory.atlasTileSize
        );
        transparentMat.setTexture("diffuseTexture", diffuseAtlasTexture);
        if (normalAtlasTexture) {
          transparentMat.setTexture("normalTexture", normalAtlasTexture);
        }

        // Create a dedicated onBind for the transparent material to pass the time uniform
        transparentMat.onBind = (mesh) => {
          const effect = transparentMat.getEffect();
          if (effect) {
            // Set shared uniforms
            effect.setVector3("lightDirection", GlobalValues.skyLightDirection);
            effect.setVector3(
              "cameraPosition",
              Map1.mainScene.activeCamera!.position
            );
            effect.setFloat("time", performance.now() / 1000.0); // Pass current time in seconds
          }
        };

        ChunkMesher.transparentAtlasMaterial = transparentMat;
      } else {
        console.error("Texture Atlas not yet built or available!");
      }
    }
  }

  public static createMeshFromData(
    chunk: Chunk,
    meshData: { opaque: MeshData; transparent: MeshData }
  ) {
    // Dispose of old meshes
    if (chunk.mesh) {
      chunk.mesh.dispose();
    }
    if (chunk.transparentMesh) {
      chunk.transparentMesh.dispose();
    }

    // Handle opaque mesh
    if (meshData.opaque.positions.length === 0) {
      chunk.mesh = null;
    } else {
      const opaqueMesh = this.buildMesh(
        chunk,
        meshData.opaque,
        "chunk_opaque",
        this.atlasMaterial!
      );
      chunk.mesh = opaqueMesh;

      // Physics should only be on the solid, opaque mesh
      new PhysicsAggregate(
        opaqueMesh,
        PhysicsShapeType.MESH,
        { mass: 0 },
        Map1.mainScene
      );
    }

    // Handle transparent mesh
    if (meshData.transparent.positions.length > 0) {
      chunk.transparentMesh = this.buildMesh(
        chunk,
        meshData.transparent,
        "chunk_transparent",
        this.transparentAtlasMaterial!
      );
    } else {
      chunk.transparentMesh = null;
    }
  }

  public static stitchBorderMesh(chunk: Chunk, borderMesh: StitchedMesh) {
    if (borderMesh.opaque.positions.length > 0 && chunk.mesh) {
      const mainVD = VertexData.ExtractFromMesh(chunk.mesh);
      const borderVD = new VertexData();
      borderVD.positions = borderMesh.opaque.positions;
      borderVD.indices = borderMesh.opaque.indices;
      borderVD.normals = borderMesh.opaque.normals;
      borderVD.uvs = borderMesh.opaque.uvs;
      borderVD.uvs2 = borderMesh.opaque.uvs2;
      borderVD.uvs3 = borderMesh.opaque.uvs3;
      mainVD.merge(borderVD);
      mainVD.applyToMesh(chunk.mesh);
    }
    if (borderMesh.transparent.positions.length > 0 && chunk.transparentMesh) {
      const mainVD = VertexData.ExtractFromMesh(chunk.transparentMesh);
      const borderVD = new VertexData();
      borderVD.positions = borderMesh.transparent.positions;
      borderVD.indices = borderMesh.transparent.indices;
      borderVD.normals = borderMesh.transparent.normals;
      borderVD.uvs = borderMesh.transparent.uvs;
      borderVD.uvs2 = borderMesh.transparent.uvs2;
      borderVD.uvs3 = borderMesh.transparent.uvs3;
      mainVD.merge(borderVD);
      mainVD.applyToMesh(chunk.transparentMesh);
    }
  }

  private static buildMesh(
    chunk: Chunk,
    meshData: MeshData,
    name: string,
    material: Material
  ): Mesh {
    const mesh = new Mesh(name, Map1.mainScene);
    mesh.material = material;

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

    return mesh;
  }
}
