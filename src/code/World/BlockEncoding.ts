export const BLOCK_ID_BITS = 10;
export const BLOCK_STATE_BITS = 6;
export const BLOCK_STATE_SHIFT = BLOCK_ID_BITS;
export const BLOCK_ID_MASK = (1 << BLOCK_ID_BITS) - 1;
export const BLOCK_STATE_MASK = (1 << BLOCK_STATE_BITS) - 1;

export function packBlockValue(blockId: number, state = 0): number {
  return (
    ((state & BLOCK_STATE_MASK) << BLOCK_STATE_SHIFT) |
    (blockId & BLOCK_ID_MASK)
  );
}

export function unpackBlockId(value: number): number {
  return value & BLOCK_ID_MASK;
}

export function unpackBlockState(value: number): number {
  return (value >>> BLOCK_STATE_SHIFT) & BLOCK_STATE_MASK;
}

export function packRotationSlice(rotation: number, slice: number): number {
  return (rotation & 7) | ((slice & 7) << 3);
}

export function unpackRotation(state: number): number {
  return state & 7;
}

export function unpackSlice(state: number): number {
  return (state >>> 3) & 7;
}
