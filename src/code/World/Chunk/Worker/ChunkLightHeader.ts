// ---------------------------------------------------------------------------
// ChunkLightHeader
//
// One row per loaded chunk, stored in a workspace-wide SharedArrayBuffer.
// Rows are addressed by a per-chunk slot allocated by ChunkWorkerPool and
// shared with workers through the registration message.
//
// Layout: 16 bytes per slot = 4 Int32 words.
//
//   word  offset  field
//   0     +0      meta:
//                   bits  0..7   flags
//                   bits  8..15  reserved
//                   bits 16..31  uniformBlockId
//   1     +4      lightVersionSeq, incremented with Atomics.add
//   2     +8      chunkId low 32 bits
//   3     +12     chunkId high 32 bits
//
// Total SAB footprint: 262,144 slots * 16 bytes = 4 MiB.
// ---------------------------------------------------------------------------

export const LIGHT_HEADER_ROW_WORDS = 4;
export const LIGHT_HEADER_ROW_SIZE =
	LIGHT_HEADER_ROW_WORDS * Int32Array.BYTES_PER_ELEMENT;

export const MAX_HEADER_SLOTS = 4 * 65_536;
export const LIGHT_HEADER_BUFFER_SIZE =
	MAX_HEADER_SLOTS * LIGHT_HEADER_ROW_SIZE;

export const LIGHT_HEADER_FLAG_UNIFORM = 1 << 0;
export const LIGHT_HEADER_FLAG_STORAGE_U16 = 1 << 1;
export const LIGHT_HEADER_FLAG_HAS_PALETTE = 1 << 2;
export const LIGHT_HEADER_FLAG_LOADED = 1 << 3;

const WORD_META = 0;
const WORD_LIGHT_SEQ = 1;
const WORD_CHUNK_ID_LOW = 2;
const WORD_CHUNK_ID_HIGH = 3;

const META_FLAGS_MASK = 0xff;
const META_UNIFORM_SHIFT = 16;
const META_UNIFORM_MASK = 0xffff;

const UINT32_BIGINT_MASK = 0xffff_ffffn;
const UINT32_BIGINT_SHIFT = 32n;

export type LightHeaderView = {
	words: Int32Array;
};

export type WriteHeaderRowOptions = {
	chunkId: bigint;
	isUniform: boolean;
	uniformBlockId: number;
	storageIsUint16: boolean;
	hasPalette: boolean;
	isLoaded: boolean;
};

/**
 * LIGHT_HEADER_ROW_WORDS is a power of two, so shifting avoids a multiplication
 * in every header access.
 */
function rowBase(slot: number): number {
	return slot << 2;
}

function packMeta(flags: number, uniformBlockId: number): number {
	return (
		(flags & META_FLAGS_MASK) |
		((uniformBlockId & META_UNIFORM_MASK) << META_UNIFORM_SHIFT)
	);
}

function chunkIdLow32(chunkId: bigint): number {
	return Number(chunkId & UINT32_BIGINT_MASK) | 0;
}

function chunkIdHigh32(chunkId: bigint): number {
	return Number((chunkId >> UINT32_BIGINT_SHIFT) & UINT32_BIGINT_MASK) | 0;
}

export function wrapLightHeader(buffer: SharedArrayBuffer): LightHeaderView {
	return {
		words: new Int32Array(buffer),
	};
}

export function readHeaderMeta(view: LightHeaderView, slot: number): number {
	const index = rowBase(slot) + WORD_META;
	return Atomics.load(view.words, index);
}

export function readHeaderFlags(view: LightHeaderView, slot: number): number {
	const index = rowBase(slot) + WORD_META;
	return Atomics.load(view.words, index) & META_FLAGS_MASK;
}

export function readHeaderUniformId(
	view: LightHeaderView,
	slot: number,
): number {
	const index = rowBase(slot) + WORD_META;
	const meta = Atomics.load(view.words, index);

	return (meta >>> META_UNIFORM_SHIFT) & META_UNIFORM_MASK;
}

/**
 * Atomically increments the light version sequence.
 *
 * Returns the value that existed before the increment, matching Atomics.add.
 */
export function bumpHeaderLightSeq(
	view: LightHeaderView,
	slot: number,
): number {
	const index = rowBase(slot) + WORD_LIGHT_SEQ;
	return Atomics.add(view.words, index, 1);
}

export function writeHeaderRow(
	view: LightHeaderView,
	slot: number,
	opts: WriteHeaderRowOptions,
): void {
	const words = view.words;
	const base = rowBase(slot);

	let flags = 0;

	if (opts.isUniform) {
		flags |= LIGHT_HEADER_FLAG_UNIFORM;
	}

	if (opts.storageIsUint16) {
		flags |= LIGHT_HEADER_FLAG_STORAGE_U16;
	}

	if (opts.hasPalette) {
		flags |= LIGHT_HEADER_FLAG_HAS_PALETTE;
	}

	if (opts.isLoaded) {
		flags |= LIGHT_HEADER_FLAG_LOADED;
	}

	/*
	 * Publish order:
	 *
	 * 1. Write the chunk identity.
	 * 2. Publish the layout and loaded-state snapshot through meta.
	 *
	 * Workers must read meta as the authoritative publication field before
	 * consuming the remaining row data.
	 */
	Atomics.store(words, base + WORD_CHUNK_ID_LOW, chunkIdLow32(opts.chunkId));

	Atomics.store(words, base + WORD_CHUNK_ID_HIGH, chunkIdHigh32(opts.chunkId));

	Atomics.store(words, base + WORD_META, packMeta(flags, opts.uniformBlockId));
}

export function clearHeaderRow(view: LightHeaderView, slot: number): void {
	const words = view.words;
	const base = rowBase(slot);

	/*
	 * Unpublish first. Once meta is zero, workers must stop treating the slot
	 * as loaded before the remaining row fields are cleared.
	 */
	Atomics.store(words, base + WORD_META, 0);
	Atomics.store(words, base + WORD_LIGHT_SEQ, 0);
	Atomics.store(words, base + WORD_CHUNK_ID_LOW, 0);
	Atomics.store(words, base + WORD_CHUNK_ID_HIGH, 0);
}
