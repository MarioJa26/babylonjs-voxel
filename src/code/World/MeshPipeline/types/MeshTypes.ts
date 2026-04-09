// MeshPipeline/types/MeshTypes.ts

/**
 * Data structure used by WorkerInternalMeshData in your engine.
 * This mirrors exactly what your JS code produces.
 */
export interface WorkerInternalMeshData {
  faceDataA: ResizableTypedArray<Uint8Array>;
  faceDataB: ResizableTypedArray<Uint8Array>;
  faceDataC: ResizableTypedArray<Uint8Array>;
  faceCount: number;
}

/**
 * Typed wrapper for your dynamic typed array implementation.
 */
export interface ResizableTypedArray<T extends Uint8Array> {
  push4(a: number, b: number, c: number, d: number): void;
  push6?(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void;
  push8?(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
  ): void;
  push12?(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i1: number,
    j: number,
    k: number,
    l: number,
  ): void;
  readonly finalArray: T;
}

/**
 * Core meshing context used by all pipelines.
 */
export interface MeshContext {
  size: number;
  lod: number;
  disableAO: boolean;
  getBlock(x: number, y: number, z: number, fallback?: number): number;
  getLight(x: number, y: number, z: number, fallback?: number): number;
  hasNeighborChunk(dx: number, dy: number, dz: number): boolean;
}

/**
 * Description of a quad to emit (internal pipeline)
 */
export interface EmitQuadParams {
  x: number;
  y: number;
  z: number;
  axis: number;
  width: number;
  height: number;
  blockId: number;
  isBackFace: boolean;
  light: number;
  ao: number;
  faceName: string;
  materialType: number;
  flip: boolean;
}

/**
 * Shape info extracted from packed block
 */
export interface BlockShapeInfo {
  isCube: boolean;
  isSliceCompatible: boolean;
  sliceMask: number;
  closedFaceMask: number;
}

/**
 * Greedy face descriptor used internally by the greedy merger
 */
export interface GreedyFaceDescriptor {
  slice: number;
  uStart: number;
  vStart: number;
  width: number;
  height: number;
  idState: number;
  light: number;
}

/**
 * Enum for material types (blockId → material bucket)
 */
export enum MaterialType {
  Default = 0,
  WaterOrGlass = 1,
}
