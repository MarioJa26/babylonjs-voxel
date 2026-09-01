export type SavedChunkData = {
	blocks: Uint8Array | Uint16Array | null;
	palette?: Uint16Array | null;
	uniformBlockId?: number;
	isUniform?: boolean;
	lightArray?: Uint8Array;
	compressed?: boolean;
	/** Server chunk version, embedded in the blob so cache reads skip a meta lookup. */
	version?: number;
};

/**
 * Structured SAB-backed result returned by readVoxelDecompressed.
 * Blocks/palette/light are already in SharedArrayBuffers so the main
 * thread skips both the deserialize round-trip and ensureSharedBacking.
 */
export interface HydratedVoxelData {
	blocksSAB: SharedArrayBuffer | null;
	paletteSAB: SharedArrayBuffer | null;
	isUniform: boolean;
	uniformBlockId: number;
	lightSAB: SharedArrayBuffer | null;
	blockBytesPerElement: 1 | 2;
}

export type SavedChunkEntityData = {
	type: string;
	payload: unknown;
};

const FLAG_HAS_BLOCKS = 1 << 0;
const FLAG_HAS_PALETTE = 1 << 1;
const FLAG_IS_UNIFORM = 1 << 2;
const FLAG_HAS_LIGHT = 1 << 3;
const FLAG_COMPRESSED = 1 << 4;

const HEADER_SIZE = 6;
const UINT16_BLOCK_BYTE_LENGTH = 65_536;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Creates a byte-level view without copying the underlying typed-array data.
 * The returned object is only a lightweight view.
 */
function asBytes(value: Uint8Array | Uint16Array): Uint8Array {
	return value instanceof Uint8Array
		? value
		: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * Copies a byte range from the serialized input directly into a destination.
 * Uses subarray view (no intermediate ArrayBuffer slice) — one memcpy.
 */
function copyBytes(
	source: Uint8Array,
	sourceOffset: number,
	destination: Uint8Array,
): void {
	destination.set(
		source.subarray(sourceOffset, sourceOffset + destination.byteLength),
	);
}

// P0-2: DataView-free LE readers to avoid per-chunk DataView allocation (GC).
function readU16LE(data: Uint8Array, offset: number): number {
	return data[offset] | (data[offset + 1] << 8);
}
function readU32LE(data: Uint8Array, offset: number): number {
	return (
		(data[offset] |
			(data[offset + 1] << 8) |
			(data[offset + 2] << 16) |
			(data[offset + 3] << 24)) >>>
		0
	);
}
function writeU16LE(data: Uint8Array, offset: number, value: number): void {
	data[offset] = value & 0xff;
	data[offset + 1] = (value >>> 8) & 0xff;
}
function writeU32LE(data: Uint8Array, offset: number, value: number): void {
	data[offset] = value & 0xff;
	data[offset + 1] = (value >>> 8) & 0xff;
	data[offset + 2] = (value >>> 16) & 0xff;
	data[offset + 3] = (value >>> 24) & 0xff;
}

/** Serialize voxel data to a compact binary blob for OPFS storage. */
export function serializeVoxelData(
	blocks: Uint8Array | Uint16Array | null,
	palette: Uint16Array | null | undefined,
	isUniform: boolean | undefined,
	uniformBlockId: number | undefined,
	lightArray: Uint8Array | null | undefined,
	compressed: boolean | undefined,
	version?: number,
): Uint8Array {
	const hasBlocks = blocks != null;
	const hasPalette = palette != null;
	const hasLight = lightArray != null;

	let flags = 0;

	if (hasBlocks) flags |= FLAG_HAS_BLOCKS;
	if (hasPalette) flags |= FLAG_HAS_PALETTE;
	if (isUniform) flags |= FLAG_IS_UNIFORM;
	if (hasLight) flags |= FLAG_HAS_LIGHT;
	if (compressed) flags |= FLAG_COMPRESSED;

	let totalLength = HEADER_SIZE;

	if (isUniform) {
		totalLength += 2;
	}

	if (blocks) {
		totalLength += 4 + blocks.byteLength;
	}

	if (palette) {
		totalLength += 4 + palette.byteLength;
	}

	if (lightArray) {
		totalLength += 4 + lightArray.byteLength;
	}

	const result = new Uint8Array(totalLength);

	result[0] = flags;
	result[1] = 1;
	writeU32LE(result, 2, version ?? 0);

	let offset = HEADER_SIZE;

	if (isUniform) {
		writeU16LE(result, offset, uniformBlockId ?? 0);
		offset += 2;
	}

	if (blocks) {
		const byteLength = blocks.byteLength;

		writeU32LE(result, offset, byteLength);
		offset += 4;

		result.set(asBytes(blocks), offset);
		offset += byteLength;
	}

	if (palette) {
		const byteLength = palette.byteLength;

		// Palette stores its element count, not its byte length.
		writeU32LE(result, offset, palette.length);
		offset += 4;

		result.set(asBytes(palette), offset);
		offset += byteLength;
	}

	if (lightArray) {
		const byteLength = lightArray.byteLength;

		writeU32LE(result, offset, byteLength);
		offset += 4;

		result.set(lightArray, offset);
	}

	return result;
}

/** Deserialize voxel data from an OPFS binary blob. */
export function deserializeVoxelData(data: Uint8Array): SavedChunkData {
	if (data.byteLength < HEADER_SIZE) {
		return {
			blocks: null,
			compressed: false,
		};
	}

	const flags = data[0];
	const isUniform = (flags & FLAG_IS_UNIFORM) !== 0;
	const compressed = (flags & FLAG_COMPRESSED) !== 0;

	const version = readU32LE(data, 2);

	let offset = HEADER_SIZE;

	let uniformBlockId: number | undefined;

	if (isUniform) {
		uniformBlockId = readU16LE(data, offset);
		offset += 2;
	}

	let blocks: Uint8Array | Uint16Array | null = null;

	if ((flags & FLAG_HAS_BLOCKS) !== 0) {
		const byteLength = readU32LE(data, offset);
		offset += 4;

		const absoluteOffset = data.byteOffset + offset;

		if (!compressed && byteLength === UINT16_BLOCK_BYTE_LENGTH) {
			if ((absoluteOffset & 1) === 0) {
				// Preserve the original zero-copy behavior when aligned.
				blocks = new Uint16Array(data.buffer, absoluteOffset, byteLength >>> 1);
			} else {
				// Allocate only the final backing store instead of first
				// allocating an alignment-fixing Uint8Array.
				const copiedBlocks = new Uint16Array(byteLength >>> 1);

				copyBytes(
					data,
					offset,
					new Uint8Array(
						copiedBlocks.buffer,
						copiedBlocks.byteOffset,
						copiedBlocks.byteLength,
					),
				);

				blocks = copiedBlocks;
			}
		} else {
			// Hot-path win (#1): byte-blocks are allocation-free views into the
			// blob, matching lightArray's existing zero-copy behavior.
			// Caller must not retain view beyond blob lifetime; if pinning is a
			// concern the SAB path (deserializeVoxelDataShared) copies instead.
			blocks = new Uint8Array(
				data.buffer,
				data.byteOffset + offset,
				byteLength,
			);
		}

		offset += byteLength;
	}

	let palette: Uint16Array | null = null;

	if ((flags & FLAG_HAS_PALETTE) !== 0) {
		const count = readU32LE(data, offset);
		offset += 4;

		const byteLength = count * Uint16Array.BYTES_PER_ELEMENT;
		const absoluteOffset = data.byteOffset + offset;

		if ((absoluteOffset & 1) === 0) {
			// Preserve the original zero-copy behavior when aligned.
			palette = new Uint16Array(data.buffer, absoluteOffset, count);
		} else {
			// Allocate only the final aligned palette backing store.
			const copiedPalette = new Uint16Array(count);

			copyBytes(
				data,
				offset,
				new Uint8Array(
					copiedPalette.buffer,
					copiedPalette.byteOffset,
					copiedPalette.byteLength,
				),
			);

			palette = copiedPalette;
		}

		offset += byteLength;
	}

	let lightArray: Uint8Array | null = null;

	if ((flags & FLAG_HAS_LIGHT) !== 0) {
		const byteLength = readU32LE(data, offset);
		offset += 4;

		// Preserve the original zero-copy view into the serialized blob.
		lightArray = new Uint8Array(
			data.buffer,
			data.byteOffset + offset,
			byteLength,
		);
	}

	return {
		blocks,
		palette: palette ?? undefined,
		uniformBlockId: isUniform ? uniformBlockId : undefined,
		isUniform: isUniform || undefined,
		lightArray: lightArray ?? undefined,
		compressed,
		version,
	};
}

/**
 * Deserialize voxel data while allocating block, palette, and light storage
 * directly in SharedArrayBuffers.
 */
export function deserializeVoxelDataShared(data: Uint8Array): SavedChunkData {
	if (data.byteLength < HEADER_SIZE) {
		return {
			blocks: null,
			compressed: false,
		};
	}

	const flags = data[0];
	const isUniform = (flags & FLAG_IS_UNIFORM) !== 0;
	const compressed = (flags & FLAG_COMPRESSED) !== 0;

	const version = readU32LE(data, 2);

	let offset = HEADER_SIZE;

	let uniformBlockId: number | undefined;

	if (isUniform) {
		uniformBlockId = readU16LE(data, offset);
		offset += 2;
	}

	let blocks: Uint8Array | Uint16Array | null = null;

	if ((flags & FLAG_HAS_BLOCKS) !== 0) {
		const byteLength = readU32LE(data, offset);
		offset += 4;

		// Zero-copy fast path when blob is already SAB-backed (e.g. pooled cache)
		if (
			data.buffer instanceof SharedArrayBuffer &&
			(data.byteOffset + offset) % 2 === 0
		) {
			if (!compressed && byteLength === UINT16_BLOCK_BYTE_LENGTH) {
				blocks = new Uint16Array(
					data.buffer,
					data.byteOffset + offset,
					byteLength >>> 1,
				);
			} else {
				blocks = new Uint8Array(
					data.buffer,
					data.byteOffset + offset,
					byteLength,
				);
			}
		} else {
			const sharedBuffer = new SharedArrayBuffer(byteLength);
			const sharedBytes = new Uint8Array(sharedBuffer);
			copyBytes(data, offset, sharedBytes);
			blocks =
				!compressed && byteLength === UINT16_BLOCK_BYTE_LENGTH
					? new Uint16Array(sharedBuffer)
					: sharedBytes;
		}

		offset += byteLength;
	}

	let palette: Uint16Array | null = null;

	if ((flags & FLAG_HAS_PALETTE) !== 0) {
		const count = readU32LE(data, offset);
		offset += 4;

		const byteLength = count * Uint16Array.BYTES_PER_ELEMENT;
		if (
			data.buffer instanceof SharedArrayBuffer &&
			(data.byteOffset + offset) % 2 === 0
		) {
			palette = new Uint16Array(data.buffer, data.byteOffset + offset, count);
		} else {
			const sharedBuffer = new SharedArrayBuffer(byteLength);
			copyBytes(data, offset, new Uint8Array(sharedBuffer));
			palette = new Uint16Array(sharedBuffer, 0, count);
		}
		offset += byteLength;
	}

	let lightArray: Uint8Array | null = null;

	if ((flags & FLAG_HAS_LIGHT) !== 0) {
		const byteLength = readU32LE(data, offset);
		offset += 4;

		if (data.buffer instanceof SharedArrayBuffer) {
			lightArray = new Uint8Array(
				data.buffer,
				data.byteOffset + offset,
				byteLength,
			);
		} else {
			const sharedBuffer = new SharedArrayBuffer(byteLength);
			lightArray = new Uint8Array(sharedBuffer);
			copyBytes(data, offset, lightArray);
		}
	}

	return {
		blocks,
		palette: palette ?? undefined,
		uniformBlockId: isUniform ? uniformBlockId : undefined,
		isUniform: isUniform || undefined,
		lightArray: lightArray ?? undefined,
		compressed,
		version,
	};
}

/** Serialize chunk entities to a JSON Uint8Array. */
export function serializeEntities(
	entities: SavedChunkEntityData[],
): Uint8Array {
	return textEncoder.encode(JSON.stringify(entities));
}

/** Deserialize chunk entities from a JSON Uint8Array. */
export function deserializeEntities(data: Uint8Array): SavedChunkEntityData[] {
	try {
		const parsed: unknown = JSON.parse(textDecoder.decode(data));
		return Array.isArray(parsed) ? (parsed as SavedChunkEntityData[]) : [];
	} catch {
		return [];
	}
}
