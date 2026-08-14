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
 * - reuses the session's typed-array scratch buffers
 * - avoids per-call array allocation
 * - avoids per-slice .fill(0) because extractMask overwrites every entry
 * - clears only mask after merging because mask is the processed/empty marker
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

	if (session.scratchMask.length < area) {
		session.scratchMask = new Int32Array(area);
	}

	if (session.scratchLights.length < area) {
		session.scratchLights = new Uint16Array(area);
	}

	const mask = session.scratchMask;
	const lights = session.scratchLights;
	const faceScratch = session.faceScratch;

	for (let slice = -1; slice < size; slice++) {
		extractMask(slice, mask, lights);

		for (let v = 0; v < size; v++) {
			const rowBase = v * size;

			for (let u = 0; u < size; ) {
				const index = rowBase + u;
				const idState = mask[index];

				if (idState === 0) {
					u++;
					continue;
				}

				const light = lights[index];

				let width = 1;
				let scan = index + 1;
				const rowEnd = rowBase + size;

				while (
					scan < rowEnd &&
					mask[scan] === idState &&
					lights[scan] === light
				) {
					width++;
					scan++;
				}

				let height = 1;

				outer: while (v + height < size) {
					const testRowBase = index + height * size;
					const testRowEnd = testRowBase + width;

					for (let idx = testRowBase; idx < testRowEnd; idx++) {
						if (mask[idx] !== idState || lights[idx] !== light) {
							break outer;
						}
					}

					height++;
				}

				faceScratch.slice = slice;
				faceScratch.uStart = u;
				faceScratch.vStart = v;
				faceScratch.width = width;
				faceScratch.height = height;
				faceScratch.idState = idState;
				faceScratch.light = light;

				emitFace(faceScratch);

				// Only mask needs clearing. It is the sole processed-cell marker.
				// lights is ignored whenever mask is 0 and extractMask overwrites it
				// before the next slice is processed.
				if (width === size) {
					mask.fill(0, index, index + height * size);
				} else if (width < 8) {
					for (let dv = 0; dv < height; dv++) {
						const clearStart = index + dv * size;
						const clearEnd = clearStart + width;

						for (let ci = clearStart; ci < clearEnd; ci++) {
							mask[ci] = 0;
						}
					}
				} else {
					for (let dv = 0; dv < height; dv++) {
						const clearStart = index + dv * size;
						mask.fill(0, clearStart, clearStart + width);
					}
				}

				u += width;
			}
		}
	}
}
