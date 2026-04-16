// MeshPipeline/core/MeshContext.ts
import type { MeshContext } from "../types/MeshTypes";

/**
 * Create a strict, immutable meshing context used by all pipelines.
 * This mirrors what your original JS code wants, but in strict TS form.
 */

export function createMeshContext(params: {
	size: number;
	lod: number;
}): Omit<MeshContext, "getBlock" | "getLight" | "hasNeighborChunk"> {
	const { size, lod } = params;

	return {
		size,
		lod,
		disableAO: lod >= 2,
	};
}
