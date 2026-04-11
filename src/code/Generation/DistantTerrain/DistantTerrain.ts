import {
  Mesh,
  MeshBuilder,
  ShaderMaterial,
  VertexBuffer,
  Effect,
  Vector3,
  Vector2,
  Scene,
  Texture,
  RawTexture,
} from "@babylonjs/core";

import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import { SettingParams } from "@/code/World/SettingParams";
import { Chunk } from "@/code/World/Chunk/Chunk";
import { Map1 } from "@/code/Maps/Map1";
import { DistantTerrainShader } from "@/code/World/Light/DistantTerrainShader";
import { ChunkWorkerPool } from "@/code/World/Chunk/ChunkWorkerPool";
import { TextureAtlasFactory } from "@/code/World/Texture/TextureAtlasFactory";
import { GlobalValues } from "@/code/World/GlobalValues";

export class DistantTerrain {
  private mesh: Mesh;
  private waterMesh: Mesh;
  private material: ShaderMaterial;
  private waterMaterial: ShaderMaterial;
  private diffuseAtlasTexture: Texture | null = null;

  // --- Tile lookup texture ---
  // Set to true if you also update the shader to sample .rg instead of .rgba
  private static readonly USE_LA_TILE_TEXTURE = false;

  #surfaceTileLookupTexture: RawTexture;
  #surfaceTileLookupData: Uint8Array;

  #radius: number;
  #gridStep = 1; // 1 vertex per gridStep*chunkSize in each axis
  #gridResolution: number;

  // Reusable vector (avoid per-frame allocations)
  #gridOrigin = new Vector2();

  // GPU buffers (created once, updated later)
  #positionVB?: VertexBuffer;
  #normalVB?: VertexBuffer;

  // Store data for reuse (transferred to worker between updates)
  #lastPositions: Int16Array | null = null;
  #lastNormals: Int8Array | null = null;
  #lastSurfaceTiles: Uint8Array | null = null;
  #lastCenterChunkX: number | null = null;
  #lastCenterChunkZ: number | null = null;

  constructor() {
    this.#radius = SettingParams.DISTANT_RENDER_DISTANCE;
    const segments = Math.floor((this.#radius * 2) / this.#gridStep);
    this.#gridResolution = segments + 1;
    const size = this.#radius * 2 * Chunk.SIZE;

    // ---- Terrain mesh ----
    this.mesh = this.createEmptyGridMesh("distantTerrain", Map1.mainScene);
    this.mesh.sideOrientation = Mesh.FRONTSIDE;

    // ---- Water mesh ----
    this.waterMesh = MeshBuilder.CreateGround(
      "distantWater",
      {
        width: size,
        height: size,
        subdivisions: 1,
        updatable: false,
      },
      Map1.mainScene,
    );

    // ---- Tile lookup texture & backing array ----
    if (DistantTerrain.USE_LA_TILE_TEXTURE) {
      // 2 channels (R=tileX, G=tileY)
      this.#surfaceTileLookupData = new Uint8Array(
        this.#gridResolution * this.#gridResolution * 2,
      );
      this.#surfaceTileLookupTexture = RawTexture.CreateLuminanceAlphaTexture(
        this.#surfaceTileLookupData,
        this.#gridResolution,
        this.#gridResolution,
        Map1.mainScene,
        false,
        false,
        Texture.NEAREST_SAMPLINGMODE,
      );
    } else {
      // 4 channels (R=tileX, G=tileY, B=0, A=255)
      this.#surfaceTileLookupData = new Uint8Array(
        this.#gridResolution * this.#gridResolution * 4,
      );
      this.#surfaceTileLookupTexture = RawTexture.CreateRGBATexture(
        this.#surfaceTileLookupData,
        this.#gridResolution,
        this.#gridResolution,
        Map1.mainScene,
        false,
        false,
        Texture.NEAREST_SAMPLINGMODE,
      );
    }

    this.#surfaceTileLookupTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.#surfaceTileLookupTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

    // ---- Shaders ----
    Effect.ShadersStore["distantTerrainVertexShader"] =
      DistantTerrainShader.distantTerrainVertexShader;
    Effect.ShadersStore["distantTerrainFragmentShader"] =
      DistantTerrainShader.distantTerrainFragmentShader;
    Effect.ShadersStore["distantWaterVertexShader"] =
      DistantTerrainShader.distantWaterVertexShader;
    Effect.ShadersStore["distantWaterFragmentShader"] =
      DistantTerrainShader.distantWaterFragmentShader;

    // ---- Terrain material ----
    this.material = new ShaderMaterial(
      "distantTerrainMat",
      Map1.mainScene,
      {
        vertex: "distantTerrain",
        fragment: "distantTerrain",
      },
      {
        attributes: ["position", "normal"],
        uniforms: [
          "world",
          "worldViewProjection",
          "lightDirection",
          "sunLightIntensity",
          "atlasTileSize",
          "textureScale",
          "useTexture",
          "tileGridResolution",
          "gridOriginWorld",
          "gridWorldStep",
          "vFogInfos",
          "vFogColor",
          "cameraPosition",
        ],
        samplers: ["diffuseTexture", "tileLookupTexture"],
      },
    );

    this.material.onBind = (_mesh) => {
      const effect = this.material.getEffect();
      if (!effect) return;
      this.bindCommonUniforms(effect, _mesh.getScene());
    };

    this.material.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
    this.material.setFloat("textureScale", 32);
    this.material.setFloat("tileGridResolution", this.#gridResolution);
    this.material.setFloat("gridWorldStep", Chunk.SIZE * this.#gridStep);
    this.material.setFloat("useTexture", 0);
    this.material.setTexture(
      "tileLookupTexture",
      this.#surfaceTileLookupTexture,
    );

    this.bindDiffuseTexture();
    this.mesh.material = this.material;

    // ---- Water material ----
    this.waterMaterial = new ShaderMaterial(
      "distantWaterMat",
      Map1.mainScene,
      {
        vertex: "distantWater",
        fragment: "distantWater",
      },
      {
        attributes: ["position"],
        uniforms: [
          "world",
          "worldViewProjection",
          "lightDirection",
          "sunLightIntensity",
          "vFogInfos",
          "vFogColor",
          "cameraPosition",
        ],
      },
    );

    this.waterMaterial.onBind = (mesh) => {
      const effect = this.waterMaterial.getEffect();
      if (!effect) return;
      this.bindCommonUniforms(effect, mesh.getScene());
    };

    this.waterMesh.material = this.waterMaterial;

    // ---- Mesh flags ----
    this.mesh.isPickable = false;
    this.mesh.checkCollisions = false;
    this.mesh.receiveShadows = false;
    this.mesh.doNotSyncBoundingInfo = true;
    this.mesh.alwaysSelectAsActiveMesh = true;

    this.waterMesh.isPickable = false;
    this.waterMesh.checkCollisions = false;
    this.waterMesh.receiveShadows = false;
    this.waterMesh.doNotSyncBoundingInfo = true;
    this.waterMesh.alwaysSelectAsActiveMesh = true;

    // Listen for worker results
    ChunkWorkerPool.getInstance().onDistantTerrainGenerated = (data) => {
      this.applyTerrainData(
        data.positions,
        data.normals,
        data.surfaceTiles,
        data.centerChunkX,
        data.centerChunkZ,
      );
    };
  }

  private createEmptyGridMesh(name: string, scene: Scene): Mesh {
    const mesh = new Mesh(name, scene);
    const engine = scene.getEngine();

    const res = this.#gridResolution;
    const vertexCount = res * res;
    const quadCount = (res - 1) * (res - 1);
    const indexCount = quadCount * 6;

    // Choose 16-bit or 32-bit index buffer
    const useUint32 = vertexCount > 65535 && !!engine.getCaps().uintIndices;
    const indices = useUint32
      ? new Uint32Array(indexCount)
      : new Uint16Array(indexCount);

    // Build indices once
    let k = 0;
    for (let z = 0; z < res - 1; z++) {
      const row = z * res;
      const next = (z + 1) * res;
      for (let x = 0; x < res - 1; x++) {
        const i0 = row + x;
        const i1 = i0 + 1;
        const i2 = next + x;
        const i3 = i2 + 1;

        indices[k++] = i0;
        indices[k++] = i2;
        indices[k++] = i1;

        indices[k++] = i1;
        indices[k++] = i2;
        indices[k++] = i3;
      }
    }

    mesh.setIndices(indices);

    // Allocate empty buffers
    const positions = new Int16Array(vertexCount * 3);
    const normals = new Int8Array(vertexCount * 3);

    // Initialize normals upward so first frame isn't black
    for (let i = 1; i < normals.length; i += 3) {
      normals[i] = 127;
    }

    this.#positionVB = new VertexBuffer(
      engine,
      positions,
      VertexBuffer.PositionKind,
      true, // updatable
      false, // postpone
      3, // stride
      false,
      0,
      undefined,
      VertexBuffer.SHORT,
      false,
    );
    mesh.setVerticesBuffer(this.#positionVB);

    this.#normalVB = new VertexBuffer(
      engine,
      normals,
      VertexBuffer.NormalKind,
      true,
      false,
      3,
      false,
      0,
      undefined,
      VertexBuffer.BYTE,
      true, // normalized
    );
    mesh.setVerticesBuffer(this.#normalVB);

    return mesh;
  }

  private bindDiffuseTexture() {
    if (!this.diffuseAtlasTexture) {
      this.diffuseAtlasTexture = TextureAtlasFactory.getDiffuse();
    }

    if (!this.diffuseAtlasTexture) {
      this.diffuseAtlasTexture = new Texture(
        "/texture/diffuse_atlas.png",
        Map1.mainScene,
        {
          noMipmap: false,
          samplingMode: Texture.NEAREST_SAMPLINGMODE,
        },
      );
      TextureAtlasFactory.setDiffuse(this.diffuseAtlasTexture);
    }

    if (this.diffuseAtlasTexture) {
      this.diffuseAtlasTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
      this.diffuseAtlasTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
      this.material.setTexture("diffuseTexture", this.diffuseAtlasTexture);
      this.material.setFloat("useTexture", 1);
    }
  }

  private bindCommonUniforms(effect: Effect, scene: Scene) {
    effect.setVector3("lightDirection", GlobalValues.skyLightDirection);

    const sunElevation = -GlobalValues.skyLightDirection.y + 0.1;
    const sunLightIntensity = Math.min(1.0, Math.max(0.1, sunElevation * 4));
    effect.setFloat("sunLightIntensity", sunLightIntensity);

    effect.setVector3(
      "cameraPosition",
      scene.activeCamera?.position || Vector3.Zero(),
    );
    effect.setFloat4(
      "vFogInfos",
      scene.fogMode,
      scene.fogStart,
      scene.fogEnd,
      scene.fogDensity,
    );
    effect.setColor3("vFogColor", scene.fogColor);
  }

  public update(centerChunkX: number, centerChunkZ: number) {
    ChunkWorkerPool.getInstance().scheduleDistantTerrain(
      centerChunkX,
      centerChunkZ,
      this.#radius,
      SettingParams.RENDER_DISTANCE,
      this.#gridStep,
      this.#lastPositions && this.#lastNormals && this.#lastSurfaceTiles
        ? {
            positions: this.#lastPositions,
            normals: this.#lastNormals,
            surfaceTiles: this.#lastSurfaceTiles,
          }
        : undefined,
      this.#lastCenterChunkX ?? undefined,
      this.#lastCenterChunkZ ?? undefined,
    );

    // transferred to worker
    this.#lastPositions = null;
    this.#lastNormals = null;
    this.#lastSurfaceTiles = null;
  }

  private applyTerrainData(
    positions: Int16Array,
    normals: Int8Array,
    surfaceTiles: Uint8Array,
    centerChunkX: number,
    centerChunkZ: number,
  ) {
    // Save data for next update reuse
    this.#lastPositions = positions;
    this.#lastNormals = normals;
    this.#lastSurfaceTiles = surfaceTiles;
    this.#lastCenterChunkX = centerChunkX;
    this.#lastCenterChunkZ = centerChunkZ;

    this.mesh.position.set(
      centerChunkX * Chunk.SIZE,
      -2,
      centerChunkZ * Chunk.SIZE,
    );

    this.waterMesh.position.set(
      centerChunkX * Chunk.SIZE,
      GenerationParams.SEA_LEVEL,
      centerChunkZ * Chunk.SIZE,
    );

    this.#gridOrigin.x = (centerChunkX - this.#radius) * Chunk.SIZE;
    this.#gridOrigin.y = (centerChunkZ - this.#radius) * Chunk.SIZE;
    this.material.setVector2("gridOriginWorld", this.#gridOrigin);

    // Update existing GPU buffers only
    this.#positionVB?.update(positions);
    this.#normalVB?.update(normals);

    // ---- Update tile lookup texture ----
    if (DistantTerrain.USE_LA_TILE_TEXTURE) {
      if (surfaceTiles.length !== this.#surfaceTileLookupData.length) {
        for (let i = 0, j = 0; i < surfaceTiles.length; i += 2, j += 2) {
          this.#surfaceTileLookupData[j] = surfaceTiles[i];
          this.#surfaceTileLookupData[j + 1] = surfaceTiles[i + 1];
        }
      } else {
        this.#surfaceTileLookupData.set(surfaceTiles);
      }
    } else {
      for (
        let src = 0, dst = 0;
        src < surfaceTiles.length;
        src += 2, dst += 4
      ) {
        this.#surfaceTileLookupData[dst] = surfaceTiles[src];
        this.#surfaceTileLookupData[dst + 1] = surfaceTiles[src + 1];
        this.#surfaceTileLookupData[dst + 2] = 0;
        this.#surfaceTileLookupData[dst + 3] = 255;
      }
    }

    this.#surfaceTileLookupTexture.update(this.#surfaceTileLookupData);
  }
}
