export function expandPalette(
	packed: Uint8Array,
	palette: ArrayLike<number>,
	totalBlocks: number,
): Uint8Array | Uint16Array {
	const expanded: Uint8Array | Uint16Array = isUint16(palette)
		? new Uint16Array(totalBlocks)
		: new Uint8Array(totalBlocks);

	const packedLength = (totalBlocks + 1) >>> 1;
	let blockIndex = 0;

	for (let packedIndex = 0; packedIndex < packedLength; packedIndex++) {
		const value = packed[packedIndex];

		expanded[blockIndex++] = palette[value & 0x0f];

		if (blockIndex < totalBlocks) {
			expanded[blockIndex++] = palette[value >>> 4];
		}
	}

	return expanded;
}

export function isUint16(
	palette: ArrayLike<number> | null | undefined,
): boolean {
	if (!palette) {
		return false;
	}

	if (palette instanceof Uint16Array) {
		return true;
	}

	const length = palette.length;

	for (let index = 0; index < length; index++) {
		if (palette[index] > 0xff) {
			return true;
		}
	}

	return false;
}
