/// <reference lib="webworker" />

import { BlockTextures } from "../Texture/BlockTextures";
import { WorldGenerator } from "../Generation/WorldGenerator";
import { MeshData } from "./DataStructures/MeshData";
import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";
import { ResizableTypedArray } from "./DataStructures/ResizableTypedArray";
import { WorkerInternalMeshData } from "./DataStructures/WorkerInternalMeshData";
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

const FACE_DATA_CACHE: { [key: number]: FaceData } = {};

// Pre-calculate face data for all 6 directions
for (const axis of [0, 1, 2]) {
  for (const side of [-1, 1]) {
    const normal = new Int8Array(3);
    normal[axis] = side;

    const key = normal[0] + 1 + (normal[1] + 1) * 3 + (normal[2] + 1) * 9;
    FACE_DATA_CACHE[key] = {
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
    getBlock: (x: number, y: number, z: number) => number,
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
    neighbors: (Uint8Array | undefined)[];
    neighborLights?: (Uint8Array | undefined)[];
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
      fallback = 0,
    ): number => {
      if (x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size) {
        return block_array[x + y * size + z * size2];
      }

      const dx = x < 0 ? -1 : x >= size ? 1 : 0;
      const dy = y < 0 ? -1 : y >= size ? 1 : 0;
      const dz = z < 0 ? -1 : z >= size ? 1 : 0;

      // Map -1,0,1 to 0,1,2 for array indexing
      // Index = (dx+1) + (dy+1)*3 + (dz+1)*9
      const neighborIndex = dx + 1 + (dy + 1) * 3 + (dz + 1) * 9;
      const neighbor = neighbors[neighborIndex];

      if (!neighbor) return fallback;

      const lx = x - dx * size;
      const ly = y - dy * size;
      const lz = z - dz * size;

      return neighbor[lx + ly * size + lz * size2];
    };

    const getLight = (
      x: number,
      y: number,
      z: number,
      fallback = 0,
    ): number => {
      if (!light_array) return 15; // Default to full light if no array
      if (x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size) {
        return light_array[x + y * size + z * size2];
      }

      const dx = x < 0 ? -1 : x >= size ? 1 : 0;
      const dy = y < 0 ? -1 : y >= size ? 1 : 0;
      const dz = z < 0 ? -1 : z >= size ? 1 : 0;

      const neighborIndex = dx + 1 + (dy + 1) * 3 + (dz + 1) * 9;
      const neighbor = neighborLights
        ? neighborLights[neighborIndex]
        : undefined;

      if (!neighbor) return fallback;

      const lx = x - dx * size;
      const ly = y - dy * size;
      const lz = z - dz * size;

      return neighbor[lx + ly * size + lz * size2];
    };

    // Mask bit encoding:
    // lower 16 bits: block ID (0 means empty)
    // bit 16 (1 << 16): TRANSPARENT_FLAG
    // bit 17 (1 << 17): BACKFACE_FLAG
    // We repack to fit 8 bits of light (sky + block)
    const BLOCK_ID_MASK = 0xfff; // 12 bits for block ID
    const TRANSPARENT_FLAG = 1 << 12;
    const BACKFACE_FLAG = 1 << 13;

    const position = [0, 0, 0];
    const direction = [0, 0, 0];

    // single pass across axes -- generate masks containing encoded values
    for (let axis = 0; axis < 3; axis++) {
      const u_axis = (axis + 1) % 3;
      const v_axis = (axis + 2) % 3;

      direction[axis] = 1;
      direction[(axis + 1) % 3] = 0;
      direction[(axis + 2) % 3] = 0;

      const faceNamePositive = this.getFaceName(direction, false);
      const faceNameNegative = this.getFaceName(direction, true);

      const keyPos =
        direction[0] + 1 + (direction[1] + 1) * 3 + (direction[2] + 1) * 9;
      const normalPositive = FACE_DATA_CACHE[keyPos].normal;
      const keyNeg =
        -direction[0] + 1 + (-direction[1] + 1) * 3 + (-direction[2] + 1) * 9;
      const normalNegative = FACE_DATA_CACHE[keyNeg].normal;

      // reuseable mask
      const mask = new Uint32Array(size * size);

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
            const blockCurrent = block_array[bx + by * size + bz * size2];
            const blockNeighbor = getBlock(
              bx + direction[0],
              by + direction[1],
              bz + direction[2],
              blockCurrent, // key: if neighbor missing, pretend same block to avoid border faces
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
                bz + direction[2],
              );
              // Calculate AO for the face (using the neighbor/air block coordinates)
              const packedAO = this.calculateAOPacked(
                bx + direction[0],
                by + direction[1],
                bz + direction[2],
                u_axis,
                v_axis,
                getBlock,
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
                getBlock,
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
              const faceName = isBackFace ? faceNameNegative : faceNamePositive;
              const normal = isBackFace ? normalNegative : normalPositive;
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
                faceName,
                normal,
                lightPacked,
                packedAO,
                targetMesh,
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
    q: number[],
  ) {
    // uvs2: tile coordinates (tx, ty) repeated for 4 vertices
    uvs2.push(tx, ty, tx, ty, tx, ty, tx, ty);

    if (q[0] === 1) {
      cornerIds.push(1, 2, 3, 0);
      uvs3.push(
        ...[height, width, height, width, height, width, height, width],
      );
    } else {
      cornerIds.push(0, 1, 2, 3);
      uvs3.push(
        ...[width, height, width, height, width, height, width, height],
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
    faceName: string,
    normal: Int8Array,
    lightLevel: number,
    packedAO: number,
    meshData: WorkerInternalMeshData,
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
    meshData.normals.push(...normal, ...normal, ...normal, ...normal);

    // tile lookup and UV writes
    const tile = tex[faceName] ?? tex.all!;
    this.pushTileUV(
      meshData.cornerIds,
      meshData.uvs2,
      meshData.uvs3,
      width,
      height,
      tile[0],
      tile[1],
      q,
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
      chunkZ,
    );

    const transferables: Transferable[] = [];
    if (
      typeof SharedArrayBuffer === "undefined" ||
      !(blocks.buffer instanceof SharedArrayBuffer)
    ) {
      transferables.push(blocks.buffer);
    }
    if (
      typeof SharedArrayBuffer === "undefined" ||
      !(light.buffer instanceof SharedArrayBuffer)
    ) {
      transferables.push(light.buffer);
    }

    self.postMessage(
      {
        chunkId,
        type: "terrain-generated",
        block_array: blocks,
        light_array: light,
      },
      transferables,
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
      oldCenterChunkZ,
    );
    self.postMessage(
      {
        type: "distant-terrain-generated",
        centerChunkX,
        centerChunkZ,
        ...data,
      },
      [data.positions.buffer, data.colors.buffer],
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
  glass: WorkerInternalMeshData,
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
    ],
  );
}
