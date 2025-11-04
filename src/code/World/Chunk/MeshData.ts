export type MeshData = {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  tangents: Float32Array;
  uvs: Float32Array;
  uvs2: Float32Array;
  uvs3: Float32Array;
  indexOffset?: number;
  chunkId?: string; // Used to pass chunk reference back from worker
};
