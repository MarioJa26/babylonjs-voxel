/// <reference lib="webworker" />

import { BlockTextures } from "../Texture/BlockTextures";
import { WorldGenerator } from "../Generation/WorldGenerator";
import { MeshData } from "./DataStructures/MeshData";
import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";
import { ResizableTypedArray } from "./DataStructures/ResizableTypedArray";
import { WorkerInternalMeshData } from "./DataStructures/WorkerInternalMeshData";
import { TerrainHeightMap } from "../Generation/TerrainHeightMap";
import { DistantTerrainGenerator } from "../Generation/DistanTerrain/DistantTerrainGenerator";

/**
 * A wrapper around a TypedArray that allows it to be resized dynamically.
 * This is more performant than using a standard number[] and then converting.
 */

const WATER_BLOCKS = new Set([30]);
const GLASS_BLOCKS = new Set([60, 61]);

type FaceData = {
  normal: Int8Array;
};

const FACE_DATA_CACHE: { [key: string]: FaceData } = {};

// Pre-calculate face data for all 6 directions
for (const axis of [0, 1, 2]) {
  for (const side of [-1, 1]) {
    const normal = new Int8Array(3);
    normal[axis] = side;

    FACE_DATA_CACHE[normal.join(",")] = {
      normal,
    };
  }
}

class ChunkWorkerMesher {
  private static createEmptyMeshData(): WorkerInternalMeshData {
    return {
      positions: new ResizableTypedArray(Uint8Array),
      indices: new ResizableTypedArray(Uint16Array),
      normals: new ResizableTypedArray(Int8Array),
      uvs2: new ResizableTypedArray(Uint8Array),
      uvs3: new ResizableTypedArray(Uint8Array),
      cornerIds: new ResizableTypedArray(Uint8Array),
      ao: new ResizableTypedArray(Uint8Array),
      light: new ResizableTypedArray(Uint8Array),
      indexOffset: 0,
    };
  }

  // Helper to calculate AO for a single 1x1 face and return it as a packed 8-bit integer
  private static calculateAOPacked(
    ax: number, // Coordinates of the "air" block adjacent to the face
    ay: number,
    az: number,
    u: number, // u-axis index (0, 1, 2)
    v: number, // v-axis index
    getBlock: (x: number, y: number, z: number) => number
  ): number {
    let packed = 0;
    // Check 4 corners: (0,0), (1,0), (1,1), (0,1) in UV space
    for (let i = 0; i < 4; i++) {
      // UV offsets for the corner
      const du = i === 1 || i === 2 ? 1 : 0;
      const dv = i === 2 || i === 3 ? 1 : 0;

      // Neighbors relative to the air block (ax, ay, az)
      // Side 1: offset in V
      const s1x = ax + (v === 0 ? (dv ? 1 : -1) : 0);
      const s1y = ay + (v === 1 ? (dv ? 1 : -1) : 0);
      const s1z = az + (v === 2 ? (dv ? 1 : -1) : 0);

      // Side 2: offset in U
      const s2x = ax + (u === 0 ? (du ? 1 : -1) : 0);
      const s2y = ay + (u === 1 ? (du ? 1 : -1) : 0);
      const s2z = az + (u === 2 ? (du ? 1 : -1) : 0);

      // Corner: offset in U and V
      const cx =
        ax + (u === 0 ? (du ? 1 : -1) : 0) + (v === 0 ? (dv ? 1 : -1) : 0);
      const cy =
        ay + (u === 1 ? (du ? 1 : -1) : 0) + (v === 1 ? (dv ? 1 : -1) : 0);
      const cz =
        az + (u === 2 ? (du ? 1 : -1) : 0) + (v === 2 ? (dv ? 1 : -1) : 0);

      const side1 = getBlock(s1x, s1y, s1z) !== 0;
      const side2 = getBlock(s2x, s2y, s2z) !== 0;
      const corner = getBlock(cx, cy, cz) !== 0;

      // Calculate AO value (0-3)
      const ao =
        (side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner && side1 && side2 ? 1 : 0);

      // Pack into 2 bits per corner: 00, 02, 04, 06 bit shifts
      packed |= ao << (i * 2);
    }
    return packed;
  }

  static generateMesh(data: {
    block_array: Uint8Array;
    chunk_size: number;
    light_array?: Uint8Array;
    neighbors: {
      px?: Uint8Array;
      nx?: Uint8Array;
      py?: Uint8Array;
      ny?: Uint8Array;
      pz?: Uint8Array;
      nz?: Uint8Array;
    };
    neighborLights?: {
      px?: Uint8Array;
      nx?: Uint8Array;
      py?: Uint8Array;
      ny?: Uint8Array;
      pz?: Uint8Array;
      nz?: Uint8Array;
    };
  }): {
    opaque: WorkerInternalMeshData;
    water: WorkerInternalMeshData;
    glass: WorkerInternalMeshData;
  } {
    const opaqueMeshData = this.createEmptyMeshData();
    const waterMeshData = this.createEmptyMeshData();
    const glassMeshData = this.createEmptyMeshData();

    const {
      block_array,
      light_array,
      chunk_size: chunk_size,
      neighbors,
      neighborLights,
    } = data;
    const size = chunk_size;
    const size2 = size * size;

    const getBlock = (
      x: number,
      y: number,
      z: number,
      fallback = 0
    ): number => {
      const inChunk =
        x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size;
      if (inChunk) return block_array[x + y * size + z * size2];

      // Check for diagonal neighbors (more than one coordinate out of bounds)
      let outCount = 0;
      if (x < 0 || x >= size) outCount++;
      if (y < 0 || y >= size) outCount++;
      if (z < 0 || z >= size) outCount++;
      if (outCount > 1) return fallback;

      if (x < 0) {
        return neighbors.nx
          ? neighbors.nx[size - 1 + y * size + z * size2]
          : fallback;
      }
      if (x >= size) {
        return neighbors.px ? neighbors.px[0 + y * size + z * size2] : fallback;
      }
      if (y < 0) {
        return neighbors.ny
          ? neighbors.ny[x + (size - 1) * size + z * size2]
          : fallback;
      }
      if (y >= size) {
        return neighbors.py ? neighbors.py[x + 0 * size + z * size2] : fallback;
      }
      if (z < 0) {
        return neighbors.nz
          ? neighbors.nz[x + y * size + (size - 1) * size2]
          : fallback;
      }
      if (z >= size) {
        return neighbors.pz ? neighbors.pz[x + y * size + 0] : fallback;
      }

      return fallback;
    };

    const getLight = (
      x: number,
      y: number,
      z: number,
      fallback = 0
    ): number => {
      if (!light_array) return 15; // Default to full light if no array
      const inChunk =
        x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size;
      if (inChunk) return light_array[x + y * size + z * size2];

      const nl = neighborLights || {};

      if (x < 0) {
        return nl.nx ? nl.nx[size - 1 + y * size + z * size2] : fallback;
      }
      if (x >= size) {
        return nl.px ? nl.px[0 + y * size + z * size2] : fallback;
      }
      if (y < 0) {
        return nl.ny ? nl.ny[x + (size - 1) * size + z * size2] : fallback;
      }
      if (y >= size) {
        return nl.py ? nl.py[x + 0 * size + z * size2] : fallback;
      }
      if (z < 0) {
        return nl.nz ? nl.nz[x + y * size + (size - 1) * size2] : fallback;
      }
      if (z >= size) {
        return nl.pz ? nl.pz[x + y * size + 0] : fallback;
      }

      return fallback;
    };

    // Mask bit encoding:
    // lower 16 bits: block ID (0 means empty)
    // bit 16 (1 << 16): TRANSPARENT_FLAG
    // bit 17 (1 << 17): BACKFACE_FLAG
    // We repack to fit 8 bits of light (sky + block)
    const BLOCK_ID_MASK = 0xfff; // 12 bits for block ID
    const TRANSPARENT_FLAG = 1 << 12;
    const BACKFACE_FLAG = 1 << 13;

    // single pass across axes -- generate masks containing encoded values
    for (let axis = 0; axis < 3; axis++) {
      const u_axis = (axis + 1) % 3;
      const v_axis = (axis + 2) % 3;

      const position = [0, 0, 0];
      const direction = [0, 0, 0];
      direction[axis] = 1;

      // reuseable mask
      const mask = new Int32Array(size * size);

      // sweep slices
      for (position[axis] = 0; position[axis] < size; position[axis]++) {
        let maskIndex = 0;

        for (
          position[v_axis] = 0;
          position[v_axis] < size;
          position[v_axis]++
        ) {
          for (
            position[u_axis] = 0;
            position[u_axis] < size;
            position[u_axis]++
          ) {
            const bx = position[0];
            const by = position[1];
            const bz = position[2];

            // sample current and neighbor; pass blockCurrent as fallback when sampling neighbor
            const blockCurrent = getBlock(bx, by, bz);
            const blockNeighbor = getBlock(
              bx + direction[0],
              by + direction[1],
              bz + direction[2],
              blockCurrent // key: if neighbor missing, pretend same block to avoid border faces
            );

            // --- Face Culling Logic ---
            if (blockCurrent === blockNeighbor) {
              mask[maskIndex++] = 0;
              continue;
            }

            const isCurrentTransparent =
              WATER_BLOCKS.has(blockCurrent) || GLASS_BLOCKS.has(blockCurrent);
            const isNeighborTransparent =
              WATER_BLOCKS.has(blockNeighbor) ||
              GLASS_BLOCKS.has(blockNeighbor);
            const isCurrentSolid = blockCurrent !== 0;
            const isNeighborSolid = blockNeighbor !== 0;

            // Water and glass should not cull each other.
            const isWaterNextToGlass =
              (WATER_BLOCKS.has(blockCurrent) &&
                GLASS_BLOCKS.has(blockNeighbor)) ||
              (GLASS_BLOCKS.has(blockCurrent) &&
                WATER_BLOCKS.has(blockNeighbor));

            if (
              isCurrentSolid &&
              (!isNeighborSolid ||
                (isNeighborTransparent && !isCurrentTransparent) ||
                isWaterNextToGlass)
            ) {
              // Current block face is visible.
              // The light level of the face is determined by the block in front of it (the neighbor).
              const lightPacked = getLight(
                bx + direction[0],
                by + direction[1],
                bz + direction[2]
              );
              // Calculate AO for the face (using the neighbor/air block coordinates)
              const packedAO = this.calculateAOPacked(
                bx + direction[0],
                by + direction[1],
                bz + direction[2],
                u_axis,
                v_axis,
                getBlock
              );
              const encCurrent =
                (blockCurrent & BLOCK_ID_MASK) |
                (isCurrentTransparent ? TRANSPARENT_FLAG : 0) |
                (packedAO << 14) | // Pack AO into bits 14-21
                (lightPacked << 22); // Pack 8-bit light into bits 22-29
              mask[maskIndex++] = encCurrent;
            } else if (
              isNeighborSolid &&
              (!isCurrentSolid ||
                (isCurrentTransparent && !isNeighborTransparent) ||
                isWaterNextToGlass)
            ) {
              // Neighbor block face is visible (so we draw a back-face).
              // The light level is determined by the current block (which is air/transparent).
              const lightPacked = getLight(bx, by, bz);
              // For backface, the "air" block is the current block (bx, by, bz)
              const packedAO = this.calculateAOPacked(
                bx,
                by,
                bz,
                u_axis,
                v_axis,
                getBlock
              );
              const encNeighbor =
                (blockNeighbor & BLOCK_ID_MASK) |
                (isNeighborTransparent ? TRANSPARENT_FLAG : 0) |
                (packedAO << 14) |
                (lightPacked << 22);
              mask[maskIndex++] = encNeighbor | BACKFACE_FLAG;
            } else {
              mask[maskIndex++] = 0;
            }
          }
        }

        maskIndex = 0;

        // Optimized Greedy merge from mask
        for (let v_coord = 0; v_coord < size; v_coord++) {
          for (let u_coord = 0; u_coord < size; ) {
            const currentMaskValue = mask[maskIndex];
            if (currentMaskValue !== 0) {
              // --- 1. Greedily find width ---
              let width = 1;
              while (
                u_coord + width < size &&
                mask[maskIndex + width] === currentMaskValue
              ) {
                width++;
              }

              // --- 2. Greedily find height ---
              let height = 1;
              while (v_coord + height < size) {
                let canExtend = true;
                // Check if the row below can be merged
                for (let w = 0; w < width; w++) {
                  if (
                    mask[maskIndex + w + height * size] !== currentMaskValue
                  ) {
                    canExtend = false;
                    break;
                  }
                }
                if (!canExtend) break;
                height++;
              }

              // --- 3. Add the quad and update the mask ---
              const isBackFace = (currentMaskValue & BACKFACE_FLAG) !== 0;
              const isTransparent = (currentMaskValue & TRANSPARENT_FLAG) !== 0;
              const blockId = currentMaskValue & BLOCK_ID_MASK;
              const lightPacked = (currentMaskValue >>> 22) & 0xff;
              const packedAO = (currentMaskValue >>> 14) & 0xff;

              position[u_axis] = u_coord;
              position[v_axis] = v_coord;

              const quadStartPos = [position[0], position[1], position[2]];
              quadStartPos[axis]++;

              let targetMesh: WorkerInternalMeshData;
              if (isTransparent) {
                targetMesh = WATER_BLOCKS.has(blockId)
                  ? waterMeshData
                  : glassMeshData;
              } else {
                targetMesh = opaqueMeshData;
              }

              this.addQuad(
                quadStartPos,
                direction,
                u_axis,
                v_axis,
                width,
                height,
                blockId,
                isBackFace,
                lightPacked,
                packedAO,
                targetMesh
              );

              // Zero out the mask for the area we just processed
              for (let h = 0; h < height; h++) {
                for (let w = 0; w < width; w++) {
                  mask[maskIndex + w + h * size] = 0;
                }
              }

              u_coord += width;
              maskIndex += width; // Advance mask index by the width of the quad
            } else {
              u_coord++;
              maskIndex++;
            }
          }
        }
      }
    }

    return {
      opaque: opaqueMeshData,
      water: waterMeshData,
      glass: glassMeshData,
    };
  }

  private static getFaceName(dir: number[], isBackFace: boolean): string {
    const [dx, dy, dz] = dir;
    if (dx === 1) return isBackFace ? "east" : "west";
    if (dy === 1) return isBackFace ? "bottom" : "top";
    if (dz === 1) return isBackFace ? "north" : "south";
    throw new Error("Invalid direction");
  }

  private static pushTileUV(
    cornerIds: ResizableTypedArray<Uint8Array>,
    uvs2: ResizableTypedArray<Uint8Array>,
    uvs3: ResizableTypedArray<Uint8Array>,
    width: number,
    height: number,
    tx: number,
    ty: number,
    q: number[]
  ) {
    // uvs2: tile coordinates (tx, ty) repeated for 4 vertices
    uvs2.push(tx, ty, tx, ty, tx, ty, tx, ty);

    if (q[0] === 1) {
      cornerIds.push(1, 2, 3, 0);
      uvs3.push(
        ...[height, width, height, width, height, width, height, width]
      );
    } else {
      cornerIds.push(0, 1, 2, 3);
      uvs3.push(
        ...[width, height, width, height, width, height, width, height]
      );
    }
  }

  public static addQuad(
    x: number[],
    q: number[],
    u: number,
    v: number,
    width: number,
    height: number,
    blockId: number,
    isBackFace: boolean,
    lightLevel: number,
    packedAO: number,
    meshData: WorkerInternalMeshData
  ) {
    const tex = BlockTextures[blockId];
    if (!tex) return;

    // create du/dv
    const du = [0, 0, 0];
    du[u] = width;
    const dv = [0, 0, 0];
    dv[v] = height;

    // compute four corner positions
    const p1 = [x[0], x[1], x[2]];
    const p2 = [x[0] + du[0], x[1] + du[1], x[2] + du[2]];
    const p3 = [
      x[0] + du[0] + dv[0],
      x[1] + du[1] + dv[1],
      x[2] + du[2] + dv[2],
    ];
    const p4 = [x[0] + dv[0], x[1] + dv[1], x[2] + dv[2]];

    // positions
    meshData.positions.push(...p1, ...p2, ...p3, ...p4);

    // Unpack AO
    const ao0 = packedAO & 3;
    const ao1 = (packedAO >> 2) & 3;
    const ao2 = (packedAO >> 4) & 3;
    const ao3 = (packedAO >> 6) & 3;
    const aoValues = [ao0, ao1, ao2, ao3];

    // 1. Push the four correct AO values for the four vertices.
    meshData.ao.push(...aoValues);

    // Push light values (flat shading for the quad)
    meshData.light.push(lightLevel, lightLevel, lightLevel, lightLevel);

    // normal
    const normalVec = isBackFace ? [-q[0], -q[1], -q[2]] : q;

    const faceData = FACE_DATA_CACHE[normalVec.join(",")];
    const { normal } = faceData;

    meshData.normals.push(...normal, ...normal, ...normal, ...normal);

    // tile lookup and UV writes
    const faceName = this.getFaceName(q, isBackFace);
    const tile = tex[faceName] ?? tex.all!;
    this.pushTileUV(
      meshData.cornerIds,
      meshData.uvs2,
      meshData.uvs3,
      width,
      height,
      tile[0],
      tile[1],
      q
    );

    const { indices, indexOffset } = meshData;

    // Standard quad indices (0,1,2) and (0,2,3)
    if (isBackFace) {
      indices.push(indexOffset, indexOffset + 1, indexOffset + 2);
      indices.push(indexOffset, indexOffset + 2, indexOffset + 3);
    } else {
      indices.push(indexOffset, indexOffset + 2, indexOffset + 1);
      indices.push(indexOffset, indexOffset + 3, indexOffset + 2);
    }
    meshData.indexOffset += 4;
  }

  public static generateHeightMapMesh(
    chunkX: number,
    chunkZ: number,
    chunkSize: number
  ) {
    // LOD: Use 1 segment per chunk (2x2 vertices) for distant terrain
    const segments = 1;
    const step = chunkSize / segments;
    const vertexCount = (segments + 1) * (segments + 1);
    const positions = new Int16Array(vertexCount * 3);
    const normals = new Uint8Array(vertexCount * 3);
    const uvs = new Uint8Array(vertexCount * 2);
    const colors = new Uint8Array(vertexCount * 4);
    const indices: number[] = [];

    const startX = chunkX * chunkSize;
    const startZ = chunkZ * chunkSize;
    const rowSize = segments + 1;

    let vIndex = 0;
    for (let z = 0; z <= chunkSize; z += step) {
      for (let x = 0; x <= chunkSize; x += step) {
        const worldX = startX + x;
        const worldZ = startZ + z;
        const y = TerrainHeightMap.getFinalTerrainHeight(worldX, worldZ);
        const biome = TerrainHeightMap.getBiome(worldX, worldZ);

        positions[vIndex * 3] = x;
        positions[vIndex * 3 + 1] = y;
        positions[vIndex * 3 + 2] = z;

        normals[vIndex * 3] = 0;
        normals[vIndex * 3 + 1] = 255;
        normals[vIndex * 3 + 2] = 0;

        uvs[vIndex * 2] = (1.0 - x / chunkSize) * 255;
        uvs[vIndex * 2 + 1] = (1.0 - z / chunkSize) * 255;

        let r = 128;
        let g = 128;
        let b = 128;

        switch (biome.name) {
          case "Forest":
            r = 34;
            g = 139;
            b = 34;
            break;
          case "Tundra":
            r = 200;
            g = 200;
            b = 200;
            break;
          case "Desert":
            r = 237;
            g = 213;
            b = 164;
            break;
          case "Jungle":
            r = 41;
            g = 168;
            b = 41;
            break;
          case "Plains":
            r = 141;
            g = 182;
            b = 104;
            break;
          case "Swamp":
            r = 47;
            g = 79;
            b = 79;
            break;
          default:
            r = 100;
            g = 100;
            b = 100;
            break;
        }

        // Simple height darkening
        if (y < 40) {
          r *= 0.8;
          g *= 0.8;
          b *= 0.8;
        }

        colors[vIndex * 4] = r;
        colors[vIndex * 4 + 1] = g;
        colors[vIndex * 4 + 2] = b;
        colors[vIndex * 4 + 3] = 255;
        vIndex++;
      }
    }

    for (let z = 0; z < segments; z++) {
      for (let x = 0; x < segments; x++) {
        const i0 = z * rowSize + x;
        const i1 = z * rowSize + (x + 1);
        const i2 = (z + 1) * rowSize + x;
        const i3 = (z + 1) * rowSize + (x + 1);

        indices.push(i0, i1, i2);
        indices.push(i1, i3, i2);
      }
    }

    return {
      positions,
      indices: new Uint16Array(indices),
      normals,
      uvs,
      colors,
    };
  }
}

// Top-level world generator instance for terrain requests
const generator: WorldGenerator = new WorldGenerator(GenerationParams);

const onMessageHandler = (event: MessageEvent) => {
  const { type } = event.data;

  // --- Default Full Remesh ---
  if (type === "full-remesh") {
    const { opaque, water, glass } = ChunkWorkerMesher.generateMesh(event.data);
    // allow GC
    event.data.block_array = undefined;
    event.data.neighbors = undefined;

    postFullMeshResult(event.data.chunkId, opaque, water, glass);
    return;
  }

  // --- Terrain generation request ---
  if (type === "generate-terrain") {
    const { chunkId, chunkX, chunkY, chunkZ } = event.data;

    const { blocks, light } = generator.generateChunkData(
      chunkX,
      chunkY,
      chunkZ
    );

    self.postMessage(
      {
        chunkId,
        type: "terrain-generated",
        block_array: blocks,
        light_array: light,
      },
      [blocks.buffer, light.buffer]
    );

    return;
  }

  if (type === "generate-heightmap") {
    const { chunkId, chunkX, chunkZ, chunk_size } = event.data;
    const meshData = ChunkWorkerMesher.generateHeightMapMesh(
      chunkX,
      chunkZ,
      chunk_size
    );

    self.postMessage(
      {
        chunkId,
        type: "heightmap-generated",
        mesh: meshData,
      },
      [
        meshData.positions.buffer,
        meshData.indices.buffer,
        meshData.normals.buffer,
        meshData.uvs.buffer,
        meshData.colors.buffer,
      ]
    );
    return;
  }

  if (type === "generate-distant-terrain") {
    const {
      centerChunkX,
      centerChunkZ,
      radius,
      renderDistance,
      gridStep,
      oldData,
      oldCenterChunkX,
      oldCenterChunkZ,
    } = event.data;
    const data = DistantTerrainGenerator.generate(
      centerChunkX,
      centerChunkZ,
      radius,
      renderDistance,
      gridStep,
      oldData,
      oldCenterChunkX,
      oldCenterChunkZ
    );
    self.postMessage(
      {
        type: "distant-terrain-generated",
        centerChunkX,
        centerChunkZ,
        ...data,
      },
      [data.positions.buffer, data.colors.buffer, data.normals.buffer]
    );
    return;
  }
};

self.onmessage = onMessageHandler;

function toTransferable(data: WorkerInternalMeshData): MeshData {
  return {
    positions: data.positions.finalArray,
    indices: data.indices.finalArray,
    normals: data.normals.finalArray,
    uvs2: data.uvs2.finalArray,
    uvs3: data.uvs3.finalArray,
    cornerIds: data.cornerIds.finalArray,
    ao: data.ao.finalArray,
    light: data.light.finalArray,
  };
}

function postFullMeshResult(
  chunkId: string,
  opaque: WorkerInternalMeshData,
  water: WorkerInternalMeshData,
  glass: WorkerInternalMeshData
) {
  const opaqueMeshData = toTransferable(opaque);
  const waterMeshData = toTransferable(water);
  const glassMeshData = toTransferable(glass);

  self.postMessage(
    {
      chunkId,
      type: "full-mesh",
      opaque: opaqueMeshData,
      water: waterMeshData,
      glass: glassMeshData,
    },
    [
      opaqueMeshData.positions.buffer,
      opaqueMeshData.indices.buffer,
      opaqueMeshData.normals.buffer,
      opaqueMeshData.uvs2.buffer,
      opaqueMeshData.uvs3.buffer,
      opaqueMeshData.cornerIds.buffer,
      opaqueMeshData.ao.buffer,
      opaqueMeshData.light.buffer,
      waterMeshData.positions.buffer,
      waterMeshData.indices.buffer,
      waterMeshData.normals.buffer,
      waterMeshData.uvs2.buffer,
      waterMeshData.uvs3.buffer,
      waterMeshData.cornerIds.buffer,
      waterMeshData.ao.buffer,
      waterMeshData.light.buffer,
      glassMeshData.positions.buffer,
      glassMeshData.indices.buffer,
      glassMeshData.normals.buffer,
      glassMeshData.uvs2.buffer,
      glassMeshData.uvs3.buffer,
      glassMeshData.cornerIds.buffer,
      glassMeshData.ao.buffer,
      glassMeshData.light.buffer,
    ]
  );
}
