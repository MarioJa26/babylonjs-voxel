export class PaletteExpander {
  expandPalette(
    packed: Uint8Array,
    palette: ArrayLike<number>,
    totalBlocks: number,
  ): Uint8Array | Uint16Array {
    const needsUint16 = this.isUint16(palette);

    const expanded = needsUint16
      ? new Uint16Array(totalBlocks)
      : new Uint8Array(totalBlocks);

    // Each byte holds 2 nibbles
    const packedLen = (totalBlocks + 1) >> 1;
    for (let packedIdx = 0; packedIdx < packedLen; packedIdx++) {
      const byte = packed[packedIdx];
      const blockIdx0 = packedIdx * 2;
      const blockIdx1 = packedIdx * 2 + 1;

      expanded[blockIdx0] = palette[byte & 0xf];
      if (blockIdx1 < totalBlocks) {
        expanded[blockIdx1] = palette[(byte >> 4) & 0xf];
      }
    }

    return expanded;
  }

  isUint16(palette: ArrayLike<number> | null | undefined): boolean {
    // Check if palette exists first
    if (!palette) {
      return false;
    }

    // Then check type
    if (palette instanceof Uint16Array) {
      return true;
    }

    // Then iterate safely
    for (let i = 0; i < palette.length; i++) {
      if (palette[i] > 255) {
        return true;
      }
    }

    return false;
  }
}
