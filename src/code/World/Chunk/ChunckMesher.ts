import {
  Mesh,
  VertexBuffer,
  Buffer,
  Effect,
  Texture,
  Material,
  Vector2,
  Vector3,
  BoundingInfo,
  AbstractMesh,
  UniformBuffer,
} from "@babylonjs/core";

import { Map1 } from "@/code/Maps/Map1";
import { TextureAtlasFactory } from "../Texture/TextureAtlasFactory";
import { WorldEnvironment } from "../../Maps/WorldEnvironment";
import { GlobalValues } from "../GlobalValues";
import { ShaderMaterial } from "@babylonjs/core";
import { OpaqueShader } from "../Light/OpaqueShader";
import { TransparentShader } from "../Light/TransparentShader";
import { Lod3Shader } from "../Light/Lod3Shader";
import { TextureCache } from "../Texture/TextureCache";
import { Chunk } from "./Chunk";
import { MeshData } from "./DataStructures/MeshData";

export class ChunkMesher {
  static #atlasMaterial: Material | null = null;
  static #transparentMaterial: Material | null = null;
  static #lod3OpaqueMaterial: Material | null = null;
  static #lod3TransparentMaterial: Material | null = null;
  static #globalUniformBuffer: UniformBuffer | null = null;
  static #sharedFacePositionBuffer: Buffer | null = null;

  // Cache global uniforms — updated once per frame.
  static #cachedUniforms = {
    lightDirection: new Vector3(0, 1, 0),
    cameraPosition: new Vector3(0, 0, 0),
    cameraPlanes: new Vector2(0.1, 1000),
    time: 0,
    sunLightIntensity: 1.0,
    wetness: 0,
  };

  // OPTIMIZATION: Scratch Vector3 reused in updateGlobalUniforms to avoid
  // allocating a new object every frame when normalizing the light direction.
  private static _tmpLightDir = new Vector3(0, 0, 0);

  private static lastUpdateFrame = -1;
  private static readonly FACE_VERTEX_TEMPLATE = new Float32Array([
    0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 5, 0, 0,
  ]);
  private static readonly FACE_INDEX_TEMPLATE = new Uint16Array([
    0, 1, 2, 3, 4, 5,
  ]);

  static initAtlas() {
    const scene = Map1.mainScene;
    if (!scene) {
      console.error("ChunkMesher.initAtlas(): scene is not available.");
      return;
    }

    let diffuseAtlasTexture = TextureAtlasFactory.getDiffuse();
    let normalAtlasTexture = TextureAtlasFactory.getNormal();

    if (!diffuseAtlasTexture) {
      if (GlobalValues.CACHE_TEXTURES) {
        diffuseAtlasTexture = this.createCachedTexture(
          "/texture/diffuse_atlas.png",
          scene,
          {
            noMipmap: false,
            samplingMode: Texture.NEAREST_SAMPLINGMODE,
          },
        );
        normalAtlasTexture = this.createCachedTexture(
          "/texture/normal_atlas.png",
          scene,
          {
            noMipmap: false,
            samplingMode: Texture.NEAREST_SAMPLINGMODE,
          },
        );
      } else {
        diffuseAtlasTexture = new Texture("/texture/diffuse_atlas.png", scene, {
          noMipmap: false,
          samplingMode: Texture.NEAREST_SAMPLINGMODE,
        });
        normalAtlasTexture = new Texture("/texture/normal_atlas.png", scene, {
          noMipmap: false,
          samplingMode: Texture.NEAREST_SAMPLINGMODE,
        });
      }

      TextureAtlasFactory.setDiffuse(diffuseAtlasTexture);
      TextureAtlasFactory.setNormal(normalAtlasTexture);
    }

    if (!diffuseAtlasTexture) {
      console.error("Texture Atlas not yet built or available!");
      return;
    }

    Effect.ShadersStore["chunkVertexShader"] = OpaqueShader.chunkVertexShader;
    Effect.ShadersStore["chunkFragmentShader"] =
      OpaqueShader.chunkFragmentShader;
    Effect.ShadersStore["transparentChunkFragmentShader"] =
      TransparentShader.chunkFragmentShader;
    Effect.ShadersStore["lod3ChunkVertexShader"] = Lod3Shader.chunkVertexShader;
    Effect.ShadersStore["lod3ChunkFragmentShader"] =
      Lod3Shader.opaqueFragmentShader;
    Effect.ShadersStore["lod3TransparentChunkFragmentShader"] =
      Lod3Shader.transparentFragmentShader;

    if (!this.#globalUniformBuffer) {
      const engine = scene.getEngine();
      this.#globalUniformBuffer = new UniformBuffer(
        engine,
        undefined,
        true,
        "GlobalUniforms",
      );
      this.#globalUniformBuffer.addUniform("lightDirection", 3);
      this.#globalUniformBuffer.addUniform("cameraPosition", 3);
      this.#globalUniformBuffer.addUniform("sunLightIntensity", 1);
      this.#globalUniformBuffer.addUniform("wetness", 1);
      this.#globalUniformBuffer.addUniform("time", 1);
      this.#globalUniformBuffer.create();
    }

    if (!this.#atlasMaterial) {
      const opaqueBlockShader = new ShaderMaterial(
        "chunkShaderMaterial",
        scene,
        { vertex: "chunk", fragment: "chunk" },
        {
          attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
          uniforms: [
            "world",
            "worldViewProjection",
            "atlasTileSize",
            "maxAtlasTiles",
          ],
          uniformBuffers: ["GlobalUniforms"],
          samplers: ["diffuseTexture", "normalTexture"],
        },
      );

      opaqueBlockShader.backFaceCulling = true;
      opaqueBlockShader.setPrePassRenderer(scene.prePassRenderer!);
      opaqueBlockShader.setFloat(
        "atlasTileSize",
        TextureAtlasFactory.atlasTileSize,
      );
      opaqueBlockShader.setFloat(
        "maxAtlasTiles",
        TextureAtlasFactory.atlasSize,
      );
      opaqueBlockShader.setTexture("diffuseTexture", diffuseAtlasTexture);
      if (normalAtlasTexture) {
        opaqueBlockShader.setTexture("normalTexture", normalAtlasTexture);
      }
      opaqueBlockShader.setUniformBuffer(
        "GlobalUniforms",
        this.#globalUniformBuffer,
      );
      opaqueBlockShader.wireframe = GlobalValues.DEBUG;
      opaqueBlockShader.freeze();

      this.#atlasMaterial = opaqueBlockShader;
    } else {
      const opaqueMat = this.#atlasMaterial as ShaderMaterial;
      if (opaqueMat.isFrozen) opaqueMat.unfreeze();
      opaqueMat.wireframe = GlobalValues.DEBUG;
      opaqueMat.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
      opaqueMat.setFloat("maxAtlasTiles", TextureAtlasFactory.atlasSize);
      opaqueMat.setTexture("diffuseTexture", diffuseAtlasTexture);
      if (normalAtlasTexture) {
        opaqueMat.setTexture("normalTexture", normalAtlasTexture);
      }
      opaqueMat.setUniformBuffer("GlobalUniforms", this.#globalUniformBuffer);
      opaqueMat.freeze();
    }

    if (!this.#transparentMaterial) {
      const transparentMat = new ShaderMaterial(
        "transparentChunkShaderMaterial",
        scene,
        { vertex: "chunk", fragment: "transparentChunk" },
        {
          attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
          uniforms: ["world", "worldViewProjection", "atlasTileSize"],
          uniformBuffers: ["GlobalUniforms"],
          samplers: ["diffuseTexture", "normalTexture"],
        },
      );

      transparentMat.backFaceCulling = false;
      transparentMat.forceDepthWrite = false;
      transparentMat.needAlphaBlending = () => true;
      transparentMat.setFloat(
        "atlasTileSize",
        TextureAtlasFactory.atlasTileSize,
      );
      transparentMat.setTexture("diffuseTexture", diffuseAtlasTexture);
      if (normalAtlasTexture) {
        transparentMat.setTexture("normalTexture", normalAtlasTexture);
      }
      transparentMat.setUniformBuffer(
        "GlobalUniforms",
        this.#globalUniformBuffer,
      );
      transparentMat.wireframe = GlobalValues.DEBUG;
      transparentMat.freeze();

      this.#transparentMaterial = transparentMat;
    } else {
      const transparentMat = this.#transparentMaterial as ShaderMaterial;
      if (transparentMat.isFrozen) transparentMat.unfreeze();
      transparentMat.wireframe = GlobalValues.DEBUG;
      transparentMat.setFloat(
        "atlasTileSize",
        TextureAtlasFactory.atlasTileSize,
      );
      transparentMat.setTexture("diffuseTexture", diffuseAtlasTexture);
      if (normalAtlasTexture) {
        transparentMat.setTexture("normalTexture", normalAtlasTexture);
      }
      transparentMat.setUniformBuffer(
        "GlobalUniforms",
        this.#globalUniformBuffer,
      );
      transparentMat.freeze();
    }

    if (!this.#lod3OpaqueMaterial) {
      const lod3Opaque = new ShaderMaterial(
        "lod3ChunkShaderMaterial",
        scene,
        { vertex: "lod3Chunk", fragment: "lod3Chunk" },
        {
          attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
          uniforms: ["worldViewProjection", "atlasTileSize"],
          uniformBuffers: ["GlobalUniforms"],
          samplers: ["diffuseTexture"],
        },
      );

      lod3Opaque.backFaceCulling = true;
      lod3Opaque.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
      lod3Opaque.setTexture("diffuseTexture", diffuseAtlasTexture);
      lod3Opaque.setUniformBuffer("GlobalUniforms", this.#globalUniformBuffer);
      lod3Opaque.wireframe = GlobalValues.DEBUG;
      lod3Opaque.freeze();

      this.#lod3OpaqueMaterial = lod3Opaque;
    } else {
      const lod3Opaque = this.#lod3OpaqueMaterial as ShaderMaterial;
      if (lod3Opaque.isFrozen) lod3Opaque.unfreeze();
      lod3Opaque.wireframe = GlobalValues.DEBUG;
      lod3Opaque.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
      lod3Opaque.setTexture("diffuseTexture", diffuseAtlasTexture);
      lod3Opaque.setUniformBuffer("GlobalUniforms", this.#globalUniformBuffer);
      lod3Opaque.freeze();
    }

    if (!this.#lod3TransparentMaterial) {
      const lod3Transparent = new ShaderMaterial(
        "lod3TransparentChunkShaderMaterial",
        scene,
        { vertex: "lod3Chunk", fragment: "lod3TransparentChunk" },
        {
          attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
          uniforms: ["worldViewProjection", "atlasTileSize"],
          uniformBuffers: ["GlobalUniforms"],
          samplers: ["diffuseTexture"],
        },
      );

      lod3Transparent.backFaceCulling = false;
      lod3Transparent.forceDepthWrite = false;
      lod3Transparent.needAlphaBlending = () => false;
      lod3Transparent.setFloat(
        "atlasTileSize",
        TextureAtlasFactory.atlasTileSize,
      );
      lod3Transparent.setTexture("diffuseTexture", diffuseAtlasTexture);
      lod3Transparent.setUniformBuffer(
        "GlobalUniforms",
        this.#globalUniformBuffer,
      );
      lod3Transparent.wireframe = GlobalValues.DEBUG;
      lod3Transparent.freeze();

      this.#lod3TransparentMaterial = lod3Transparent;
    } else {
      const lod3Transparent = this.#lod3TransparentMaterial as ShaderMaterial;
      if (lod3Transparent.isFrozen) lod3Transparent.unfreeze();
      lod3Transparent.wireframe = GlobalValues.DEBUG;
      lod3Transparent.setFloat(
        "atlasTileSize",
        TextureAtlasFactory.atlasTileSize,
      );
      lod3Transparent.setTexture("diffuseTexture", diffuseAtlasTexture);
      lod3Transparent.setUniformBuffer(
        "GlobalUniforms",
        this.#globalUniformBuffer,
      );
      lod3Transparent.freeze();
    }
  }
  private static ensureSharedFacePositionBuffer(): void {
    if (this.#sharedFacePositionBuffer) {
      return;
    }

    const scene = Map1.mainScene;
    const engine = scene.getEngine();

    this.#sharedFacePositionBuffer = new Buffer(
      engine,
      ChunkMesher.FACE_VERTEX_TEMPLATE,
      false,
      3,
      false,
      false,
    );
  }
  public static createMeshFromData(
    chunk: Chunk,
    meshData: {
      opaque: MeshData | null;
      transparent: MeshData | null;
    },
  ) {
    const opaqueMeshData = meshData.opaque;
    const transparentMeshData = meshData.transparent;

    const hasOpaque = !!opaqueMeshData && opaqueMeshData.faceCount > 0;
    const hasTransparent =
      !!transparentMeshData && transparentMeshData.faceCount > 0;

    // Cache raw mesh data only for chunks that may need saving.
    if (chunk.isModified) {
      chunk.opaqueMeshData = hasOpaque ? opaqueMeshData : null;
      chunk.transparentMeshData = hasTransparent ? transparentMeshData : null;
    } else {
      chunk.opaqueMeshData = null;
      chunk.transparentMeshData = null;
    }

    if (hasOpaque) {
      const opaqueMaterial =
        (chunk.lodLevel ?? 0) >= 3
          ? this.#lod3OpaqueMaterial!
          : this.#atlasMaterial!;
      chunk.mesh = this.upsertMesh(
        chunk,
        chunk.mesh,
        opaqueMeshData!,
        "c_opaque",
        opaqueMaterial,
        1,
      );
    } else if (chunk.mesh) {
      chunk.mesh.dispose();
      chunk.mesh = null;
    }

    if (hasTransparent) {
      const transparentMaterial =
        (chunk.lodLevel ?? 0) >= 3
          ? this.#lod3TransparentMaterial!
          : this.#transparentMaterial!;
      chunk.transparentMesh = this.upsertMesh(
        chunk,
        chunk.transparentMesh,
        transparentMeshData!,
        "c_transparent",
        transparentMaterial,
        1,
      );
    } else if (chunk.transparentMesh) {
      chunk.transparentMesh.dispose();
      chunk.transparentMesh = null;
    }

    if (chunk.colliderDirty) {
      chunk.colliderDirty = false;
    }
  }
  private static upsertMesh(
    chunk: Chunk,
    existingMesh: Mesh | null,
    meshData: MeshData,
    name: string,
    material: Material,
    renderingGroupId = 1,
  ): Mesh {
    const scene = Map1.mainScene;
    const engine = scene.getEngine();

    this.ensureSharedFacePositionBuffer();

    let mesh = existingMesh;

    if (!mesh) {
      mesh = new Mesh(name, scene);
      mesh.renderingGroupId = renderingGroupId;
      mesh.material = material;
      mesh.checkCollisions = false;
      mesh.isPickable = false;
      mesh.doNotSyncBoundingInfo = true;
      mesh.ignoreNonUniformScaling = true;

      // Shared static face-position buffer
      mesh.setVerticesBuffer(
        this.#sharedFacePositionBuffer!.createVertexBuffer(
          VertexBuffer.PositionKind,
          0,
          3,
          3,
          false,
          false,
          0,
        ),
      );

      // Index buffer is created once per mesh.
      mesh.setIndices(ChunkMesher.FACE_INDEX_TEMPLATE);

      mesh.position.set(
        chunk.chunkX * Chunk.SIZE,
        chunk.chunkY * Chunk.SIZE,
        chunk.chunkZ * Chunk.SIZE,
      );

      const boundsMin = Vector3.Zero();
      const boundsMax = new Vector3(Chunk.SIZE, Chunk.SIZE, Chunk.SIZE);
      mesh.setBoundingInfo(new BoundingInfo(boundsMin, boundsMax));
      mesh.cullingStrategy = AbstractMesh.CULLINGSTRATEGY_OPTIMISTIC_INCLUSION;

      mesh.freezeWorldMatrix();
    }

    mesh.renderingGroupId = renderingGroupId;
    mesh.material = material;
    mesh.name = `${name}_${chunk.chunkX}_${chunk.chunkY}_${chunk.chunkZ}`;

    this.upsertFaceVertexBuffer(mesh, engine, "faceDataA", meshData.faceDataA);
    this.upsertFaceVertexBuffer(mesh, engine, "faceDataB", meshData.faceDataB);
    this.upsertFaceVertexBuffer(mesh, engine, "faceDataC", meshData.faceDataC);

    mesh.overridenInstanceCount = meshData.faceCount;

    return mesh;
  }
  private static upsertFaceVertexBuffer(
    mesh: Mesh,
    engine: ReturnType<typeof Map1.mainScene.getEngine>,
    kind: string,
    data: Uint8Array,
  ): void {
    const bufferLengths = this.getFaceBufferLengths(mesh);
    const existing = mesh.getVertexBuffer(kind);
    const nextLength = data.length;

    // Fast path: same sized updatable buffer -> update in place
    if (
      existing &&
      existing.isUpdatable() &&
      bufferLengths[kind] === nextLength
    ) {
      existing.update(data);
      return;
    }

    // Size changed or old buffer is not updatable -> recreate
    if (existing) {
      existing.dispose();
    }

    mesh.setVerticesBuffer(
      new VertexBuffer(
        engine,
        data,
        kind,
        true, // updatable
        undefined,
        4,
        true,
        undefined,
        4,
        VertexBuffer.UNSIGNED_BYTE,
        false,
      ),
    );

    bufferLengths[kind] = nextLength;
  }
  private static getFaceBufferLengths(mesh: Mesh): Record<string, number> {
    if (!mesh.metadata || typeof mesh.metadata !== "object") {
      mesh.metadata = {};
    }

    const metadata = mesh.metadata as {
      __chunkMesherFaceBufferLengths?: Record<string, number>;
    };

    if (!metadata.__chunkMesherFaceBufferLengths) {
      metadata.__chunkMesherFaceBufferLengths = Object.create(null) as Record<
        string,
        number
      >;
    }

    return metadata.__chunkMesherFaceBufferLengths;
  }

  static updateGlobalUniforms(frameId: number) {
    if (this.lastUpdateFrame === frameId) return;
    this.lastUpdateFrame = frameId;

    const scene = Map1.mainScene;
    if (!scene || !this.#globalUniformBuffer) return;

    const camera = scene.activeCamera;
    if (!camera) return;

    const lightDir = GlobalValues.skyLightDirection;
    this._tmpLightDir
      .set(lightDir.x, lightDir.y, lightDir.z)
      .normalizeToRef(this._tmpLightDir);

    const u = this.#cachedUniforms;

    u.lightDirection.set(
      -this._tmpLightDir.x,
      -this._tmpLightDir.y,
      -this._tmpLightDir.z,
    );

    const camPos = camera.position;
    u.cameraPosition.set(camPos.x, camPos.y, camPos.z);
    u.cameraPlanes.set(camera.minZ, camera.maxZ);
    u.time = performance.now() / 1000.0;

    const sunElevation = -lightDir.y + 0.1;
    u.sunLightIntensity = Math.min(1.0, Math.max(0.1, sunElevation * 4.0));
    u.wetness = WorldEnvironment.instance
      ? WorldEnvironment.instance.wetness
      : 0;

    this.#globalUniformBuffer.updateVector3("lightDirection", u.lightDirection);
    this.#globalUniformBuffer.updateVector3("cameraPosition", u.cameraPosition);
    this.#globalUniformBuffer.updateFloat(
      "sunLightIntensity",
      u.sunLightIntensity,
    );
    this.#globalUniformBuffer.updateFloat("wetness", u.wetness);
    this.#globalUniformBuffer.updateFloat("time", u.time);
    this.#globalUniformBuffer.update();
  }

  private static createCachedTexture(
    url: string,
    scene: any,
    args: any,
  ): Texture {
    const texture = new Texture(null, scene, args);

    this.loadTextureToCache(url)
      .then((blobUrl) => {
        const revokeOnceLoaded = () => {
          try {
            URL.revokeObjectURL(blobUrl);
          } catch {
            // Ignore revoke failures.
          }
        };

        texture.onLoadObservable.addOnce(revokeOnceLoaded);
        texture.updateURL(blobUrl);
      })
      .catch((e) => {
        console.warn("Texture cache failed, falling back to network", e);
        texture.updateURL(url);
      });

    return texture;
  }

  private static async loadTextureToCache(url: string): Promise<string> {
    const cacheKey = `${url}?v=${GlobalValues.TEXTURE_VERSION}`;

    const cachedBlob = await TextureCache.get(cacheKey);
    if (cachedBlob) {
      return URL.createObjectURL(cachedBlob);
    }

    const response = await fetch(cacheKey);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch texture: ${cacheKey} (${response.status})`,
      );
    }

    const newBlob = await response.blob();
    await TextureCache.put(cacheKey, newBlob);

    return URL.createObjectURL(newBlob);
  }
  public static disposeSharedResources(): void {
    if (this.#sharedFacePositionBuffer) {
      this.#sharedFacePositionBuffer.dispose();
      this.#sharedFacePositionBuffer = null;
    }

    this.#globalUniformBuffer?.dispose();
    this.#globalUniformBuffer = null;

    this.#atlasMaterial?.dispose();
    this.#atlasMaterial = null;

    this.#transparentMaterial?.dispose();
    this.#transparentMaterial = null;

    this.#lod3OpaqueMaterial?.dispose();
    this.#lod3OpaqueMaterial = null;

    this.#lod3TransparentMaterial?.dispose();
    this.#lod3TransparentMaterial = null;

    this.lastUpdateFrame = -1;
  }
}
