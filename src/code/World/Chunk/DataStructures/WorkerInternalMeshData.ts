import { ResizableTypedArray } from "./ResizableTypedArray";

export type WorkerInternalMeshData = {
  positions: ResizableTypedArray<Uint8Array>;
  indices: ResizableTypedArray<Uint16Array>;
  normals: ResizableTypedArray<Int8Array>;
  uvData: ResizableTypedArray<Uint8Array>;
  cornerIds: ResizableTypedArray<Uint8Array>;
  ao: ResizableTypedArray<Uint8Array>;
  light: ResizableTypedArray<Uint8Array>;
  materialFlags: ResizableTypedArray<Uint8Array>;
  indexOffset: number;
};
