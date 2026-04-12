// MeshPipeline/core/GreedyPipeline.ts
import { MeshContext, GreedyFaceDescriptor } from "../types/MeshTypes";

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
export interface MaskExtractor {
  (slice: number, mask: WritableNumberArray, light: WritableNumberArray): void;
}

/**
 * Interface required from the caller to handle a greedy face descriptor.
 */
export interface FaceEmitterCallback {
  (desc: GreedyFaceDescriptor): void;
}

/**
 * Reusable scratch buffers.
 *
 * Since the worker is effectively single-threaded for this code path,
 * module-level scratch reuse is safe as long as greedyMesh is not re-entered.
 */
let SCRATCH_MASK = new Int32Array(0);
let SCRATCH_LIGHTS = new Uint16Array(0);

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
  axis: number,
  extractMask: MaskExtractor,
  emitFace: FaceEmitterCallback,
): void {
  const size = ctx.size;
  const area = size * size;

  const scratch = ensureScratchCapacity(area);
  const mask = scratch.mask;
  const lights = scratch.lights;

  // axis-slice iteration
  for (let slice = 0; slice < size; slice++) {
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
        emitFace({
          slice,
          uStart: u,
          vStart: v,
          width,
          height,
          idState,
          light,
        });

        // Clear the merged region so it won’t be processed again
        for (let dv = 0; dv < height; dv++) {
          const clearRowBase = index + dv * size;
          for (let du = 0; du < width; du++) {
            mask[clearRowBase + du] = 0;
            lights[clearRowBase + du] = 0;
          }
        }

        u += width;
      }
    }
  }
}
