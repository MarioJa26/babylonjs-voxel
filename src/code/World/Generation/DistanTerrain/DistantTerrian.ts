import {
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  VertexBuffer,
} from "@babylonjs/core";
import { SettingParams } from "../../SettingParams";
import { Map1 } from "@/code/Maps/Map1";
import { Chunk } from "../../Chunk/Chunk";
import { ChunkWorkerPool } from "../../Chunk/ChunkWorkerPool";

export class DistantTerrain {
  private mesh: Mesh;
  private material: StandardMaterial;
  private radius: number;
  private gridStep = 1; // Optimization: 1 vertex per 4 chunks

  // Store data for reuse
  private lastPositions: Int16Array | null = null;
  private lastColors: Uint8Array | null = null;
  private lastNormals: Uint8Array | null = null;
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

    // Setup material
    this.material = new StandardMaterial("distantMat", Map1.mainScene);
    this.material.specularColor = Color3.Black();
    this.mesh.material = this.material;

    // Optimization
    this.mesh.isPickable = false;
    this.mesh.checkCollisions = false;
    this.mesh.receiveShadows = false;
    this.mesh.doNotSyncBoundingInfo = true;
    this.mesh.alwaysSelectAsActiveMesh = true; // Always render if enabled

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
    normals: Uint8Array,
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
      VertexBuffer.UNSIGNED_BYTE, // type
      true // normalized
    );
    this.mesh.setVerticesBuffer(normalBuffer);
  }
}
