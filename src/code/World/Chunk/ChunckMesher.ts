import {
  Mesh,
  VertexBuffer,
  Effect,
  Material,
  PhysicsAggregate,
  PhysicsShapeType,
  Texture,
  Tools,
  CubeTexture,
  DepthRenderer,
  Vector2,
} from "@babylonjs/core";
import "@babylonjs/core/Rendering/depthRendererSceneComponent"; // For getDepthRenderer
import { Map1 } from "@/code/Maps/Map1";
import { TextureAtlasFactory } from "../Texture/TextureAtlasFactory";

import { Chunk } from "./Chunk";
import { GlobalValues } from "../GlobalValues";
//import { DiffuseOnlyShader } from "../Light/DiffuseOnlyShader";
import { ShaderMaterial } from "@babylonjs/core";
import { MeshData } from "./MeshData";
import { DiffuseNormalShader } from "../Light/DiffuseNormalShader";
import { WaterShader } from "../Light/WaterShader";
import { GlassShader } from "../Light/GlassShader";

export class ChunkMesher {
  private static atlasMaterial: Material | null = null;
  private static waterMaterial: Material | null = null;
  private static glassMaterial: Material | null = null;
  private static depthRenderer: DepthRenderer | null = null;

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
        // Register the water and glass shaders
        Effect.ShadersStore["waterChunkFragmentShader"] =
          WaterShader.chunkFragmentShader;
        Effect.ShadersStore["glassChunkFragmentShader"] =
          GlassShader.chunkFragmentShader;

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
              "ao",
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

        mat.onBind = () => {
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

        // Create a separate material for water meshes
        const waterMat = new ShaderMaterial(
          "waterChunkShaderMaterial",
          scene,
          {
            vertex: "chunk", // Reuse the same vertex shader
            fragment: "waterChunk", // Use our water fragment shader
          },
          {
            attributes: [
              "position",
              "normal",
              "uv2",
              "uv3",
              "tangent",
              "cornerId",
              "ao",
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

        waterMat.backFaceCulling = false;
        waterMat.forceDepthWrite = false;
        waterMat.needAlphaBlending = () => true; // Enable alpha blending

        waterMat.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
        waterMat.setTexture("diffuseTexture", diffuseAtlasTexture);
        if (normalAtlasTexture) {
          waterMat.setTexture("normalTexture", normalAtlasTexture);
        }

        waterMat.onBind = () => {
          const effect = waterMat.getEffect();
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

        ChunkMesher.waterMaterial = waterMat;

        // Create a separate material for glass meshes
        const glassMat = new ShaderMaterial(
          "glassChunkShaderMaterial",
          scene,
          {
            vertex: "chunk", // Reuse the same vertex shader
            fragment: "glassChunk", // Use our glass fragment shader
          },
          {
            attributes: [
              "position",
              "normal",
              "uv2",
              "uv3",
              "tangent",
              "cornerId",
              "ao",
            ],
            uniforms: [
              "world",
              "worldViewProjection",
              "atlasTileSize",
              "cameraPosition",
              "lightDirection",
              "cameraPlanes",
              "screenSize",
            ],
            samplers: [
              "diffuseTexture",
              "normalTexture",
              "depthSampler",
              "skyboxTexture",
            ],
          }
        );

        glassMat.backFaceCulling = true;
        // Enable depth writing so glass occludes other glass correctly.
        glassMat.forceDepthWrite = true;
        glassMat.needAlphaBlending = () => true; // Enable alpha blending for transparency.

        glassMat.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
        glassMat.setTexture("diffuseTexture", diffuseAtlasTexture);
        if (normalAtlasTexture) {
          glassMat.setTexture("normalTexture", normalAtlasTexture);
        }

        // Find and set the skybox texture for reflections
        if (
          scene.environmentTexture &&
          scene.environmentTexture instanceof CubeTexture
        ) {
          glassMat.setTexture("skyboxTexture", scene.environmentTexture);
        }

        glassMat.onBind = () => {
          const effect = glassMat.getEffect();
          if (effect) {
            effect.setVector3("lightDirection", GlobalValues.skyLightDirection);
            effect.setVector3(
              "cameraPosition",
              Map1.mainScene.activeCamera!.position
            );
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
            const depthMap = ChunkMesher.depthRenderer?.getDepthMap();
            if (depthMap) {
              effect.setTexture("depthSampler", depthMap);
            }
          }
        };
        ChunkMesher.glassMaterial = glassMat;
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
    meshData: { opaque: MeshData; water: MeshData; glass: MeshData }
  ) {
    if (!chunk.isLoaded) return;

    // Cache the raw mesh data on the chunk instance for future saving
    chunk.opaqueMeshData = meshData.opaque;
    chunk.waterMeshData = meshData.water;
    chunk.glassMeshData = meshData.glass;

    // Dispose of old meshes
    if (chunk.mesh) {
      chunk.mesh.dispose();
    }
    if (chunk.waterMesh) {
      chunk.waterMesh.dispose();
    }
    if (chunk.glassMesh) {
      chunk.glassMesh.dispose();
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

    // Handle water mesh
    if (meshData.water.positions.length > 0) {
      chunk.waterMesh = this.buildMesh(
        chunk,
        meshData.water,
        "chunk_water",
        this.waterMaterial!
      );
    } else {
      chunk.waterMesh = null;
    }

    // Handle glass mesh
    if (meshData.glass.positions.length > 0) {
      chunk.glassMesh = this.buildMesh(
        chunk,
        meshData.glass,
        "chunk_glass",
        this.glassMaterial!
      );
    } else {
      chunk.glassMesh = null;
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

    // Create VertexBuffer for ao (Uint8)
    const aoBuffer = new VertexBuffer(
      engine,
      meshData.ao,
      "ao",
      false, // updatable
      undefined, // postpone
      1, // stride
      false, // instanced
      undefined, // offset
      undefined, // size
      VertexBuffer.UNSIGNED_BYTE,
      false // normalized
    );
    mesh.setVerticesBuffer(aoBuffer);

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
    if (name === "chunk_opaque" || name === "chunk_glass") {
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
