/**
 * ChunkCompression — shared block compression helpers for the server.
 *
 * Blocks are stored as a 32³ (32768-entry) byte array. To cut memory and
 * network payload size, chunks are compressed on generation:
 * - uniform chunk: all voxels share one block id → stores nothing (0 bytes)
 * - ≤16 unique ids: 4-bit palette-packed (half the size)
 * - otherwise: raw copy
 *
 * The inverse (decompressBlocks) is needed when applying block edits to a
 * stored chunk: edits target world coordinates, so the full array must be
 * materialized first.
 */

export const CHUNK_VOLUME = 32 * 32 * 32;

export interface CompressedBlocks {
	data: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
}

// Module-level scratch buffers reused across calls instead of allocating a
// fresh Uint16Array(256)/Uint8Array(256) on every single chunk compressed.
// Safe to share: compressBlocks is fully synchronous (no `await` inside),
// and JS run-to-completion semantics guarantee one call always finishes
// before the next starts, even when many "concurrent" callers invoke it
// back-to-back via Promise.all — there's never mid-function interleaving.
const _countsScratch = new Uint16Array(256);
const _blockToPaletteScratch = new Uint8Array(256);

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
export function compressBlocks(blocks: Uint8Array): CompressedBlocks {
	const len = blocks.length;

	// Single-pass: count unique block IDs using a fixed-size scratch array
	// (block IDs are uint8, so max 256 unique). Simultaneously track the
	// first non-empty id for the uniform-chunk fast path.
	const counts = _countsScratch;
	counts.fill(0);
	let uniqueCount = 0;
	let firstNonEmpty = -1;

	for (let i = 0; i < len; i++) {
		const id = blocks[i];
		if (counts[id] === 0) {
			uniqueCount++;
			if (firstNonEmpty === -1) firstNonEmpty = id;
		}
		counts[id]++;
	}

	// Uniform: all voxels share one block id
	if (uniqueCount === 1) {
		return {
			data: new Uint8Array(0),
			isUniform: true,
			uniformBlockId: firstNonEmpty,
		};
	}

	// Palette-packed: ≤16 unique block ids → 4-bit nibble packing
	if (uniqueCount <= 16) {
		// Build palette from the count scratch (stable order: iterate 0..255),
		// stopping as soon as every unique id has been collected instead of
		// always scanning the full 256 entries.
		const palette: number[] = [];
		for (let i = 0; i < 256 && palette.length < uniqueCount; i++) {
			if (counts[i] > 0) palette.push(i);
		}

		// Build reverse lookup: blockId → palette index. Reused scratch — only
		// the entries for this chunk's palette ids are (re)written, and the
		// packing loop below only ever reads ids that are in that palette
		// (they came from the same `blocks` array), so stale entries from a
		// previous call are never observed.
		const blockToPalette = _blockToPaletteScratch;
		for (let i = 0; i < palette.length; i++) {
			blockToPalette[palette[i]] = i;
		}

		const packed = new Uint8Array(Math.ceil(len / 2));
		for (let i = 0; i < len; i += 2) {
			// blockToPalette values are palette indices in [0, uniqueCount-1]
			// ⊆ [0, 15] by construction, so they already fit a nibble —
			// the `& 0x0f` masks in the original code were always no-ops.
			packed[i >> 1] =
				blockToPalette[blocks[i]] | (blockToPalette[blocks[i + 1]] << 4);
		}

		return { data: packed, palette, isUniform: false, uniformBlockId: 0 };
	}

	// Raw — caller already owns the buffer, hand it back without a copy.
	return { data: blocks, isUniform: false, uniformBlockId: 0 };
}

/**
 * Expand a compressed chunk back into the full 32³ block array.
 * Returns a fresh buffer when the chunk was palette-packed; for raw chunks
 * the stored buffer is returned as-is (no copy).
 *
 * Uses a small buffer pool to avoid per-call 32KB allocations on the hot
 * path (block edit flushes). Callers that need to hold the buffer beyond
 * the synchronous scope should copy it.
 */
export function decompressBlocks(compressed: CompressedBlocks): Uint8Array {
	const { data, palette, isUniform, uniformBlockId } = compressed;
	const len = CHUNK_VOLUME;

	if (isUniform) {
		const out = _decompPool.pop() ?? new Uint8Array(len);
		out.fill(uniformBlockId);
		return out;
	}

	if (palette && palette.length > 0) {
		const out = _decompPool.pop() ?? new Uint8Array(len);
		// Step by 2 and unpack both nibbles from one byte read, instead of
		// re-reading `data[i>>1]` on every voxel (twice per byte) and
		// branching on parity each iteration.
		for (let i = 0; i < len; i += 2) {
			const packed = data[i >> 1];
			out[i] = palette[packed & 0x0f];
			// packed is a uint8 (0-255), so packed >> 4 is already 0-15 —
			// no mask needed for the high nibble.
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
 */
export function releaseDecompBuffer(buf: Uint8Array): void {
	if (
		buf.length === CHUNK_VOLUME &&
		_decompPool.length < DECOMP_POOL_MAX
	) {
		_decompPool.push(buf);
	}
}
