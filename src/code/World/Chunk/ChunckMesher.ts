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

  // Cache global uniforms — updated once per frame.
  static #cachedUniforms = {
    lightDirection: new Vector3(0, 1, 0),
    cameraPosition: new Vector3(0, 0, 0),
    screenSize: new Vector2(1920, 1080),
    cameraPlanes: new Vector2(0.1, 1000),
    time: 0,
    sunLightIntensity: 1.0,
    wetness: 0,
  };

  // OPTIMIZATION: Scratch Vector3 reused in updateGlobalUniforms to avoid
  // allocating a new object every frame when normalizing the light direction.
  private static _tmpLightDir = new Vector3(0, 0, 0);

  private static lastUpdateFrame = -1;

  static initAtlas() {
    let diffuseAtlasTexture: Texture | null = null;
    let normalAtlasTexture: Texture | null = null;
    const scene = Map1.mainScene;

    diffuseAtlasTexture = TextureAtlasFactory.getDiffuse();
    normalAtlasTexture = TextureAtlasFactory.getNormal();
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

    if (diffuseAtlasTexture) {
      Effect.ShadersStore["chunkVertexShader"] = OpaqueShader.chunkVertexShader;
      Effect.ShadersStore["chunkFragmentShader"] =
        OpaqueShader.chunkFragmentShader;
      Effect.ShadersStore["transparentChunkFragmentShader"] =
        TransparentShader.chunkFragmentShader;

      const opaqueBlockShader = new ShaderMaterial(
        "chunkShaderMaterial",
        scene,
        { vertex: "chunk", fragment: "chunk" },
        {
          attributes: [
            "position",
            "normal",
            "uvData",
            "cornerId",
            "ao",
            "light",
            "materialType",
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
      if (normalAtlasTexture)
        opaqueBlockShader.setTexture("normalTexture", normalAtlasTexture);

      opaqueBlockShader.onBind = () => {
        const effect = opaqueBlockShader.getEffect();
        if (effect) ChunkMesher.applyOpaqueUniforms(effect);
      };
      ChunkMesher.#atlasMaterial = opaqueBlockShader;

      // Transparent material (glass + water)
      const transparentMat = new ShaderMaterial(
        "transparentChunkShaderMaterial",
        scene,
        { vertex: "chunk", fragment: "transparentChunk" },
        {
          attributes: [
            "position",
            "normal",
            "uvData",
            "cornerId",
            "ao",
            "light",
            "materialType",
          ],
          uniforms: [
            "world",
            "worldViewProjection",
            "atlasTileSize",
            "cameraPosition",
            "lightDirection",
            "time",
            "screenSize",
            "sunLightIntensity",
            "wetness",
          ],
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
      if (normalAtlasTexture)
        transparentMat.setTexture("normalTexture", normalAtlasTexture);

      transparentMat.onBind = () => {
        const effect = transparentMat.getEffect();
        if (effect) ChunkMesher.applyTransparentUniforms(effect);
      };
      ChunkMesher.#transparentMaterial = transparentMat;
    } else {
      console.error("Texture Atlas not yet built or available!");
    }
  }

  public static createMeshFromData(
    chunk: Chunk,
    meshData: {
      opaque: MeshData | null;
      transparent: MeshData | null;
    },
  ) {
    const opaqueMesh = meshData.opaque;
    const transparentMesh = meshData.transparent;

    // Cache raw mesh data only for chunks that need saving
    if (chunk.isModified) {
      chunk.opaqueMeshData =
        opaqueMesh && opaqueMesh.positions.length > 0 ? opaqueMesh : null;
      chunk.transparentMeshData =
        transparentMesh && transparentMesh.positions.length > 0
          ? transparentMesh
          : null;
    } else {
      chunk.opaqueMeshData = null;
      chunk.transparentMeshData = null;
    }

    // Dispose old meshes
    chunk.mesh?.dispose();
    chunk.transparentMesh?.dispose();

    chunk.mesh =
      opaqueMesh && opaqueMesh.positions.length > 0
        ? this.buildMesh(chunk, opaqueMesh, "c_opaque", this.#atlasMaterial!)
        : null;

    chunk.transparentMesh =
      transparentMesh && transparentMesh.positions.length > 0
        ? this.buildMesh(
            chunk,
            transparentMesh,
            "c_transparent",
            this.#transparentMaterial!,
          )
        : null;

    if (chunk.colliderDirty) {
      chunk.colliderDirty = false;
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

    mesh.setVerticesBuffer(
      new VertexBuffer(
        engine,
        meshData.positions,
        VertexBuffer.PositionKind,
        false,
        undefined,
        3,
        false,
        undefined,
        undefined,
        VertexBuffer.UNSIGNED_BYTE,
        false,
      ),
    );

    mesh.setVerticesBuffer(
      new VertexBuffer(
        engine,
        meshData.normals,
        VertexBuffer.NormalKind,
        false,
        undefined,
        3,
        false,
        undefined,
        undefined,
        VertexBuffer.BYTE,
        true,
      ),
    );
    mesh.setVerticesBuffer(
      new VertexBuffer(
        engine,
        meshData.uvData,
        "uvData",
        false,
        undefined,
        4, // 4 components: tx, ty, w, h
        false,
        undefined,
        undefined,
        VertexBuffer.UNSIGNED_BYTE,
        false,
      ),
    );

    mesh.setVerticesBuffer(
      new VertexBuffer(
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
        false,
      ),
    );

    mesh.setVerticesBuffer(
      new VertexBuffer(
        engine,
        meshData.ao,
        "ao",
        false,
        undefined,
        1,
        false,
        undefined,
        undefined,
        VertexBuffer.UNSIGNED_BYTE,
        false,
      ),
    );

    mesh.setVerticesBuffer(
      new VertexBuffer(
        engine,
        meshData.light,
        "light",
        false,
        undefined,
        1,
        false,
        undefined,
        undefined,
        VertexBuffer.UNSIGNED_BYTE,
        false,
      ),
    );

    mesh.setVerticesBuffer(
      new VertexBuffer(
        engine,
        meshData.materialType,
        "materialType",
        false,
        undefined,
        1,
        false,
        undefined,
        undefined,
        VertexBuffer.UNSIGNED_BYTE,
        false,
      ),
    );

    mesh.setIndices(meshData.indices);

    if (mesh.material) {
      (mesh.material as ShaderMaterial).wireframe = GlobalValues.DEBUG;
    }

    mesh.position.set(
      chunk.chunkX * Chunk.SIZE,
      chunk.chunkY * Chunk.SIZE,
      chunk.chunkZ * Chunk.SIZE,
    );

    // Chunks are axis-aligned boxes — use OPTIMISTIC_INCLUSION for the fastest cull path.
    // CULLINGSTRATEGY_STANDARD uses sphere+AABB and is correct but slightly slower.
    const chunkMax = new Vector3(Chunk.SIZE, Chunk.SIZE, Chunk.SIZE);
    mesh.setBoundingInfo(new BoundingInfo(Vector3.Zero(), chunkMax));
    mesh.cullingStrategy = AbstractMesh.CULLINGSTRATEGY_OPTIMISTIC_INCLUSION;

    mesh.doNotSyncBoundingInfo = true;
    mesh.ignoreNonUniformScaling = true;
    mesh.checkCollisions = false;
    mesh.isPickable = false;
    mesh.material.freeze();
    mesh.freezeNormals();
    mesh.freezeWorldMatrix();

    mesh.name = `${name}_${chunk.chunkX}_${chunk.chunkY}_${chunk.chunkZ}`;

    return mesh;
  }

  private static applyOpaqueUniforms(effect: Effect) {
    const u = this.#cachedUniforms;
    effect.setVector3("lightDirection", u.lightDirection);
    effect.setVector3("cameraPosition", u.cameraPosition);
    effect.setVector2("screenSize", u.screenSize);
    effect.setFloat("sunLightIntensity", u.sunLightIntensity);
    effect.setFloat("wetness", u.wetness);
  }

  private static applyTransparentUniforms(effect: Effect) {
    const u = this.#cachedUniforms;
    effect.setVector3("lightDirection", u.lightDirection);
    effect.setVector3("cameraPosition", u.cameraPosition);
    effect.setVector2("screenSize", u.screenSize);
    effect.setFloat("time", u.time);
    effect.setFloat("sunLightIntensity", u.sunLightIntensity);
    effect.setFloat("wetness", u.wetness);
  }

  static updateGlobalUniforms(frameId: number) {
    if (this.lastUpdateFrame === frameId) return;
    this.lastUpdateFrame = frameId;

    const scene = Map1.mainScene;
    if (!scene) return;
    const camera = scene.activeCamera;
    if (!camera) return;
    const engine = scene.getEngine();

    // OPTIMIZATION: normalize into _tmpLightDir (pre-allocated) instead of
    // `new Vector3(...).normalize()` which allocates a fresh object every frame.
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

    u.screenSize.set(engine.getRenderWidth(), engine.getRenderHeight());
    u.cameraPlanes.set(camera.minZ, camera.maxZ);
    u.time = performance.now() / 1000.0;

    const sunElevation = -lightDir.y + 0.1;
    u.sunLightIntensity = Math.min(1.0, Math.max(0.1, sunElevation * 4));

    if (WorldEnvironment.instance) {
      u.wetness = WorldEnvironment.instance.wetness;
    }
  }

  private static createCachedTexture(
    url: string,
    scene: any,
    args: any,
  ): Texture {
    const texture = new Texture(null, scene, args);
    this.loadTextureToCache(url)
      .then((blobUrl) => texture.updateURL(blobUrl))
      .catch((e) => {
        console.warn("Texture cache failed, falling back to network", e);
        texture.updateURL(url);
      });
    return texture;
  }

  private static async loadTextureToCache(url: string): Promise<string> {
    const cacheKey = `${url}?v=${GlobalValues.TEXTURE_VERSION}`;
    const blob = await TextureCache.get(cacheKey);
    if (blob) return URL.createObjectURL(blob);
    const response = await fetch(cacheKey);
    const newBlob = await response.blob();
    await TextureCache.put(cacheKey, newBlob);
    return URL.createObjectURL(newBlob);
  }
}
