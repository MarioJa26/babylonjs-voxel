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
  private surfaceTileLookupTexture: RawTexture;
  private surfaceTileLookupData: Uint8Array;
  private radius: number;
  private gridStep = 1; // Optimization: 1 vertex per 4 chunks
  private gridResolution: number;

  // Store data for reuse
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

    // Create a flat ground plane
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

    // Create water plane
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

    this.surfaceTileLookupData = new Uint8Array(
      this.gridResolution * this.gridResolution * 4,
    );
    for (let i = 0; i < this.surfaceTileLookupData.length; i += 4) {
      this.surfaceTileLookupData[i] = 14;
      this.surfaceTileLookupData[i + 1] = 0;
      this.surfaceTileLookupData[i + 2] = 0;
      this.surfaceTileLookupData[i + 3] = 255;
    }
    this.surfaceTileLookupTexture = RawTexture.CreateRGBATexture(
      this.surfaceTileLookupData,
      this.gridResolution,
      this.gridResolution,
      Map1.mainScene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
    );
    this.surfaceTileLookupTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.surfaceTileLookupTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

    Effect.ShadersStore["distantTerrainVertexShader"] =
      DistantTerrainShader.distantTerrainVertexShader;

    Effect.ShadersStore["distantTerrainFragmentShader"] =
      DistantTerrainShader.distantTerrainFragmentShader;

    Effect.ShadersStore["distantWaterVertexShader"] =
      DistantTerrainShader.distantWaterVertexShader;
    Effect.ShadersStore["distantWaterFragmentShader"] =
      DistantTerrainShader.distantWaterFragmentShader;

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

    this.material.onBind = (mesh) => {
      this.bindDiffuseTexture();
      const effect = this.material.getEffect();
      if (!effect) return;
      this.bindCommonUniforms(effect, mesh.getScene());
    };
    this.material.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
    this.material.setFloat("textureScale", 32);
    this.material.setFloat("tileGridResolution", this.gridResolution);
    this.material.setFloat("gridWorldStep", Chunk.SIZE * this.gridStep);
    this.material.setVector2("gridOriginWorld", Vector2.Zero());
    this.material.setFloat("useTexture", 0);
    this.material.setTexture(
      "tileLookupTexture",
      this.surfaceTileLookupTexture,
    );
    this.bindDiffuseTexture();
    this.mesh.material = this.material;

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

    // Optimization
    this.mesh.isPickable = false;
    this.mesh.checkCollisions = false;
    this.mesh.receiveShadows = false;
    this.mesh.doNotSyncBoundingInfo = true;
    this.mesh.alwaysSelectAsActiveMesh = true; // Always render if enabled
    this.mesh.freezeNormals();

    this.waterMesh.isPickable = false;
    this.waterMesh.checkCollisions = false;
    this.waterMesh.receiveShadows = false;
    this.waterMesh.doNotSyncBoundingInfo = true;
    this.waterMesh.alwaysSelectAsActiveMesh = true;
    this.waterMesh.freezeNormals();

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

    // Clear references since we transferred ownership to worker
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
    // Save data for next update reuse
    this.lastPositions = positions;
    this.lastNormals = normals;
    this.lastSurfaceTiles = surfaceTiles;
    this.lastCenterChunkX = centerChunkX;
    this.lastCenterChunkZ = centerChunkZ;

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

    const gridCenterChunkX =
      Math.floor(centerChunkX / this.gridStep) * this.gridStep;
    const gridCenterChunkZ =
      Math.floor(centerChunkZ / this.gridStep) * this.gridStep;
    this.material.setVector2(
      "gridOriginWorld",
      new Vector2(
        (gridCenterChunkX - this.radius) * Chunk.SIZE,
        (gridCenterChunkZ - this.radius) * Chunk.SIZE,
      ),
    );

    const engine = this.mesh.getEngine();
    const positionBuffer = new VertexBuffer(
      engine,
      positions,
      VertexBuffer.PositionKind,
      true, // updatable
      false, // postpone
      3, // stride
      false, // instanced
      0, // offset
      undefined, // size
      VertexBuffer.SHORT, // type
      false, // normalized
    );
    this.mesh.setVerticesBuffer(positionBuffer);

    const normalBuffer = new VertexBuffer(
      engine,
      normals,
      VertexBuffer.NormalKind,
      true, // updatable
      false, // postpone
      3, // stride
      false, // instanced
      0, // offset
      undefined, // size
      VertexBuffer.BYTE, // type
      true, // normalized
    );
    this.mesh.setVerticesBuffer(normalBuffer);

    for (
      let srcIndex = 0, dstIndex = 0;
      srcIndex < surfaceTiles.length;
      srcIndex += 2, dstIndex += 4
    ) {
      this.surfaceTileLookupData[dstIndex] = surfaceTiles[srcIndex];
      this.surfaceTileLookupData[dstIndex + 1] = surfaceTiles[srcIndex + 1];
      this.surfaceTileLookupData[dstIndex + 2] = 0;
      this.surfaceTileLookupData[dstIndex + 3] = 255;
    }
    this.surfaceTileLookupTexture.update(this.surfaceTileLookupData);
  }
}
