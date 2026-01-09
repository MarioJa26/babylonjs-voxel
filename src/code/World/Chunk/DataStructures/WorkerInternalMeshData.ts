import { ResizableTypedArray } from "./ResizableTypedArray";

export type WorkerInternalMeshData = {
  positions: ResizableTypedArray<Uint8Array>;
  indices: ResizableTypedArray<Uint16Array>;
  normals: ResizableTypedArray<Int8Array>;
  tangents: ResizableTypedArray<Int8Array>;
  uvs2: ResizableTypedArray<Uint8Array>;
  uvs3: ResizableTypedArray<Uint8Array>;
  cornerIds: ResizableTypedArray<Uint8Array>;
  ao: ResizableTypedArray<Uint8Array>;
  light: ResizableTypedArray<Uint8Array>;
  indexOffset: number;
};
