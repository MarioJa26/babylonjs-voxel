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
} from "@babylonjs/core";
import { Map1 } from "@/code/Maps/Map1";
import { TextureAtlasFactory } from "../Texture/TextureAtlasFactory";

import { Chunk } from "./Chunk";
import { GlobalValues } from "../GlobalValues";
//import { DiffuseOnlyShader } from "../Light/DiffuseOnlyShader";
import { ShaderMaterial } from "@babylonjs/core";
import { MeshData } from "./DataStructures/MeshData";
import { DiffuseNormalShader } from "../Light/DiffuseNormalShader";
import { WaterShader } from "../Light/WaterShader";
import { GlassShader } from "../Light/GlassShader";

export class ChunkMesher {
  private static atlasMaterial: Material | null = null; // One material for all

  // Cache global uniforms
  private static cachedUniforms = {
    lightDirection: new Vector3(0, 1, 0),
    cameraPosition: new Vector3(0, 0, 0),
    screenSize: new Vector2(1920, 1080),
    cameraPlanes: new Vector2(0.1, 1000),
    time: 0,
  };

  private static lastUpdateFrame = -1;

  static initAtlas() {
    if (!ChunkMesher.atlasMaterial) {
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

        const mat = new ShaderMaterial(
          "chunkShaderMaterial",
          scene,
          {
            vertex: "chunk",
            fragment: "chunk", // Uses the unified shader
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
              "materialId", // This tells shader what to render
            ],
            uniforms: [
              "world",
              "worldViewProjection",
              "atlasTileSize",
              "cameraPosition",
              "lightDirection",
              "screenSize",
              "time",
            ],
            samplers: ["diffuseTexture", "normalTexture"],
          }
        );
        mat.backFaceCulling = true;
        mat.needAlphaBlending = () => true; // Enable for water/glass
        mat.forceDepthWrite = true; // Required for transparency

        mat.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
        mat.setTexture("diffuseTexture", diffuseAtlasTexture);
        if (normalAtlasTexture) {
          mat.setTexture("normalTexture", normalAtlasTexture);
        }

        mat.onBind = () => {
          const effect = mat.getEffect();
          if (effect) {
            ChunkMesher.applyUniforms(effect); // Single function
          }
        };

        ChunkMesher.atlasMaterial = mat;
      } else {
        console.error("Texture Atlas not yet built or available!");
      }
    }
  }

  public static createMeshFromData(
    chunk: Chunk,
    meshData: { opaque: MeshData; water: MeshData; glass: MeshData }
  ) {
    if (!chunk.isLoaded) return;

    // Dispose of old mesh
    if (chunk.mesh) {
      chunk.mesh.dispose();
    }
    chunk.waterMesh = null; // No longer needed
    chunk.glassMesh = null; // No longer needed

    // Merge all meshes into one
    const mergedMesh = this.mergeMeshData(meshData);

    if (mergedMesh.positions.length > 0) {
      chunk.mesh = this.buildMergedMesh(
        chunk,
        mergedMesh,
        "chunk_merged",
        this.atlasMaterial!
      );
    } else {
      chunk.mesh = null;
    }
  }

  private static mergeMeshData(meshData: {
    opaque: MeshData;
    water: MeshData;
    glass: MeshData;
  }): MeshData & { materialIds: Uint8Array } {
    const opaque = meshData.opaque;
    const water = meshData.water;
    const glass = meshData.glass;

    const totalVertices =
      opaque.positions.length + water.positions.length + glass.positions.length;

    const merged: any = {
      positions: new Uint8Array(totalVertices),
      normals: new Uint8Array(totalVertices),
      uvs2: new Uint8Array((totalVertices / 3) * 2),
      uvs3: new Uint8Array((totalVertices / 3) * 2),
      cornerIds: new Uint8Array(totalVertices / 3),
      ao: new Uint8Array(totalVertices / 3),
      light: new Uint8Array(totalVertices / 3),
      materialIds: new Uint8Array(totalVertices / 3), // 0=opaque, 1=water, 2=glass
      indices: new Uint32Array(
        opaque.indices.length + water.indices.length + glass.indices.length
      ),
    };

    let vertexOffset = 0;
    let indexOffset = 0;

    // Merge opaque (materialId = 0)
    this.mergeGeometry(
      merged,
      opaque,
      vertexOffset,
      indexOffset,
      0 // materialId
    );
    vertexOffset += opaque.positions.length;
    indexOffset += opaque.indices.length;

    // Merge water (materialId = 1)
    this.mergeGeometry(
      merged,
      water,
      vertexOffset,
      indexOffset,
      1 // materialId
    );
    vertexOffset += water.positions.length;
    indexOffset += water.indices.length;

    // Merge glass (materialId = 2)
    this.mergeGeometry(
      merged,
      glass,
      vertexOffset,
      indexOffset,
      2 // materialId
    );

    return merged;
  }

  private static mergeGeometry(
    merged: any,
    source: MeshData,
    vertexOffset: number,
    indexOffset: number,
    materialId: number
  ) {
    // Copy vertex data
    merged.positions.set(source.positions, vertexOffset);
    merged.normals.set(source.normals, vertexOffset);
    merged.uvs2.set(source.uvs2, (vertexOffset / 3) * 2);
    merged.uvs3.set(source.uvs3, (vertexOffset / 3) * 2);
    merged.cornerIds.set(source.cornerIds, vertexOffset / 3);
    merged.ao.set(source.ao, vertexOffset / 3);
    merged.light.set(source.light, vertexOffset / 3);

    // Set material IDs
    const vertexCount = source.positions.length / 3;
    for (let i = 0; i < vertexCount; i++) {
      merged.materialIds[vertexOffset / 3 + i] = materialId;
    }

    // Copy and offset indices
    for (let i = 0; i < source.indices.length; i++) {
      merged.indices[indexOffset + i] = source.indices[i] + vertexOffset / 3;
    }
  }

  private static buildMergedMesh(
    chunk: Chunk,
    meshData: MeshData & { materialIds: Uint8Array },
    name: string,
    material: Material
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
      false // normalized
    );
    mesh.setVerticesBuffer(lightBuffer);

    // Add materialId buffer
    const materialIdBuffer = new VertexBuffer(
      engine,
      meshData.materialIds,
      "materialId",
      false,
      undefined,
      1,
      false,
      undefined,
      undefined,
      VertexBuffer.UNSIGNED_BYTE,
      false
    );
    mesh.setVerticesBuffer(materialIdBuffer);

    mesh.setIndices(meshData.indices);

    mesh.position.set(
      chunk.chunkX * Chunk.SIZE,
      chunk.chunkY * Chunk.SIZE,
      chunk.chunkZ * Chunk.SIZE
    );
    mesh.freezeWorldMatrix();

    // Single physics aggregate for the merged mesh
    new PhysicsAggregate(
      mesh,
      PhysicsShapeType.MESH,
      { mass: 0 },
      Map1.mainScene
    );

    return mesh;
  }

  // Single uniform application function
  private static applyUniforms(effect: Effect) {
    effect.setVector3("lightDirection", this.cachedUniforms.lightDirection);
    effect.setVector3("cameraPosition", this.cachedUniforms.cameraPosition);
    effect.setVector2("screenSize", this.cachedUniforms.screenSize);
    effect.setFloat("time", this.cachedUniforms.time);
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
    this.cachedUniforms.lightDirection.x = lightDir.x;
    this.cachedUniforms.lightDirection.y = lightDir.y;
    this.cachedUniforms.lightDirection.z = lightDir.z;
    const camPos = camera.position;
    this.cachedUniforms.cameraPosition.x = camPos.x;
    this.cachedUniforms.cameraPosition.y = camPos.y;
    this.cachedUniforms.cameraPosition.z = camPos.z;

    this.cachedUniforms.screenSize.set(
      engine.getRenderWidth(),
      engine.getRenderHeight()
    );

    this.cachedUniforms.cameraPlanes.set(camera.minZ, camera.maxZ);
    this.cachedUniforms.time = performance.now() / 1000.0;
  }
}
