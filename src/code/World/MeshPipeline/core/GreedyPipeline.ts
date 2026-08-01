// MeshPipeline/core/GreedyPipeline.ts
import type { GreedyFaceDescriptor } from "../types/MeshTypes";
import type { MeshBuildSession } from "./WorkerMeshHelpers";

/**
 * Writable numeric arrays accepted by the greedy pipeline.
 *
 * - mask uses Int32 because idState may carry high-bit markers
 *   like BACK_FACE_MASK / NON_CUBE_MASK.
 * - light uses Uint16 because your packed lightMask stores:
 *     low 8 bits  = AO
 *     high 8 bits = packed light
 */
export type WritableNumberArray =
	| number[]
	| Int32Array
	| Uint16Array
	| Uint32Array;

/**
 * Interface required from the caller to extract mask data.
 */
export type MaskExtractor = (
	slice: number,
	mask: WritableNumberArray,
	light: WritableNumberArray,
) => void;

/**
 * Interface required from the caller to handle a greedy face descriptor.
 */
export type FaceEmitterCallback = (desc: GreedyFaceDescriptor) => void;

/**
 * The main greedy-meshing engine.
 *
 * It accepts:
 *   - session for dimensions + reusable scratch buffers
 *   - extractMask(...) to fill mask & light arrays for a slice
 *   - emitFace(...) callback that builds quads using the merged results
 *
 * Optimized version:
 * - reuses the session's typed-array scratch buffers (no per-call allocation)
 * - avoids per-call array allocation
 * - avoids per-call .fill(0) because extractMask overwrites every entry
 *
 * The shared face descriptor lives on the session, so greedyMesh is
 * re-entrant as long as the callback doesn't stash the descriptor.
 */
export function greedyMesh(
	session: MeshBuildSession,
	extractMask: MaskExtractor,
	emitFace: FaceEmitterCallback,
): void {
	const size = session.size;
	const area = size * size;

	// Ensure the session's scratch buffers are at least the required size.
	if (session.scratchMask.length < area) {
		session.scratchMask = new Int32Array(area);
	}
	if (session.scratchLights.length < area) {
		session.scratchLights = new Uint16Array(area);
	}
	const mask = session.scratchMask;
	const lights = session.scratchLights;

	const faceScratch = session.faceScratch;

	// axis-slice iteration
	// Start at -1 to handle the negative boundary (face at position 0).
	for (let slice = -1; slice < size; slice++) {
		// Fill mask & light data for this slice.
		// IMPORTANT:
		// extractMask MUST overwrite every entry in mask/lights for the slice.
		extractMask(slice, mask, lights);

		// v = vertical dimension on the 2D slice plane
		for (let v = 0; v < size; v++) {
			const rowBase = v * size;

			// u = horizontal dimension
			for (let u = 0; u < size; ) {
				const index = rowBase + u;
				const idState = mask[index];

				if (idState === 0) {
					u++;
					continue;
				}

				const light = lights[index];

				// Compute merge width
				let width = 1;
				while (u + width < size) {
					const idx = index + width;
					if (mask[idx] !== idState || lights[idx] !== light) {
						break;
					}
					width++;
				}

				// Compute merge height
				let height = 1;
				outer: while (v + height < size) {
					const testRowBase = index + height * size;
					for (let k = 0; k < width; k++) {
						const idx = testRowBase + k;
						if (mask[idx] !== idState || lights[idx] !== light) {
							break outer;
						}
					}
					height++;
				}

				// Emit the merged face descriptor
				faceScratch.slice = slice;
				faceScratch.uStart = u;
				faceScratch.vStart = v;
				faceScratch.width = width;
				faceScratch.height = height;
				faceScratch.idState = idState;
				faceScratch.light = light;
				emitFace(faceScratch);

				// Clear the merged region so it wont be processed again
				if (width === size) {
					const clearEnd = index + height * size;
					for (let ci = index; ci < clearEnd; ci++) {
						mask[ci] = 0;
						lights[ci] = 0;
					}
				} else if (width < 8) {
					for (let dv = 0; dv < height; dv++) {
						const rowBase = index + dv * size;
						const rowEnd = rowBase + width;
						for (let ci = rowBase; ci < rowEnd; ci++) {
							mask[ci] = 0;
							lights[ci] = 0;
						}
					}
				} else {
					for (let dv = 0; dv < height; dv++) {
						const rowBase = index + dv * size;
						mask.fill(0, rowBase, rowBase + width);
						lights.fill(0, rowBase, rowBase + width);
					}
				}

				u += width;
			}
		}
	}
}
