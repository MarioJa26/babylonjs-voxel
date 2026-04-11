// MeshPipeline/core/MeshAssembler.ts
import { WorkerInternalMeshData } from "../types/MeshTypes";

/**
 * Append mesh data from `source` into `target`.
 * Preserves your exact internal memory layout.
 */
export function mergeMeshData(
  target: WorkerInternalMeshData,
  source: WorkerInternalMeshData,
): void {
  if (source.faceCount === 0) return;

  const A = source.faceDataA.finalArray;
  const B = source.faceDataB.finalArray;
  const C = source.faceDataC.finalArray;

  for (let i = 0; i < A.length; i += 4) {
    target.faceDataA.push4(A[i], A[i + 1], A[i + 2], A[i + 3]);
  }

  for (let i = 0; i < B.length; i += 4) {
    target.faceDataB.push4(B[i], B[i + 1], B[i + 2], B[i + 3]);
  }

  for (let i = 0; i < C.length; i += 4) {
    target.faceDataC.push4(C[i], C[i + 1], C[i + 2], C[i + 3]);
  }

  target.faceCount += source.faceCount;
}
