// MeshPipeline/core/MeshAssembler.ts
import type { WorkerInternalMeshData } from "../types/MeshTypes";

/**
 * Append mesh data from `source` into `target`.
 * Preserves your exact internal memory layout.
 * Uses bulk operations for better performance.
 */
export function mergeMeshData(
	target: WorkerInternalMeshData,
	source: WorkerInternalMeshData,
): void {
	if (source.faceCount === 0) return;

	const A = source.faceDataA.finalArray;
	const B = source.faceDataB.finalArray;
	const C = source.faceDataC.finalArray;

	target.faceDataA.bulkPush(A);
	target.faceDataB.bulkPush(B);
	target.faceDataC.bulkPush(C);

	target.faceCount += source.faceCount;
}
