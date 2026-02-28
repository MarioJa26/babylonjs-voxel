/// <reference lib="webworker" />

import { WorldGenerator } from "../Generation/WorldGenerator";
import { MeshData } from "./DataStructures/MeshData";
import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";
import { ResizableTypedArray } from "./DataStructures/ResizableTypedArray";
import { WorkerInternalMeshData } from "./DataStructures/WorkerInternalMeshData";
import { DistantTerrainGenerator } from "../Generation/DistanTerrain/DistantTerrainGenerator";
import { BlockTextures } from "../Texture/BlockTextures";

// ---------------------------------------------------------------------------
// Block classification — flat Uint8 lookup instead of Set.has() calls
// ---------------------------------------------------------------------------
// Set.has() on every block face in the inner loop is surprisingly expensive.
// Replace with a typed array lookup: O(1) with no hashing overhead.
const BLOCK_TYPE = new Uint8Array(65536); // covers all 16-bit block IDs
const BLOCK_TYPE_TRANSPARENT = 1;
// 0 = opaque/air
for (const id of [30, 60, 61]) BLOCK_TYPE[id] = BLOCK_TYPE_TRANSPARENT; // water (30) and glass (60, 61)

type FaceData = {
  normal: Int8Array;
};

const FACE_DATA_CACHE: { [key: number]: FaceData } = {};

// Pre-calculate face data for all 6 directions
for (const axis of [0, 1, 2]) {
  for (const side of [-1, 1]) {
    const normal = new Int8Array(3);
    normal[axis] = side * 127;

    const k = [0, 0, 0];
    k[axis] = side;

    const key = k[0] + 1 + (k[1] + 1) * 3 + (k[2] + 1) * 9;
    FACE_DATA_CACHE[key] = { normal };
  }
}

// Pre-build cornerId + swapUV tables indexed by [axis * 2 + (isBackFace ? 1 : 0)]
// so addQuad() avoids a chain of if/else on every call.
const CORNER_TABLE: [number, number, number, number, boolean][] = [
  [0, 3, 2, 1, true], // axis=0 front  (East  +X)
  [1, 2, 3, 0, true], // axis=0 back   (West  -X)
  [0, 3, 2, 1, true], // axis=1 front  (Top   +Y)
  [3, 0, 1, 2, true], // axis=1 back   (Bottom-Y)
  [1, 0, 3, 2, false], // axis=2 front  (South +Z)
  [0, 1, 2, 3, false], // axis=2 back   (North -Z)
];

const BLOCK_ID_MASK = 0xfff; // 12 bits for block ID
const TRANSPARENT_FLAG = 1 << 12;
const BACKFACE_FLAG = 1 << 13;

class ChunkWorkerMesher {
  private static toCompactNeighborIndex(fullIndex: number): number {
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
      materialFlags: new ResizableTypedArray(Uint8Array), // 0 = glass, 1 = water
      indexOffset: 0,
    };
  }

  /**
   * Calculate packed AO (2 bits × 4 corners = 8 bits) for one face.
   *
   * OPTIMIZATION: Pre-compute the six axis offsets once per call rather than
   * recomputing the ternary `(axis === N ? ±1 : 0)` expressions 12× inside
   * the corner loop. This cuts ~72 conditional evaluations down to 6.
   */
  private static calculateAOPacked(
    ax: number,
    ay: number,
    az: number,
    u: number,
    v: number,
    getBlock: (x: number, y: number, z: number) => number,
  ): number {
    // Offsets along u-axis (±1) and v-axis (±1) in world-space X/Y/Z
    const ux = u === 0 ? 1 : 0;
    const uy = u === 1 ? 1 : 0;
    const uz = u === 2 ? 1 : 0;
    const vx = v === 0 ? 1 : 0;
    const vy = v === 1 ? 1 : 0;
    const vz = v === 2 ? 1 : 0;

    // 4 corners: du/dv ∈ {0,1}×{0,1} mapped to UV-quad corners (0,0)(1,0)(1,1)(0,1)
    let packed = 0;
    for (let i = 0; i < 4; i++) {
      // du=1 for corners 1 & 2,  dv=1 for corners 2 & 3
      const du = i === 1 || i === 2 ? 1 : -1;
      const dv = i === 2 || i === 3 ? 1 : -1;

      const side1 = getBlock(ax + vx * dv, ay + vy * dv, az + vz * dv) !== 0;
      const side2 = getBlock(ax + ux * du, ay + uy * du, az + uz * du) !== 0;
      const corner =
        getBlock(
          ax + ux * du + vx * dv,
          ay + uy * du + vy * dv,
          az + uz * du + vz * dv,
        ) !== 0;

      const ao =
        (side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner && side1 && side2 ? 1 : 0);
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
    transparent: WorkerInternalMeshData;
  } {
    const opaqueMeshData = this.createEmptyMeshData();
    const transparentMeshData = this.createEmptyMeshData();

    const {
      block_array,
      light_array,
      chunk_size: size,
      neighbors,
      neighborLights,
    } = data;

    if (!block_array) {
      return {
        opaque: opaqueMeshData,
        transparent: transparentMeshData,
      };
    }

    const size2 = size * size;

    // ---------------------------------------------------------------------------
    // getBlock / getLight — inlined hot path for in-bounds coords,
    // neighbor lookup only for out-of-bounds.
    // ---------------------------------------------------------------------------
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
      const neighbor =
        neighbors[
          this.toCompactNeighborIndex(dx + 1 + (dy + 1) * 3 + (dz + 1) * 9)
        ];
      if (!neighbor) return fallback;
      return neighbor[
        x - dx * size + (y - dy * size) * size + (z - dz * size) * size2
      ];
    };

    const getLight = (
      x: number,
      y: number,
      z: number,
      fallback = 0,
    ): number => {
      if (!light_array) return 15 << 4;
      if (x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size) {
        return light_array[x + y * size + z * size2];
      }
      const dx = x < 0 ? -1 : x >= size ? 1 : 0;
      const dy = y < 0 ? -1 : y >= size ? 1 : 0;
      const dz = z < 0 ? -1 : z >= size ? 1 : 0;
      const neighbor = neighborLights
        ? neighborLights[
            this.toCompactNeighborIndex(dx + 1 + (dy + 1) * 3 + (dz + 1) * 9)
          ]
        : undefined;
      if (!neighbor) return fallback;
      return neighbor[
        x - dx * size + (y - dy * size) * size + (z - dz * size) * size2
      ];
    };

    const direction = [0, 0, 0];
    const mask = new Uint32Array(size * size); // reused across all slices

    for (let axis = 0; axis < 3; axis++) {
      direction[0] = axis === 0 ? 1 : 0;
      direction[1] = axis === 1 ? 1 : 0;
      direction[2] = axis === 2 ? 1 : 0;

      const faceNamePositive = this.getFaceName(direction, false);
      const faceNameNegative = this.getFaceName(direction, true);

      const keyPos =
        direction[0] + 1 + (direction[1] + 1) * 3 + (direction[2] + 1) * 9;
      const keyNeg =
        -direction[0] + 1 + (-direction[1] + 1) * 3 + (-direction[2] + 1) * 9;
      const normalPositive = FACE_DATA_CACHE[keyPos].normal;
      const normalNegative = FACE_DATA_CACHE[keyNeg].normal;

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
          transparentMeshData,
          faceNamePositive,
          faceNameNegative,
          normalPositive,
          normalNegative,
        );
      }
    }

    return {
      opaque: opaqueMeshData,
      transparent: transparentMeshData,
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

    const dx = direction[0],
      dy = direction[1],
      dz = direction[2];

    for (position[v_axis] = 0; position[v_axis] < size; position[v_axis]++) {
      for (position[u_axis] = 0; position[u_axis] < size; position[u_axis]++) {
        const bx = position[0];
        const by = position[1];
        const bz = position[2];

        const blockCurrent = block_array[bx + by * size + bz * size2];
        const blockNeighbor = getBlock(bx + dx, by + dy, bz + dz, blockCurrent);

        if (blockCurrent === blockNeighbor) {
          mask[maskIndex++] = 0;
          continue;
        }

        // OPTIMIZATION: replace Set.has() with flat array lookup (no hashing)
        const curType = BLOCK_TYPE[blockCurrent];
        const nbrType = BLOCK_TYPE[blockNeighbor];
        const isCurrentTransparent = curType !== 0;
        const isNeighborTransparent = nbrType !== 0;
        const isCurrentSolid = blockCurrent !== 0;
        const isNeighborSolid = blockNeighbor !== 0;

        if (
          isCurrentSolid &&
          (!isNeighborSolid || (isNeighborTransparent && !isCurrentTransparent))
        ) {
          const currentLightPacked = getLight(bx, by, bz, 15 << 4);
          const lightPacked = getLight(
            bx + dx,
            by + dy,
            bz + dz,
            currentLightPacked,
          );
          const packedAO = this.calculateAOPacked(
            bx + dx,
            by + dy,
            bz + dz,
            u_axis,
            v_axis,
            getBlock,
          );
          mask[maskIndex++] =
            (blockCurrent & BLOCK_ID_MASK) |
            (isCurrentTransparent ? TRANSPARENT_FLAG : 0) |
            (packedAO << 14) |
            (lightPacked << 22);
        } else if (
          isNeighborSolid &&
          (!isCurrentSolid || (isCurrentTransparent && !isNeighborTransparent))
        ) {
          const lightPacked = getLight(bx, by, bz);
          const packedAO = this.calculateAOPacked(
            bx,
            by,
            bz,
            u_axis,
            v_axis,
            getBlock,
          );
          mask[maskIndex++] =
            (blockNeighbor & BLOCK_ID_MASK) |
            (isNeighborTransparent ? TRANSPARENT_FLAG : 0) |
            (packedAO << 14) |
            (lightPacked << 22) |
            BACKFACE_FLAG;
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
    transparentMeshData: WorkerInternalMeshData,
    faceNamePositive: string,
    faceNameNegative: string,
    normalPositive: Int8Array,
    normalNegative: Int8Array,
  ) {
    const u_axis = (axis + 1) % 3;
    const v_axis = (axis + 2) % 3;
    let maskIndex = 0;

    for (let v_coord = 0; v_coord < size; v_coord++) {
      for (let u_coord = 0; u_coord < size; ) {
        const currentMaskValue = mask[maskIndex];
        if (currentMaskValue !== 0) {
          // Greedy width
          let width = 1;
          while (
            u_coord + width < size &&
            mask[maskIndex + width] === currentMaskValue
          ) {
            width++;
          }

          // Greedy height
          let height = 1;
          outer: while (v_coord + height < size) {
            for (let w = 0; w < width; w++) {
              if (mask[maskIndex + w + height * size] !== currentMaskValue)
                break outer;
            }
            height++;
          }

          const isBackFace = (currentMaskValue & BACKFACE_FLAG) !== 0;
          const isTransparent = (currentMaskValue & TRANSPARENT_FLAG) !== 0;
          const blockId = currentMaskValue & BLOCK_ID_MASK;
          const faceName = isBackFace ? faceNameNegative : faceNamePositive;
          const normal = isBackFace ? normalNegative : normalPositive;
          const lightPacked = (currentMaskValue >>> 22) & 0xff;
          const packedAO = (currentMaskValue >>> 14) & 0xff;

          // Resolve vertex origin based on axis
          let x: number, y: number, z: number;
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

          // OPTIMIZATION: replace Set.has() with flat array lookup
          let targetMesh: WorkerInternalMeshData;
          if (isTransparent) {
            targetMesh = transparentMeshData;
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

          // Zero out the processed mask region
          for (let h = 0; h < height; h++) {
            for (let w = 0; w < width; w++) {
              mask[maskIndex + w + h * size] = 0;
            }
          }

          u_coord += width;
          maskIndex += width;
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

    // Compute four corner positions
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

    meshData.positions.push12(x1, y1, z1, x2, y2, z2, x3, y3, z3, x4, y4, z4);

    const ao0 = packedAO & 3;
    const ao1 = (packedAO >> 2) & 3;
    const ao2 = (packedAO >> 4) & 3;
    const ao3 = (packedAO >> 6) & 3;
    meshData.ao.push4(ao0, ao1, ao2, ao3);

    meshData.light.push4(lightLevel, lightLevel, lightLevel, lightLevel);

    // Determine material type: 1 = water (blockId 30), 0 = glass (blockId 60, 61)
    const materialType = blockId === 30 ? 1 : 0;
    meshData.materialFlags.push4(
      materialType,
      materialType,
      materialType,
      materialType,
    );

    const nx = normal[0],
      ny = normal[1],
      nz = normal[2];
    meshData.normals.push12(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);

    const tile = tex[faceName] ?? tex.all!;
    const tx = tile[0],
      ty = tile[1];
    meshData.uvs2.push8(tx, ty, tx, ty, tx, ty, tx, ty);

    // OPTIMIZATION: look up corner config from pre-built table — eliminates
    // 6 branches (if/else chain) executed on every single quad.
    const [c0, c1, c2, c3, swapUV] =
      CORNER_TABLE[axis * 2 + (isBackFace ? 1 : 0)];
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
    const flip = ao0 + ao2 < ao1 + ao3;

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

// ---------------------------------------------------------------------------
// Block compression
// ---------------------------------------------------------------------------

function compressBlocks(blocks: Uint8Array): {
  isUniform: boolean;
  uniformBlockId: number;
  palette: Uint16Array | null;
  packedBlocks: Uint8Array | Uint16Array | null;
} {
  // OPTIMIZATION: scan with early-exit rather than collecting into a Set.
  // We only need to know: uniform? ≤16 unique? or >16 unique?
  // This avoids allocating a Set object on every terrain generation call.
  const seen = new Uint8Array(255); // 64 KB, stack-allocated equivalent
  let uniqueCount = 0;
  const firstId = blocks[0];

  for (let i = 0; i < blocks.length; i++) {
    const id = blocks[i];
    if (!seen[id]) {
      seen[id] = 1;
      uniqueCount++;
      if (uniqueCount > 16) break;
    }
  }

  if (uniqueCount === 1) {
    return {
      isUniform: true,
      uniformBlockId: firstId,
      palette: null,
      packedBlocks: null,
    };
  }

  if (uniqueCount <= 16) {
    // Build palette from the seen[] flags (preserves insertion order isn't needed)
    const palette = new Uint16Array(uniqueCount);
    let pi = 0;
    for (let id = 0; id < 65536 && pi < uniqueCount; id++) {
      if (seen[id]) palette[pi++] = id;
    }

    // Build a reverse lookup: blockId → palette index
    // Re-use seen[] as a scratch buffer (values 0..15 now mean palette index)
    for (let i = 0; i < palette.length; i++) seen[palette[i]] = i;

    const len = (blocks.length + 1) >> 1;
    const buffer =
      typeof SharedArrayBuffer !== "undefined"
        ? new SharedArrayBuffer(len)
        : new ArrayBuffer(len);
    const packedArray = new Uint8Array(buffer);

    for (let i = 0; i < blocks.length; i++) {
      const nibble = seen[blocks[i]];
      const byteIndex = i >> 1;
      if (i & 1) {
        packedArray[byteIndex] =
          (packedArray[byteIndex] & 0x0f) | ((nibble & 0xf) << 4);
      } else {
        packedArray[byteIndex] =
          (packedArray[byteIndex] & 0xf0) | (nibble & 0xf);
      }
    }

    return {
      isUniform: false,
      uniformBlockId: 0,
      palette,
      packedBlocks: packedArray,
    };
  }

  // >16 unique blocks — store raw
  return {
    isUniform: false,
    uniformBlockId: 0,
    palette: null,
    packedBlocks: blocks,
  };
}

// ---------------------------------------------------------------------------
// Palette expansion helpers (reused by full-remesh handler)
// ---------------------------------------------------------------------------

function hasPaletteValuesAbove255(palette: ArrayLike<number>): boolean {
  for (let i = 0; i < palette.length; i++) {
    if (palette[i] > 255) return true;
  }
  return false;
}

function expandPalette(
  packed: Uint8Array,
  palette: ArrayLike<number>,
  totalBlocks: number,
): Uint8Array | Uint16Array {
  const expanded = hasPaletteValuesAbove255(palette)
    ? new Uint16Array(totalBlocks)
    : new Uint8Array(totalBlocks);
  for (let i = 0; i < totalBlocks; i++) {
    const byte = packed[i >> 1];
    expanded[i] = palette[i & 1 ? (byte >> 4) & 0xf : byte & 0xf];
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// Worker message handler
// ---------------------------------------------------------------------------

const generator = new WorldGenerator(GenerationParams);

const onMessageHandler = (event: MessageEvent) => {
  const { type } = event.data;

  // --- Full Remesh ---
  if (type === "full-remesh") {
    const { chunk_size } = event.data;
    const totalBlocks = chunk_size ** 3;

    // Rehydrate center chunk block array
    if (
      !event.data.block_array &&
      typeof event.data.uniformBlockId === "number"
    ) {
      event.data.block_array =
        event.data.uniformBlockId > 255
          ? new Uint16Array(totalBlocks).fill(event.data.uniformBlockId)
          : new Uint8Array(totalBlocks).fill(event.data.uniformBlockId);
    } else if (event.data.palette && event.data.block_array) {
      event.data.block_array = expandPalette(
        event.data.block_array,
        event.data.palette,
        totalBlocks,
      );
    }

    // Rehydrate neighbors
    const { neighbors, neighborUniformIds, neighborPalettes } = event.data;
    if (neighborUniformIds) {
      for (let i = 0; i < neighbors.length; i++) {
        if (!neighbors[i] && typeof neighborUniformIds[i] === "number") {
          neighbors[i] =
            neighborUniformIds[i]! > 255
              ? new Uint16Array(totalBlocks).fill(neighborUniformIds[i]!)
              : new Uint8Array(totalBlocks).fill(neighborUniformIds[i]!);
        } else if (neighbors[i] && neighborPalettes?.[i]) {
          neighbors[i] = expandPalette(
            neighbors[i]! as Uint8Array,
            neighborPalettes[i]!,
            totalBlocks,
          );
        }
      }
    }

    const { opaque, transparent } = ChunkWorkerMesher.generateMesh(event.data);
    // Allow GC of large block arrays
    event.data.block_array = undefined;
    event.data.neighbors = undefined;

    postFullMeshResult(event.data.chunkId, opaque, transparent);
    return;
  }

  // --- Terrain generation ---
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
      !(
        packedBlocks.buffer instanceof
        (typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : Object)
      )
    ) {
      transferables.push(packedBlocks.buffer);
    }
    if (
      !(
        light.buffer instanceof
        (typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : Object)
      )
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

  // --- Distant terrain ---
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
      [data.positions.buffer, data.normals.buffer, data.surfaceTiles.buffer],
    );
    return;
  }
};

self.onmessage = onMessageHandler;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    materialType: data.materialFlags.finalArray,
  };
}

function postFullMeshResult(
  chunkId: string,
  opaque: WorkerInternalMeshData,
  transparent: WorkerInternalMeshData,
) {
  const opaqueMeshData = toTransferable(opaque);
  const transparentMeshData = toTransferable(transparent);

  self.postMessage(
    {
      chunkId,
      type: "full-mesh",
      opaque: opaqueMeshData,
      transparent: transparentMeshData,
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
      transparentMeshData.positions.buffer,
      transparentMeshData.indices.buffer,
      transparentMeshData.normals.buffer,
      transparentMeshData.uvs2.buffer,
      transparentMeshData.uvs3.buffer,
      transparentMeshData.cornerIds.buffer,
      transparentMeshData.ao.buffer,
      transparentMeshData.light.buffer,
      transparentMeshData.materialType.buffer,
    ],
  );
}
