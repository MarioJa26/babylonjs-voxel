// ---------------------------------------------------------------------------
// ChunkLightHeader
//
// One row per loaded chunk, stored in a single workspace-wide
// SharedArrayBuffer. Rows are addressed by a per-chunk slot index allocated
// by the ChunkWorkerPool and shared with workers via the registration message.
//
// Layout: 16 bytes per slot = 4 Int32 words.
//
//   word  offset  field
//   0     +0      meta:
//                   bits  0..7   flags
//                   bits  8..15  reserved
//                   bits 16..31  uniformBlockId
//   1     +4      lightVersionSeq — Atomics.add counter
//   2     +8      chunkId low 32 bits
//   3     +12     chunkId high 32 bits
//
// Total SAB footprint = 16 * 65536 = 1 MiB.
// ---------------------------------------------------------------------------

export const LIGHT_HEADER_ROW_WORDS = 4;
export const LIGHT_HEADER_ROW_SIZE = LIGHT_HEADER_ROW_WORDS * 4;
export const MAX_HEADER_SLOTS = 4 * 65536;

export const LIGHT_HEADER_FLAG_UNIFORM = 1 << 0;
export const LIGHT_HEADER_FLAG_STORAGE_U16 = 1 << 1;
export const LIGHT_HEADER_FLAG_HAS_PALETTE = 1 << 2;
export const LIGHT_HEADER_FLAG_LOADED = 1 << 3;

const WORD_META = 0;
const WORD_LIGHT_SEQ = 1;
const WORD_CHUNK_ID_LOW = 2;
const WORD_CHUNK_ID_HIGH = 3;

export type LightHeaderView = {
	words: Int32Array;
};

function rowBase(slot: number): number {
	return slot * LIGHT_HEADER_ROW_WORDS;
}

export function wrapLightHeader(buffer: SharedArrayBuffer): LightHeaderView {
	return {
		words: new Int32Array(buffer),
	};
}

export function readHeaderMeta(view: LightHeaderView, slot: number): number {
	return Atomics.load(view.words, rowBase(slot) + WORD_META);
}

export function readHeaderFlags(view: LightHeaderView, slot: number): number {
	return readHeaderMeta(view, slot) & 0xff;
}

export function readHeaderUniformId(
	view: LightHeaderView,
	slot: number,
): number {
	return (readHeaderMeta(view, slot) >>> 16) & 0xffff;
}

export function bumpHeaderLightSeq(
	view: LightHeaderView,
	slot: number,
): number {
	return Atomics.add(view.words, rowBase(slot) + WORD_LIGHT_SEQ, 1);
}

export function writeHeaderRow(
	view: LightHeaderView,
	slot: number,
	opts: {
		chunkId: bigint;
		isUniform: boolean;
		uniformBlockId: number;
		storageIsUint16: boolean;
		hasPalette: boolean;
		isLoaded: boolean;
	},
): void {
	const base = rowBase(slot);

	let flags = 0;
	if (opts.isUniform) flags |= LIGHT_HEADER_FLAG_UNIFORM;
	if (opts.storageIsUint16) flags |= LIGHT_HEADER_FLAG_STORAGE_U16;
	if (opts.hasPalette) flags |= LIGHT_HEADER_FLAG_HAS_PALETTE;
	if (opts.isLoaded) flags |= LIGHT_HEADER_FLAG_LOADED;

	const meta = (flags & 0xff) | ((opts.uniformBlockId & 0xffff) << 16);

	// Publish order:
	// Write chunk identity first, then publish layout/loaded state via meta.
	// Workers treat meta.flags as the authoritative loaded/layout snapshot.
	Atomics.store(
		view.words,
		base + WORD_CHUNK_ID_LOW,
		Number(opts.chunkId & 0xffffffffn) | 0,
	);

	Atomics.store(
		view.words,
		base + WORD_CHUNK_ID_HIGH,
		Number((opts.chunkId >> 32n) & 0xffffffffn) | 0,
	);

	Atomics.store(view.words, base + WORD_META, meta);
}

export function clearHeaderRow(view: LightHeaderView, slot: number): void {
	const base = rowBase(slot);

	// Unpublish first so workers stop considering this slot loaded.
	Atomics.store(view.words, base + WORD_META, 0);

	Atomics.store(view.words, base + WORD_LIGHT_SEQ, 0);
	Atomics.store(view.words, base + WORD_CHUNK_ID_LOW, 0);
	Atomics.store(view.words, base + WORD_CHUNK_ID_HIGH, 0);
}
