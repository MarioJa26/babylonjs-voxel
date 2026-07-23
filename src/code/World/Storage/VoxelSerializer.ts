export type SavedChunkData = {
	blocks: Uint8Array | Uint16Array | null;
	palette?: Uint16Array | null;
	uniformBlockId?: number;
	isUniform?: boolean;
	lightArray?: Uint8Array;
	compressed?: boolean;
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
): Uint8Array {
	const chunks: Uint8Array[] = [];
	let totalLen = 2; // 2-byte flags (byte 0 = feature flags, byte 1 = format version)

	let flags1 = 0;
	if (blocks) flags1 |= FLAG_HAS_BLOCKS;
	if (palette) flags1 |= FLAG_HAS_PALETTE;
	if (isUniform) flags1 |= FLAG_IS_UNIFORM;
	if (lightArray) flags1 |= FLAG_HAS_LIGHT;
	if (compressed) flags1 |= FLAG_COMPRESSED;

	if (isUniform) {
		const u16 = new Uint8Array(2);
		new DataView(u16.buffer).setUint16(0, uniformBlockId ?? 0, true);
		chunks.push(u16);
		totalLen += 2;
	}

	if (blocks) {
		const lenBuf = new Uint8Array(4);
		new DataView(lenBuf.buffer).setUint32(0, blocks.byteLength, true);
		chunks.push(lenBuf);
		totalLen += 4;
		const bytes =
			blocks instanceof Uint16Array
				? new Uint8Array(blocks.buffer, blocks.byteOffset, blocks.byteLength)
				: blocks;
		chunks.push(bytes);
		totalLen += bytes.byteLength;
	}

	if (palette) {
		const lenBuf = new Uint8Array(4);
		new DataView(lenBuf.buffer).setUint32(0, palette.length, true);
		chunks.push(lenBuf);
		totalLen += 4;
		const bytes = new Uint8Array(
			palette.buffer,
			palette.byteOffset,
			palette.byteLength,
		);
		chunks.push(bytes);
		totalLen += bytes.byteLength;
	}

	if (lightArray) {
		const lenBuf = new Uint8Array(4);
		new DataView(lenBuf.buffer).setUint32(0, lightArray.byteLength, true);
		chunks.push(lenBuf);
		totalLen += 4;
		chunks.push(lightArray);
		totalLen += lightArray.byteLength;
	}

	const result = new Uint8Array(totalLen);
	result[0] = flags1;
	result[1] = 0; // format version (reserved)
	let offset = 2;
	for (const c of chunks) {
		result.set(c, offset);
		offset += c.byteLength;
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

	let offset = 2;

	let uniformBlockId: number | undefined;
	if (isUniform) {
		uniformBlockId = new DataView(
			data.buffer,
			data.byteOffset + offset,
			2,
		).getUint16(0, true);
		offset += 2;
	}

	let blocks: Uint8Array | Uint16Array | null = null;
	if (flags & FLAG_HAS_BLOCKS) {
		const len = new DataView(
			data.buffer,
			data.byteOffset + offset,
			4,
		).getUint32(0, true);
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
		const count = new DataView(
			data.buffer,
			data.byteOffset + offset,
			4,
		).getUint32(0, true);
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
		const len = new DataView(
			data.buffer,
			data.byteOffset + offset,
			4,
		).getUint32(0, true);
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
