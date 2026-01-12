import { Chunk } from "./Chunk";

export default class Util {
  /**
   * Returns the slice of blocks at the northern edge of the chunk (z=0).
   * Based on texture mapping, North corresponds to -Z direction.
   */
  public static getNorthSlice(block_array: Uint8Array): Uint8Array {
    if (block_array.buffer instanceof SharedArrayBuffer) {
      return block_array.subarray(0, Chunk.SIZE2);
    }
    return block_array.slice(0, Chunk.SIZE2);
  }

  public static getSouthSlice(block_array: Uint8Array): Uint8Array {
    const start = (Chunk.SIZE - 1) * Chunk.SIZE2;
    if (block_array.buffer instanceof SharedArrayBuffer) {
      return block_array.subarray(start, start + Chunk.SIZE2);
    }
    return block_array.slice(start, start + Chunk.SIZE2);
  }
}
