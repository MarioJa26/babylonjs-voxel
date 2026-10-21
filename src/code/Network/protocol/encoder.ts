/**
 * Binary encoder/decoder for b102 multiplayer protocol.
 *
 * All integers are little-endian. Uses DataView for cross-platform correctness.
 *
 * Single source of truth for client AND server — the server imports this
 * module via its "@/code/Network/protocol/*" path alias.
 */

import { deflate } from "../../World/Storage/BlobCompression";
import type { RemoteChunkData } from "../chunk/RemoteChunkProvider";
import {
	type ArrowTrajectoryData,
	type BlockEditData,
	type BlockEditRejectedData,
	type ChatMessageData,
	ChunkResultKind,
	type ContainerCloseData,
	type ContainerOpenData,
	type ContainerRejectedData,
	type ContainerSetSlotData,
	type ContainerSlotData,
	type ContainerSlotUpdateData,
	type ContainerStateData,
	type ExplosionData,
	type HeldItemSelectionData,
	type ItemDropData,
	type ItemPickupData,
	type ItemPickupRejectedData,
	type ItemSpawnData,
	type ItemUpdateBatchEntry,
	MessageType,
	type MobDamageData,
	type MobImpactData,
	type MobSpawnRequestData,
	type MobUpdateBatchEntry,
	type PlayerHeldItemData,
	type PlayerJoinData,
	type PlayerLeaveData,
	type PlayerSkinData,
	type PlayerStateBatchEntry,
	type PlayerStateData,
	type StationClaimResultData,
	type StationOpenData,
	type StationRejectedData,
	type StationResultClaimedData,
	type StationSetSlotData,
	type StationSlotUpdateData,
	type StationStateData,
	type StationUpgradeData,
	type TntIgniteData,
} from "./messages";

// Module-level scratch encoders: writeString/readString allocate a fresh
// TextEncoder/TextDecoder per call otherwise. The encode/decode calls are
// synchronous, so a single shared instance per direction is safe.
const _textEncoder = new TextEncoder();
const _textDecoder = new TextDecoder();

const MAX_UINT16 = 0xffff;

const BLOCK_EDIT_ENTRY_BYTES = 16; // x/y/z:i32 + blockId:u16 + blockState:u8 + action:u8
const EXPLOSION_BROADCAST_BYTES = 1 + 4 + 4 + 4 * 4;
const CHUNK_VOLUME = 32 * 32 * 32; // Chunk.SIZE^3 — light arrays are this size

export class BinaryEncoder {
	private buffer: Uint8Array;
	private view: DataView;
	private offset: number;

	constructor(initialCapacity = 1024) {
		this.buffer = new Uint8Array(Math.max(1, initialCapacity));
		this.view = new DataView(
			this.buffer.buffer,
			this.buffer.byteOffset,
			this.buffer.byteLength,
		);
		this.offset = 0;
	}

	/**
	 * Guarantees at least `additionalBytes` more bytes fit before `offset`,
	 * growing the backing buffer when needed. Call once per fixed-layout
	 * message so the inner writes skip their individual capacity checks.
	 */
	reserve(additionalBytes: number): void {
		if (
			!Number.isSafeInteger(additionalBytes) ||
			additionalBytes < 0
		) {
			throw new RangeError(`Invalid reserve size: ${additionalBytes}`);
		}

		const required = this.offset + additionalBytes;
		if (required <= this.buffer.byteLength) return;

		let newCapacity = this.buffer.byteLength;

		// Geometric growth for ordinary messages. For very large messages, jump
		// straight to the required size to avoid repeated doubling (and the
		// temporary memory each doubling allocates).
		if (newCapacity < 1024 * 1024) {
			do {
				newCapacity *= 2;
			} while (newCapacity < required);
		} else {
			newCapacity = required;
		}

		const newBuffer = new Uint8Array(newCapacity);
		newBuffer.set(this.buffer.subarray(0, this.offset));
		this.buffer = newBuffer;
		this.view = new DataView(
			newBuffer.buffer,
			newBuffer.byteOffset,
			newBuffer.byteLength,
		);
	}

	/**
	 * Unchecked primitive write. Only valid when a prior `reserve()` call has
	 * guaranteed at least `1` free byte. Hot batch paths use this to skip the
	 * per-write bounds check.
	 */
	writeUint8Unchecked(value: number): void {
		this.buffer[this.offset++] = value;
	}

	private ensure(needed: number): void {
		const required = this.offset + needed;
		if (required <= this.buffer.byteLength) return;
		let newCap = this.buffer.byteLength * 2;
		while (newCap < required) newCap *= 2;
		const newBuf = new Uint8Array(newCap);
		newBuf.set(this.buffer);
		this.buffer = newBuf;
		this.view = new DataView(newBuf.buffer);
	}

	writeUint8(value: number): void {
		this.ensure(1);
		this.view.setUint8(this.offset, value);
		this.offset += 1;
	}

	writeInt16(value: number): void {
		this.ensure(2);
		this.view.setInt16(this.offset, value, true);
		this.offset += 2;
	}

	writeInt32(value: number): void {
		this.ensure(4);
		this.view.setInt32(this.offset, value, true);
		this.offset += 4;
	}

	writeFloat32(value: number): void {
		this.ensure(4);
		this.view.setFloat32(this.offset, value, true);
		this.offset += 4;
	}

	writeUint16(value: number): void {
		this.ensure(2);
		this.view.setUint16(this.offset, value, true);
		this.offset += 2;
	}

	writeUint32(value: number): void {
		this.ensure(4);
		this.view.setUint32(this.offset, value, true);
		this.offset += 4;
	}

	/**
	 * Writes a uint16 length prefix then the UTF-8 bytes. Throws instead of
	 * truncating when the payload exceeds the 16-bit length field — the old
	 * behaviour emitted a truncated length followed by the full payload,
	 * silently corrupting the stream.
	 */
	writeString(str: string): void {
		const encoded = _textEncoder.encode(str);
		const length = encoded.byteLength;

		if (length > MAX_UINT16) {
			throw new RangeError(
				`UTF-8 string is ${length} bytes; protocol maximum is ${MAX_UINT16}`,
			);
		}

		this.ensure(2 + length);
		this.view.setUint16(this.offset, length, true);
		this.buffer.set(encoded, this.offset + 2);
		this.offset += 2 + length;
	}

	writeBytes(bytes: Uint8Array): void {
		this.ensure(bytes.byteLength);
		this.buffer.set(bytes, this.offset);
		this.offset += bytes.byteLength;
	}

	/**
	 * Copies any typed-array or DataView region without constructing an
	 * intermediate Uint8Array at the call site (e.g. for a dense Uint16Array
	 * block payload).
	 */
	writeArrayBufferView(value: ArrayBufferView): void {
		const bytes = new Uint8Array(
			value.buffer,
			value.byteOffset,
			value.byteLength,
		);
		this.writeBytes(bytes);
	}

	// Engine perf: container/chunk coords are always x/y/z i32 triples.
	// Single call site keeps encode fns small; V8 inlines (same 3 DataView ops).
	writeCoords(x: number, y: number, z: number): void {
		this.ensure(12);
		this.view.setInt32(this.offset, x, true);
		this.view.setInt32(this.offset + 4, y, true);
		this.view.setInt32(this.offset + 8, z, true);
		this.offset += 12;
	}

	/**
	 * C→S: no sessionId — the server uses the connection identity.
	 * yaw: 0-255 maps the full 360° circle; pitch: 0-255 maps -90°..+90°.
	 * C→S: write player state from raw values without allocating an
	 * intermediate PlayerStateData object (20 Hz hot path).
	 */
	writePlayerStateRaw(
		x: number,
		y: number,
		z: number,
		yaw: number,
		pitch: number,
		animation: number,
	): void {
		this.reserve(1 + 12 + 3);
		this.writeUint8(MessageType.PlayerState);
		this.view.setFloat32(this.offset, x, true);
		this.view.setFloat32(this.offset + 4, y, true);
		this.view.setFloat32(this.offset + 8, z, true);
		this.offset += 12;
		this.writeUint8Unchecked(yaw);
		this.writeUint8Unchecked(pitch);
		this.writeUint8Unchecked(animation);
	}

	/** C→S: no sessionId — the server uses the connection identity. */
	writeBlockEdit(data: BlockEditData): void {
		this.reserve(1 + 12 + 4);
		this.writeUint8(MessageType.BlockEdit);
		this.view.setInt32(this.offset, data.x, true);
		this.view.setInt32(this.offset + 4, data.y, true);
		this.view.setInt32(this.offset + 8, data.z, true);
		this.offset += 12;
		this.view.setUint16(this.offset, data.blockId, true);
		this.buffer[this.offset + 2] = data.blockState;
		this.buffer[this.offset + 3] = data.action;
		this.offset += 4;
	}

	/** C→S and S→C share the ChatMessage layout (sessionId, name, message). */
	writeChatMessage(data: ChatMessageData): void {
		this.writeUint8(MessageType.ChatMessage);
		this.writeString(data.sessionId);
		this.writeString(data.name);
		this.writeString(data.message);
	}

	writeChunkRequest(
		cx: number,
		cy: number,
		cz: number,
		lod: number,
		cachedVersion = 0,
	): void {
		this.reserve(1 + 12 + 1 + 4);
		this.writeUint8(MessageType.ChunkRequest);
		this.view.setInt32(this.offset, cx, true);
		this.view.setInt32(this.offset + 4, cy, true);
		this.view.setInt32(this.offset + 8, cz, true);
		this.offset += 12;
		this.writeUint8Unchecked(lod);
		this.view.setUint32(this.offset, cachedVersion, true);
		this.offset += 4;
	}

	writeChunkRequestBatch(
		requests: ReadonlyArray<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedVersion: number;
		}>,
	): void {
		const count = Math.min(requests.length, MAX_UINT16);
		const entryBytes = 4 + 4 + 4 + 1 + 4; // 17

		this.reserve(1 + 2 + count * entryBytes);
		this.writeUint8(MessageType.ChunkRequestBatch);
		this.view.setUint16(this.offset, count, true);
		this.offset += 2;

		for (let i = 0; i < count; i++) {
			const request = requests[i];
			this.view.setInt32(this.offset, request.cx, true);
			this.view.setInt32(this.offset + 4, request.cy, true);
			this.view.setInt32(this.offset + 8, request.cz, true);
			this.buffer[this.offset + 12] = request.lod;
			this.view.setUint32(this.offset + 13, request.cachedVersion, true);
			this.offset += entryBytes;
		}
	}

	/**
	 * Returns a live view backed by this encoder's current buffer.
	 *
	 * Only safe when the consumer synchronously copies or fully consumes the
	 * bytes before this encoder is reset or written to again. Pooled encoders
	 * whose results may be retained must use `finish()` instead.
	 */
	getBytesView(): Uint8Array {
		return this.buffer.subarray(0, this.offset);
	}

	/**
	 * Returns an independently owned packet (one copy). Use this from pooled
	 * encoders when the transport may retain the supplied data after send
	 * returns, so a later reset/encode cannot mutate a prior packet.
	 */
	finish(): Uint8Array {
		return this.buffer.slice(0, this.offset);
	}

	/**
	 * Compatibility alias for `getBytesView()` (keeps the historical zero-copy
	 * behavior for one-shot, exact-sized encoders).
	 */
	getBytes(): Uint8Array {
		return this.getBytesView();
	}

	reset(): void {
		this.offset = 0;
	}
}

// PERF: reused scratch encoder for the small single-event encode helpers below
// (player join/leave, mob spawn/despawn, item spawn/despawn, container/station
// updates). Each helper resets and writes into it, then returns finish() — an
// OWNED copy — because callers may retain the packet past the next encode:
// the join fan-out path pushes several encoded frames into a parts[] array and
// merges them after the loop, so a live subarray view would alias the shared
// buffer (and every retained view would collapse onto the last-encoded bytes
// whenever the payloads fit in one allocation). The one copy per event is the
// price of not aliasing pooled storage across live messages.
const _singleEventEncoder = new BinaryEncoder(64);

export class BinaryDecoder {
	private buffer: Uint8Array;
	private view: DataView;
	private offset: number;

	constructor(buffer: Uint8Array, startOffset = 0) {
		if (
			!Number.isSafeInteger(startOffset) ||
			startOffset < 0 ||
			startOffset > buffer.byteLength
		) {
			throw new RangeError(`Invalid decoder offset: ${startOffset}`);
		}

		this.buffer = buffer;
		this.view = new DataView(
			buffer.buffer,
			buffer.byteOffset,
			buffer.byteLength,
		);
		this.offset = startOffset;
	}

	/**
	 * Rebind this decoder to a new buffer. Lets message handlers reuse one
	 * decoder instance across many packets instead of allocating a fresh
	 * decoder + DataView per message.
	 */
	setBuffer(buffer: Uint8Array, startOffset = 0): void {
		if (
			!Number.isSafeInteger(startOffset) ||
			startOffset < 0 ||
			startOffset > buffer.byteLength
		) {
			throw new RangeError(`Invalid decoder offset: ${startOffset}`);
		}

		this.buffer = buffer;
		this.view = new DataView(
			buffer.buffer,
			buffer.byteOffset,
			buffer.byteLength,
		);
		this.offset = startOffset;
	}

	get remaining(): number {
		return this.buffer.byteLength - this.offset;
	}

	get position(): number {
		return this.offset;
	}

	/**
	 * Throws (without advancing) when fewer than byteLength bytes remain.
	 * Public so batch decoders can validate the whole batch body once —
	 * bounding an untrusted count before per-entry reads — instead of
	 * paying one check per read.
	 */
	require(byteLength: number): void {
		if (
			!Number.isSafeInteger(byteLength) ||
			byteLength < 0 ||
			byteLength > this.buffer.byteLength - this.offset
		) {
			throw new RangeError(
				`Packet underflow at ${this.offset}: requested ${byteLength}, ` +
					`${this.buffer.byteLength - this.offset} remaining`,
			);
		}
	}

	/**
	 * Advances `offset` by byteLength without reading. Bounds-checked: a
	 * malformed length can no longer push the decoder past the end of the
	 * packet (the old behaviour did that silently and desynchronised every
	 * subsequent read).
	 */
	skip(byteLength: number): void {
		this.require(byteLength);
		this.offset += byteLength;
	}

	peekUint8(): number {
		this.require(1);
		return this.buffer[this.offset];
	}

	readUint8(): number {
		this.require(1);
		const v = this.buffer[this.offset];
		this.offset += 1;
		return v;
	}

	readInt16(): number {
		this.require(2);
		const v = this.view.getInt16(this.offset, true);
		this.offset += 2;
		return v;
	}

	readInt32(): number {
		this.require(4);
		const v = this.view.getInt32(this.offset, true);
		this.offset += 4;
		return v;
	}

	readFloat32(): number {
		this.require(4);
		const v = this.view.getFloat32(this.offset, true);
		this.offset += 4;
		return v;
	}

	readUint16(): number {
		this.require(2);
		const v = this.view.getUint16(this.offset, true);
		this.offset += 2;
		return v;
	}

	readUint32(): number {
		this.require(4);
		const v = this.view.getUint32(this.offset, true);
		this.offset += 4;
		return v;
	}

	/**
	 * Bulk-copy len bytes out of the buffer. One slice() copy instead of N
	 * readUint8() calls — the hot chunk-decode paths move tens of thousands
	 * of bytes per chunk.
	 */
	readBytes(len: number): Uint8Array {
		this.require(len);

		const start = this.offset;
		this.offset += len;
		return this.buffer.slice(start, this.offset);
	}

	/**
	 * Zero-copy view into the buffer — avoids the allocation + memcpy of
	 * readBytes(). Safe only when the caller guarantees the underlying
	 * buffer won't be reused before the view is consumed. For chunk decode
	 * paths where data flows into loadFromStorage → ensureSharedBacking
	 * (which copies into SAB), this is safe.
	 */
	readBytesView(len: number): Uint8Array {
		this.require(len);

		const start = this.offset;
		this.offset += len;
		return this.buffer.subarray(start, this.offset);
	}

	/**
	 * Copy len bytes into a fresh SharedArrayBuffer-backed view, allocating
	 * `capacity` bytes (default: len). Used by the chunk decoders when the
	 * consumer will hand the arrays to workers via loadFromStorage — the
	 * SAB view skips ensureSharedBacking()'s later copy, and the zero-aligned
	 * fresh buffer also satisfies the palette's alignment requirement without
	 * the readBytes() slice. The capacity form lets the light array come out
	 * at Chunk.SIZE3 (matching ensureSharedBacking's invariant) while
	 * advancing the decoder offset by the real wire length.
	 */
	readBytesViewSAB(len: number, capacity = len): Uint8Array {
		this.require(len);

		if (!Number.isSafeInteger(capacity) || capacity < len) {
			throw new RangeError(
				`SAB capacity ${capacity} is smaller than payload ${len}`,
			);
		}

		const target = new Uint8Array(new SharedArrayBuffer(capacity));
		target.set(this.buffer.subarray(this.offset, this.offset + len));
		this.offset += len;
		return target;
	}

	readString(): string {
		const len = this.readUint16();
		this.require(len);

		const start = this.offset;
		this.offset += len;
		return _textDecoder.decode(this.buffer.subarray(start, this.offset));
	}

	// Engine perf: mirrors writeCoords; fills caller-owned {x,y,z}, no alloc.
	readCoordsInto<T extends { x: number; y: number; z: number }>(target: T): T {
		this.require(12);

		target.x = this.view.getInt32(this.offset, true);
		target.y = this.view.getInt32(this.offset + 4, true);
		target.z = this.view.getInt32(this.offset + 8, true);
		this.offset += 12;
		return target;
	}

	/**
	 * C→S: decode into a caller-owned object instead of allocating a fresh
	 * one per message. Returns the target for chaining. The previous values
	 * are overwritten in place.
	 */
	readPlayerStateInto(target: PlayerStateData): PlayerStateData {
		this.require(15);

		target.x = this.view.getFloat32(this.offset, true);
		target.y = this.view.getFloat32(this.offset + 4, true);
		target.z = this.view.getFloat32(this.offset + 8, true);
		target.yaw = this.buffer[this.offset + 12];
		target.pitch = this.buffer[this.offset + 13];
		target.animation = this.buffer[this.offset + 14];
		this.offset += 15;
		return target;
	}

	/**
	 * C→S: decode into a caller-owned object instead of allocating a fresh
	 * one per message. Returns the target for chaining.
	 */
	readBlockEditInto(target: BlockEditData): BlockEditData {
		this.require(16);

		target.x = this.view.getInt32(this.offset, true);
		target.y = this.view.getInt32(this.offset + 4, true);
		target.z = this.view.getInt32(this.offset + 8, true);
		target.blockId = this.view.getUint16(this.offset + 12, true);
		target.blockState = this.buffer[this.offset + 14];
		target.action = this.buffer[this.offset + 15];
		this.offset += 16;
		return target;
	}

	readChatMessageInto(target: ChatMessageData): ChatMessageData {
		target.sessionId = this.readString();
		target.name = this.readString();
		target.message = this.readString();
		return target;
	}

	readChunkRequestInto(target: {
		cx: number;
		cy: number;
		cz: number;
		lod: number;
		cachedVersion: number;
	}): typeof target {
		const entryBytes = 4 + 4 + 4 + 1 + 4; // 17
		this.require(entryBytes);

		target.cx = this.view.getInt32(this.offset, true);
		target.cy = this.view.getInt32(this.offset + 4, true);
		target.cz = this.view.getInt32(this.offset + 8, true);
		target.lod = this.buffer[this.offset + 12];
		target.cachedVersion = this.view.getUint32(this.offset + 13, true);
		this.offset += entryBytes;
		return target;
	}
}

/**
 * Batch encoding for server → client broadcasts.
 * Per player: [index:u8][x:f32][y:f32][z:f32][yaw:u8][pitch:u8][anim:u8] — 16
 * bytes instead of a sessionId string (~16-24 bytes) plus 12+3.
 *
 * writePlayerStateBatch writes into a caller-owned (reused) encoder so the
 * fixed-rate server tick doesn't allocate a fresh buffer every cycle.
 */
export function writePlayerStateBatch(
	enc: BinaryEncoder,
	states: PlayerStateBatchEntry[],
	sequence: number,
): void {
	const count = Math.min(states.length, 255);
	// Reserve the whole batch once; the per-entry writes below then hit an
	// already-satisfied capacity (each ensure() is a no-op comparison).
	enc.reserve(1 + 1 + 2 + count * 16);

	enc.writeUint8(MessageType.PlayerStateBatch);
	enc.writeUint8(count);
	enc.writeUint16(sequence & 0xffff);

	for (let i = 0; i < count; i++) {
		const s = states[i];
		enc.writeUint8(s.index);
		enc.writeFloat32(s.x);
		enc.writeFloat32(s.y);
		enc.writeFloat32(s.z);
		enc.writeUint8(s.yaw);
		enc.writeUint8(s.pitch);
		enc.writeUint8(s.animation);
	}
}

/**
 * True when `incoming` is strictly newer than `previous`, treating both as
 * wrapping counters.
 *
 * A plain `>` comparison is wrong at the wrap point: with a 16-bit counter, a
 * late packet with sequence 5 arriving after 65534 must be recognised as OLDER
 * than it is not, so it gets rejected. The half-range rule is the standard
 * serial-number arithmetic (RFC 1982) and is unambiguous as long as fewer than
 * half the counter space can be in flight at once — trivially true for a
 * per-tick counter on a reliable transport.
 */
export function isSequenceNewer(incoming: number, previous: number): boolean {
	const a = incoming & 0xffff;
	const b = previous & 0xffff;
	return a !== b && ((a - b) & 0xffff) < 0x8000;
}

/**
 * Decoder-based batch-entry reader — reads from an already-positioned decoder
 * (type byte already consumed) instead of deriving a fresh one from the raw
 * buffer.
 *
 * @param out Receives the batch sequence when provided.
 */
export function decodePlayerStateBatchEntriesInto(
	dec: BinaryDecoder,
	target: PlayerStateBatchEntry[],
	out?: { sequence: number },
): number {
	const count = dec.readUint8();
	dec.require(2 + count * 16);
	const sequence = dec.readUint16();

	if (out !== undefined) out.sequence = sequence;

	for (let i = 0; i < count; i++) {
		let entry = target[i];
		if (!entry) {
			entry = { index: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, animation: 0 };
			target[i] = entry;
		}
		entry.index = dec.readUint8();
		entry.x = dec.readFloat32();
		entry.y = dec.readFloat32();
		entry.z = dec.readFloat32();
		entry.yaw = dec.readUint8();
		entry.pitch = dec.readUint8();
		entry.animation = dec.readUint8();
	}
	target.length = count;
	return count;
}

/**
 * Encode a batch of block edits — sent to new players on join
 * so they sync existing world changes.
 * Format: [type:1][count:2][editData...]
 */
export function encodeBlockEditBatch(edits: BlockEditData[]): Uint8Array {
	const count = Math.min(edits.length, 65535);
	const enc = new BinaryEncoder(3 + count * BLOCK_EDIT_ENTRY_BYTES);

	enc.writeUint8(MessageType.BlockEditBatch);
	enc.writeUint16(count);
	enc.reserve(count * BLOCK_EDIT_ENTRY_BYTES);

	for (let i = 0; i < count; i++) {
		const e = edits[i];
		enc.writeInt32(e.x);
		enc.writeInt32(e.y);
		enc.writeInt32(e.z);
		enc.writeUint16(e.blockId);
		enc.writeUint8(e.blockState);
		enc.writeUint8(e.action);
	}

	return enc.getBytes();
}

/**
 * Structure-of-arrays view over a decoded block edit batch.
 *
 * PERF: the alternative — one `BlockEditData` object per edit — allocates per
 * edit on a path that fires with up to 2048 edits at once (the join snapshot)
 * and again for every explosion crater. SoA keeps the decode allocation-free
 * and makes the consumer's inner loop read contiguous typed arrays.
 *
 * The arrays are OVER-ALLOCATED to `capacity` and never resized; only indices
 * `[0, count)` are meaningful. A batch of 2048 edits therefore allocates once
 * per NetClient, not once per batch.
 */
export interface BlockEditBatchView {
	/** Entries written by the most recent decode. */
	count: number;
	x: Int32Array;
	y: Int32Array;
	z: Int32Array;
	blockId: Uint16Array;
	blockState: Uint8Array;
	action: Uint8Array;
}

/**
 * Largest batch we will decode into a view.
 *
 * `BlockEditBatch.count` is a uint16 on the wire, so up to 65535 entries are
 * representable. The server caps a join snapshot at 2048, but a hostile or
 * corrupted server could still send more. Clamping bounds the allocation and
 * keeps a malformed packet from requesting a multi-megabyte view; the decoder
 * still CONSUMES every entry so the stream stays aligned.
 */
export const MAX_BLOCK_EDIT_BATCH = 4096;

export function createBlockEditBatchView(): BlockEditBatchView {
	return {
		count: 0,
		x: new Int32Array(MAX_BLOCK_EDIT_BATCH),
		y: new Int32Array(MAX_BLOCK_EDIT_BATCH),
		z: new Int32Array(MAX_BLOCK_EDIT_BATCH),
		blockId: new Uint16Array(MAX_BLOCK_EDIT_BATCH),
		blockState: new Uint8Array(MAX_BLOCK_EDIT_BATCH),
		action: new Uint8Array(MAX_BLOCK_EDIT_BATCH),
	};
}

/**
 * Decode a `BlockEditBatch` message body into `view`.
 *
 * @param dec Positioned decoder with the message type byte already consumed.
 * @returns The number of entries written, which is `min(count, MAX_BLOCK_EDIT_BATCH)`.
 */
export function decodeBlockEditBatchInto(
	dec: BinaryDecoder,
	view: BlockEditBatchView,
): number {
	const wireCount = dec.readUint16();
	// Validate the whole batch up front: the decoder consumes every entry to
	// keep the stream aligned, so an untrusted count must be checked once,
	// not discovered mid-loop.
	dec.require(wireCount * BLOCK_EDIT_ENTRY_BYTES);
	const accepted = Math.min(wireCount, MAX_BLOCK_EDIT_BATCH);

	for (let i = 0; i < wireCount; i++) {
		const x = dec.readInt32();
		const y = dec.readInt32();
		const z = dec.readInt32();
		const blockId = dec.readUint16();
		const blockState = dec.readUint8();
		const action = dec.readUint8();

		if (i < accepted) {
			view.x[i] = x;
			view.y[i] = y;
			view.z[i] = z;
			view.blockId[i] = blockId;
			view.blockState[i] = blockState;
			view.action[i] = action;
		}
	}

	view.count = accepted;
	return accepted;
}

/**
 * Player join — server → client.
 * [type:1][index:u8][sessionId:str][name:str]
 * The joiner receives its OWN join message (with its index) directly; other
 * clients receive it via broadcast.
 */
export function encodePlayerJoin(data: PlayerJoinData): Uint8Array {
	const enc = _singleEventEncoder;
	enc.reset();
	enc.writeUint8(MessageType.PlayerJoin);
	enc.writeUint8(data.index);
	enc.writeString(data.sessionId);
	enc.writeString(data.name);
	return enc.finish();
}

export function decodePlayerJoinInto(
	dec: BinaryDecoder,
	target: PlayerJoinData,
): typeof target {
	target.index = dec.readUint8();
	target.sessionId = dec.readString();
	target.name = dec.readString();
	return target;
}

/**
 * Player leave — server → client.
 * [type:1][index:u8] — the client resolves sessionId via its index map.
 */
export function encodePlayerLeave(data: PlayerLeaveData): Uint8Array {
	const enc = _singleEventEncoder;
	enc.reset();
	enc.writeUint8(MessageType.PlayerLeave);
	enc.writeUint8(data.index);
	return enc.finish();
}

export function encodeHeldItemSelect(data: HeldItemSelectionData): Uint8Array {
	const enc = new BinaryEncoder(4);
	enc.writeUint8(MessageType.HeldItemSelect);
	enc.writeUint16(data.itemId);
	enc.writeUint8(data.blockState);
	return enc.getBytes();
}

export function decodeHeldItemSelectInto(
	dec: BinaryDecoder,
	target: HeldItemSelectionData,
): typeof target {
	target.itemId = dec.readUint16();
	target.blockState = dec.readUint8();
	return target;
}

export function encodePlayerHeldItem(data: PlayerHeldItemData): Uint8Array {
	const enc = new BinaryEncoder(5);
	enc.writeUint8(MessageType.PlayerHeldItem);
	enc.writeUint8(data.index);
	enc.writeUint16(data.itemId);
	enc.writeUint8(data.blockState);
	return enc.getBytes();
}

export function decodePlayerHeldItemInto(
	dec: BinaryDecoder,
	target: PlayerHeldItemData,
): typeof target {
	target.index = dec.readUint8();
	decodeHeldItemSelectInto(dec, target);
	return target;
}

/**
 * C→S: upload this client's avatar skin.
 * [type:1][len:u16][png bytes]
 * Sent once after joining; the server validates and relays it to others.
 */
export function encodeSkinUpload(png: Uint8Array): Uint8Array {
	if (png.byteLength > MAX_UINT16) {
		throw new RangeError(
			`Skin payload is ${png.byteLength} bytes; the wire length field is uint16 (max ${MAX_UINT16})`,
		);
	}
	const enc = new BinaryEncoder(3 + png.byteLength);
	enc.writeUint8(MessageType.SkinUpload);
	enc.writeUint16(png.byteLength);
	enc.writeBytes(png);
	return enc.getBytes();
}

/**
 * S→C: another player's avatar skin, keyed by room index.
 * [type:1][index:u8][len:u16][png bytes]
 */
export function encodePlayerSkin(data: PlayerSkinData): Uint8Array {
	if (data.png.byteLength > MAX_UINT16) {
		throw new RangeError(
			`Skin payload is ${data.png.byteLength} bytes; the wire length field is uint16 (max ${MAX_UINT16})`,
		);
	}
	const enc = new BinaryEncoder(4 + data.png.byteLength);
	enc.writeUint8(MessageType.PlayerSkin);
	enc.writeUint8(data.index);
	enc.writeUint16(data.png.byteLength);
	enc.writeBytes(data.png);
	return enc.getBytes();
}

/**
 * S→C: broadcast of one player's block edit.
 * [type:1][sessionId:str][x:i32][y:i32][z:i32][blockId:u16][blockState:u8][action:u8]
 * Keeps the sessionId string — block edits are rare, so the overhead is fine.
 */
export function encodeBlockEditBroadcast(data: BlockEditData): Uint8Array {
	const enc = new BinaryEncoder(32);
	enc.writeUint8(MessageType.BlockEditBroadcast);
	enc.writeString(data.sessionId);
	enc.writeInt32(data.x);
	enc.writeInt32(data.y);
	enc.writeInt32(data.z);
	enc.writeUint16(data.blockId);
	enc.writeUint8(data.blockState);
	enc.writeUint8(data.action);
	return enc.getBytes();
}

export function decodeBlockEditBroadcastInto(
	dec: BinaryDecoder,
	target: BlockEditData,
): typeof target {
	target.sessionId = dec.readString();
	target.x = dec.readInt32();
	target.y = dec.readInt32();
	target.z = dec.readInt32();
	target.blockId = dec.readUint16();
	target.blockState = dec.readUint8();
	target.action = dec.readUint8();
	return target;
}

/**
 * S→C: the server rejected one of this client's block edits.
 * [type:1][x:i32][y:i32][z:i32][blockId:u16][blockState:u8][action:u8][reason:u8]
 * blockId/blockState echo the client's edit so a rejected Break can be restored.
 */
export function encodeBlockEditRejected(
	data: BlockEditRejectedData,
): Uint8Array {
	const enc = new BinaryEncoder(18);

	enc.writeUint8(MessageType.BlockEditRejected);
	enc.writeInt32(data.x);
	enc.writeInt32(data.y);
	enc.writeInt32(data.z);
	enc.writeUint16(data.blockId);
	enc.writeUint8(data.blockState);
	enc.writeUint8(data.action);
	enc.writeUint8(data.reason);

	return enc.getBytes();
}

export function decodeBlockEditRejectedInto(
	dec: BinaryDecoder,
	target: BlockEditRejectedData,
): typeof target {
	target.x = dec.readInt32();
	target.y = dec.readInt32();
	target.z = dec.readInt32();
	target.blockId = dec.readUint16();
	target.blockState = dec.readUint8();
	target.action = dec.readUint8();
	target.reason = dec.readUint8();
	return target;
}

export function encodeChatMessage(data: ChatMessageData): Uint8Array {
	const enc = new BinaryEncoder(256);
	enc.writeChatMessage(data);
	return enc.getBytes();
}

/**
 * World time sync — server → client.
 * timeOfDay: 0..1 fraction of day cycle (0=midnight, 0.5=noon).
 * Format: [type:1][timeOfDay:f32]
 */
export function encodeWorldTime(timeOfDay: number): Uint8Array {
	const enc = new BinaryEncoder(5);
	enc.writeUint8(MessageType.WorldTime);
	enc.writeFloat32(timeOfDay);
	return enc.getBytes();
}

/**
 * World config — server → client on join.
 * Carries the authoritative world seed so the client's clip map matches
 * the server's terrain generation, plus the day/night cycle settings so the
 * client sun interpolates at the server's rate.
 * Format: [type:1][seedLength:u16][seed...][dayDuration:f32][dayCycle:u8]
 */
export function encodeWorldConfig(
	seed: string,
	dayDurationMs: number,
	dayCycle: boolean,
): Uint8Array {
	const enc = new BinaryEncoder(512);
	enc.writeUint8(MessageType.WorldConfig);
	enc.writeString(seed);
	enc.writeFloat32(dayDurationMs);
	enc.writeUint8(dayCycle ? 1 : 0);
	return enc.getBytes();
}

export interface WorldConfigData {
	seed: string;
	dayDurationMs: number;
	dayCycle: boolean;
}

export function decodeWorldConfigInto(
	dec: BinaryDecoder,
	target: WorldConfigData,
): typeof target {
	target.seed = dec.readString();
	target.dayDurationMs = dec.readFloat32();
	target.dayCycle = dec.readUint8() !== 0;
	return target;
}

// ---------------------------------------------------------------------------
// Chunk data wire format — server → client (response to chunk request).
//
// Entry (shared by single and batch packets):
//   [cx:i32][cy:i32][cz:i32][version:u32][flags:u8][blockData...][lightData...]
//
// flags: bit0=isUniform, bit1=hasPalette, bit2=denseBlocksAreU16
//   isUniform:      next 2 bytes = uniformBlockId, no block data
//   hasPalette:     next 2 bytes = paletteLength (1..16, four-bit indices),
//                   then paletteLength*2 palette bytes, then
//                   CHUNK_PACKED_NIBBLE_BYTES of packed block indices
//   dense u16:      CHUNK_VOLUME*2 bytes of little-endian uint16 block values
//   dense u8:       CHUNK_VOLUME bytes
// lightData always follows blockData: [lightLength:u32][light bytes]
//
// Single: [type:1] + entry
// Batch:  [type:1][count:u16] + entry × count
// ---------------------------------------------------------------------------

const CHUNK_FLAG_UNIFORM = 1 << 0;
const CHUNK_FLAG_PALETTE = 1 << 1;
const CHUNK_FLAG_DENSE_U16 = 1 << 2;
/** Every bit the wire format defines; unknown bits are rejected on decode. */
const CHUNK_KNOWN_FLAGS =
	CHUNK_FLAG_UNIFORM | CHUNK_FLAG_PALETTE | CHUNK_FLAG_DENSE_U16;

/** Four-bit nibble packing caps a palette at 16 entries. */
const MAX_CHUNK_PALETTE_ENTRIES = 16;
/** Fixed light payload size for a 32^3 chunk. */
const MAX_CHUNK_LIGHT_BYTES = CHUNK_VOLUME;

/** Nibble-packed block payload size: two four-bit indices per byte. */
const CHUNK_PACKED_NIBBLE_BYTES = (CHUNK_VOLUME + 1) >>> 1;

export interface ChunkWireData {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	blocks: Uint8Array | Uint16Array;
	light: Uint8Array;
	palette?: readonly number[];
	isUniform: boolean;
	uniformBlockId: number;
	version: number;
}

/**
 * Validates a chunk against the fixed wire sizes BEFORE any allocation or
 * offset advancement, so a corrupt or hostile chunk cannot drive a
 * mismatched payload through the encoder. Stored chunks always satisfy these
 * (dense 32^3, 16384-byte nibble payloads, palettes of at most 16, light of
 * at most 32768 bytes) — this only rejects malformed input.
 */
function validateChunkForEncoding(chunk: ChunkWireData): void {
	if (chunk.light.byteLength > MAX_CHUNK_LIGHT_BYTES) {
		throw new RangeError(
			`Chunk light payload exceeds ${MAX_CHUNK_LIGHT_BYTES} bytes`,
		);
	}

	if (chunk.isUniform) return;

	if (chunk.palette !== undefined) {
		const palette = chunk.palette;
		if (palette.length < 1 || palette.length > MAX_CHUNK_PALETTE_ENTRIES) {
			throw new RangeError(
				`Chunk palette must hold 1..${MAX_CHUNK_PALETTE_ENTRIES} entries, got ${palette.length}`,
			);
		}

		if (!(chunk.blocks instanceof Uint8Array)) {
			throw new TypeError(
				"Palette-compressed chunk blocks must be a Uint8Array",
			);
		}

		if (chunk.blocks.byteLength !== CHUNK_PACKED_NIBBLE_BYTES) {
			throw new RangeError(
				`Palette block payload must be ${CHUNK_PACKED_NIBBLE_BYTES} bytes`,
			);
		}

		return;
	}

	if (chunk.blocks.length !== CHUNK_VOLUME) {
		throw new RangeError(
			`Dense chunk block array must contain ${CHUNK_VOLUME} entries`,
		);
	}
}

/** Exact on-wire size of one chunk entry (no type byte). */
function measureChunkEntry(chunk: ChunkWireData): number {
	validateChunkForEncoding(chunk);

	let size = 12 + 4 + 1; // coords + version + flags

	if (chunk.isUniform) {
		size += 2;
	} else if (chunk.palette !== undefined) {
		size += 2;
		size += chunk.palette.length * 2;
		size += chunk.blocks.byteLength;
	} else {
		size += chunk.blocks.byteLength;
	}

	size += 4 + chunk.light.byteLength; // lightLength + light

	return size;
}

function writeChunkEntry(encoder: BinaryEncoder, chunk: ChunkWireData): void {
	let flags = 0;

	if (chunk.isUniform) {
		flags |= CHUNK_FLAG_UNIFORM;
	} else if (chunk.palette !== undefined) {
		flags |= CHUNK_FLAG_PALETTE;
	} else if (chunk.blocks instanceof Uint16Array) {
		flags |= CHUNK_FLAG_DENSE_U16;
	}

	encoder.writeCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
	encoder.writeUint32(chunk.version);
	encoder.writeUint8(flags);

	if (chunk.isUniform) {
		encoder.writeUint16(chunk.uniformBlockId);
	} else if (chunk.palette !== undefined) {
		const palette = chunk.palette;
		encoder.writeUint16(palette.length);

		for (let i = 0; i < palette.length; i++) {
			encoder.writeUint16(palette[i]);
		}

		encoder.writeBytes(chunk.blocks as Uint8Array);
	} else {
		encoder.writeArrayBufferView(chunk.blocks);
	}

	encoder.writeUint32(chunk.light.byteLength);
	encoder.writeBytes(chunk.light);
}

/**
 * Chunk data — server → client (response to chunk request).
 * Contains compressed voxel data for meshing on the client.
 */
export function encodeChunkData(chunk: ChunkWireData): Uint8Array {
	const size = 1 + measureChunkEntry(chunk);
	const encoder = new BinaryEncoder(size);

	encoder.writeUint8(MessageType.ChunkData);
	writeChunkEntry(encoder, chunk);

	return encoder.getBytes();
}

/**
 * Chunk data batch — server → client, multiple chunks in one message.
 * Supports the same block encodings as encodeChunkData, including dense
 * Uint16Array payloads (the previous batch encoder silently dropped the
 * denseBlocksAreU16 flag, corrupting u16 batches on the wire).
 */
export function encodeChunkDataBatch(
	chunks: readonly ChunkWireData[],
): Uint8Array {
	const count = Math.min(chunks.length, MAX_UINT16);

	let totalSize = 1 + 2;
	for (let i = 0; i < count; i++) {
		totalSize += measureChunkEntry(chunks[i]);

		if (!Number.isSafeInteger(totalSize)) {
			throw new RangeError("Chunk batch size exceeds safe integer range");
		}
	}

	const encoder = new BinaryEncoder(totalSize);
	encoder.writeUint8(MessageType.ChunkDataBatch);
	encoder.writeUint16(count);

	for (let i = 0; i < count; i++) {
		writeChunkEntry(encoder, chunks[i]);
	}

	return encoder.getBytes();
}

function decodeChunkDataEntry(
	dec: BinaryDecoder,
	allocSAB: boolean,
): RemoteChunkData {
	const chunkX = dec.readInt32();
	const chunkY = dec.readInt32();
	const chunkZ = dec.readInt32();
	const version = dec.readUint32();
	const flags = dec.readUint8();
	const isUniform = (flags & CHUNK_FLAG_UNIFORM) !== 0;
	const hasPalette = (flags & CHUNK_FLAG_PALETTE) !== 0;
	const denseU16 = (flags & CHUNK_FLAG_DENSE_U16) !== 0;

	if ((flags & ~CHUNK_KNOWN_FLAGS) !== 0) {
		throw new RangeError(`Unknown chunk flags: 0x${flags.toString(16)}`);
	}

	if (isUniform && (hasPalette || denseU16)) {
		throw new RangeError("Invalid uniform chunk flags");
	}
	if (hasPalette && denseU16) {
		throw new RangeError("Chunk cannot be palette and dense-u16 encoded");
	}

	let uniformBlockId = 0;
	let palette: Uint16Array | undefined;
	let blocks: Uint8Array | Uint16Array;

	if (isUniform) {
		uniformBlockId = dec.readUint16();
		blocks = new Uint8Array(0);
	} else if (hasPalette) {
		const paletteLen = dec.readUint16();

		// Four-bit indices cannot address more than 16 palette entries.
		if (paletteLen < 1 || paletteLen > MAX_CHUNK_PALETTE_ENTRIES) {
			throw new RangeError(`Invalid nibble palette length: ${paletteLen}`);
		}

		const paletteBytes = allocSAB
			? dec.readBytesViewSAB(paletteLen * 2)
			: dec.readBytes(paletteLen * 2);

		palette = new Uint16Array(
			paletteBytes.buffer,
			paletteBytes.byteOffset,
			paletteLen,
		);

		blocks = allocSAB
			? dec.readBytesViewSAB(CHUNK_PACKED_NIBBLE_BYTES)
			: dec.readBytesView(CHUNK_PACKED_NIBBLE_BYTES);
	} else if (denseU16) {
		const byteLen = CHUNK_VOLUME * 2;
		const raw = allocSAB
			? dec.readBytesViewSAB(byteLen)
			: dec.readBytesView(byteLen);

		if ((raw.byteOffset & 1) !== 0) {
			// Uint16Array requires two-byte alignment. The SAB path and any
			// packet whose view is already even-aligned skip this copy.
			const aligned = allocSAB
				? new Uint8Array(new SharedArrayBuffer(byteLen))
				: new Uint8Array(byteLen);
			aligned.set(raw);
			blocks = new Uint16Array(
				aligned.buffer,
				aligned.byteOffset,
				CHUNK_VOLUME,
			);
		} else {
			blocks = new Uint16Array(raw.buffer, raw.byteOffset, CHUNK_VOLUME);
		}
	} else {
		blocks = allocSAB
			? dec.readBytesViewSAB(CHUNK_VOLUME)
			: dec.readBytesView(CHUNK_VOLUME);
	}

	const lightLen = dec.readUint32();

	if (lightLen > MAX_CHUNK_LIGHT_BYTES) {
		throw new RangeError(`Invalid chunk light length: ${lightLen}`);
	}

	const light = allocSAB
		? dec.readBytesViewSAB(lightLen, MAX_CHUNK_LIGHT_BYTES)
		: dec.readBytesView(lightLen);

	return {
		kind: ChunkResultKind.Data,
		chunkX,
		chunkY,
		chunkZ,
		blocks,
		light,
		palette,
		isUniform,
		uniformBlockId,
		version,
	};
}

export function decodeChunkData(
	buffer: Uint8Array,
	allocSAB = false,
): RemoteChunkData {
	if (buffer.byteLength === 0 || buffer[0] !== MessageType.ChunkData) {
		throw new Error("Expected ChunkData packet");
	}

	const dec = new BinaryDecoder(buffer, 1);
	const result = decodeChunkDataEntry(dec, allocSAB);

	if (dec.remaining !== 0) {
		throw new Error(`ChunkData packet has ${dec.remaining} trailing bytes`);
	}

	return result;
}

export function decodeChunkDataBatch(
	buffer: Uint8Array,
	allocSAB = false,
): Array<RemoteChunkData> {
	if (buffer.byteLength === 0 || buffer[0] !== MessageType.ChunkDataBatch) {
		throw new Error("Expected ChunkDataBatch packet");
	}

	const dec = new BinaryDecoder(buffer, 1);
	const count = dec.readUint16();
	const chunks = new Array<RemoteChunkData>(count);

	for (let i = 0; i < count; i++) {
		chunks[i] = decodeChunkDataEntry(dec, allocSAB);
	}

	if (dec.remaining !== 0) {
		throw new Error(
			`ChunkDataBatch packet has ${dec.remaining} trailing bytes`,
		);
	}

	return chunks;
}

/**
 * Chunk unchanged — server → client (chunk hasn't changed since client's cached version).
 * Format: [type:1][chunkX:i32][chunkY:i32][chunkZ:i32][version:u32]
 */
export function encodeChunkUnchanged(
	cx: number,
	cy: number,
	cz: number,
	version: number,
): Uint8Array {
	const enc = new BinaryEncoder(17);
	enc.writeUint8(MessageType.ChunkUnchanged);
	enc.writeInt32(cx);
	enc.writeInt32(cy);
	enc.writeInt32(cz);
	enc.writeUint32(version);
	return enc.getBytes();
}

export function decodeChunkUnchangedInto(
	dec: BinaryDecoder,
	target: { cx: number; cy: number; cz: number; version: number },
): typeof target {
	dec.require(16);
	target.cx = dec.readInt32();
	target.cy = dec.readInt32();
	target.cz = dec.readInt32();
	target.version = dec.readUint32();
	return target;
}

/**
 * Decode chunk unchanged batch into a reusable pre-allocated array.
 * Avoids per-entry object allocation on the hot path.
 */
export function decodeChunkUnchangedBatchInto(
	dec: BinaryDecoder,
	target: Array<{ cx: number; cy: number; cz: number; version: number }>,
): number {
	const count = dec.readUint16();
	dec.require(count * 16);
	for (let i = 0; i < count; i++) {
		let entry = target[i];
		if (!entry) {
			entry = { cx: 0, cy: 0, cz: 0, version: 0 };
			target[i] = entry;
		}
		entry.cx = dec.readInt32();
		entry.cy = dec.readInt32();
		entry.cz = dec.readInt32();
		entry.version = dec.readUint32();
	}
	target.length = count;
	return count;
}

// ---------------------------------------------------------------------------
// Chunk request batch — client → server, multiple coords in one message
// Format: [type:1][count:u16][cx:i32][cy:i32][cz:i32][lod:u8][cachedVersion:u32] × count
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deflated chunk blobs — server → client.
//
// The server serializes each chunk once (serializeVoxelData output) and
// deflates it with zlib deflate; the client inflates it into an exact-size
// buffer (origLen) and persists the (now-decompressed) serialized blob
// directly, skipping the decode→reserialize round trip of the legacy
// ChunkData/ChunkDataBatch messages.
//
// Single:   [type:1][cx:i32][cy:i32][cz:i32][version:u32][len:u32][origLen:u32][deflated]
// Batch:    [type:1][count:u16][(cx:i32)(cy:i32)(cz:i32)(version:u32)(len:u32)(origLen:u32)(deflated)] × count
// ---------------------------------------------------------------------------

export interface DeflatedChunk {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	version: number;
	/** Uncompressed length of the serialized storage blob. */
	origLen: number;
	/** Zlib-deflate of the serialized storage blob. */
	deflated: Uint8Array;
}

/**
 * Largest serialized storage blob a 32^3 chunk can produce: header (7) +
 * dense-u16 blocks (4 + 65536) + full palette (4 + 32) + full light
 * (4 + 32768) ≈ 98 KB. `origLen` is an untrusted uint32 on the wire, so cap
 * it well above the real maximum to stop a corrupt/hostile length from
 * driving a multi-gigabyte inflate allocation.
 */
const MAX_DEFLATED_CHUNK_ORIG_LEN = 1024 * 1024;

/** Encode one deflated chunk message (async: deflation streams off-thread). */
export async function encodeChunkDataDeflated(data: {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	version: number;
	blob: Uint8Array;
}): Promise<Uint8Array> {
	const deflated = await deflate(data.blob);
	return encodeChunkDataDeflatedPayload({
		chunkX: data.chunkX,
		chunkY: data.chunkY,
		chunkZ: data.chunkZ,
		version: data.version,
		origLen: data.blob.byteLength,
		deflated,
	});
}

/**
 * Encode one deflated chunk message from an already-deflated payload (the
 * deflate step is skipped entirely — callers with a wire cache reuse it).
 */
export function encodeChunkDataDeflatedPayload(
	data: DeflatedChunk,
): Uint8Array {
	const enc = new BinaryEncoder(1 + 12 + 4 + 4 + 4 + data.deflated.byteLength);
	enc.writeUint8(MessageType.ChunkDataDeflated);
	enc.writeInt32(data.chunkX);
	enc.writeInt32(data.chunkY);
	enc.writeInt32(data.chunkZ);
	enc.writeUint32(data.version);
	enc.writeUint32(data.deflated.byteLength);
	enc.writeUint32(data.origLen);
	enc.writeBytes(data.deflated);
	return enc.getBytes();
}

export function decodeChunkDataDeflatedFrom(dec: BinaryDecoder): DeflatedChunk {
	dec.require(12 + 4 + 4 + 4);
	const chunkX = dec.readInt32();
	const chunkY = dec.readInt32();
	const chunkZ = dec.readInt32();
	const version = dec.readUint32();
	const len = dec.readUint32();
	const origLen = dec.readUint32();
	if (origLen > MAX_DEFLATED_CHUNK_ORIG_LEN) {
		throw new RangeError(`deflated chunk origLen exceeds cap: ${origLen}`);
	}
	return {
		chunkX,
		chunkY,
		chunkZ,
		version,
		origLen,
		deflated: dec.readBytes(len),
	};
}

/**
 * Zero-copy variant for deflated chunk decoding.
 *
 * `deflated` is a view into the packet buffer. Each transport message arrives
 * in its own ArrayBuffer and the view pins it, so the data stays valid for
 * the lifetime of the view even after the shared decoder is rebound to the
 * next packet. Use this when the payload is consumed (inflated) and never
 * retained; the normal decoder copies the payload for safe retention.
 */
export function decodeChunkDataDeflatedViewFrom(
	dec: BinaryDecoder,
): DeflatedChunk {
	dec.require(12 + 4 + 4 + 4);
	const chunkX = dec.readInt32();
	const chunkY = dec.readInt32();
	const chunkZ = dec.readInt32();
	const version = dec.readUint32();
	const len = dec.readUint32();
	const origLen = dec.readUint32();
	if (origLen > MAX_DEFLATED_CHUNK_ORIG_LEN) {
		throw new RangeError(`deflated chunk origLen exceeds cap: ${origLen}`);
	}
	return {
		chunkX,
		chunkY,
		chunkZ,
		version,
		origLen,
		deflated: dec.readBytesView(len),
	};
}

/** Decode a batch of deflated chunks. */
export function decodeChunkDataDeflatedBatchFrom(
	dec: BinaryDecoder,
): DeflatedChunk[] {
	const count = dec.readUint16();
	const chunks = new Array<DeflatedChunk>(count);

	for (let i = 0; i < count; i++) {
		chunks[i] = decodeChunkDataDeflatedFrom(dec);
	}

	return chunks;
}

/**
 * Iterator-style batch decode for immediate inflate-and-consume processing.
 *
 * Avoids the intermediate DeflatedChunk object graph entirely: each payload
 * is handed straight to `consume` as a zero-copy view. As with
 * decodeChunkDataDeflatedViewFrom, the view pins the packet's ArrayBuffer, so
 * the callback may defer consumption across awaits — but the packet must not
 * be mutated by the transport.
 *
 * @returns The number of entries consumed.
 */
export function decodeChunkDataDeflatedBatchEach(
	dec: BinaryDecoder,
	consume: (
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		version: number,
		origLen: number,
		deflated: Uint8Array,
	) => void,
): number {
	const count = dec.readUint16();

	for (let i = 0; i < count; i++) {
		dec.require(12 + 4 + 4 + 4);
		const chunkX = dec.readInt32();
		const chunkY = dec.readInt32();
		const chunkZ = dec.readInt32();
		const version = dec.readUint32();
		const len = dec.readUint32();
		const origLen = dec.readUint32();
		if (origLen > MAX_DEFLATED_CHUNK_ORIG_LEN) {
			throw new RangeError(`deflated chunk origLen exceeds cap: ${origLen}`);
		}
		const deflated = dec.readBytesView(len);

		consume(chunkX, chunkY, chunkZ, version, origLen, deflated);
	}

	return count;
}

// ---------------------------------------------------------------------------
// Yaw/pitch byte helpers. The periodic wire format carries rotations as
// 0-255 bytes (yaw: 0-255 maps 0°..360°; pitch: 0-255 maps -90°..+90°).
// Float fields (e.g. SpawnPosition) carry the decoded DEGREE values.
// ---------------------------------------------------------------------------

export function encodeYawByte(yaw: number): number {
	const normalized = ((yaw % 360) + 360) % 360;
	return Math.round((normalized / 360) * 255) & 0xff;
}

export function encodePitchByte(pitch: number): number {
	const clamped = pitch < -90 ? -90 : pitch > 90 ? 90 : pitch;
	return Math.round(((clamped + 90) / 180) * 255) & 0xff;
}

export function decodeYawByte(byte: number): number {
	return (byte / 255) * 360;
}

export function decodePitchByte(byte: number): number {
	return (byte / 255) * 180 - 90;
}

// ---------------------------------------------------------------------------
// Spawn position — server → client on join
// Format: [type:1][x:f32][y:f32][z:f32][yaw:f32][pitch:f32]
// ---------------------------------------------------------------------------

export function encodeSpawnPosition(
	x: number,
	y: number,
	z: number,
	yaw: number,
	pitch: number,
): Uint8Array {
	const enc = new BinaryEncoder(21);
	enc.writeUint8(MessageType.SpawnPosition);
	enc.writeFloat32(x);
	enc.writeFloat32(y);
	enc.writeFloat32(z);
	enc.writeFloat32(yaw);
	enc.writeFloat32(pitch);
	return enc.getBytes();
}

export function decodeSpawnPositionInto(
	dec: BinaryDecoder,
	target: { x: number; y: number; z: number; yaw: number; pitch: number },
): typeof target {
	target.x = dec.readFloat32();
	target.y = dec.readFloat32();
	target.z = dec.readFloat32();
	target.yaw = dec.readFloat32();
	target.pitch = dec.readFloat32();
	return target;
}

// ---------------------------------------------------------------------------
// Server-authoritative mobs
// MobSpawn:    [type:1][mobId:u16][mobType:u8][x:f32][y:f32][z:f32][yaw:u8]
// MobUpdateBatch: [type:1][count:u8][mobId:u16][x:f32][y:f32][z:f32][yaw:u8] × count
// MobDespawn:  [type:1][mobId:u16]
// ---------------------------------------------------------------------------

export function encodeMobSpawn(
	mobId: number,
	mobType: number,
	x: number,
	y: number,
	z: number,
	yaw: number,
): Uint8Array {
	const enc = _singleEventEncoder;
	enc.reset();

	enc.writeUint8(MessageType.MobSpawn);
	enc.writeUint16(mobId);
	enc.writeUint8(mobType);
	enc.writeFloat32(x);
	enc.writeFloat32(y);
	enc.writeFloat32(z);
	enc.writeUint8(yaw);

	return enc.finish();
}

export function decodeMobSpawnInto(
	dec: BinaryDecoder,
	target: {
		mobId: number;
		mobType: number;
		x: number;
		y: number;
		z: number;
		yaw: number;
	},
): typeof target {
	target.mobId = dec.readUint16();
	target.mobType = dec.readUint8();
	target.x = dec.readFloat32();
	target.y = dec.readFloat32();
	target.z = dec.readFloat32();
	target.yaw = dec.readUint8();
	return target;
}

/**
 * Batch encoding for server → client mob state broadcasts — same pattern as
 * writePlayerStateBatch (count:u8, then 1+4+4+4+1 bytes per mob). Writes
 * into a caller-owned (reused) encoder so the broadcast tick doesn't
 * allocate a fresh buffer every cycle.
 */
export function writeMobUpdateBatch(
	enc: BinaryEncoder,
	entries: MobUpdateBatchEntry[],
): void {
	const count = Math.min(entries.length, 255);
	// 1 + 1 + count × (2 + 4×3 + 1)
	enc.reserve(1 + 1 + count * 14);

	enc.writeUint8(MessageType.MobUpdateBatch);
	enc.writeUint8(count);

	for (let i = 0; i < count; i++) {
		const e = entries[i];
		enc.writeUint16(e.mobId);
		enc.writeFloat32(e.x);
		enc.writeFloat32(e.y);
		enc.writeFloat32(e.z);
		enc.writeUint8(e.yaw);
	}
}

export function encodeMobDespawn(mobId: number): Uint8Array {
	const enc = _singleEventEncoder;
	enc.reset();
	enc.writeUint8(MessageType.MobDespawn);
	enc.writeUint16(mobId);
	return enc.finish();
}

export function decodeMobDespawn(buffer: Uint8Array): number {
	const dec = new BinaryDecoder(buffer, 1);
	return dec.readUint16();
}

// MobSpawnRequest (C→S): [type:1][typeId:u8][x:f32][y:f32][z:f32]

export function encodeMobSpawnRequest(data: MobSpawnRequestData): Uint8Array {
	const enc = new BinaryEncoder(1 + 1 + 4 * 3);
	enc.writeUint8(MessageType.MobSpawnRequest);
	enc.writeUint8(data.typeId);
	enc.writeFloat32(data.x);
	enc.writeFloat32(data.y);
	enc.writeFloat32(data.z);
	return enc.getBytes();
}

export function decodeMobSpawnRequestInto(
	dec: BinaryDecoder,
	target: MobSpawnRequestData,
): typeof target {
	target.typeId = dec.readUint8();
	target.x = dec.readFloat32();
	target.y = dec.readFloat32();
	target.z = dec.readFloat32();
	return target;
}

// MobDamage (C↔S): [type:1][mobId:u16][damage:f32]  (fractional, e.g. 0.4)

export function encodeMobDamage(data: MobDamageData): Uint8Array {
	const enc = new BinaryEncoder(1 + 2 + 4);
	enc.writeUint8(MessageType.MobDamage);
	enc.writeUint16(data.mobId);
	enc.writeFloat32(data.damage);
	return enc.getBytes();
}

export function decodeMobDamageInto(
	dec: BinaryDecoder,
	target: MobDamageData,
): typeof target {
	target.mobId = dec.readUint16();
	target.damage = dec.readFloat32();
	return target;
}

// MobImpact (S→C): [type:1][mobId:u16][x:f32][y:f32][z:f32][fallDistance:f32]

export function encodeMobImpact(data: MobImpactData): Uint8Array {
	const enc = new BinaryEncoder(1 + 2 + 4 * 4);
	enc.writeUint8(MessageType.MobImpact);
	enc.writeUint16(data.mobId);
	enc.writeFloat32(data.x);
	enc.writeFloat32(data.y);
	enc.writeFloat32(data.z);
	enc.writeFloat32(data.fallDistance);
	return enc.getBytes();
}

export function decodeMobImpactInto(
	dec: BinaryDecoder,
	target: MobImpactData,
): typeof target {
	target.mobId = dec.readUint16();
	target.x = dec.readFloat32();
	target.y = dec.readFloat32();
	target.z = dec.readFloat32();
	target.fallDistance = dec.readFloat32();
	return target;
}

// ArrowShoot (C→S) / ArrowSpawn (S→C):
//   [type:1][x:f32][y:f32][z:f32][vx:f32][vy:f32][vz:f32][arrowType:u8]

export function encodeArrowShoot(data: ArrowTrajectoryData): Uint8Array {
	return encodeArrowTrajectory(MessageType.ArrowShoot, data);
}

export function decodeArrowShootInto(
	dec: BinaryDecoder,
	target: ArrowTrajectoryData,
): typeof target {
	return decodeArrowTrajectoryInto(dec, target);
}

export function encodeArrowSpawn(data: ArrowTrajectoryData): Uint8Array {
	return encodeArrowTrajectory(MessageType.ArrowSpawn, data);
}

export function decodeArrowSpawnInto(
	dec: BinaryDecoder,
	target: ArrowTrajectoryData,
): typeof target {
	return decodeArrowTrajectoryInto(dec, target);
}

function encodeArrowTrajectory(
	type: number,
	data: ArrowTrajectoryData,
): Uint8Array {
	const enc = new BinaryEncoder(1 + 4 * 6 + 1);
	enc.writeUint8(type);
	enc.writeFloat32(data.x);
	enc.writeFloat32(data.y);
	enc.writeFloat32(data.z);
	enc.writeFloat32(data.vx);
	enc.writeFloat32(data.vy);
	enc.writeFloat32(data.vz);
	enc.writeUint8(data.arrowType);
	return enc.getBytes();
}

export function decodeArrowTrajectoryInto(
	dec: BinaryDecoder,
	target: ArrowTrajectoryData,
): typeof target {
	target.x = dec.readFloat32();
	target.y = dec.readFloat32();
	target.z = dec.readFloat32();
	target.vx = dec.readFloat32();
	target.vy = dec.readFloat32();
	target.vz = dec.readFloat32();
	target.arrowType = dec.readUint8();
	return target;
}

// Explosion (C→S): [type:1][x:f32][y:f32][z:f32][radius:f32]

export function encodeExplosion(data: ExplosionData): Uint8Array {
	const enc = new BinaryEncoder(1 + 4 * 4);
	enc.writeUint8(MessageType.Explosion);
	enc.writeFloat32(data.x);
	enc.writeFloat32(data.y);
	enc.writeFloat32(data.z);
	enc.writeFloat32(data.radius);
	return enc.getBytes();
}

export function decodeExplosionInto(
	dec: BinaryDecoder,
	target: ExplosionData,
): typeof target {
	target.x = dec.readFloat32();
	target.y = dec.readFloat32();
	target.z = dec.readFloat32();
	target.radius = dec.readFloat32();
	return target;
}

// ExplosionBroadcast (S->C): [type:1][eventId:u32][seed:u32][x:f32][y:f32][z:f32][radius:f32]
//
// The event id and seed are what make an explosion ONE idempotent operation
// rather than a bag of independent messages: the id suppresses redelivery, and
// the seed lets every client derive the same particles locally instead of each
// arriving at a different visual via its own BlockEditBatch.

export function encodeExplosionBroadcast(data: ExplosionData): Uint8Array {
	const enc = new BinaryEncoder(EXPLOSION_BROADCAST_BYTES);

	enc.writeUint8(MessageType.ExplosionBroadcast);
	enc.writeUint32(data.eventId ?? 0);
	enc.writeUint32(data.seed ?? 0);
	enc.writeFloat32(data.x);
	enc.writeFloat32(data.y);
	enc.writeFloat32(data.z);
	enc.writeFloat32(data.radius);

	return enc.getBytes();
}

export function decodeExplosionBroadcastInto(
	dec: BinaryDecoder,
	target: ExplosionData,
): typeof target {
	target.eventId = dec.readUint32();
	target.seed = dec.readUint32();
	target.x = dec.readFloat32();
	target.y = dec.readFloat32();
	target.z = dec.readFloat32();
	target.radius = dec.readFloat32();
	return target;
}

// TntIgnite (C→S and S→C): [type:1][x:f32][y:f32][z:f32][fuse:f32][radius:f32]

export function encodeTntIgnite(data: TntIgniteData): Uint8Array {
	const enc = new BinaryEncoder(1 + 4 * 5);
	enc.writeUint8(MessageType.TntIgnite);
	enc.writeFloat32(data.x);
	enc.writeFloat32(data.y);
	enc.writeFloat32(data.z);
	enc.writeFloat32(data.fuse);
	enc.writeFloat32(data.radius);
	return enc.getBytes();
}

export function decodeTntIgniteInto(
	dec: BinaryDecoder,
	target: TntIgniteData,
): typeof target {
	target.x = dec.readFloat32();
	target.y = dec.readFloat32();
	target.z = dec.readFloat32();
	target.fuse = dec.readFloat32();
	target.radius = dec.readFloat32();
	return target;
}

// ---------------------------------------------------------------------------
// Server-authoritative dropped items
// ItemDrop (C→S):       [type:1][itemId:u16][stackSize:u16][x:f32][y:f32][z:f32][vx:f32][vy:f32][vz:f32]
// ItemPickup (C→S):     [type:1][itemId:u32]  (server-assigned instance id)
// ItemSpawn (S→C):      [type:1][id:u32][itemId:u16][stackSize:u16][x:f32][y:f32][z:f32][vx:f32][vy:f32][vz:f32]
// ItemUpdateBatch (S→C):[type:1][count:u8][id:u32][x:f32][y:f32][z:f32][vx:f32][vy:f32][vz:f32] × count
// ItemDespawn (S→C):    [type:1][id:u32]
// ItemPickupRejected (S→C): [type:1][id:u32][reason:u8]
// ---------------------------------------------------------------------------

export function encodeItemDrop(data: ItemDropData): Uint8Array {
	const enc = new BinaryEncoder(1 + 2 + 2 + 4 * 6);
	enc.writeUint8(MessageType.ItemDrop);
	enc.writeUint16(data.itemId);
	enc.writeUint16(data.stackSize);
	enc.writeFloat32(data.x);
	enc.writeFloat32(data.y);
	enc.writeFloat32(data.z);
	enc.writeFloat32(data.vx);
	enc.writeFloat32(data.vy);
	enc.writeFloat32(data.vz);
	return enc.getBytes();
}

export function decodeItemDropInto(
	dec: BinaryDecoder,
	target: ItemDropData,
): typeof target {
	target.itemId = dec.readUint16();
	target.stackSize = dec.readUint16();
	target.x = dec.readFloat32();
	target.y = dec.readFloat32();
	target.z = dec.readFloat32();
	target.vx = dec.readFloat32();
	target.vy = dec.readFloat32();
	target.vz = dec.readFloat32();
	return target;
}

export function encodeItemPickup(data: ItemPickupData): Uint8Array {
	const enc = new BinaryEncoder(5);
	enc.writeUint8(MessageType.ItemPickup);
	enc.writeUint32(data.itemId);
	return enc.getBytes();
}

export function decodeItemPickupInto(
	dec: BinaryDecoder,
	target: ItemPickupData,
): typeof target {
	target.itemId = dec.readUint32();
	return target;
}

export function encodeItemSpawn(data: ItemSpawnData): Uint8Array {
	const enc = _singleEventEncoder;
	enc.reset();
	enc.writeUint8(MessageType.ItemSpawn);
	enc.writeUint32(data.id);
	enc.writeUint16(data.itemId);
	enc.writeUint16(data.stackSize);
	enc.writeFloat32(data.x);
	enc.writeFloat32(data.y);
	enc.writeFloat32(data.z);
	enc.writeFloat32(data.vx);
	enc.writeFloat32(data.vy);
	enc.writeFloat32(data.vz);
	return enc.finish();
}

export function decodeItemSpawnInto(
	dec: BinaryDecoder,
	target: ItemSpawnData,
): typeof target {
	target.id = dec.readUint32();
	target.itemId = dec.readUint16();
	target.stackSize = dec.readUint16();
	target.x = dec.readFloat32();
	target.y = dec.readFloat32();
	target.z = dec.readFloat32();
	target.vx = dec.readFloat32();
	target.vy = dec.readFloat32();
	target.vz = dec.readFloat32();
	return target;
}

/** Batch encoding for server → client item position broadcasts (pooled). */
export function writeItemUpdateBatch(
	enc: BinaryEncoder,
	entries: ItemUpdateBatchEntry[],
): void {
	const count = Math.min(entries.length, 255);
	// 1 + 1 + count × (4 + 4×6)
	enc.reserve(1 + 1 + count * 28);
	enc.writeUint8(MessageType.ItemUpdateBatch);
	enc.writeUint8(count);
	for (let i = 0; i < count; i++) {
		const e = entries[i];
		enc.writeUint32(e.id);
		enc.writeFloat32(e.x);
		enc.writeFloat32(e.y);
		enc.writeFloat32(e.z);
		enc.writeFloat32(e.vx);
		enc.writeFloat32(e.vy);
		enc.writeFloat32(e.vz);
	}
}

export function encodeItemDespawn(id: number): Uint8Array {
	const enc = _singleEventEncoder;
	enc.reset();
	enc.writeUint8(MessageType.ItemDespawn);
	enc.writeUint32(id);
	return enc.finish();
}

export function decodeItemDespawn(buffer: Uint8Array): number {
	const dec = new BinaryDecoder(buffer, 1);
	return dec.readUint32();
}

export function encodeItemPickupRejected(
	data: ItemPickupRejectedData,
): Uint8Array {
	const enc = _singleEventEncoder;
	enc.reset();
	enc.writeUint8(MessageType.ItemPickupRejected);
	enc.writeUint32(data.id);
	enc.writeUint8(data.reason);
	return enc.finish();
}

export function decodeItemPickupRejectedInto(
	dec: BinaryDecoder,
	target: ItemPickupRejectedData,
): typeof target {
	target.id = dec.readUint32();
	target.reason = dec.readUint8();
	return target;
}

// ---------------------------------------------------------------------------
// Server-authoritative block containers (Wood Crate)
// ContainerOpen (C→S):        [type:1][x:i32][y:i32][z:i32]
// ContainerState (S→C):       [type:1][x:i32][y:i32][z:i32][version:u32][w:u8][h:u8][itemId:u16][stack:u16] × (w*h)
// ContainerSetSlot (C→S):     [type:1][x:i32][y:i32][z:i32][row:u8][col:u8][itemId:u16][stack:u16]
// ContainerSlotUpdate (S→C):  [type:1][x:i32][y:i32][z:i32][version:u32][row:u8][col:u8][itemId:u16][stack:u16]
// ContainerClose (C→S):       [type:1][x:i32][y:i32][z:i32]
// ContainerRejected (S→C):    [type:1][x:i32][y:i32][z:i32][reason:u8]
// ---------------------------------------------------------------------------

/** Max slots accepted in a ContainerState payload (guards malicious blobs). */
export const MAX_CONTAINER_SLOTS = 64;

/** Shared immutable empty slot for encoding missing entries (no per-slot alloc). */
const EMPTY_CONTAINER_SLOT: ContainerSlotData = { itemId: 0, stackSize: 0 };

export function encodeContainerOpen(data: ContainerOpenData): Uint8Array {
	const enc = new BinaryEncoder(13);
	enc.writeUint8(MessageType.ContainerOpen);
	enc.writeCoords(data.x, data.y, data.z);
	return enc.getBytes();
}

export function decodeContainerOpenInto(
	dec: BinaryDecoder,
	target: ContainerOpenData,
): typeof target {
	return dec.readCoordsInto(target);
}

export function encodeContainerState(data: ContainerStateData): Uint8Array {
	const count = data.width * data.height;
	if (count > MAX_CONTAINER_SLOTS) {
		throw new RangeError(`container state out of range: ${count} slots`);
	}
	const enc = new BinaryEncoder(19 + count * 4);
	enc.writeUint8(MessageType.ContainerState);
	enc.writeCoords(data.x, data.y, data.z);
	enc.writeUint32(data.version);
	enc.writeUint8(data.width);
	enc.writeUint8(data.height);
	for (let i = 0; i < count; i++) {
		const slot: ContainerSlotData = data.slots[i] ?? EMPTY_CONTAINER_SLOT;
		enc.writeUint16(slot.itemId);
		enc.writeUint16(slot.stackSize);
	}
	return enc.getBytes();
}

/**
 * Decode a ContainerState into a caller-owned object, updating the slots
 * array and its slot objects IN PLACE. The slots array is only grown when a
 * larger container arrives; existing slot objects are reused, so a repeated
 * snapshot of the same crate allocates nothing per message.
 */
export function decodeContainerStateInto(
	dec: BinaryDecoder,
	target: ContainerStateData,
): typeof target {
	dec.readCoordsInto(target);
	target.version = dec.readUint32();
	target.width = dec.readUint8();
	target.height = dec.readUint8();
	const count = target.width * target.height;
	if (count > MAX_CONTAINER_SLOTS) {
		throw new RangeError(`container state out of range: ${count} slots`);
	}
	dec.require(count * 4);

	let slots: ContainerSlotData[] | undefined = target.slots;
	if (slots === undefined) {
		slots = [];
		target.slots = slots;
	}

	for (let i = 0; i < count; i++) {
		let slot = slots[i];
		if (slot === undefined) {
			slot = { itemId: 0, stackSize: 0 };
			slots[i] = slot;
		}
		slot.itemId = dec.readUint16();
		slot.stackSize = dec.readUint16();
	}
	slots.length = count;
	return target;
}

export function encodeContainerSetSlot(data: ContainerSetSlotData): Uint8Array {
	const enc = new BinaryEncoder(19);
	enc.writeUint8(MessageType.ContainerSetSlot);
	enc.writeCoords(data.x, data.y, data.z);
	enc.writeUint8(data.row);
	enc.writeUint8(data.col);
	enc.writeUint16(data.itemId);
	enc.writeUint16(data.stackSize);
	return enc.getBytes();
}

export function decodeContainerSetSlotInto(
	dec: BinaryDecoder,
	target: ContainerSetSlotData,
): typeof target {
	dec.readCoordsInto(target);
	target.row = dec.readUint8();
	target.col = dec.readUint8();
	target.itemId = dec.readUint16();
	target.stackSize = dec.readUint16();
	return target;
}

export function encodeContainerSlotUpdate(
	data: ContainerSlotUpdateData,
): Uint8Array {
	const enc = _singleEventEncoder;
	enc.reset();
	enc.writeUint8(MessageType.ContainerSlotUpdate);
	enc.writeCoords(data.x, data.y, data.z);
	enc.writeUint32(data.version);
	enc.writeUint8(data.row);
	enc.writeUint8(data.col);
	enc.writeUint16(data.itemId);
	enc.writeUint16(data.stackSize);
	return enc.finish();
}

export function decodeContainerSlotUpdateInto(
	dec: BinaryDecoder,
	target: ContainerSlotUpdateData,
): typeof target {
	dec.readCoordsInto(target);
	target.version = dec.readUint32();
	target.row = dec.readUint8();
	target.col = dec.readUint8();
	target.itemId = dec.readUint16();
	target.stackSize = dec.readUint16();
	return target;
}

export function encodeContainerClose(data: ContainerCloseData): Uint8Array {
	const enc = new BinaryEncoder(13);
	enc.writeUint8(MessageType.ContainerClose);
	enc.writeCoords(data.x, data.y, data.z);
	return enc.getBytes();
}

export function decodeContainerCloseInto(
	dec: BinaryDecoder,
	target: ContainerCloseData,
): typeof target {
	return dec.readCoordsInto(target);
}

export function encodeContainerRejected(
	data: ContainerRejectedData,
): Uint8Array {
	const enc = _singleEventEncoder;
	enc.reset();
	enc.writeUint8(MessageType.ContainerRejected);
	enc.writeCoords(data.x, data.y, data.z);
	enc.writeUint8(data.reason);
	return enc.finish();
}

export function decodeContainerRejectedInto(
	dec: BinaryDecoder,
	target: ContainerRejectedData,
): typeof target {
	dec.readCoordsInto(target);
	target.reason = dec.readUint8();
	return target;
}

// ---------------------------------------------------------------------------
// Server-authoritative stations (kiln / furnace / whetstone)
//
// A station is not a fixed grid, so the wire is an explicit three-slot triple
// plus two progress counters rather than a width/height/pairs loop.
//
// StationOpen (C->S):        [type:1][x:i32][y:i32][z:i32]
// StationState (S->C):       [type:1][x:i32][y:i32][z:i32][version:u32][kind:u8][capTier:u8]
//                                      [inId:u16][inN:u16][fuelId:u16][fuelN:u16]
//                                      [outId:u16][outN:u16]
//                                      [smeltProgress:u16][burnRemaining:u16][lit:u8]
// StationSetSlot (C->S):     [type:1][x:i32][y:i32][z:i32][slot:u8][itemId:u16][stack:u16]
// StationUpgrade (C->S):     [type:1][x:i32][y:i32][z:i32][capTier:u8]
// StationSlotUpdate (S->C):  [type:1][x:i32][y:i32][z:i32][version:u32][slot:u8]
//                                      [itemId:u16][stack:u16]
//                                      [smeltProgress:u16][burnRemaining:u16][lit:u8]
// StationRejected (S->C):    [type:1][x:i32][y:i32][z:i32][reason:u8]
//
// `lit` is sent rather than derived, so the client can never disagree with the
// server about what lit means. StationSlotUpdate omits the other two slots
// because the progress counter moves every tick: fanning a full snapshot 20x a
// second per viewer would be the single largest source of traffic in the game.
// ---------------------------------------------------------------------------

export function encodeStationOpen(data: StationOpenData): Uint8Array {
	const enc = new BinaryEncoder(13);
	enc.writeUint8(MessageType.StationOpen);
	enc.writeCoords(data.x, data.y, data.z);
	return enc.getBytes();
}

export function decodeStationOpenInto(
	dec: BinaryDecoder,
	target: StationOpenData,
): typeof target {
	return dec.readCoordsInto(target);
}

export function encodeStationState(data: StationStateData): Uint8Array {
	// 1 + 12 + 4 + 1 + 1 + 12 + 4 + 1
	const enc = new BinaryEncoder(36);
	enc.writeUint8(MessageType.StationState);
	enc.writeCoords(data.x, data.y, data.z);
	enc.writeUint32(data.version);
	enc.writeUint8(data.kind);
	enc.writeUint8(data.capTier);
	enc.writeUint16(data.input.itemId);
	enc.writeUint16(data.input.stackSize);
	enc.writeUint16(data.fuel.itemId);
	enc.writeUint16(data.fuel.stackSize);
	enc.writeUint16(data.output.itemId);
	enc.writeUint16(data.output.stackSize);
	enc.writeUint16(data.smeltProgress);
	enc.writeUint16(data.burnRemaining);
	enc.writeUint8(data.lit ? 1 : 0);
	return enc.getBytes();
}

export function decodeStationStateInto(
	dec: BinaryDecoder,
	target: StationStateData,
): typeof target {
	dec.readCoordsInto(target);
	target.version = dec.readUint32();
	target.kind = dec.readUint8();
	target.capTier = dec.readUint8();

	// Reuse the three slot objects instead of allocating fresh ones per
	// snapshot — station state moves every tick for every viewer.
	target.input ??= { itemId: 0, stackSize: 0 };
	target.fuel ??= { itemId: 0, stackSize: 0 };
	target.output ??= { itemId: 0, stackSize: 0 };

	target.input.itemId = dec.readUint16();
	target.input.stackSize = dec.readUint16();
	target.fuel.itemId = dec.readUint16();
	target.fuel.stackSize = dec.readUint16();
	target.output.itemId = dec.readUint16();
	target.output.stackSize = dec.readUint16();

	target.smeltProgress = dec.readUint16();
	target.burnRemaining = dec.readUint16();
	target.lit = dec.readUint8() !== 0;
	return target;
}

export function encodeStationSetSlot(data: StationSetSlotData): Uint8Array {
	const enc = new BinaryEncoder(18);
	enc.writeUint8(MessageType.StationSetSlot);
	enc.writeCoords(data.x, data.y, data.z);
	enc.writeUint8(data.slot);
	enc.writeUint16(data.itemId);
	enc.writeUint16(data.stackSize);
	return enc.getBytes();
}

export function decodeStationSetSlotInto(
	dec: BinaryDecoder,
	target: StationSetSlotData,
): typeof target {
	dec.readCoordsInto(target);
	target.slot = dec.readUint8();
	target.itemId = dec.readUint16();
	target.stackSize = dec.readUint16();
	return target;
}

export function encodeStationUpgrade(data: StationUpgradeData): Uint8Array {
	const enc = new BinaryEncoder(14);
	enc.writeUint8(MessageType.StationUpgrade);
	enc.writeCoords(data.x, data.y, data.z);
	enc.writeUint8(data.capTier);
	return enc.getBytes();
}

export function decodeStationUpgradeInto(
	dec: BinaryDecoder,
	target: StationUpgradeData,
): typeof target {
	dec.readCoordsInto(target);
	target.capTier = dec.readUint8();
	return target;
}

/**
 * StationResultClaimed (S->C): [type:1][x:i32][y:i32][z:i32][itemId:u16][stack:u16]
 *
 * Sent to the claiming client alone, so other viewers learn the result is gone
 * from the normal slot broadcast rather than from this message.
 */
export function encodeStationResultClaimed(
	data: StationResultClaimedData,
): Uint8Array {
	const enc = _singleEventEncoder;
	enc.reset();
	enc.writeUint8(MessageType.StationResultClaimed);
	enc.writeCoords(data.x, data.y, data.z);
	enc.writeUint16(data.itemId);
	enc.writeUint16(data.stackSize);
	return enc.finish();
}

export function decodeStationResultClaimedInto(
	dec: BinaryDecoder,
	target: StationResultClaimedData,
): typeof target {
	dec.readCoordsInto(target);
	target.itemId = dec.readUint16();
	target.stackSize = dec.readUint16();
	return target;
}

/**
 * StationClaimResult (C->S): [type:1][x:i32][y:i32][z:i32]
 *
 * Deliberately carries no item id or count. The server decides what the result
 * slot holds and hands it over whole, so a client cannot claim a different stack
 * than the one on screen or claim the same stack twice.
 */
export function encodeStationClaimResult(
	data: StationClaimResultData,
): Uint8Array {
	const enc = new BinaryEncoder(13);
	enc.writeUint8(MessageType.StationClaimResult);
	enc.writeCoords(data.x, data.y, data.z);
	return enc.getBytes();
}

export function decodeStationClaimResultInto(
	dec: BinaryDecoder,
	target: StationClaimResultData,
): typeof target {
	dec.readCoordsInto(target);
	return target;
}

export function encodeStationSlotUpdate(
	data: StationSlotUpdateData,
): Uint8Array {
	const enc = _singleEventEncoder;
	enc.reset();
	enc.writeUint8(MessageType.StationSlotUpdate);
	enc.writeCoords(data.x, data.y, data.z);
	enc.writeUint32(data.version);
	enc.writeUint8(data.slot < 0 ? 255 : data.slot);
	enc.writeUint16(data.itemId);
	enc.writeUint16(data.stackSize);
	enc.writeUint16(data.smeltProgress);
	enc.writeUint16(data.burnRemaining);
	enc.writeUint8(data.lit ? 1 : 0);
	return enc.finish();
}

export function decodeStationSlotUpdateInto(
	dec: BinaryDecoder,
	target: StationSlotUpdateData,
): typeof target {
	dec.readCoordsInto(target);
	target.version = dec.readUint32();
	const slot = dec.readUint8();
	// 255 is the wire form of "a counter changed, not a slot".
	target.slot = slot === 255 ? -1 : slot;
	target.itemId = dec.readUint16();
	target.stackSize = dec.readUint16();
	target.smeltProgress = dec.readUint16();
	target.burnRemaining = dec.readUint16();
	target.lit = dec.readUint8() !== 0;
	return target;
}

export function encodeStationRejected(data: StationRejectedData): Uint8Array {
	const enc = _singleEventEncoder;
	enc.reset();
	enc.writeUint8(MessageType.StationRejected);
	enc.writeCoords(data.x, data.y, data.z);
	enc.writeUint8(data.reason);
	return enc.finish();
}

export function decodeStationRejectedInto(
	dec: BinaryDecoder,
	target: StationRejectedData,
): typeof target {
	dec.readCoordsInto(target);
	target.reason = dec.readUint8();
	return target;
}
