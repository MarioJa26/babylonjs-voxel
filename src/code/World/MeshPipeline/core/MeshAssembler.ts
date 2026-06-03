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

	target.faceDataA.pushFrom(source.faceDataA);
	target.faceDataB.pushFrom(source.faceDataB);
	target.faceDataC.pushFrom(source.faceDataC);

	target.faceCount += source.faceCount;
}
