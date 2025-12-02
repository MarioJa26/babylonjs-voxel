import {
  Mesh,
  VertexBuffer,
  Effect,
  Material,
  PhysicsAggregate,
  PhysicsShapeType,
  Texture,
  Tools,
  DepthRenderer,
  Vector2,
} from "@babylonjs/core";
import "@babylonjs/core/Rendering/depthRendererSceneComponent"; // For getDepthRenderer
import { Map1 } from "@/code/Maps/Map1";
import { TextureAtlasFactory } from "../Texture/TextureAtlasFactory";

import { Chunk } from "./Chunk";
import { GlobalValues } from "../GlobalValues";
import { DiffuseOnlyShader } from "../Light/DiffuseOnlyShader";
import { ShaderMaterial } from "@babylonjs/core";
import { MeshData } from "./MeshData";
import { DiffuseNormalShader } from "../Light/DiffuseNormalShader";
import { TransparentNormalShader } from "../Light/TransparentNormalShader";

export class ChunkMesher {
  private static atlasMaterial: Material | null = null;
  private static transparentAtlasMaterial: Material | null = null;
  private static depthRenderer: DepthRenderer | null = null;

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
          await new Promise<void>((resolve) => {
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
            attributes: [
              "position",
              "normal",
              "uv2",
              "uv3",
              "tangent",
              "cornerId",
            ],
            uniforms: [
              "world",
              "worldViewProjection",
              "atlasTileSize",
              "cameraPosition",
              "lightDirection",
              "screenSize",
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
            effect.setVector2(
              "screenSize",
              new Vector2(
                Map1.mainScene.getEngine().getRenderWidth(),
                Map1.mainScene.getEngine().getRenderHeight()
              )
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
            attributes: [
              "position",
              "normal",
              "uv2",
              "uv3",
              "tangent",
              "cornerId",
            ],
            uniforms: [
              "world",
              "worldViewProjection",
              "atlasTileSize",
              "cameraPosition",
              "lightDirection",
              "time", // Add time for animation,
              "cameraPlanes", // for depth calculation
              "screenSize", // for depth calculation
            ],
            samplers: ["diffuseTexture", "normalTexture", "depthSampler"],
          }
        );

        transparentMat.backFaceCulling = false;
        transparentMat.forceDepthWrite = false;
        transparentMat.needAlphaBlending = () => true; // Enable alpha blending

        transparentMat.setFloat(
          "atlasTileSize",
          TextureAtlasFactory.atlasTileSize
        );
        transparentMat.setTexture("diffuseTexture", diffuseAtlasTexture);
        if (normalAtlasTexture) {
          transparentMat.setTexture("normalTexture", normalAtlasTexture);
        }

        transparentMat.onBind = (mesh) => {
          const effect = transparentMat.getEffect();
          if (effect) {
            effect.setVector3("lightDirection", GlobalValues.skyLightDirection);
            effect.setVector3(
              "cameraPosition",
              Map1.mainScene.activeCamera!.position
            );
            effect.setFloat("time", performance.now() / 1000.0); // Pass current time in seconds
            effect.setVector2(
              "cameraPlanes",
              new Vector2(
                Map1.mainScene.activeCamera!.minZ,
                Map1.mainScene.activeCamera!.maxZ
              )
            );
            effect.setVector2(
              "screenSize",
              new Vector2(
                Map1.mainScene.getEngine().getRenderWidth(),
                Map1.mainScene.getEngine().getRenderHeight()
              )
            );

            // This is the crucial step: bind the depth map to the sampler
            const depthMap = ChunkMesher.depthRenderer?.getDepthMap();
            if (depthMap) {
              effect.setTexture("depthSampler", depthMap);
            }
          }
        };

        ChunkMesher.transparentAtlasMaterial = transparentMat;
      } else {
        console.error("Texture Atlas not yet built or available!");
      }

      if (!ChunkMesher.depthRenderer) {
        ChunkMesher.depthRenderer = scene.enableDepthRenderer();
      }
    }
  }

  public static createMeshFromData(
    chunk: Chunk,
    meshData: { opaque: MeshData; transparent: MeshData }
  ) {
    if (!chunk.isLoaded) return;

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

  private static buildMesh(
    chunk: Chunk,
    meshData: MeshData,
    name: string,
    material: Material
  ): Mesh {
    const mesh = new Mesh(name, Map1.mainScene);
    mesh.material = material;

    const engine = Map1.mainScene.getEngine();

    // Create VertexBuffer for positions (Uint8)
    const positionBuffer = new VertexBuffer(
      engine,
      meshData.positions,
      VertexBuffer.PositionKind,
      false, // updatable
      undefined, // postpone
      3, // stride
      false, // instanced
      undefined, // offset
      undefined, // size
      VertexBuffer.UNSIGNED_BYTE, // type
      false // normalized
    );
    mesh.setVerticesBuffer(positionBuffer);

    // Create VertexBuffer for normals (Int8)
    const normalBuffer = new VertexBuffer(
      engine,
      meshData.normals,
      VertexBuffer.NormalKind,
      false,
      undefined,
      3,
      false,
      undefined,
      undefined,
      VertexBuffer.UNSIGNED_BYTE,
      true
    );
    mesh.setVerticesBuffer(normalBuffer);

    const uv2Buffer = new VertexBuffer(
      engine,
      meshData.uvs2,
      "uv2",
      false,
      undefined,
      2,
      false,
      undefined,
      undefined,
      VertexBuffer.UNSIGNED_BYTE,
      false
    );
    mesh.setVerticesBuffer(uv2Buffer);

    const uv3Buffer = new VertexBuffer(
      engine,
      meshData.uvs3,
      "uv3",
      false,
      undefined,
      2,
      false,
      undefined,
      undefined,
      VertexBuffer.UNSIGNED_BYTE,
      false
    );
    mesh.setVerticesBuffer(uv3Buffer);

    // Create VertexBuffer for cornerId (Uint8)
    const cornerIdBuffer = new VertexBuffer(
      engine,
      meshData.cornerIds,
      "cornerId",
      false,
      undefined,
      1,
      false,
      undefined,
      undefined,
      VertexBuffer.UNSIGNED_BYTE,
      false // normalized
    );
    mesh.setVerticesBuffer(cornerIdBuffer);

    mesh.setIndices(meshData.indices);

    // Create VertexBuffer for tangents (Int8)
    const tangentBuffer = new VertexBuffer(
      engine,
      meshData.tangents,
      VertexBuffer.TangentKind,
      false,
      undefined,
      4,
      false,
      undefined,
      undefined,
      VertexBuffer.BYTE,
      true
    );
    mesh.setVerticesBuffer(tangentBuffer);

    if (mesh.material) {
      (mesh.material as ShaderMaterial).wireframe = GlobalValues.DEBUG;
    }

    mesh.position.set(
      chunk.chunkX * Chunk.SIZE,
      chunk.chunkY * Chunk.SIZE,
      chunk.chunkZ * Chunk.SIZE
    );

    // Create physics aggregate AFTER the world matrix is set.
    // Only for opaque meshes.
    if (name === "chunk_opaque") {
      new PhysicsAggregate(
        mesh,
        PhysicsShapeType.MESH,
        { mass: 0 },
        Map1.mainScene
      );
    }

    return mesh;
  }
}
