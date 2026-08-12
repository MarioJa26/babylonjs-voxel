export type SavedChunkData = {
	blocks: Uint8Array | Uint16Array | null;
	palette?: Uint16Array | null;
	uniformBlockId?: number;
	isUniform?: boolean;
	lightArray?: Uint8Array;
	compressed?: boolean;
	/** Server chunk version, embedded in the blob so cache reads skip a meta lookup. */
	version?: number;
	/** Precomputed hash, embedded in the blob so reads skip recomputation. */
	hash?: number;
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
	// byte 0 = feature flags, byte 1 = format version, bytes 2-5 = chunk version
	let totalLen = version != null ? 6 : 2;

	let flags1 = 0;
	if (blocks) flags1 |= FLAG_HAS_BLOCKS;
	if (palette) flags1 |= FLAG_HAS_PALETTE;
	if (isUniform) flags1 |= FLAG_IS_UNIFORM;
	if (lightArray) flags1 |= FLAG_HAS_LIGHT;
	if (compressed) flags1 |= FLAG_COMPRESSED;

	if (isUniform) totalLen += 2;
	if (blocks) totalLen += 4 + blocks.byteLength;
	if (palette) totalLen += 4 + palette.byteLength;
	if (lightArray) totalLen += 4 + lightArray.byteLength;

	const result = new Uint8Array(totalLen);
	const dv = new DataView(result.buffer);
	result[0] = flags1;
	if (version != null) {
		result[1] = 1; // format v1: includes chunk version
		dv.setUint32(2, version, true);
	} else {
		result[1] = 0; // legacy format
	}
	let offset = version != null ? 6 : 2;

	if (isUniform) {
		dv.setUint16(offset, uniformBlockId ?? 0, true);
		offset += 2;
	}

	if (blocks) {
		dv.setUint32(offset, blocks.byteLength, true);
		offset += 4;
		const bytes =
			blocks instanceof Uint16Array
				? new Uint8Array(blocks.buffer, blocks.byteOffset, blocks.byteLength)
				: blocks;
		result.set(bytes, offset);
		offset += bytes.byteLength;
	}

	if (palette) {
		dv.setUint32(offset, palette.length, true);
		offset += 4;
		const bytes = new Uint8Array(
			palette.buffer,
			palette.byteOffset,
			palette.byteLength,
		);
		result.set(bytes, offset);
		offset += bytes.byteLength;
	}

	if (lightArray) {
		dv.setUint32(offset, lightArray.byteLength, true);
		offset += 4;
		result.set(lightArray, offset);
		offset += lightArray.byteLength;
	}

	return result;
}

/** Deserialize voxel data from an OPFS binary blob. */
export function deserializeVoxelData(data: Uint8Array): SavedChunkData {
	if (data.byteLength < 2) {
		return { blocks: null, compressed: false };
	}
	const flags = data[0];
	const isUniform = !!(flags & FLAG_IS_UNIFORM);
	const compressed = !!(flags & FLAG_COMPRESSED);

	const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let offset = 2;
	let version: number | undefined;
	if (data[1] >= 1 && data.byteLength >= 6) {
		version = dv.getUint32(2, true);
		offset = 6;
	}

	let uniformBlockId: number | undefined;
	if (isUniform) {
		uniformBlockId = dv.getUint16(offset, true);
		offset += 2;
	}

	let blocks: Uint8Array | Uint16Array | null = null;
	if (flags & FLAG_HAS_BLOCKS) {
		const len = dv.getUint32(offset, true);
		offset += 4;
		const raw = new Uint8Array(data.buffer, data.byteOffset + offset, len);
		if (!compressed && len === 65536) {
			const aligned = raw.byteOffset % 2 === 0 ? raw : new Uint8Array(raw);
			blocks = new Uint16Array(aligned.buffer, aligned.byteOffset, len >>> 1);
		} else {
			blocks = new Uint8Array(raw);
		}
		offset += len;
	}

	let palette: Uint16Array | null = null;
	if (flags & FLAG_HAS_PALETTE) {
		const count = dv.getUint32(offset, true);
		offset += 4;
		const raw = new Uint8Array(
			data.buffer,
			data.byteOffset + offset,
			count * 2,
		);
		const alignedPalette = raw.byteOffset % 2 === 0 ? raw : new Uint8Array(raw);
		palette = new Uint16Array(
			alignedPalette.buffer,
			alignedPalette.byteOffset,
			count,
		);
		offset += count * 2;
	}

	let lightArray: Uint8Array | null = null;
	if (flags & FLAG_HAS_LIGHT) {
		const len = dv.getUint32(offset, true);
		offset += 4;
		lightArray = new Uint8Array(data.buffer, data.byteOffset + offset, len);
		offset += len;
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
	const json = JSON.stringify(entities);
	const encoder = new TextEncoder();
	return encoder.encode(json);
}

/** Deserialize chunk entities from a JSON Uint8Array. */
export function deserializeEntities(data: Uint8Array): SavedChunkEntityData[] {
	const decoder = new TextDecoder();
	const json = decoder.decode(data);
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
