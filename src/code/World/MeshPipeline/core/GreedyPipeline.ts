// MeshPipeline/core/GreedyPipeline.ts

import type { GreedyFaceDescriptor } from "../types/MeshTypes";
import type { MeshBuildSession } from "./WorkerMeshHelpers";

/**
 * Writable numeric arrays accepted by the greedy pipeline.
 *
 * - mask uses Int32 because idState may carry high-bit markers
 *   such as BACK_FACE_MASK / NON_CUBE_MASK.
 * - light uses Uint16 because packed light stores:
 *     low 8 bits  = AO
 *     high 8 bits = packed light
 */
export type WritableNumberArray =
	| number[]
	| Int32Array
	| Uint16Array
	| Uint32Array;

export type MaskExtractor = (
	slice: number,
	mask: WritableNumberArray,
	light: WritableNumberArray,
) => void;

export type FaceEmitterCallback = (desc: GreedyFaceDescriptor) => void;

/**
 * Runs greedy meshing over each slice of the current mesh grid.
 *
 * In scratch mode, extractMask overwrites an area-sized mask for every slice.
 * In banked mode, each slice occupies one contiguous area-sized bank region:
 *
 *     offset = (slice + 1) * area
 */
export function greedyMesh(
	session: MeshBuildSession,
	extractMask: MaskExtractor | null,
	emitFace: FaceEmitterCallback,
	maskBank?: Int32Array,
	lightBank?: Uint16Array,
): void {
	const size = session.meshGridSize > 0 ? session.meshGridSize : session.size;

	const area = size * size;
	const banked = maskBank !== undefined && lightBank !== undefined;

	if (!banked && extractMask === null) {
		throw new Error("greedyMesh requires extractMask or mask banks");
	}

	let mask: WritableNumberArray;
	let lights: WritableNumberArray;

	if (banked) {
		mask = maskBank;
		lights = lightBank;
	} else {
		if (session.scratchMask.length < area) {
			session.scratchMask = new Int32Array(area);
		}

		if (session.scratchLights.length < area) {
			session.scratchLights = new Uint16Array(area);
		}

		mask = session.scratchMask;
		lights = session.scratchLights;
	}

	// This is guaranteed to exist in scratch mode by the validation above.
	const extractor = extractMask as MaskExtractor;
	const faceScratch = session.faceScratch;
	const occupancy = session.sliceOccupancy;
	const occupancyLength = occupancy.length;

	for (let slice = -1; slice < size; slice++) {
		const sliceIndex = slice + 1;
		const base = banked ? sliceIndex * area : 0;

		if (banked) {
			// Skip slices that the bank-building sweep marked as empty.
			//
			// Check the occupancy index itself. Comparing base + area against
			// occupancy.length is incorrect because base is a mask-bank offset,
			// while occupancy.length is measured in slices.
			if (
				slice >= 0 &&
				sliceIndex < occupancyLength &&
				occupancy[sliceIndex] === 0
			) {
				continue;
			}
		} else {
			extractor(slice, mask, lights);
		}

		const sliceEnd = base + area;

		for (let rowBase = base, v = 0; rowBase < sliceEnd; rowBase += size, v++) {
			const rowEnd = rowBase + size;

			for (let index = rowBase, u = 0; index < rowEnd; ) {
				const idState = mask[index];

				if (idState === 0) {
					index++;
					u++;
					continue;
				}

				const light = lights[index];

				// Find the maximum matching width in the current row.
				let scan = index + 1;

				while (
					scan < rowEnd &&
					mask[scan] === idState &&
					lights[scan] === light
				) {
					scan++;
				}

				const width = scan - index;

				// Extend the rectangle downward while every cell in the next
				// row has the same mask and lighting value.
				let height = 1;
				let testRowBase = index + size;

				heightScan: while (v + height < size) {
					const testRowEnd = testRowBase + width;

					for (
						let testIndex = testRowBase;
						testIndex < testRowEnd;
						testIndex++
					) {
						if (mask[testIndex] !== idState || lights[testIndex] !== light) {
							break heightScan;
						}
					}

					height++;
					testRowBase += size;
				}

				faceScratch.slice = slice;
				faceScratch.uStart = u;
				faceScratch.vStart = v;
				faceScratch.width = width;
				faceScratch.height = height;
				faceScratch.idState = idState;
				faceScratch.light = light;

				emitFace(faceScratch);

				// Mask is the processed-cell marker. Lighting does not need to
				// be cleared because cells with mask === 0 are ignored.
				if (width === size) {
					// A full-width rectangle is contiguous in memory.
					mask.fill(0, index, index + height * size);
				} else if (width < 8) {
					// Direct writes are generally cheaper for narrow spans.
					let clearStart = index;

					for (let row = 0; row < height; row++) {
						const clearEnd = clearStart + width;

						for (
							let clearIndex = clearStart;
							clearIndex < clearEnd;
							clearIndex++
						) {
							mask[clearIndex] = 0;
						}

						clearStart += size;
					}
				} else {
					// Native fill is preferable for wider spans.
					let clearStart = index;

					for (let row = 0; row < height; row++) {
						mask.fill(0, clearStart, clearStart + width);
						clearStart += size;
					}
				}

				index += width;
				u += width;
			}
		}
	}
}
