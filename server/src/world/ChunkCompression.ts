/**
 * ChunkCompression — shared block compression helpers for the server.
 *
 * Blocks are stored as a 32³ (32768-entry) array. To cut memory and
 * network payload size, chunks are compressed on generation:
 * - uniform chunk: all voxels share one block id, stores nothing
 * - 16 or fewer unique values: 4-bit palette-packed
 * - otherwise: raw input buffer
 *
 * Entries are packed block values: a 10-bit block id with its 6-bit shape
 * state packed above it. Every value therefore fits in a u16.
 */

export const CHUNK_VOLUME = 32 * 32 * 32;

/**
 * Matches the client's BLOCK_ID_BITS maximum block ID.
 * Packed values may be larger because they also contain shape state.
 */
export const MAX_BLOCK_ID = 1023;

/** Largest value representable by a Uint16Array element. */
const PACKED_VALUE_COUNT = 65536;

/** Maximum number of values representable by a 4-bit palette index. */
const MAX_PALETTE_SIZE = 16;

/**
 * One additional slot is required to detect the first value that makes a
 * chunk ineligible for palette compression.
 */
const UNIQUE_SCRATCH_SIZE = MAX_PALETTE_SIZE + 1;

export interface CompressedBlocks {
	data: Uint8Array | Uint16Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
}

/**
 * Scratch storage used only during synchronous compression.
 *
 * _seenScratch is a membership table, not a frequency table. Compression only
 * needs to know whether a value has already appeared, so maintaining counts
 * provides no benefit.
 *
 * Instead of clearing all 65,536 entries before every chunk, compressBlocks()
 * records each touched value in _uniqueValuesScratch and clears only those
 * entries before returning. At most 17 entries are touched because raw mode is
 * selected immediately after the seventeenth unique value.
 */
const _seenScratch = new Uint8Array(PACKED_VALUE_COUNT);
const _uniqueValuesScratch = new Uint16Array(UNIQUE_SCRATCH_SIZE);

/**
 * Maps packed block values to their 4-bit palette indices.
 *
 * Entries do not need to be globally cleared. Every value read from this table
 * was encountered in the current call and assigned below.
 */
const _blockToPaletteScratch = new Uint8Array(PACKED_VALUE_COUNT);

/**
 * Small pool for temporary 8-bit decompression buffers.
 *
 * Uint16Array results are not pooled because wide-value chunks are expected to
 * be uncommon and each buffer consumes twice as much memory.
 */
const _decompPool: Uint8Array[] = [];
const DECOMP_POOL_MAX = 4;

/**
 * Clear only the membership entries touched by the current compression call.
 */
function clearSeenValues(uniqueValues: Uint16Array, uniqueCount: number): void {
	for (let i = 0; i < uniqueCount; i++) {
		_seenScratch[uniqueValues[i]] = 0;
	}
}

/**
 * Obtain a full-sized temporary Uint8Array.
 */
function acquireDecompBuffer(): Uint8Array {
	return _decompPool.pop() ?? new Uint8Array(CHUNK_VOLUME);
}

/**
 * Compress a full block array.
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

	for (let i = 0; i < length; i++) {
		const value = blocks[i];

		if (seen[value] !== 0) {
			continue;
		}

		seen[value] = 1;
		uniqueValues[uniqueCount++] = value;

		if (uniqueCount > MAX_PALETTE_SIZE) {
			/*
			 * Clear the 17 touched entries before returning. No scan of the
			 * remaining input is needed because the chunk can no longer use a
			 * 4-bit palette.
			 */
			clearSeenValues(uniqueValues, uniqueCount);

			return {
				data: blocks,
				isUniform: false,
				uniformBlockId: 0,
			};
		}
	}

	/*
	 * Clear membership state before constructing the result. This also keeps
	 * the scratch state valid if later result construction is changed to call
	 * code that can throw.
	 */
	clearSeenValues(uniqueValues, uniqueCount);

	if (uniqueCount === 1) {
		/*
		 * A fresh empty view is intentional. Worker postMessage() may transfer
		 * its ArrayBuffer, so a shared module-level empty array could become
		 * detached and would not be safe to reuse.
		 */
		return {
			data: new Uint8Array(0),
			isUniform: true,
			uniformBlockId: uniqueValues[0],
		};
	}

	/*
	 * Preserve the existing behavior for an empty input. Although production
	 * chunks are expected to contain CHUNK_VOLUME entries, the original
	 * implementation returned an empty palette-packed result for length zero.
	 */
	const palette = new Array<number>(uniqueCount);
	const blockToPalette = _blockToPaletteScratch;

	for (let i = 0; i < uniqueCount; i++) {
		const value = uniqueValues[i];

		palette[i] = value;
		blockToPalette[value] = i;
	}

	/*
	 * Production chunks always have an even length. Using length >> 1 matches
	 * the original allocation and packing behavior.
	 */
	const packed = new Uint8Array(length >> 1);

	for (
		let inputIndex = 0, outputIndex = 0;
		inputIndex < length;
		inputIndex += 2, outputIndex++
	) {
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
 * A Uint16Array is used whenever the decompressed values cannot fit in u8.
 */
export function decompressBlocks(
	compressed: CompressedBlocks,
): Uint8Array | Uint16Array {
	const { data, palette, isUniform, uniformBlockId } = compressed;

	if (isUniform) {
		if (uniformBlockId > 255) {
			const output = new Uint16Array(CHUNK_VOLUME);
			output.fill(uniformBlockId);
			return output;
		}

		const output = acquireDecompBuffer();
		output.fill(uniformBlockId);
		return output;
	}

	if (palette === undefined || palette.length === 0) {
		return data;
	}

	let hasWideValues = false;

	for (let i = 0; i < palette.length; i++) {
		if (palette[i] > 255) {
			hasWideValues = true;
			break;
		}
	}

	/*
	 * Both typed arrays support numeric indexed writes, so one unpacking loop
	 * can serve both widths without duplicating the hot loop.
	 */
	const output: Uint8Array | Uint16Array = hasWideValues
		? new Uint16Array(CHUNK_VOLUME)
		: acquireDecompBuffer();

	for (
		let outputIndex = 0, packedIndex = 0;
		outputIndex < CHUNK_VOLUME;
		outputIndex += 2, packedIndex++
	) {
		const packedValue = data[packedIndex];

		output[outputIndex] = palette[packedValue & 0x0f];
		output[outputIndex + 1] = palette[packedValue >> 4];
	}

	return output;
}

/**
 * Return an eligible decompression buffer to the reuse pool.
 *
 * Only call this for an owned temporary result returned by decompressBlocks().
 * Do not release a raw stored chunk merely because it is a full-sized
 * Uint8Array, since raw decompression returns the original storage object.
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
