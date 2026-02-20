/// <reference lib="webworker" />

import { WorldGenerator } from "../Generation/WorldGenerator";
import { MeshData } from "./DataStructures/MeshData";
import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";
import { ResizableTypedArray } from "./DataStructures/ResizableTypedArray";
import { WorkerInternalMeshData } from "./DataStructures/WorkerInternalMeshData";
import { DistantTerrainGenerator } from "../Generation/DistanTerrain/DistantTerrainGenerator";
import { BlockTextures } from "../Texture/BlockTextures";

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
    normal[axis] = side * 127;

    // Key calculation must use -1, 0, 1 values to match lookup in generateMesh
    const k = [0, 0, 0];
    k[axis] = side;

    const key = k[0] + 1 + (k[1] + 1) * 3 + (k[2] + 1) * 9;
    FACE_DATA_CACHE[key] = {
      normal,
    };
  }
}

const BLOCK_ID_MASK = 0xfff; // 12 bits for block ID
const TRANSPARENT_FLAG = 1 << 12;
const BACKFACE_FLAG = 1 << 13;

class ChunkWorkerMesher {
  private static toCompactNeighborIndex(fullIndex: number): number {
    // Full index is in a 3x3x3 cube (0..26) with center at 13.
    // Remesh payload omits center, so compact index is 0..25.
    return fullIndex > 13 ? fullIndex - 1 : fullIndex;
  }

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
    block_array: Uint8Array | Uint16Array;
    chunk_size: number;
    light_array?: Uint8Array;
    neighbors: (Uint8Array | Uint16Array | undefined)[];
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

    if (!block_array) {
      return {
        opaque: opaqueMeshData,
        water: waterMeshData,
        glass: glassMeshData,
      };
    }

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
      const fullNeighborIndex = dx + 1 + (dy + 1) * 3 + (dz + 1) * 9;
      const neighbor =
        neighbors[this.toCompactNeighborIndex(fullNeighborIndex)];

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
      if (!light_array) return 15 << 4; // Default to full skylight if no array
      if (x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size) {
        return light_array[x + y * size + z * size2];
      }

      const dx = x < 0 ? -1 : x >= size ? 1 : 0;
      const dy = y < 0 ? -1 : y >= size ? 1 : 0;
      const dz = z < 0 ? -1 : z >= size ? 1 : 0;

      const fullNeighborIndex = dx + 1 + (dy + 1) * 3 + (dz + 1) * 9;
      const neighbor = neighborLights
        ? neighborLights[this.toCompactNeighborIndex(fullNeighborIndex)]
        : undefined;

      if (!neighbor) return fallback;

      const lx = x - dx * size;
      const ly = y - dy * size;
      const lz = z - dz * size;

      return neighbor[lx + ly * size + lz * size2];
    };

    const direction = [0, 0, 0];
    // Reuseable mask allocated once
    const mask = new Uint32Array(size * size);

    // single pass across axes -- generate masks containing encoded values
    for (let axis = 0; axis < 3; axis++) {
      direction[axis] = 1;
      direction[(axis + 1) % 3] = 0;
      direction[(axis + 2) % 3] = 0;

      // Precompute face data for this axis to avoid lookups in the inner loop
      const faceNamePositive = this.getFaceName(direction, false);
      const faceNameNegative = this.getFaceName(direction, true);

      const keyPos =
        direction[0] + 1 + (direction[1] + 1) * 3 + (direction[2] + 1) * 9;
      const normalPositive = FACE_DATA_CACHE[keyPos].normal;
      const keyNeg =
        -direction[0] + 1 + (-direction[1] + 1) * 3 + (-direction[2] + 1) * 9;
      const normalNegative = FACE_DATA_CACHE[keyNeg].normal;

      // sweep slices
      for (let slice = 0; slice < size; slice++) {
        this.computeSliceMask(
          size,
          axis,
          slice,
          direction,
          block_array,
          getBlock,
          getLight,
          mask,
        );
        this.meshSlice(
          size,
          axis,
          slice,
          mask,
          opaqueMeshData,
          waterMeshData,
          glassMeshData,
          faceNamePositive,
          faceNameNegative,
          normalPositive,
          normalNegative,
        );
      }
    }

    return {
      opaque: opaqueMeshData,
      water: waterMeshData,
      glass: glassMeshData,
    };
  }

  private static computeSliceMask(
    size: number,
    axis: number,
    slice: number,
    direction: number[],
    block_array: Uint8Array | Uint16Array,
    getBlock: (x: number, y: number, z: number, fallback?: number) => number,
    getLight: (x: number, y: number, z: number, fallback?: number) => number,
    mask: Uint32Array,
  ) {
    const u_axis = (axis + 1) % 3;
    const v_axis = (axis + 2) % 3;
    const size2 = size * size;
    let maskIndex = 0;
    const position = [0, 0, 0];
    position[axis] = slice;

    for (position[v_axis] = 0; position[v_axis] < size; position[v_axis]++) {
      for (position[u_axis] = 0; position[u_axis] < size; position[u_axis]++) {
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
          WATER_BLOCKS.has(blockNeighbor) || GLASS_BLOCKS.has(blockNeighbor);
        const isCurrentSolid = blockCurrent !== 0;
        const isNeighborSolid = blockNeighbor !== 0;

        // Water and glass should not cull each other.
        const isWaterNextToGlass =
          (WATER_BLOCKS.has(blockCurrent) && GLASS_BLOCKS.has(blockNeighbor)) ||
          (GLASS_BLOCKS.has(blockCurrent) && WATER_BLOCKS.has(blockNeighbor));

        if (
          isCurrentSolid &&
          (!isNeighborSolid ||
            (isNeighborTransparent && !isCurrentTransparent) ||
            isWaterNextToGlass)
        ) {
          // Current block face is visible.
          // The light level of the face is determined by the block in front of it (the neighbor).
          const currentLightPacked = getLight(bx, by, bz, 15 << 4);
          const lightPacked = getLight(
            bx + direction[0],
            by + direction[1],
            bz + direction[2],
            currentLightPacked,
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
  }

  private static meshSlice(
    size: number,
    axis: number,
    slice: number,
    mask: Uint32Array,
    opaqueMeshData: WorkerInternalMeshData,
    waterMeshData: WorkerInternalMeshData,
    glassMeshData: WorkerInternalMeshData,
    faceNamePositive: string,
    faceNameNegative: string,
    normalPositive: Int8Array,
    normalNegative: Int8Array,
  ) {
    const u_axis = (axis + 1) % 3;
    const v_axis = (axis + 2) % 3;
    let maskIndex = 0;

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
              if (mask[maskIndex + w + height * size] !== currentMaskValue) {
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

          let x = 0,
            y = 0,
            z = 0;
          if (axis === 0) {
            x = slice + 1;
            y = u_coord;
            z = v_coord;
          } else if (axis === 1) {
            x = v_coord;
            y = slice + 1;
            z = u_coord;
          } else {
            x = u_coord;
            y = v_coord;
            z = slice + 1;
          }

          let targetMesh: WorkerInternalMeshData;
          if (isTransparent) {
            targetMesh = WATER_BLOCKS.has(blockId)
              ? waterMeshData
              : glassMeshData;
          } else {
            targetMesh = opaqueMeshData;
          }

          this.addQuad(
            x,
            y,
            z,
            axis,
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

  private static getFaceName(dir: number[], isBackFace: boolean): string {
    const [dx, dy, dz] = dir;
    if (dx === 1) return isBackFace ? "east" : "west";
    if (dy === 1) return isBackFace ? "bottom" : "top";
    if (dz === 1) return isBackFace ? "north" : "south";
    throw new Error("Invalid direction");
  }

  public static addQuad(
    x: number,
    y: number,
    z: number,
    axis: number,
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

    // Compute four corner positions directly
    const x1 = x,
      y1 = y,
      z1 = z;
    let x2 = x,
      y2 = y,
      z2 = z;
    let x3 = x,
      y3 = y,
      z3 = z;
    let x4 = x,
      y4 = y,
      z4 = z;

    // Apply width (u_axis)
    if (u === 0) {
      x2 += width;
      x3 += width;
    } else if (u === 1) {
      y2 += width;
      y3 += width;
    } else {
      z2 += width;
      z3 += width;
    }

    // Apply height (v_axis)
    if (v === 0) {
      x3 += height;
      x4 += height;
    } else if (v === 1) {
      y3 += height;
      y4 += height;
    } else {
      z3 += height;
      z4 += height;
    }

    // positions
    meshData.positions.push12(x1, y1, z1, x2, y2, z2, x3, y3, z3, x4, y4, z4);

    // Unpack AO
    const ao0 = packedAO & 3;
    const ao1 = (packedAO >> 2) & 3;
    const ao2 = (packedAO >> 4) & 3;
    const ao3 = (packedAO >> 6) & 3;

    // 1. Push the four correct AO values for the four vertices.
    meshData.ao.push4(ao0, ao1, ao2, ao3);

    // Push light values (flat shading for the quad)
    meshData.light.push4(lightLevel, lightLevel, lightLevel, lightLevel);

    // normal
    // We can assume normal is Int8Array(3)
    const nx = normal[0],
      ny = normal[1],
      nz = normal[2];
    meshData.normals.push12(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);

    // tile lookup and UV writes
    const tile = tex[faceName] ?? tex.all!;

    // Determine cornerIds and swapUV based on face direction to fix wrapping/mirroring
    let c0 = 0,
      c1 = 1,
      c2 = 2,
      c3 = 3;
    let swapUV = false;

    if (axis === 0) {
      if (!isBackFace) {
        // East (+X)
        c0 = 0;
        c1 = 3;
        c2 = 2;
        c3 = 1;
        swapUV = true;
      } else {
        // West (-X)
        c0 = 1;
        c1 = 2;
        c2 = 3;
        c3 = 0;
        swapUV = true;
      }
    } else if (axis === 1) {
      if (!isBackFace) {
        // Top (+Y)
        c0 = 0;
        c1 = 3;
        c2 = 2;
        c3 = 1;
        swapUV = true;
      } else {
        // Bottom (-Y)
        c0 = 3;
        c1 = 0;
        c2 = 1;
        c3 = 2;
        swapUV = true;
      }
    } else if (axis === 2) {
      if (!isBackFace) {
        // South (+Z)
        c0 = 1;
        c1 = 0;
        c2 = 3;
        c3 = 2;
        swapUV = false;
      } else {
        // North (-Z)
        c0 = 0;
        c1 = 1;
        c2 = 2;
        c3 = 3;
        swapUV = false;
      }
    }

    // Push UVs and Corner IDs
    const tx = tile[0];
    const ty = tile[1];
    meshData.uvs2.push8(tx, ty, tx, ty, tx, ty, tx, ty);
    meshData.cornerIds.push4(c0, c1, c2, c3);

    if (swapUV) {
      meshData.uvs3.push8(
        height,
        width,
        height,
        width,
        height,
        width,
        height,
        width,
      );
    } else {
      meshData.uvs3.push8(
        width,
        height,
        width,
        height,
        width,
        height,
        width,
        height,
      );
    }

    const { indices, indexOffset } = meshData;

    // Fix anisotropy by flipping quad diagonal based on AO
    const flip = ao0 + ao2 < ao1 + ao3;

    // Standard quad indices (0,1,2) and (0,2,3)
    if (isBackFace) {
      if (flip) {
        indices.push6(
          indexOffset,
          indexOffset + 1,
          indexOffset + 3,
          indexOffset + 1,
          indexOffset + 2,
          indexOffset + 3,
        );
      } else {
        indices.push6(
          indexOffset,
          indexOffset + 1,
          indexOffset + 2,
          indexOffset,
          indexOffset + 2,
          indexOffset + 3,
        );
      }
    } else {
      if (flip) {
        indices.push6(
          indexOffset,
          indexOffset + 3,
          indexOffset + 1,
          indexOffset + 1,
          indexOffset + 3,
          indexOffset + 2,
        );
      } else {
        indices.push6(
          indexOffset,
          indexOffset + 2,
          indexOffset + 1,
          indexOffset,
          indexOffset + 3,
          indexOffset + 2,
        );
      }
    }
    meshData.indexOffset += 4;
  }
}

function compressBlocks(blocks: Uint8Array): {
  isUniform: boolean;
  uniformBlockId: number;
  palette: Uint16Array | null;
  packedBlocks: Uint8Array | Uint16Array | null;
} {
  const uniqueBlocks = new Set<number>();
  for (let i = 0; i < blocks.length; i++) {
    uniqueBlocks.add(blocks[i]);
    if (uniqueBlocks.size > 16) break;
  }

  if (uniqueBlocks.size === 1) {
    return {
      isUniform: true,
      uniformBlockId: uniqueBlocks.values().next().value || 0,
      palette: null,
      packedBlocks: null,
    };
  } else if (uniqueBlocks.size <= 16) {
    const palette = Uint16Array.from(uniqueBlocks);
    const len = Math.ceil(blocks.length / 2);
    const buffer =
      typeof SharedArrayBuffer !== "undefined"
        ? new SharedArrayBuffer(len)
        : new ArrayBuffer(len);
    const packedArray = new Uint8Array(buffer);

    const paletteMap = new Map<number, number>();
    for (let i = 0; i < palette.length; i++) {
      paletteMap.set(palette[i], i);
    }

    for (let i = 0; i < blocks.length; i++) {
      const byteIndex = i >> 1;
      let byte = packedArray[byteIndex];
      const nibble = paletteMap.get(blocks[i])!;
      if (i & 1) {
        byte = (byte & 0x0f) | ((nibble & 0xf) << 4);
      } else {
        byte = (byte & 0xf0) | (nibble & 0xf);
      }
      packedArray[byteIndex] = byte;
    }
    return {
      isUniform: false,
      uniformBlockId: 0,
      palette,
      packedBlocks: packedArray,
    };
  } else {
    return {
      isUniform: false,
      uniformBlockId: 0,
      palette: null,
      packedBlocks: blocks,
    };
  }
}

// Top-level world generator instance for terrain requests
const generator = new WorldGenerator(GenerationParams);

function hasPaletteValuesAbove255(palette: ArrayLike<number>): boolean {
  for (let i = 0; i < palette.length; i++) {
    if (palette[i] > 255) return true;
  }
  return false;
}

const onMessageHandler = (event: MessageEvent) => {
  const { type } = event.data;

  // --- Default Full Remesh ---
  if (type === "full-remesh") {
    const { chunk_size } = event.data;
    // Rehydrate block_array if uniform
    if (
      !event.data.block_array &&
      typeof event.data.uniformBlockId === "number"
    ) {
      if (event.data.uniformBlockId > 255) {
        event.data.block_array = new Uint16Array(chunk_size ** 3).fill(
          event.data.uniformBlockId,
        );
      } else {
        event.data.block_array = new Uint8Array(chunk_size ** 3).fill(
          event.data.uniformBlockId,
        );
      }
    } else if (event.data.palette && event.data.block_array) {
      // Expand palette to raw array for meshing
      const packed = event.data.block_array as Uint8Array;
      const palette = event.data.palette as ArrayLike<number>;
      const expanded = hasPaletteValuesAbove255(palette)
        ? new Uint16Array(chunk_size ** 3)
        : new Uint8Array(chunk_size ** 3);
      for (let i = 0; i < expanded.length; i++) {
        const byteIndex = i >> 1;
        const byte = packed[byteIndex];
        const nibble = i & 1 ? (byte >> 4) & 0xf : byte & 0xf;
        expanded[i] = palette[nibble];
      }
      event.data.block_array = expanded;
    }

    // Rehydrate neighbors if uniform
    const { neighbors, neighborUniformIds, neighborPalettes } = event.data;
    if (neighborUniformIds) {
      for (let i = 0; i < neighbors.length; i++) {
        if (!neighbors[i] && typeof neighborUniformIds[i] === "number") {
          if (neighborUniformIds[i]! > 255) {
            neighbors[i] = new Uint16Array(chunk_size ** 3).fill(
              neighborUniformIds[i]!,
            );
          } else {
            neighbors[i] = new Uint8Array(chunk_size ** 3).fill(
              neighborUniformIds[i]!,
            );
          }
        } else if (neighbors[i] && neighborPalettes && neighborPalettes[i]) {
          const packed = neighbors[i]!;
          const palette = neighborPalettes[i]! as ArrayLike<number>;
          const expanded = hasPaletteValuesAbove255(palette)
            ? new Uint16Array(chunk_size ** 3)
            : new Uint8Array(chunk_size ** 3);
          for (let j = 0; j < expanded.length; j++) {
            const byteIndex = j >> 1;
            const byte = packed[byteIndex];
            const nibble = j & 1 ? (byte >> 4) & 0xf : byte & 0xf;
            expanded[j] = palette[nibble];
          }
          neighbors[i] = expanded;
        }
      }
    }

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

    const { isUniform, uniformBlockId, palette, packedBlocks } =
      compressBlocks(blocks);

    const transferables: Transferable[] = [];
    if (
      packedBlocks &&
      (typeof SharedArrayBuffer === "undefined" ||
        !(packedBlocks.buffer instanceof SharedArrayBuffer))
    ) {
      transferables.push(packedBlocks.buffer);
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
        block_array: packedBlocks,
        light_array: light,
        isUniform,
        uniformBlockId,
        palette,
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
