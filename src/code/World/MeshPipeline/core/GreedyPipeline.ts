// MeshPipeline/core/GreedyPipeline.ts
import type { GreedyFaceDescriptor, MeshContext } from "../types/MeshTypes";

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
 * Reusable scratch buffers.
 *
 * Since the worker is effectively single-threaded for this code path,
 * module-level scratch reuse is safe as long as greedyMesh is not re-entered.
 */
let SCRATCH_MASK = new Int32Array(0);
let SCRATCH_LIGHTS = new Uint16Array(0);
const _greedyFaceScratch: GreedyFaceDescriptor = {
	slice: 0,
	uStart: 0,
	vStart: 0,
	width: 0,
	height: 0,
	idState: 0,
	light: 0,
};

/**
 * Ensure the reusable scratch buffers are at least the required size.
 */
function ensureScratchCapacity(area: number): {
	mask: Int32Array;
	lights: Uint16Array;
} {
	if (SCRATCH_MASK.length < area) {
		SCRATCH_MASK = new Int32Array(area);
	}
	if (SCRATCH_LIGHTS.length < area) {
		SCRATCH_LIGHTS = new Uint16Array(area);
	}

	return {
		mask: SCRATCH_MASK,
		lights: SCRATCH_LIGHTS,
	};
}

/**
 * The main greedy-meshing engine.
 *
 * It accepts:
 *   - ctx.size for dimensions
 *   - extractMask(...) to fill mask & light arrays for a slice
 *   - emitFace(...) callback that builds quads using the merged results
 *
 * Optimized version:
 * - reuses typed-array scratch buffers
 * - avoids per-call array allocation
 * - avoids per-call .fill(0) because extractMask overwrites every entry
 */
export function greedyMesh(
	ctx: MeshContext,
	extractMask: MaskExtractor,
	emitFace: FaceEmitterCallback,
): void {
	const size = ctx.size;
	const area = size * size;

	const scratch = ensureScratchCapacity(area);
	const mask = scratch.mask;
	const lights = scratch.lights;

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
				_greedyFaceScratch.slice = slice;
				_greedyFaceScratch.uStart = u;
				_greedyFaceScratch.vStart = v;
				_greedyFaceScratch.width = width;
				_greedyFaceScratch.height = height;
				_greedyFaceScratch.idState = idState;
				_greedyFaceScratch.light = light;
				emitFace(_greedyFaceScratch);

				// Clear the merged region so it won’t be processed again
				for (let dv = 0; dv < height; dv++) {
					const clearRowBase = index + dv * size;
					mask.fill(0, clearRowBase, clearRowBase + width);
					lights.fill(0, clearRowBase, clearRowBase + width);
				}

				u += width;
			}
		}
	}
}
