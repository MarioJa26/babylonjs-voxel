/**
 * ChunkCompression — shared block compression helpers for the server.
 *
 * Blocks are stored as a 32³ (32768-entry) array. To cut memory and
 * network payload size, chunks are compressed on generation:
 * - uniform chunk: all voxels share one block id → stores nothing (0 bytes)
 * - ≤16 unique ids: 4-bit palette-packed (half the size)
 * - otherwise: raw copy (Uint8Array for 8-bit ids, Uint16Array when any
 *   id exceeds 255 — e.g. mason shape-variant ids in the 500+ range)
 *
 * The inverse (decompressBlocks) is needed when applying block edits to a
 * stored chunk: edits target world coordinates, so the full array must be
 * materialized first.
 *
 * Entries are packed block values: a 10-bit block id with its 6-bit shape
 * state (rotation/flipY/slice) packed above it — see BlockEncoding.
 * packBlockValue. Values fit a u16; raw generated ids are packed values
 * with state 0, so unedited chunks need no conversion.
 */

export const CHUNK_VOLUME = 32 * 32 * 32;

/** Matches the client's BLOCK_ID_BITS (World/Chunk/DataStructures/BlockEncoding.ts). */
export const MAX_BLOCK_ID = 1023;

/** Largest storable packed value: id | state << 10 (u16 range). */
const MAX_PACKED_VALUE = 65535;

export interface CompressedBlocks {
	data: Uint8Array | Uint16Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
}

// Module-level scratch buffers reused across calls instead of allocating a
// fresh Uint16Array(65536)/Uint8Array(65536) on every single chunk compressed.
// Safe to share: compressBlocks is fully synchronous (no `await` inside),
// and JS run-to-completion semantics guarantee one call always finishes
// before the next starts, even when many "concurrent" callers invoke it
// back-to-back via Promise.all — there's never mid-function interleaving.
const _countsScratch = new Uint16Array(MAX_PACKED_VALUE + 1);
const _blockToPaletteScratch = new Uint8Array(MAX_PACKED_VALUE + 1);
// First-seen order collection of unique values (palette build input).
const _uniqueValuesScratch = new Uint16Array(17);

// Small pool of pre-allocated 32KB decompression buffers. Avoids GC pressure
// from allocating a fresh Uint8Array(32768) on every decompressBlocks call.
// Pool is safe without locks: JS is single-threaded and decompressBlocks is
// synchronous, so no caller can observe a mid-use buffer.
const _decompPool: Uint8Array[] = [];
const DECOMP_POOL_MAX = 4;

/**
 * Compress a full 32³ block array. The returned `data` is either a fresh
 * packed buffer or (when raw) the input buffer itself — never a copy of the
 * input in the raw case.
 *
 * Optimized: reused count/palette-index scratch buffers instead of fresh
 * per-call allocations, single-pass palette build with early exit once all
 * unique ids are found, and dropped mask ops that were always no-ops given
 * the value ranges involved (see inline notes).
 */
export function compressBlocks(
	blocks: Uint8Array | Uint16Array,
): CompressedBlocks {
	const len = blocks.length;

	const counts = _countsScratch;
	counts.fill(0);

	let uniqueCount = 0;
	let uniqueValueCount = 0;
	let firstBlockId = -1;
	const uniqueValues = _uniqueValuesScratch;

	for (let i = 0; i < len; i++) {
		const value = blocks[i];

		if (counts[value] === 0) {
			counts[value] = 1;
			uniqueCount++;

			if (uniqueValueCount < uniqueValues.length) {
				uniqueValues[uniqueValueCount++] = value;
			}

			if (firstBlockId === -1) {
				firstBlockId = value;
			}

			if (uniqueCount > 16) {
				return {
					data: blocks,
					isUniform: false,
					uniformBlockId: 0,
				};
			}
		} else {
			counts[value]++;
		}
	}

	if (uniqueCount === 1) {
		return {
			data: new Uint8Array(0),
			isUniform: true,
			uniformBlockId: firstBlockId,
		};
	}

	const palette: number[] = [];
	const blockToPalette = _blockToPaletteScratch;

	// Build the palette from the tracked unique values (first-seen order)
	// instead of scanning a 64K range — values may be packed id|state.
	for (let i = 0; i < uniqueValueCount; i++) {
		const value = uniqueValues[i];
		blockToPalette[value] = palette.length;
		palette.push(value);
	}

	const packed = new Uint8Array(len >> 1);

	for (let i = 0, j = 0; i < len; i += 2, j++) {
		packed[j] =
			blockToPalette[blocks[i]] | (blockToPalette[blocks[i + 1]] << 4);
	}

	return {
		data: packed,
		palette,
		isUniform: false,
		uniformBlockId: 0,
	};
}

/**
 * Expand a compressed chunk back into the full 32³ block array.
 * Returns a fresh buffer when the chunk was palette-packed; for raw chunks
 * the stored buffer is returned as-is (no copy).
 *
 * The result is a Uint16Array whenever any block id exceeds 255 (uniform
 * ids, palette entries, or raw u16 storage); otherwise a pooled Uint8Array.
 *
 * Uses a small buffer pool to avoid per-call 32KB allocations on the hot
 * path (block edit flushes). Callers that need to hold the buffer beyond
 * the synchronous scope should copy it.
 */
export function decompressBlocks(
	compressed: CompressedBlocks,
): Uint8Array | Uint16Array {
	const { data, palette, isUniform, uniformBlockId } = compressed;
	const len = CHUNK_VOLUME;

	if (isUniform) {
		if (uniformBlockId > 255) {
			const out = new Uint16Array(len);
			out.fill(uniformBlockId);
			return out;
		}

		const out = _decompPool.pop() ?? new Uint8Array(len);
		out.fill(uniformBlockId);
		return out;
	}

	if (palette && palette.length > 0) {
		let hasWideIds = false;
		for (let i = 0; i < palette.length; i++) {
			if (palette[i] > 255) {
				hasWideIds = true;
				break;
			}
		}

		if (hasWideIds) {
			const out = new Uint16Array(len);
			for (let i = 0, j = 0; i < len; i += 2, j++) {
				const packed = data[j];
				out[i] = palette[packed & 0x0f];
				out[i + 1] = palette[packed >> 4];
			}
			return out;
		}

		const out = _decompPool.pop() ?? new Uint8Array(len);

		for (let i = 0, j = 0; i < len; i += 2, j++) {
			const packed = data[j];
			out[i] = palette[packed & 0x0f];
			out[i + 1] = palette[packed >> 4];
		}

		return out;
	}

	return data;
}

/**
 * Return a decompression buffer to the pool for reuse.
 * Call after you're done with the buffer from decompressBlocks (e.g. after
 * compressing the modified blocks or after mesh generation copies the data).
 * Uint16Array results are never pooled (they are rare, freshly allocated).
 */
export function releaseDecompBuffer(buf: Uint8Array | Uint16Array): void {
	if (
		buf instanceof Uint8Array &&
		buf.length === CHUNK_VOLUME &&
		_decompPool.length < DECOMP_POOL_MAX
	) {
		_decompPool.push(buf);
	}
}
