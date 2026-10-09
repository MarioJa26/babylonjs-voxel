/**
 * ChunkCompression: shared block compression helpers for the server.
 *
 * Blocks are stored as a 32³ (32768-entry) array. To reduce memory and
 * network payload size, chunks are compressed on generation:
 * - uniform chunk: all voxels share one packed value, stores no block array
 * - 16 or fewer unique values: 4-bit palette-packed
 * - otherwise: original input buffer
 *
 * Entries are packed block values: a 10-bit block ID with its 6-bit shape
 * state packed above it. Every value therefore fits in a u16.
 */

export const CHUNK_VOLUME = 32 * 32 * 32;

/**
 * Matches the client's BLOCK_ID_BITS maximum block ID.
 * Packed values may be larger because they also contain shape state.
 */
export const MAX_BLOCK_ID = 1023;

/** Number of distinct values representable by a Uint16Array element. */
const PACKED_VALUE_COUNT = 1 << 16;

/** Maximum number of values representable by a 4-bit palette index. */
const MAX_PALETTE_SIZE = 1 << 4;

/**
 * One additional slot detects the first value that makes a chunk ineligible
 * for 4-bit palette compression.
 */
const UNIQUE_SCRATCH_SIZE = MAX_PALETTE_SIZE + 1;

export interface CompressedBlocks {
	data: Uint8Array | Uint16Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
}

/**
 * Compression scratch storage.
 *
 * Compression is synchronous and must not be re-entered within the same
 * JavaScript isolate while these module-level buffers are in use.
 */
const _seenScratch = new Uint8Array(PACKED_VALUE_COUNT);
const _uniqueValuesScratch = new Uint16Array(UNIQUE_SCRATCH_SIZE);
const _blockToPaletteScratch = new Uint8Array(PACKED_VALUE_COUNT);

/**
 * Small pool for temporary 8-bit decompression buffers.
 *
 * Uint16Array outputs are not pooled because wide-value chunks are expected
 * to be uncommon and each buffer consumes twice as much memory.
 */
const _decompPool: Uint8Array[] = [];
const DECOMP_POOL_MAX = 4;

/**
 * Clear only membership entries touched by the current compression call.
 */
function clearSeenValues(uniqueValues: Uint16Array, uniqueCount: number): void {
	const seen = _seenScratch;

	for (let i = 0; i < uniqueCount; i++) {
		seen[uniqueValues[i]] = 0;
	}
}

/**
 * Obtain a full-sized temporary Uint8Array.
 */
function acquireDecompBuffer(): Uint8Array {
	const pooled = _decompPool.pop();
	return pooled !== undefined ? pooled : new Uint8Array(CHUNK_VOLUME);
}

/**
 * Compress a block array.
 *
 * The returned data is:
 * - a fresh empty Uint8Array for a uniform chunk
 * - a fresh palette-packed Uint8Array for 2 to 16 unique values
 * - the original input object when more than 16 unique values are present
 *
 * Returning the original object in raw mode preserves zero-copy transfer
 * behavior in the worker.
 */
export function compressBlocks(
	blocks: Uint8Array | Uint16Array,
): CompressedBlocks {
	const length = blocks.length;
	const seen = _seenScratch;
	const uniqueValues = _uniqueValuesScratch;

	let uniqueCount = 0;

	/*
	 * Stop as soon as the seventeenth unique value is encountered. Once that
	 * happens, the chunk cannot use a four-bit palette and no further scan is
	 * necessary.
	 */
	for (let i = 0; i < length; i++) {
		const value = blocks[i];

		if (seen[value] !== 0) {
			continue;
		}

		seen[value] = 1;
		uniqueValues[uniqueCount++] = value;

		if (uniqueCount > MAX_PALETTE_SIZE) {
			clearSeenValues(uniqueValues, uniqueCount);

			return {
				data: blocks,
				isUniform: false,
				uniformBlockId: 0,
			};
		}
	}

	/*
	 * Clear membership state before constructing the result so scratch state
	 * remains valid if future result construction introduces throwing code.
	 */
	clearSeenValues(uniqueValues, uniqueCount);

	if (uniqueCount === 1) {
		/*
		 * A fresh empty view is intentional. Worker postMessage() may transfer
		 * its ArrayBuffer, so a shared empty typed array could become detached.
		 */
		return {
			data: new Uint8Array(0),
			isUniform: true,
			uniformBlockId: uniqueValues[0],
		};
	}

	/*
	 * Preserve empty-input behavior: an empty input produces an empty
	 * palette-packed result with an empty palette.
	 */
	const palette = new Array<number>(uniqueCount);
	const blockToPalette = _blockToPaletteScratch;

	for (let i = 0; i < uniqueCount; i++) {
		const value = uniqueValues[i];
		palette[i] = value;
		blockToPalette[value] = i;
	}

	/*
	 * Production chunks have an even length. Using floor(length / 2)
	 * preserves the existing behavior for malformed odd-length inputs: the
	 * unpaired final entry is not represented.
	 */
	const packedLength = length >> 1;
	const packed = new Uint8Array(packedLength);

	/*
	 * Pack four input values into two output bytes per iteration. This reduces
	 * loop-control work while retaining straightforward bounds behavior.
	 */
	let inputIndex = 0;
	let outputIndex = 0;

	const pairedLength = packedLength << 1;
	const unrolledEnd = pairedLength & ~3;

	for (; inputIndex < unrolledEnd; inputIndex += 4, outputIndex += 2) {
		packed[outputIndex] =
			blockToPalette[blocks[inputIndex]] |
			(blockToPalette[blocks[inputIndex + 1]] << 4);

		packed[outputIndex + 1] =
			blockToPalette[blocks[inputIndex + 2]] |
			(blockToPalette[blocks[inputIndex + 3]] << 4);
	}

	for (; inputIndex < pairedLength; inputIndex += 2, outputIndex++) {
		packed[outputIndex] =
			blockToPalette[blocks[inputIndex]] |
			(blockToPalette[blocks[inputIndex + 1]] << 4);
	}

	return {
		data: packed,
		palette,
		isUniform: false,
		uniformBlockId: 0,
	};
}

/**
 * Expand compressed blocks into a full block array.
 *
 * Behavior:
 * - uniform chunks allocate or acquire a full output buffer
 * - palette chunks allocate or acquire a full output buffer
 * - raw chunks return the stored data object unchanged
 *
 * Uint16Array is used whenever at least one decompressed value cannot fit
 * in an unsigned byte.
 */
export function decompressBlocks(
	compressed: CompressedBlocks,
): Uint8Array | Uint16Array {
	const { data, palette, isUniform, uniformBlockId } = compressed;

	if (isUniform) {
		if (uniformBlockId > 0xff) {
			const output = new Uint16Array(CHUNK_VOLUME);
			output.fill(uniformBlockId);
			return output;
		}

		const output = acquireDecompBuffer();
		output.fill(uniformBlockId);
		return output;
	}

	/*
	 * No palette indicates raw storage. Returning the original object is part
	 * of the zero-copy contract.
	 */
	if (palette === undefined || palette.length === 0) {
		return data;
	}

	let hasWideValues = false;

	for (let i = 0; i < palette.length; i++) {
		if (palette[i] > 0xff) {
			hasWideValues = true;
			break;
		}
	}

	/*
	 * Keep separate output-width branches. Although both typed arrays support
	 * numeric indexed writes, a union-typed destination can produce less
	 * specialized machine code in JavaScript engines.
	 */
	if (hasWideValues) {
		const output = new Uint16Array(CHUNK_VOLUME);

		let packedIndex = 0;
		let outputIndex = 0;

		/*
		 * Each iteration expands two packed bytes into four block values.
		 */
		const unrolledEnd = CHUNK_VOLUME & ~3;

		for (; outputIndex < unrolledEnd; outputIndex += 4, packedIndex += 2) {
			const packed0 = data[packedIndex];
			const packed1 = data[packedIndex + 1];

			output[outputIndex] = palette[packed0 & 0x0f];
			output[outputIndex + 1] = palette[packed0 >>> 4];
			output[outputIndex + 2] = palette[packed1 & 0x0f];
			output[outputIndex + 3] = palette[packed1 >>> 4];
		}

		return output;
	}

	const output = acquireDecompBuffer();

	let packedIndex = 0;
	let outputIndex = 0;

	const unrolledEnd = CHUNK_VOLUME & ~3;

	for (; outputIndex < unrolledEnd; outputIndex += 4, packedIndex += 2) {
		const packed0 = data[packedIndex];
		const packed1 = data[packedIndex + 1];

		output[outputIndex] = palette[packed0 & 0x0f];
		output[outputIndex + 1] = palette[packed0 >>> 4];
		output[outputIndex + 2] = palette[packed1 & 0x0f];
		output[outputIndex + 3] = palette[packed1 >>> 4];
	}

	return output;
}

/**
 * Return an eligible decompression buffer to the reuse pool.
 *
 * Only call this for an owned temporary result returned by decompressBlocks().
 * Do not release raw stored chunks, because raw decompression returns the
 * original storage object.
 */
export function releaseDecompBuffer(buffer: Uint8Array | Uint16Array): void {
	if (
		buffer instanceof Uint8Array &&
		buffer.length === CHUNK_VOLUME &&
		_decompPool.length < DECOMP_POOL_MAX
	) {
		_decompPool.push(buffer);
	}
}
