import {
  Mesh,
  VertexBuffer,
  Effect,
  PhysicsAggregate,
  PhysicsShapeType,
  Texture,
  Material,
  Vector2,
  Vector3,
  BoundingInfo,
  AbstractMesh,
} from "@babylonjs/core";
import { Map1 } from "@/code/Maps/Map1";
import { TextureAtlasFactory } from "../Texture/TextureAtlasFactory";
import { WorldEnvironment } from "../../Maps/WorldEnvironment";

import { Chunk } from "./Chunk";
import { GlobalValues } from "../GlobalValues";
import { ShaderMaterial } from "@babylonjs/core";
import { MeshData } from "./DataStructures/MeshData";
import { DiffuseNormalShader } from "../Light/DiffuseNormalShader";
import { WaterShader } from "../Light/WaterShader";
import { GlassShader } from "../Light/GlassShader";

export class ChunkMesher {
  static #atlasMaterial: Material | null = null;
  static #waterMaterial: Material | null = null;
  static #glassMaterial: Material | null = null;

  // Cache global uniforms
  static #cachedUniforms = {
    lightDirection: new Vector3(0, 1, 0),
    cameraPosition: new Vector3(0, 0, 0),
    screenSize: new Vector2(1920, 1080),
    cameraPlanes: new Vector2(0.1, 1000),
    time: 0,
    sunLightIntensity: 1.0,
    wetness: 0,
  };

  private static lastUpdateFrame = -1;

  static initAtlas() {
    if (!ChunkMesher.#atlasMaterial) {
      let diffuseAtlasTexture: Texture | null = null;
      let normalAtlasTexture: Texture | null = null;
      const scene = Map1.mainScene;

      diffuseAtlasTexture = TextureAtlasFactory.getDiffuse();
      normalAtlasTexture = TextureAtlasFactory.getNormal();
      if (!diffuseAtlasTexture) {
        diffuseAtlasTexture = new Texture("/texture/diffuse_atlas.png", scene, {
          noMipmap: false,
          samplingMode: Texture.NEAREST_SAMPLINGMODE,
        });
        normalAtlasTexture = new Texture("/texture/normal_atlas.png", scene, {
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

        const opaqueBlockShader = new ShaderMaterial(
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
              "cornerId",
              "ao",
              "light",
            ],
            uniforms: [
              "world",
              "worldViewProjection",
              "atlasTileSize",
              "cameraPosition",
              "lightDirection",
              "screenSize",
              "sunLightIntensity",
              "wetness",
            ],
            samplers: ["diffuseTexture", "normalTexture"],
          },
        );
        opaqueBlockShader.backFaceCulling = true;
        opaqueBlockShader.setPrePassRenderer(scene.prePassRenderer!);
        opaqueBlockShader.setFloat(
          "atlasTileSize",
          TextureAtlasFactory.atlasTileSize,
        );

        opaqueBlockShader.setTexture("diffuseTexture", diffuseAtlasTexture);
        if (normalAtlasTexture) {
          opaqueBlockShader.setTexture("normalTexture", normalAtlasTexture);
        }

        opaqueBlockShader.onBind = () => {
          const effect = opaqueBlockShader.getEffect();
          if (effect) {
            ChunkMesher.applyOpaqueUniforms(effect);
          }
        };

        ChunkMesher.#atlasMaterial = opaqueBlockShader;

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
              "cornerId",
              "ao",
              "light",
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
              "sunLightIntensity",
              "wetness",
            ],
            samplers: ["diffuseTexture", "normalTexture"],
          },
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
            ChunkMesher.applyWaterUniforms(effect);
          }
        };

        ChunkMesher.#waterMaterial = waterMat;

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
              "cornerId",
              "ao",
              "light",
            ],
            uniforms: [
              "world",
              "worldViewProjection",
              "atlasTileSize",
              "cameraPosition",
              "lightDirection",
              "cameraPlanes",
              "screenSize",
              "wetness",
            ],
            samplers: ["diffuseTexture", "normalTexture", "skyboxTexture"],
          },
        );

        glassMat.backFaceCulling = true;
        // Enable depth writing so glass occludes other glass correctly.
        glassMat.needAlphaBlending = () => true; // Enable alpha blending for transparency.

        glassMat.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
        glassMat.setTexture("diffuseTexture", diffuseAtlasTexture);
        if (normalAtlasTexture) {
          glassMat.setTexture("normalTexture", normalAtlasTexture);
        }
        glassMat.onBind = () => {
          const effect = glassMat.getEffect();
          if (effect) {
            ChunkMesher.applyGlassUniforms(effect);
          }
        };
        ChunkMesher.#glassMaterial = glassMat;
      } else {
        console.error("Texture Atlas not yet built or available!");
      }
    }
  }

  public static createMeshFromData(
    chunk: Chunk,
    meshData: { opaque: MeshData; water: MeshData; glass: MeshData },
  ) {
    // Cache the raw mesh data on the chunk instance for future saving
    // Optimization: Only keep raw data in memory if the chunk is modified and needs saving.
    if (chunk.isModified) {
      // Only cache if there is actual data to save to avoid holding empty objects
      chunk.opaqueMeshData =
        meshData.opaque.positions.length > 0 ? meshData.opaque : null;
      chunk.waterMeshData =
        meshData.water?.positions.length > 0 ? meshData.water : null;
      chunk.glassMeshData =
        meshData.glass?.positions.length > 0 ? meshData.glass : null;
    } else {
      // Only keep if actively being edited
      chunk.opaqueMeshData = null;
      chunk.waterMeshData = null;
      chunk.glassMeshData = null;
    }

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
    if (meshData.opaque.positions.length > 0) {
      chunk.mesh = this.buildMesh(
        chunk,
        meshData.opaque,
        "chunk_opaque",
        this.#atlasMaterial!,
      );
    } else {
      chunk.mesh = null;
    }

    // Handle water mesh
    if (meshData.water?.positions.length > 0) {
      chunk.waterMesh = this.buildMesh(
        chunk,
        meshData.water,
        "chunk_water",
        this.#waterMaterial!,
      );
      chunk.waterMesh.isPickable = false;
    } else {
      chunk.waterMesh = null;
    }

    // Handle glass mesh
    if (meshData.glass?.positions.length > 0) {
      chunk.glassMesh = this.buildMesh(
        chunk,
        meshData.glass,
        "chunk_glass",
        this.#glassMaterial!,
      );
    } else {
      chunk.glassMesh = null;
    }
  }

  private static buildMesh(
    chunk: Chunk,
    meshData: MeshData,
    name: string,
    material: Material,
  ): Mesh {
    const mesh = new Mesh(name, Map1.mainScene);
    mesh.renderingGroupId = 1;

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
      false, // normalized
    );
    mesh.setVerticesBuffer(positionBuffer);

    // Create VertexBuffer for normals (now faceId: 1 component)
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
      true,
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
      false,
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
      false,
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
      false, // normalized
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
      false, // normalized
    );
    mesh.setVerticesBuffer(aoBuffer);

    // Create VertexBuffer for light (Uint8)
    const lightBuffer = new VertexBuffer(
      engine,
      meshData.light,
      "light",
      false, // updatable
      undefined, // postpone
      1, // stride
      false, // instanced
      undefined, // offset
      undefined, // size
      VertexBuffer.UNSIGNED_BYTE,
      false, // normalized
    );
    mesh.setVerticesBuffer(lightBuffer);

    mesh.setIndices(meshData.indices);

    if (mesh.material) {
      (mesh.material as ShaderMaterial).wireframe = GlobalValues.DEBUG;
    }

    mesh.position.set(
      chunk.chunkX * Chunk.SIZE,
      chunk.chunkY * Chunk.SIZE,
      chunk.chunkZ * Chunk.SIZE,
    );

    const chunkMax = new Vector3(Chunk.SIZE, Chunk.SIZE, Chunk.SIZE);
    mesh.setBoundingInfo(new BoundingInfo(Vector3.Zero(), chunkMax));

    // Optimization: Use sphere culling for faster visibility checks on cubic chunks
    mesh.cullingStrategy = AbstractMesh.CULLINGSTRATEGY_STANDARD;

    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.ignoreNonUniformScaling = true;
    mesh.checkCollisions = false;
    mesh.freezeNormals();

    // Create physics aggregate AFTER the world matrix is set.
    if (name === "chunk_opaque" || name === "chunk_glass") {
      // For voxel engines, MESH is necessary but needs proper setup
      new PhysicsAggregate(
        mesh,
        PhysicsShapeType.MESH,
        {
          mass: 0,
          restitution: 0.0,
          friction: 0.8,
        },
        Map1.mainScene,
      );
    }

    return mesh;
  }

  // Apply uniforms using cached values (no expensive operations)
  private static applyOpaqueUniforms(effect: Effect) {
    effect.setVector3("lightDirection", this.#cachedUniforms.lightDirection);
    effect.setVector3("cameraPosition", this.#cachedUniforms.cameraPosition);
    effect.setVector2("screenSize", this.#cachedUniforms.screenSize);
    effect.setFloat(
      "sunLightIntensity",
      this.#cachedUniforms.sunLightIntensity,
    );
    effect.setFloat("wetness", this.#cachedUniforms.wetness);
  }

  private static applyWaterUniforms(effect: Effect) {
    effect.setVector3("lightDirection", this.#cachedUniforms.lightDirection);
    effect.setVector3("cameraPosition", this.#cachedUniforms.cameraPosition);
    effect.setVector2("cameraPlanes", this.#cachedUniforms.cameraPlanes);
    effect.setVector2("screenSize", this.#cachedUniforms.screenSize);
    effect.setFloat("time", this.#cachedUniforms.time);
    effect.setFloat(
      "sunLightIntensity",
      this.#cachedUniforms.sunLightIntensity,
    );
    effect.setFloat("wetness", this.#cachedUniforms.wetness);
  }

  private static applyGlassUniforms(effect: Effect) {
    effect.setVector3("lightDirection", this.#cachedUniforms.lightDirection);
    effect.setVector3("cameraPosition", this.#cachedUniforms.cameraPosition);
    effect.setVector2("cameraPlanes", this.#cachedUniforms.cameraPlanes);
    effect.setVector2("screenSize", this.#cachedUniforms.screenSize);
    effect.setFloat("wetness", this.#cachedUniforms.wetness);
  }

  static updateGlobalUniforms(frameId: number) {
    // Skip if already updated this frame
    if (this.lastUpdateFrame === frameId) {
      return;
    }
    this.lastUpdateFrame = frameId;

    const scene = Map1.mainScene;
    if (!scene) return;
    const camera = scene.activeCamera;
    if (!camera) return;
    const engine = scene.getEngine();

    const lightDir = GlobalValues.skyLightDirection;
    // Ensure cached light direction is normalized on the CPU so shaders can skip per-pixel normalize()
    const tmpLight = new Vector3(
      lightDir.x,
      lightDir.y,
      lightDir.z,
    ).normalize();
    this.#cachedUniforms.lightDirection.x = tmpLight.x;
    this.#cachedUniforms.lightDirection.y = tmpLight.y;
    this.#cachedUniforms.lightDirection.z = tmpLight.z;
    const camPos = camera.position;
    this.#cachedUniforms.cameraPosition.x = camPos.x;
    this.#cachedUniforms.cameraPosition.y = camPos.y;
    this.#cachedUniforms.cameraPosition.z = camPos.z;

    this.#cachedUniforms.screenSize.set(
      engine.getRenderWidth(),
      engine.getRenderHeight(),
    );

    this.#cachedUniforms.cameraPlanes.set(camera.minZ, camera.maxZ);
    this.#cachedUniforms.time = performance.now() / 1000.0;

    const sunElevation = -lightDir.y + 0.1;
    this.#cachedUniforms.sunLightIntensity = Math.min(
      1.0,
      Math.max(0.1, sunElevation * 4),
    );
    if (WorldEnvironment.instance) {
      this.#cachedUniforms.wetness = WorldEnvironment.instance.wetness;
    }
  }
}
