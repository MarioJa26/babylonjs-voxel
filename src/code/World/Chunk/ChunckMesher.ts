import {
  Mesh,
  VertexBuffer,
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

import { Chunk } from "./Chunk";
import { GlobalValues } from "../GlobalValues";
import { ShaderMaterial } from "@babylonjs/core";
import { MeshData } from "./DataStructures/MeshData";
import { OpaqueShader } from "../Light/OpaqueShader";
import { TransparentShader } from "../Light/TransparentShader";
import { TextureCache } from "../Texture/TextureCache";

export class ChunkMesher {
  static #atlasMaterial: Material | null = null;
  static #transparentMaterial: Material | null = null;
  static #globalUniformBuffer: UniformBuffer | null = null;

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

    if (chunk.mesh) {
      chunk.mesh.dispose();
      chunk.mesh = null;
    }

    if (chunk.transparentMesh) {
      chunk.transparentMesh.dispose();
      chunk.transparentMesh = null;
    }

    if (hasOpaque) {
      chunk.mesh = this.buildMesh(
        chunk,
        opaqueMeshData!,
        "c_opaque",
        this.#atlasMaterial!,
        1,
      );
    }

    if (hasTransparent) {
      chunk.transparentMesh = this.buildMesh(
        chunk,
        transparentMeshData!,
        "c_transparent",
        this.#transparentMaterial!,
        1,
      );
    }

    if (chunk.colliderDirty) {
      chunk.colliderDirty = false;
    }
  }

  private static buildMesh(
    chunk: Chunk,
    meshData: MeshData,
    name: string,
    material: Material,
    renderingGroupId = 1,
  ): Mesh {
    const scene = Map1.mainScene;
    const engine = scene.getEngine();
    const mesh = new Mesh(name, scene);

    mesh.renderingGroupId = renderingGroupId;
    mesh.material = material;
    mesh.checkCollisions = false;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    mesh.ignoreNonUniformScaling = true;

    mesh.setVerticesBuffer(
      new VertexBuffer(
        engine,
        ChunkMesher.FACE_VERTEX_TEMPLATE,
        VertexBuffer.PositionKind,
        false,
        undefined,
        3,
        false,
      ),
    );

    mesh.setVerticesBuffer(
      new VertexBuffer(
        engine,
        meshData.faceDataA,
        "faceDataA",
        false,
        undefined,
        4,
        true,
        undefined,
        4,
        VertexBuffer.UNSIGNED_BYTE,
        false,
      ),
    );

    mesh.setVerticesBuffer(
      new VertexBuffer(
        engine,
        meshData.faceDataB,
        "faceDataB",
        false,
        undefined,
        4,
        true,
        undefined,
        4,
        VertexBuffer.UNSIGNED_BYTE,
        false,
      ),
    );

    mesh.setVerticesBuffer(
      new VertexBuffer(
        engine,
        meshData.faceDataC,
        "faceDataC",
        false,
        undefined,
        4,
        true,
        undefined,
        4,
        VertexBuffer.UNSIGNED_BYTE,
        false,
      ),
    );

    mesh.setIndices(ChunkMesher.FACE_INDEX_TEMPLATE);
    mesh.overridenInstanceCount = meshData.faceCount;

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
    mesh.name = `${name}_${chunk.chunkX}_${chunk.chunkY}_${chunk.chunkZ}`;

    return mesh;
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
}
