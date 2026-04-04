import { MeshData } from "../../Chunk/DataStructures/MeshData";
import { ResizableTypedArray } from "../../Chunk/DataStructures/ResizableTypedArray";
import { WorkerInternalMeshData } from "../../Chunk/DataStructures/WorkerInternalMeshData";
import type { MeshContext } from "../types/MeshTypes";

export type WorkerMeshBaseContext = {
  size: number;
  lod: number;
};

export type WorkerMeshInput = {
  block_array: Uint8Array | Uint16Array;
  light_array?: Uint8Array;
  neighbors: (Uint8Array | Uint16Array | undefined)[];
  neighborLights?: (Uint8Array | undefined)[];
};

/**
 * Create an empty WorkerInternalMeshData inside the worker.
 * This must never be posted directly to main thread.
 */
export function createEmptyWorkerInternalMeshData(): WorkerInternalMeshData {
  return {
    faceDataA: new ResizableTypedArray(Uint8Array),
    faceDataB: new ResizableTypedArray(Uint8Array),
    faceDataC: new ResizableTypedArray(Uint8Array),
    faceCount: 0,
  };
}

/**
 * Convert internal mesh data (contains ResizableTypedArray instances)
 * into plain MeshData (transferable / cloneable).
 */
export function toTransferableMeshData(data: WorkerInternalMeshData): MeshData {
  const out = new MeshData();
  out.faceDataA = data.faceDataA.finalArray;
  out.faceDataB = data.faceDataB.finalArray;
  out.faceDataC = data.faceDataC.finalArray;
  out.faceCount = data.faceCount;
  return out;
}

/**
 * Rebuild full MeshContext inside the worker from plain postMessage payload.
 * This version supports the center chunk and 26 neighbors.
 */
export function createMeshContextFromPayload(
  base: WorkerMeshBaseContext,
  input: WorkerMeshInput,
): MeshContext {
  const size = base.size;

  const getNeighborIndex = (dx: number, dy: number, dz: number): number => {
    let index = 0;
    for (let z = -1; z <= 1; z++) {
      for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
          if (x === 0 && y === 0 && z === 0) continue;
          if (x === dx && y === dy && z === dz) {
            return index;
          }
          index++;
        }
      }
    }
    return -1;
  };

  const hasNeighborChunk = (dx: number, dy: number, dz: number): boolean => {
    const neighborIndex = getNeighborIndex(dx, dy, dz);
    if (neighborIndex < 0) return false;
    return !!input.neighbors[neighborIndex];
  };

  const wrapCoord = (value: number): { chunkOffset: number; local: number } => {
    if (value < 0) return { chunkOffset: -1, local: value + size };
    if (value >= size) return { chunkOffset: 1, local: value - size };
    return { chunkOffset: 0, local: value };
  };

  const getIndex = (x: number, y: number, z: number): number => {
    return x + y * size + z * size * size;
  };

  const readBlock = (x: number, y: number, z: number, fallback = 0): number => {
    const wx = wrapCoord(x);
    const wy = wrapCoord(y);
    const wz = wrapCoord(z);

    // center chunk
    if (wx.chunkOffset === 0 && wy.chunkOffset === 0 && wz.chunkOffset === 0) {
      return (
        input.block_array[getIndex(wx.local, wy.local, wz.local)] ?? fallback
      );
    }

    // neighbor chunk
    const neighborIndex = getNeighborIndex(
      wx.chunkOffset,
      wy.chunkOffset,
      wz.chunkOffset,
    );

    if (neighborIndex < 0) return fallback;

    const neighbor = input.neighbors[neighborIndex];
    if (!neighbor) return fallback;

    return neighbor[getIndex(wx.local, wy.local, wz.local)] ?? fallback;
  };

  const readLight = (x: number, y: number, z: number, fallback = 0): number => {
    const wx = wrapCoord(x);
    const wy = wrapCoord(y);
    const wz = wrapCoord(z);

    // center chunk
    if (wx.chunkOffset === 0 && wy.chunkOffset === 0 && wz.chunkOffset === 0) {
      if (!input.light_array) return fallback;
      return (
        input.light_array[getIndex(wx.local, wy.local, wz.local)] ?? fallback
      );
    }

    // neighbor chunk
    const neighborIndex = getNeighborIndex(
      wx.chunkOffset,
      wy.chunkOffset,
      wz.chunkOffset,
    );

    if (neighborIndex < 0) return fallback;

    const neighborLight = input.neighborLights?.[neighborIndex];
    if (!neighborLight) return fallback;

    return neighborLight[getIndex(wx.local, wy.local, wz.local)] ?? fallback;
  };

  return {
    size,
    lod: base.lod,
    disableAO: base.lod >= 2,
    getBlock: readBlock,
    getLight: readLight,
    hasNeighborChunk,
  };
}
