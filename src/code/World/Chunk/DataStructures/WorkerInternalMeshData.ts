import type { ResizableTypedArray } from "./ResizableTypedArray";

export type WorkerInternalMeshData = {
	faceData: ResizableTypedArray<Uint8Array>;
	faceCount: number;
};
