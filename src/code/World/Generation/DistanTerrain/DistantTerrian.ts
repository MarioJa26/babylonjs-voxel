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
import { SettingParams } from "../../SettingParams";
import { Map1 } from "@/code/Maps/Map1";
import { Chunk } from "../../Chunk/Chunk";
import { ChunkWorkerPool } from "../../Chunk/ChunkWorkerPool";
import { GlobalValues } from "../../GlobalValues";
import { DistantTerrainShader } from "../../Light/DistantTerrainShader";
import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import { TextureAtlasFactory } from "../../Texture/TextureAtlasFactory";

export class DistantTerrain {
  private mesh: Mesh;
  private waterMesh: Mesh;
  private material: ShaderMaterial;
  private waterMaterial: ShaderMaterial;
  private diffuseAtlasTexture: Texture | null = null;

  // --- Tile lookup texture ---
  // Set to true if you also update the shader to sample .rg instead of .rgba
  private static readonly USE_LA_TILE_TEXTURE = false;

  private surfaceTileLookupTexture: RawTexture;
  private surfaceTileLookupData: Uint8Array; // length depends on format (2 or 4 bytes per texel)

  private radius: number;
  private gridStep = 1; // 1 vertex per gridStep*chunkSize in each axis
  private gridResolution: number;

  // Reusable vector (avoid per-frame allocations)
  private _gridOrigin = new Vector2();

  // GPU buffers (reused)
  private _positionVB?: VertexBuffer;
  private _normalVB?: VertexBuffer;

  // Store data for reuse (transferred to worker between updates)
  private lastPositions: Int16Array | null = null;
  private lastNormals: Int8Array | null = null;
  private lastSurfaceTiles: Uint8Array | null = null;
  private lastCenterChunkX: number | null = null;
  private lastCenterChunkZ: number | null = null;

  constructor() {
    this.radius = SettingParams.DISTANT_RENDER_DISTANCE;
    const segments = Math.floor((this.radius * 2) / this.gridStep);
    this.gridResolution = segments + 1;
    const size = this.radius * 2 * Chunk.SIZE;

    // ---- Meshes ----
    this.mesh = MeshBuilder.CreateGround(
      "distantTerrain",
      {
        width: size,
        height: size,
        subdivisions: segments,
        updatable: true,
      },
      Map1.mainScene,
    );
    this.mesh.sideOrientation = Mesh.FRONTSIDE;

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
      this.surfaceTileLookupData = new Uint8Array(
        this.gridResolution * this.gridResolution * 2,
      );
      this.surfaceTileLookupTexture = RawTexture.CreateLuminanceAlphaTexture(
        this.surfaceTileLookupData,
        this.gridResolution,
        this.gridResolution,
        Map1.mainScene,
        false, // generateMipMaps
        false, // invertY
        Texture.NEAREST_SAMPLINGMODE,
      );
    } else {
      // 4 channels (R=tileX, G=tileY, B=0, A=255) - compatible with your current shader
      this.surfaceTileLookupData = new Uint8Array(
        this.gridResolution * this.gridResolution * 4,
      );
      this.surfaceTileLookupTexture = RawTexture.CreateRGBATexture(
        this.surfaceTileLookupData,
        this.gridResolution,
        this.gridResolution,
        Map1.mainScene,
        false,
        false,
        Texture.NEAREST_SAMPLINGMODE,
      );
    }
    this.surfaceTileLookupTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.surfaceTileLookupTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

    // ---- Shaders ----
    Effect.ShadersStore["distantTerrainVertexShader"] =
      DistantTerrainShader.distantTerrainVertexShader;
    Effect.ShadersStore["distantTerrainFragmentShader"] =
      DistantTerrainShader.distantTerrainFragmentShader;
    Effect.ShadersStore["distantWaterVertexShader"] =
      DistantTerrainShader.distantWaterVertexShader;
    Effect.ShadersStore["distantWaterFragmentShader"] =
      DistantTerrainShader.distantWaterFragmentShader;

    // ---- Materials ----
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

    // Bind *only* the dynamic uniforms here (no texture checks)
    this.material.onBind = (_mesh) => {
      const effect = this.material.getEffect();
      if (!effect) return;
      this.bindCommonUniforms(effect, _mesh.getScene());
    };

    this.material.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
    this.material.setFloat("textureScale", 32);
    this.material.setFloat("tileGridResolution", this.gridResolution);
    this.material.setFloat("gridWorldStep", Chunk.SIZE * this.gridStep);
    this.material.setFloat("useTexture", 0);
    this.material.setTexture(
      "tileLookupTexture",
      this.surfaceTileLookupTexture,
    );

    // Bind diffuse atlas once and set flag so shader samples it
    this.bindDiffuseTexture();
    this.mesh.material = this.material;

    // Water material
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
    // If you want frustum culling, set this to false (recommended unless you *must* always render)
    // this.mesh.alwaysSelectAsActiveMesh = false;
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

  private bindDiffuseTexture() {
    // Try shared atlas first
    if (!this.diffuseAtlasTexture) {
      this.diffuseAtlasTexture = TextureAtlasFactory.getDiffuse();
    }

    // Fallback to loading
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
    // Request new vertex data relative to this center
    ChunkWorkerPool.getInstance().scheduleDistantTerrain(
      centerChunkX,
      centerChunkZ,
      this.radius,
      SettingParams.RENDER_DISTANCE,
      this.gridStep,
      this.lastPositions && this.lastNormals && this.lastSurfaceTiles
        ? {
            positions: this.lastPositions,
            normals: this.lastNormals,
            surfaceTiles: this.lastSurfaceTiles,
          }
        : undefined,
      this.lastCenterChunkX ?? undefined,
      this.lastCenterChunkZ ?? undefined,
    );

    // We expect the worker to take ownership of these (transferable), so release references
    this.lastPositions = null;
    this.lastNormals = null;
    this.lastSurfaceTiles = null;
  }

  private applyTerrainData(
    positions: Int16Array,
    normals: Int8Array,
    surfaceTiles: Uint8Array,
    centerChunkX: number,
    centerChunkZ: number,
  ) {
    // Save data for next update reuse (will be transferred on next schedule)
    this.lastPositions = positions;
    this.lastNormals = normals;
    this.lastSurfaceTiles = surfaceTiles;
    this.lastCenterChunkX = centerChunkX;
    this.lastCenterChunkZ = centerChunkZ;

    // Move meshes to the current center (cheap); alternatively, keep meshes at origin and only move gridOrigin
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

    // Update grid origin without allocating a new Vector2
    const gridCenterChunkX =
      Math.floor(centerChunkX / this.gridStep) * this.gridStep;
    const gridCenterChunkZ =
      Math.floor(centerChunkZ / this.gridStep) * this.gridStep;
    this._gridOrigin.x = (gridCenterChunkX - this.radius) * Chunk.SIZE;
    this._gridOrigin.y = (gridCenterChunkZ - this.radius) * Chunk.SIZE;
    this.material.setVector2("gridOriginWorld", this._gridOrigin);

    // ---- Update / create GPU vertex buffers (no reallocation if already exist) ----
    const engine = this.mesh.getEngine();

    // Position buffer (Int16, not normalized)
    if (!this._positionVB) {
      this._positionVB = new VertexBuffer(
        engine,
        positions,
        VertexBuffer.PositionKind,
        true, // updatable
        false, // postpone
        3, // stride
        false, // instanced
        0,
        undefined,
        VertexBuffer.SHORT, // component type
        false, // normalized
      );
      this.mesh.setVerticesBuffer(this._positionVB);
    } else {
      this._positionVB.update(positions);
    }

    // Normal buffer (Int8, normalized)
    if (!this._normalVB) {
      this._normalVB = new VertexBuffer(
        engine,
        normals,
        VertexBuffer.NormalKind,
        true, // updatable
        false,
        3,
        false,
        0,
        undefined,
        VertexBuffer.BYTE, // component type
        true, // normalized
      );
      this.mesh.setVerticesBuffer(this._normalVB);
    } else {
      this._normalVB.update(normals);
    }

    // ---- Update tile-lookup texture ----
    if (DistantTerrain.USE_LA_TILE_TEXTURE) {
      // 2 channels: RG = [tileX, tileY]
      // Copy interleaved pairs
      // surfaceTiles is [tileX, tileY, tileX, tileY, ...]
      // Our texture data is the same layout (RG), so we can copy directly if lengths match:
      // But our texture resolution is gridResolution^2 texels, and surfaceTiles length is (gridRes^2 * 2)
      // => We can just set the array directly.
      if (surfaceTiles.length !== this.surfaceTileLookupData.length) {
        // Fallback (shouldn't happen); copy pairwise
        for (let i = 0, j = 0; i < surfaceTiles.length; i += 2, j += 2) {
          this.surfaceTileLookupData[j] = surfaceTiles[i];
          this.surfaceTileLookupData[j + 1] = surfaceTiles[i + 1];
        }
      } else {
        this.surfaceTileLookupData.set(surfaceTiles);
      }
    } else {
      // 4 channels: RGBA = [tileX, tileY, 0, 255]
      // Expand pairs into RGBA
      for (
        let src = 0, dst = 0;
        src < surfaceTiles.length;
        src += 2, dst += 4
      ) {
        this.surfaceTileLookupData[dst] = surfaceTiles[src];
        this.surfaceTileLookupData[dst + 1] = surfaceTiles[src + 1];
        this.surfaceTileLookupData[dst + 2] = 0;
        this.surfaceTileLookupData[dst + 3] = 255;
      }
    }
    this.surfaceTileLookupTexture.update(this.surfaceTileLookupData);
  }
}
``;
