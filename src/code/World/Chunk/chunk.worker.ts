/// <reference lib="webworker" />

import { BlockTextures } from "../Texture/BlockTextures";
import { WorldGenerator } from "../Generation/WorldGenerator";
import { MeshData } from "./MeshData";

/**
 * A wrapper around a TypedArray that allows it to be resized dynamically.
 * This is more performant than using a standard number[] and then converting.
 */
class ResizableTypedArray<T extends Uint8Array | Uint16Array | Int8Array> {
  private array: T;
  private capacity: number;
  public length = 0;

  constructor(
    private ctor: new (capacity: number) => T,
    initialCapacity = 256
  ) {
    this.capacity = initialCapacity;
    this.array = new ctor(this.capacity);
  }

  push(...values: number[]): void {
    if (this.length + values.length > this.capacity) {
      this.grow(this.length + values.length);
    }
    this.array.set(values, this.length);
    this.length += values.length;
  }

  private grow(minCapacity: number): void {
    let newCapacity = this.capacity * 2;
    while (newCapacity < minCapacity) {
      newCapacity *= 2;
    }
    const newArray = new this.ctor(newCapacity);
    newArray.set(this.array.subarray(0, this.length));
    this.array = newArray;
    this.capacity = newCapacity;
  }

  get finalArray(): T {
    return this.array.subarray(0, this.length) as T;
  }
}

type WorkerInternalMeshData = {
  positions: ResizableTypedArray<Uint8Array>;
  indices: ResizableTypedArray<Uint16Array>;
  normals: ResizableTypedArray<Int8Array>;
  tangents: ResizableTypedArray<Int8Array>;
  uvs2: ResizableTypedArray<Uint8Array>;
  uvs3: ResizableTypedArray<Uint8Array>;
  cornerIds: ResizableTypedArray<Uint8Array>;
  ao: ResizableTypedArray<Uint8Array>;
  indexOffset: number;
};

const WATER_BLOCKS = new Set([30]);
const GLASS_BLOCKS = new Set([60]);

type FaceData = {
  normal: Int8Array;
  tangent: Int8Array;
  handedness: number;
};

const FACE_DATA_CACHE: { [key: string]: FaceData } = {};

// Pre-calculate face data for all 6 directions
for (const axis of [0, 1, 2]) {
  for (const side of [-1, 1]) {
    const normal = new Int8Array(3);
    normal[axis] = side;

    const u_axis = (axis + 1) % 3;
    const v_axis = (axis + 2) % 3;

    const tangentVec = new Int8Array(3);
    tangentVec[u_axis] = 1;

    const bitangentVec = new Int8Array(3);
    bitangentVec[v_axis] = 1;

    const crossNT = [
      normal[1] * tangentVec[2] - normal[2] * tangentVec[1],
      normal[2] * tangentVec[0] - normal[0] * tangentVec[2],
      normal[0] * tangentVec[1] - normal[1] * tangentVec[0],
    ];
    const handedness =
      crossNT[0] * bitangentVec[0] +
        crossNT[1] * bitangentVec[1] +
        crossNT[2] * bitangentVec[2] <
      0
        ? -1.0
        : 1.0;
    FACE_DATA_CACHE[normal.join(",")] = {
      normal,
      tangent: tangentVec,
      handedness,
    };
  }
}

class ChunkWorkerMesher {
  private static createEmptyMeshData(): WorkerInternalMeshData {
    return {
      positions: new ResizableTypedArray(Uint8Array),
      indices: new ResizableTypedArray(Uint16Array),
      normals: new ResizableTypedArray(Int8Array),
      tangents: new ResizableTypedArray(Int8Array),
      uvs2: new ResizableTypedArray(Uint8Array),
      uvs3: new ResizableTypedArray(Uint8Array),
      cornerIds: new ResizableTypedArray(Uint8Array),
      ao: new ResizableTypedArray(Uint8Array),
      indexOffset: 0,
    };
  }

  static generateMesh(data: {
    block_array: Uint8Array;
    chunk_size: number;
    neighbors: {
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

    const { block_array, chunk_size: chunk_size, neighbors } = data;
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

    // Mask bit encoding:
    // lower 16 bits: block ID (0 means empty)
    // bit 16 (1 << 16): TRANSPARENT_FLAG
    // bit 17 (1 << 17): BACKFACE_FLAG
    const TRANSPARENT_FLAG = 1 << 16;
    const BACKFACE_FLAG = 1 << 17;
    const BLOCK_ID_MASK = 0xffff;

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
              const encCurrent =
                (blockCurrent & BLOCK_ID_MASK) |
                (isCurrentTransparent ? TRANSPARENT_FLAG : 0);
              mask[maskIndex++] = encCurrent;
            } else if (
              isNeighborSolid &&
              (!isCurrentSolid ||
                (isCurrentTransparent && !isNeighborTransparent) ||
                isWaterNextToGlass)
            ) {
              // Neighbor block face is visible (so we draw a back-face).
              const encNeighbor =
                (blockNeighbor & BLOCK_ID_MASK) |
                (isNeighborTransparent ? TRANSPARENT_FLAG : 0);
              mask[maskIndex++] = encNeighbor | BACKFACE_FLAG;
            } else {
              mask[maskIndex++] = 0;
            }
          }
        }

        maskIndex = 0;

        // --- Non-Greedy Quad Generation for Per-Block AO ---
        for (let v_coord = 0; v_coord < size; v_coord++) {
          for (let u_coord = 0; u_coord < size; u_coord++) {
            const currentMaskValue = mask[maskIndex];
            if (currentMaskValue !== 0) {
              // Decode mask value
              const isBackFace = (currentMaskValue & BACKFACE_FLAG) !== 0;
              const isTransparent = (currentMaskValue & TRANSPARENT_FLAG) !== 0;
              const blockId = currentMaskValue & BLOCK_ID_MASK;

              position[u_axis] = u_coord;
              position[v_axis] = v_coord;

              const quadStartPos = [position[0], position[1], position[2]];
              quadStartPos[axis]++;

              let targetMesh = opaqueMeshData;
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
                1, // width is always 1
                1, // height is always 1
                blockId,
                isBackFace,
                getBlock,
                targetMesh
              );
            }
            maskIndex++;
          }
        }
        /*
        // Optimized Greedy merge from mask
        for (let v_coord = 0; v_coord < size; v_coord++) {
          for (let u_coord = 0; u_coord < size; ) {
            const currentMaskValue = mask[maskIndex];
            if (currentMaskValue !== 0) {
              // Greedily find width
              let width = 1;
              while (
                u_coord + width < size &&
                mask[maskIndex + width] === currentMaskValue
              ) {
                width++;
              }

              // Greedily find height
              let height = 1;
              // Scan rows below to extend the quad vertically
              for (let h = 1; v_coord + h < size; h++) {
                let canExtend = true;
                for (let w = 0; w < width; w++) {
                  if (mask[maskIndex + w + h * size] !== currentMaskValue) {
                    canExtend = false;
                    break;
                  }
                }
                if (!canExtend) break;
                height++;
              }

              // Decode mask value
              const isBackFace = (currentMaskValue & BACKFACE_FLAG) !== 0;
              const isTransparent = (currentMaskValue & TRANSPARENT_FLAG) !== 0;
              const blockId = currentMaskValue & BLOCK_ID_MASK;

              position[u_axis] = u_coord;
              position[v_axis] = v_coord;

              const quadStartPos = [position[0], position[1], position[2]];
              quadStartPos[axis]++;

              const targetMesh = isTransparent
                ? transparentMeshData
                : opaqueMeshData;

              this.addQuad(
                quadStartPos,
                direction,
                u_axis,
                v_axis,
                width,
                height,
                blockId,
                isBackFace,
                getBlock,
                targetMesh
              );

              // Zero out the mask for the area covered by the new quad
              for (let hh = 0; hh < height; hh++) {
                const start = maskIndex + hh * size;
                mask.fill(0, start, start + width);
              }

              u_coord += width;
              maskIndex += width; // Advance mask index by the width of the quad
            } else {
              u_coord++;
              maskIndex++;
            }
          }
        }
        */
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
    getBlock: (x: number, y: number, z: number) => number,
    meshData: WorkerInternalMeshData
  ) {
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

    // AO calculation
    const aoValues = [0, 0, 0, 0]; // p1, p2, p3, p4
    const corners = [p1, p2, p3, p4];

    // Get the integer coordinates of the block this face belongs to.
    // `x` is the position of the corner of the quad, which is on a block boundary.
    // For a front face, we subtract the normal `q` to get the block's origin.
    // For a back face, the quad is on the correct side, so we don't subtract.
    const blockPos = isBackFace
      ? [x[0] - q[0], x[1] - q[1], x[2] - q[2]]
      : [x[0], x[1], x[2]];

    for (let i = 0; i < 4; i++) {
      const corner = corners[i];

      // Determine the two side directions and the corner direction relative to the vertex.
      // `corner - x` gives us the offset from the quad's origin (e.g., [0,0,0], [w,0,0], [w,h,0], [0,h,0])
      const offsetU = corner[u] - x[u] > 0 ? 1 : -1;
      const offsetV = corner[v] - x[v] > 0 ? 1 : -1;

      // The three blocks to check for occlusion are relative to the block being drawn.
      // side1 is offset along the v-axis and the face normal.
      // side2 is offset along the u-axis and the face normal.
      // corner is offset along both u and v axes.
      const side1Pos = [blockPos[0], blockPos[1], blockPos[2]];
      side1Pos[v] += offsetV;

      const side2Pos = [blockPos[0], blockPos[1], blockPos[2]];
      side2Pos[u] += offsetU;

      const cornerPos = [blockPos[0], blockPos[1], blockPos[2]];
      cornerPos[u] += offsetU;
      cornerPos[v] += offsetV;

      const side1IsSolid =
        getBlock(side1Pos[0], side1Pos[1], side1Pos[2]) !== 0;
      const side2IsSolid =
        getBlock(side2Pos[0], side2Pos[1], side2Pos[2]) !== 0;
      const cornerIsSolid =
        getBlock(cornerPos[0], cornerPos[1], cornerPos[2]) !== 0;

      aoValues[i] =
        (side1IsSolid ? 1 : 0) +
        (side2IsSolid ? 1 : 0) +
        (cornerIsSolid && side1IsSolid && side2IsSolid ? 1 : 0);
    }
    // 1. Push the four correct AO values for the four vertices.
    meshData.ao.push(...aoValues);

    // normal
    const normalVec = isBackFace ? [-q[0], -q[1], -q[2]] : q;

    const faceData = FACE_DATA_CACHE[normalVec.join(",")];
    const { normal, tangent, handedness } = faceData;

    meshData.normals.push(...normal, ...normal, ...normal, ...normal);

    for (let i = 0; i < 4; i++) {
      meshData.tangents.push(tangent[0], tangent[1], tangent[2], handedness);
    }

    // tile lookup and UV writes
    const faceName = this.getFaceName(q, isBackFace);
    const tex = BlockTextures[blockId]!;
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

    // 2. Decide which way to split the quad to get the best AO look.
    // We split along the diagonal that is "brighter" (has a lower AO sum).
    if (aoValues[0] + aoValues[2] > aoValues[1] + aoValues[3]) {
      // The p1-p3 diagonal is darker. Split along p2-p4.
      // Triangles are (p1, p2, p4) and (p2, p3, p4).
      // Indices: (0, 1, 3) and (1, 2, 3).
      if (isBackFace) {
        indices.push(indexOffset, indexOffset + 1, indexOffset + 3);
        indices.push(indexOffset + 1, indexOffset + 2, indexOffset + 3);
      } else {
        indices.push(indexOffset, indexOffset + 3, indexOffset + 1);
        indices.push(indexOffset + 1, indexOffset + 3, indexOffset + 2);
      }
    } else {
      // The p2-p4 diagonal is darker (or they are equal). Split along p1-p3.
      // Triangles are (p1, p2, p3) and (p1, p3, p4).
      // Indices: (0, 1, 2) and (0, 2, 3).
      if (isBackFace) {
        indices.push(indexOffset, indexOffset + 1, indexOffset + 2);
        indices.push(indexOffset, indexOffset + 2, indexOffset + 3);
      } else {
        indices.push(indexOffset, indexOffset + 2, indexOffset + 1);
        indices.push(indexOffset, indexOffset + 3, indexOffset + 2);
      }
    }
    meshData.indexOffset += 4;
  }
}

// Top-level world generator instance for terrain requests
let generator: WorldGenerator | null = null;

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

    if (!generator) {
      generator = new WorldGenerator({ ...event.data });
    }

    const { blocks } = generator.generateChunkData(chunkX, chunkY, chunkZ);

    self.postMessage(
      { chunkId, type: "terrain-generated", block_array: blocks },
      [blocks.buffer]
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
    tangents: data.tangents.finalArray,
    uvs2: data.uvs2.finalArray,
    uvs3: data.uvs3.finalArray,
    cornerIds: data.cornerIds.finalArray,
    ao: data.ao.finalArray,
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
      opaqueMeshData.tangents.buffer,
      opaqueMeshData.uvs2.buffer,
      opaqueMeshData.uvs3.buffer,
      opaqueMeshData.cornerIds.buffer,
      opaqueMeshData.ao.buffer,
      waterMeshData.positions.buffer,
      waterMeshData.indices.buffer,
      waterMeshData.normals.buffer,
      waterMeshData.tangents.buffer,
      waterMeshData.uvs2.buffer,
      waterMeshData.uvs3.buffer,
      waterMeshData.cornerIds.buffer,
      waterMeshData.ao.buffer,
      glassMeshData.positions.buffer,
      glassMeshData.indices.buffer,
      glassMeshData.normals.buffer,
      glassMeshData.tangents.buffer,
      glassMeshData.uvs2.buffer,
      glassMeshData.uvs3.buffer,
      glassMeshData.cornerIds.buffer,
      glassMeshData.ao.buffer,
    ]
  );
}
