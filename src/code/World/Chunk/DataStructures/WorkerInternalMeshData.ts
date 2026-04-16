import type { ResizableTypedArray } from "./ResizableTypedArray";

export type WorkerInternalMeshData = {
	faceDataA: ResizableTypedArray<Uint8Array>;
	faceDataB: ResizableTypedArray<Uint8Array>;
	faceDataC: ResizableTypedArray<Uint8Array>;
	faceCount: number;
};
