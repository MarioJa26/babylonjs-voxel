// MeshPipeline/core/GreedyPipeline.ts
import { MeshContext, GreedyFaceDescriptor } from "../types/MeshTypes.js";

/**
 * Interface required from the caller to extract mask data.
 */
export interface MaskExtractor {
  (slice: number, mask: number[], light: number[]): void;
}

/**
 * Interface required from the caller to handle a greedy face descriptor.
 */
export interface FaceEmitterCallback {
  (desc: GreedyFaceDescriptor): void;
}

/**
 * The main greedy-meshing engine.
 *
 * It accepts:
 *   - ctx.size for dimensions
 *   - extractMask(...) to fill mask & light arrays for a slice
 *   - emitFace(...) callback that builds quads using the merged results
 */
export function greedyMesh(
  ctx: MeshContext,
  axis: number,
  extractMask: MaskExtractor,
  emitFace: FaceEmitterCallback,
): void {
  const size = ctx.size;

  // 1D versions of mask and light arrays for the slice
  const mask = new Array<number>(size * size).fill(0);
  const lights = new Array<number>(size * size).fill(0);

  // axis-slice iteration
  for (let slice = 0; slice < size; slice++) {
    // Fill mask & light data for this slice
    extractMask(slice, mask, lights);

    let index = 0;

    // v = vertical dimension on the 2D slice plane
    for (let v = 0; v < size; v++) {
      // u = horizontal dimension
      for (let u = 0; u < size; ) {
        const idState = mask[index];
        if (!idState) {
          u++;
          index++;
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
          const rowStart = index + height * size;
          for (let k = 0; k < width; k++) {
            const idx = rowStart + k;
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
          const rowStart = index + dv * size;
          for (let du = 0; du < width; du++) {
            mask[rowStart + du] = 0;
            lights[rowStart + du] = 0;
          }
        }

        u += width;
        index += width;
      }
    }
  }
}
