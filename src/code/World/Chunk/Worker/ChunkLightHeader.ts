// ---------------------------------------------------------------------------
// ChunkLightHeader
//
// One row per loaded chunk, stored in a single workspace-wide
// SharedArrayBuffer. Rows are addressed by a per-chunk slot index allocated
// by the ChunkWorkerPool and shared with workers via the registration
// message. Workers re-read the row on every BFS visit so they always see
// the latest block-storage layout (uniform / palette / Uint8-vs-Uint16)
// without a per-mutation main->worker message.
//
// Layout (16 bytes, little-endian):
//   offset  bytes  field
//   0       1      flags (bit0 = isUniform, bit1 = storageIsUint16,
//                          bit2 = hasPalette, bit3 = isLoaded)
//   1       1      padding (u8 — keeps uniformId u16-aligned)
//   2       2      uniformBlockId (u16 little-endian)
//   4       4      lightVersionSeq — Atomics.add counter, bumped by the
//                          worker on every BFS completion
//   8       4      chunkId low 32 bits
//   12      4      chunkId high 32 bits
//
// ROW_SIZE = 16, max rows = MAX_HEADER_SLOTS (64K initially).
// Total SAB footprint = 16 * 64K = 1 MB.
// ---------------------------------------------------------------------------

export const LIGHT_HEADER_ROW_SIZE = 16;
export const MAX_HEADER_SLOTS = 65536;

export const LIGHT_HEADER_FLAG_UNIFORM = 1 << 0;
export const LIGHT_HEADER_FLAG_STORAGE_U16 = 1 << 1;
export const LIGHT_HEADER_FLAG_HAS_PALETTE = 1 << 2;
export const LIGHT_HEADER_FLAG_LOADED = 1 << 3;

const OFF_FLAGS = 0;
const OFF_UNIFORM_ID = 2;
const OFF_LIGHT_SEQ = 4;
const OFF_CHUNK_ID = 8;

export type LightHeaderView = {
	flags: Uint8Array;
	uniformId: Uint16Array;
	lightSeq: Int32Array;
	chunkIdLow: Int32Array;
	chunkIdHigh: Int32Array;
};

export function wrapLightHeader(buffer: SharedArrayBuffer): LightHeaderView {
	const u8 = new Uint8Array(buffer);
	return {
		flags: u8.subarray(OFF_FLAGS, MAX_HEADER_SLOTS * LIGHT_HEADER_ROW_SIZE),
		uniformId: new Uint16Array(buffer, OFF_UNIFORM_ID, MAX_HEADER_SLOTS),
		lightSeq: new Int32Array(buffer, OFF_LIGHT_SEQ, MAX_HEADER_SLOTS),
		chunkIdLow: new Int32Array(buffer, OFF_CHUNK_ID, MAX_HEADER_SLOTS),
		chunkIdHigh: new Int32Array(buffer, OFF_CHUNK_ID + 4, MAX_HEADER_SLOTS),
	};
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
	const base = slot * LIGHT_HEADER_ROW_SIZE;
	let flags = 0;
	if (opts.isUniform) flags |= LIGHT_HEADER_FLAG_UNIFORM;
	if (opts.storageIsUint16) flags |= LIGHT_HEADER_FLAG_STORAGE_U16;
	if (opts.hasPalette) flags |= LIGHT_HEADER_FLAG_HAS_PALETTE;
	if (opts.isLoaded) flags |= LIGHT_HEADER_FLAG_LOADED;
	Atomics.store(view.flags, base + OFF_FLAGS, flags);
	Atomics.store(view.uniformId, slot, opts.uniformBlockId & 0xffff);
	Atomics.store(view.chunkIdLow, slot, Number(opts.chunkId & 0xffffffffn) | 0);
	Atomics.store(
		view.chunkIdHigh,
		slot,
		Number((opts.chunkId >> 32n) & 0xffffffffn) | 0,
	);
}

export function clearHeaderRow(view: LightHeaderView, slot: number): void {
	const base = slot * LIGHT_HEADER_ROW_SIZE;
	Atomics.store(view.flags, base + OFF_FLAGS, 0);
	Atomics.store(view.uniformId, slot, 0);
	Atomics.store(view.chunkIdLow, slot, 0);
	Atomics.store(view.chunkIdHigh, slot, 0);
	Atomics.store(view.lightSeq, slot, 0);
}

export function readHeaderFlags(view: LightHeaderView, slot: number): number {
	const base = slot * LIGHT_HEADER_ROW_SIZE;
	return Atomics.load(view.flags, base + OFF_FLAGS);
}

export function readHeaderUniformId(
	view: LightHeaderView,
	slot: number,
): number {
	return Atomics.load(view.uniformId, slot);
}
