import {
  Mesh,
  MeshBuilder,
  ShaderMaterial,
  VertexBuffer,
  Effect,
  Vector3,
  Scene,
  Color3,
} from "@babylonjs/core";
import { SettingParams } from "../../SettingParams";
import { Map1 } from "@/code/Maps/Map1";
import { Chunk } from "../../Chunk/Chunk";
import { ChunkWorkerPool } from "../../Chunk/ChunkWorkerPool";
import { GlobalValues } from "../../GlobalValues";
import { DistantTerrainShader } from "../../Light/DistantTerrainShader";
import { GenerationParams } from "../NoiseAndParameters/GenerationParams";

export class DistantTerrain {
  private mesh: Mesh;
  private waterMesh: Mesh;
  private material: ShaderMaterial;
  private waterMaterial: ShaderMaterial;
  private radius: number;
  private gridStep = 1; // Optimization: 1 vertex per 4 chunks

  // Store data for reuse
  private lastPositions: Int16Array | null = null;
  private lastColors: Uint8Array | null = null;
  private lastNormals: Int8Array | null = null;
  private lastCenterChunkX: number | null = null;
  private lastCenterChunkZ: number | null = null;

  constructor() {
    this.radius = SettingParams.DISTANT_RENDER_DISTANCE;
    const segments = Math.floor((this.radius * 2) / this.gridStep);
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
      Map1.mainScene
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
      Map1.mainScene
    );

    // Initialize dummy colors for shader to prevent crash before worker returns
    const engine = this.mesh.getEngine();
    const initialColors = new Uint8Array(this.mesh.getTotalVertices() * 3).fill(
      128
    );
    const initialColorBuffer = new VertexBuffer(
      engine,
      initialColors,
      VertexBuffer.ColorKind,
      true,
      false,
      3,
      false,
      0,
      undefined,
      VertexBuffer.UNSIGNED_BYTE,
      true
    );
    this.mesh.setVerticesBuffer(initialColorBuffer);

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
        attributes: ["position", "normal", "color"],
        uniforms: [
          "world",
          "worldViewProjection",
          "lightDirection",
          "sunLightIntensity",
          "vFogInfos",
          "vFogColor",
          "cameraPosition",
        ],
      }
    );

    this.material.onBind = (mesh) => {
      const effect = this.material.getEffect();
      if (!effect) return;
      this.bindCommonUniforms(effect, mesh.getScene());
    };
    this.material.setColor3("color", new Color3(31 / 255, 64 / 255, 107 / 255));
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
      }
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

    this.waterMesh.isPickable = false;
    this.waterMesh.checkCollisions = false;
    this.waterMesh.receiveShadows = false;
    this.waterMesh.doNotSyncBoundingInfo = true;
    this.waterMesh.alwaysSelectAsActiveMesh = true;

    // Listen for worker results
    ChunkWorkerPool.getInstance().onDistantTerrainGenerated = (data) => {
      this.applyTerrainData(
        data.positions,
        data.colors,
        data.normals,
        data.centerChunkX,
        data.centerChunkZ
      );
    };
  }

  private bindCommonUniforms(effect: Effect, scene: Scene) {
    effect.setVector3("lightDirection", GlobalValues.skyLightDirection);

    const sunElevation = -GlobalValues.skyLightDirection.y + 0.1;
    const sunLightIntensity = Math.min(1.0, Math.max(0.1, sunElevation * 4));
    effect.setFloat("sunLightIntensity", sunLightIntensity);

    effect.setVector3(
      "cameraPosition",
      scene.activeCamera?.position || Vector3.Zero()
    );
    effect.setFloat4(
      "vFogInfos",
      scene.fogMode,
      scene.fogStart,
      scene.fogEnd,
      scene.fogDensity
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
      this.lastPositions && this.lastColors && this.lastNormals
        ? {
            positions: this.lastPositions,
            colors: this.lastColors,
            normals: this.lastNormals,
          }
        : undefined,
      this.lastCenterChunkX ?? undefined,
      this.lastCenterChunkZ ?? undefined
    );

    // Clear references since we transferred ownership to worker
    this.lastPositions = null;
    this.lastColors = null;
    this.lastNormals = null;
  }

  private applyTerrainData(
    positions: Int16Array,
    colors: Uint8Array,
    normals: Int8Array,
    centerChunkX: number,
    centerChunkZ: number
  ) {
    // Save data for next update reuse
    this.lastPositions = positions;
    this.lastColors = colors;
    this.lastNormals = normals;
    this.lastCenterChunkX = centerChunkX;
    this.lastCenterChunkZ = centerChunkZ;

    this.mesh.position.set(
      centerChunkX * Chunk.SIZE,
      -2,
      centerChunkZ * Chunk.SIZE
    );

    this.waterMesh.position.set(
      centerChunkX * Chunk.SIZE,
      GenerationParams.SEA_LEVEL,
      centerChunkZ * Chunk.SIZE
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
      false // normalized
    );
    this.mesh.setVerticesBuffer(positionBuffer);

    // Use setVerticesBuffer to ensure the buffer is created with the correct type and normalization
    const colorBuffer = new VertexBuffer(
      engine,
      colors,
      VertexBuffer.ColorKind,
      true, // updatable
      false, // postpone
      3, // stride
      false, // instanced
      0, // offset
      undefined, // size
      VertexBuffer.UNSIGNED_BYTE, // type
      true // normalized
    );
    this.mesh.setVerticesBuffer(colorBuffer);

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
      true // normalized
    );
    this.mesh.setVerticesBuffer(normalBuffer);
  }
}
