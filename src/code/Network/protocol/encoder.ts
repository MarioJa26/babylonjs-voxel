/**
 * Binary encoder/decoder for b102 multiplayer protocol.
 *
 * All integers are little-endian. Uses DataView for cross-platform correctness.
 *
 * Single source of truth for client AND server — the server imports this
 * module via its "@/code/Network/protocol/*" path alias.
 */

import type { RemoteChunkData } from "../chunk/RemoteChunkProvider";
import {
	type BlockEditData,
	type BlockEditRejectedData,
	type ChatMessageData,
	ChunkResultKind,
	MessageType,
	type PlayerJoinData,
	type PlayerLeaveData,
	type PlayerStateBatchEntry,
	type PlayerStateData,
} from "./messages";

// Module-level scratch encoders: writeString/readString allocate a fresh
// TextEncoder/TextDecoder per call otherwise. The encode/decode calls are
// synchronous, so a single shared instance per direction is safe.
const _textEncoder = new TextEncoder();
const _textDecoder = new TextDecoder();

export class BinaryEncoder {
	private buffer: Uint8Array;
	private view: DataView;
	private offset: number;

	constructor(initialCapacity = 1024) {
		this.buffer = new Uint8Array(initialCapacity);
		this.view = new DataView(this.buffer.buffer);
		this.offset = 0;
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

	writeString(str: string): void {
		const encoded = _textEncoder.encode(str);
		this.writeUint16(encoded.byteLength);
		this.ensure(encoded.byteLength);
		this.buffer.set(encoded, this.offset);
		this.offset += encoded.byteLength;
	}

	writeBytes(bytes: Uint8Array): void {
		this.ensure(bytes.byteLength);
		this.buffer.set(bytes, this.offset);
		this.offset += bytes.byteLength;
	}

	/**
	 * C→S: no sessionId — the server uses the connection identity.
	 * yaw: 0-255 maps the full 360° circle; pitch: 0-255 maps -90°..+90°.
	 */
	writePlayerState(data: PlayerStateData): void {
		this.writeUint8(MessageType.PlayerState);
		this.writeFloat32(data.x);
		this.writeFloat32(data.y);
		this.writeFloat32(data.z);
		this.writeUint8(data.yaw);
		this.writeUint8(data.pitch);
		this.writeUint8(data.animation);
	}

	/**
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
		this.writeUint8(MessageType.PlayerState);
		this.writeFloat32(x);
		this.writeFloat32(y);
		this.writeFloat32(z);
		this.writeUint8(yaw);
		this.writeUint8(pitch);
		this.writeUint8(animation);
	}

	/** C→S: no sessionId — the server uses the connection identity. */
	writeBlockEdit(data: BlockEditData): void {
		this.writeUint8(MessageType.BlockEdit);
		this.writeInt32(data.x);
		this.writeInt32(data.y);
		this.writeInt32(data.z);
		this.writeUint16(data.blockId);
		this.writeUint8(data.action);
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
		this.writeUint8(MessageType.ChunkRequest);
		this.writeInt32(cx);
		this.writeInt32(cy);
		this.writeInt32(cz);
		this.writeUint8(lod);
		this.writeUint32(cachedVersion);
	}

	writeChunkRequestBatch(
		requests: Array<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedVersion: number;
		}>,
	): void {
		this.writeUint8(MessageType.ChunkRequestBatch);
		this.writeUint16(Math.min(requests.length, 65535));
		for (const r of requests) {
			this.writeInt32(r.cx);
			this.writeInt32(r.cy);
			this.writeInt32(r.cz);
			this.writeUint8(r.lod);
			this.writeUint32(r.cachedVersion);
		}
	}

	getBytes(): Uint8Array {
		return this.buffer.subarray(0, this.offset);
	}

	reset(): void {
		this.offset = 0;
	}
}

export class BinaryDecoder {
	private view: DataView;
	private offset: number;
	private buffer: Uint8Array;

	constructor(buffer: Uint8Array, startOffset = 0) {
		this.buffer = buffer;
		this.view = new DataView(
			buffer.buffer,
			buffer.byteOffset,
			buffer.byteLength,
		);
		this.offset = startOffset;
	}

	/**
	 * Rebind this decoder to a new buffer (resets the read offset). Lets
	 * message handlers reuse one decoder instance across many packets instead
	 * of allocating a fresh decoder + DataView per message.
	 */
	setBuffer(buffer: Uint8Array): void {
		this.buffer = buffer;
		this.view = new DataView(
			buffer.buffer,
			buffer.byteOffset,
			buffer.byteLength,
		);
		this.offset = 0;
	}

	get remaining(): number {
		return this.buffer.byteLength - this.offset;
	}

	peekUint8(): number {
		return this.view.getUint8(this.offset);
	}

	readUint8(): number {
		const v = this.view.getUint8(this.offset);
		this.offset += 1;
		return v;
	}

	readInt16(): number {
		const v = this.view.getInt16(this.offset, true);
		this.offset += 2;
		return v;
	}

	readInt32(): number {
		const v = this.view.getInt32(this.offset, true);
		this.offset += 4;
		return v;
	}

	readFloat32(): number {
		const v = this.view.getFloat32(this.offset, true);
		this.offset += 4;
		return v;
	}

	readUint16(): number {
		const v = this.view.getUint16(this.offset, true);
		this.offset += 2;
		return v;
	}

	readUint32(): number {
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
		const start = this.offset;
		this.offset += len;
		return this.buffer.subarray(start, this.offset);
	}

	readString(): string {
		const len = this.readUint16();
		const start = this.offset;
		this.offset += len;
		return _textDecoder.decode(this.buffer.subarray(start, this.offset));
	}

	/** C→S: no sessionId field on the wire. */
	readPlayerState(): PlayerStateData {
		const x = this.readFloat32();
		const y = this.readFloat32();
		const z = this.readFloat32();
		const yaw = this.readUint8();
		const pitch = this.readUint8();
		const animation = this.readUint8();
		return { x, y, z, yaw, pitch, animation };
	}

	/**
	 * C→S: decode into a caller-owned object instead of allocating a fresh
	 * one per message. Returns the target for chaining. The previous values
	 * are overwritten in place.
	 */
	readPlayerStateInto(target: PlayerStateData): PlayerStateData {
		target.x = this.readFloat32();
		target.y = this.readFloat32();
		target.z = this.readFloat32();
		target.yaw = this.readUint8();
		target.pitch = this.readUint8();
		target.animation = this.readUint8();
		return target;
	}

	/** C→S: no sessionId field on the wire. */
	readBlockEdit(): BlockEditData {
		const x = this.readInt32();
		const y = this.readInt32();
		const z = this.readInt32();
		const blockId = this.readUint16();
		const action = this.readUint8();
		return { sessionId: "", x, y, z, blockId, action };
	}

	/**
	 * C→S: decode into a caller-owned object instead of allocating a fresh
	 * one per message. Returns the target for chaining.
	 */
	readBlockEditInto(target: BlockEditData): BlockEditData {
		target.x = this.readInt32();
		target.y = this.readInt32();
		target.z = this.readInt32();
		target.blockId = this.readUint16();
		target.action = this.readUint8();
		return target;
	}

	readChatMessage(): ChatMessageData {
		return {
			sessionId: this.readString(),
			name: this.readString(),
			message: this.readString(),
		};
	}

	readChunkRequest(): {
		cx: number;
		cy: number;
		cz: number;
		lod: number;
		cachedVersion: number;
	} {
		const cx = this.readInt32();
		const cy = this.readInt32();
		const cz = this.readInt32();
		const lod = this.readUint8();
		const cachedVersion = this.readUint32();
		return { cx, cy, cz, lod, cachedVersion };
	}

	readChunkRequestInto(target: {
		cx: number;
		cy: number;
		cz: number;
		lod: number;
		cachedVersion: number;
	}): typeof target {
		target.cx = this.readInt32();
		target.cy = this.readInt32();
		target.cz = this.readInt32();
		target.lod = this.readUint8();
		target.cachedVersion = this.readUint32();
		return target;
	}

	readChunkRequestBatch(): Array<{
		cx: number;
		cy: number;
		cz: number;
		lod: number;
		cachedVersion: number;
	}> {
		const count = this.readUint16();
		const requests: Array<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedVersion: number;
		}> = [];
		for (let i = 0; i < count; i++) {
			requests.push({
				cx: this.readInt32(),
				cy: this.readInt32(),
				cz: this.readInt32(),
				lod: this.readUint8(),
				cachedVersion: this.readUint32(),
			});
		}
		return requests;
	}

	/**
	 * Decode chunk request batch into a reusable pre-allocated array.
	 * Avoids per-entry object allocation on the server hot path.
	 */
	readChunkRequestBatchInto(
		target: Array<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedVersion: number;
		}>,
	): number {
		const count = this.readUint16();
		for (let i = 0; i < count; i++) {
			let entry = target[i];
			if (!entry) {
				entry = { cx: 0, cy: 0, cz: 0, lod: 0, cachedVersion: 0 };
				target[i] = entry;
			}
			entry.cx = this.readInt32();
			entry.cy = this.readInt32();
			entry.cz = this.readInt32();
			entry.lod = this.readUint8();
			entry.cachedVersion = this.readUint32();
		}
		target.length = count;
		return count;
	}
}

/**
 * Batch encoding for server → client broadcasts.
 * Per player: [index:u8][x:f32][y:f32][z:f32][yaw:u8][pitch:u8][anim:u8] — 13
 * bytes instead of a sessionId string (~16-24 bytes) plus 12+3.
 *
 * writePlayerStateBatch writes into a caller-owned (reused) encoder so the
 * fixed-rate server tick doesn't allocate a fresh buffer every cycle.
 */
export function writePlayerStateBatch(
	enc: BinaryEncoder,
	states: PlayerStateBatchEntry[],
): void {
	enc.writeUint8(MessageType.PlayerStateBatch);
	enc.writeUint8(Math.min(states.length, 255));
	for (const s of states) {
		enc.writeUint8(s.index);
		enc.writeFloat32(s.x);
		enc.writeFloat32(s.y);
		enc.writeFloat32(s.z);
		enc.writeUint8(s.yaw);
		enc.writeUint8(s.pitch);
		enc.writeUint8(s.animation);
	}
}

export function encodePlayerStateBatch(
	states: PlayerStateBatchEntry[],
): Uint8Array {
	const enc = new BinaryEncoder(2 + states.length * 13);
	writePlayerStateBatch(enc, states);
	return enc.getBytes();
}

export function decodePlayerStateBatch(
	buffer: Uint8Array,
): PlayerStateBatchEntry[] {
	const dec = new BinaryDecoder(buffer, 1); // skip type byte
	const count = dec.readUint8();
	const states: PlayerStateBatchEntry[] = [];
	for (let i = 0; i < count; i++) {
		states.push({
			index: dec.readUint8(),
			x: dec.readFloat32(),
			y: dec.readFloat32(),
			z: dec.readFloat32(),
			yaw: dec.readUint8(),
			pitch: dec.readUint8(),
			animation: dec.readUint8(),
		});
	}
	return states;
}

/**
 * Decode a player state batch into a reusable pre-allocated array.
 * Avoids per-tick object + array allocation on the hot path.
 * Returns the number of entries written.
 */
export function decodePlayerStateBatchInto(
	buffer: Uint8Array,
	target: PlayerStateBatchEntry[],
): number {
	return decodePlayerStateBatchEntriesInto(
		new BinaryDecoder(buffer, 1),
		target,
	);
}

/**
 * Decoder-based variant of decodePlayerStateBatchInto — reads from an
 * already-positioned decoder (type byte already consumed) instead of
 * deriving a fresh one from the raw buffer.
 */
export function decodePlayerStateBatchEntriesInto(
	dec: BinaryDecoder,
	target: PlayerStateBatchEntry[],
): number {
	const count = dec.readUint8();
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
	const enc = new BinaryEncoder(3 + edits.length * 16);
	enc.writeUint8(MessageType.BlockEditBatch);
	enc.writeUint16(Math.min(edits.length, 65535));
	for (const e of edits) {
		enc.writeInt32(e.x);
		enc.writeInt32(e.y);
		enc.writeInt32(e.z);
		enc.writeUint16(e.blockId);
		enc.writeUint8(e.action);
	}
	return enc.getBytes();
}

export function decodeBlockEditBatch(buffer: Uint8Array): BlockEditData[] {
	const dec = new BinaryDecoder(buffer, 1); // skip type byte
	const count = dec.readUint16();
	const edits: BlockEditData[] = [];
	for (let i = 0; i < count; i++) {
		edits.push({
			sessionId: "", // filled in by caller
			x: dec.readInt32(),
			y: dec.readInt32(),
			z: dec.readInt32(),
			blockId: dec.readUint16(),
			action: dec.readUint8(),
		});
	}
	return edits;
}

/**
 * Player join — server → client.
 * [type:1][index:u8][sessionId:str][name:str]
 * The joiner receives its OWN join message (with its index) directly; other
 * clients receive it via broadcast.
 */
export function encodePlayerJoin(data: PlayerJoinData): Uint8Array {
	const enc = new BinaryEncoder(64);
	enc.writeUint8(MessageType.PlayerJoin);
	enc.writeUint8(data.index);
	enc.writeString(data.sessionId);
	enc.writeString(data.name);
	return enc.getBytes();
}

export function decodePlayerJoin(buffer: Uint8Array): PlayerJoinData {
	return decodePlayerJoinFrom(new BinaryDecoder(buffer, 1));
}

export function decodePlayerJoinFrom(dec: BinaryDecoder): PlayerJoinData {
	return {
		index: dec.readUint8(),
		sessionId: dec.readString(),
		name: dec.readString(),
	};
}

/**
 * Player leave — server → client.
 * [type:1][index:u8] — the client resolves sessionId via its index map.
 */
export function encodePlayerLeave(data: PlayerLeaveData): Uint8Array {
	const enc = new BinaryEncoder(2);
	enc.writeUint8(MessageType.PlayerLeave);
	enc.writeUint8(data.index);
	return enc.getBytes();
}

export function decodePlayerLeave(buffer: Uint8Array): number {
	return buffer[1];
}

/**
 * S→C: broadcast of one player's block edit.
 * [type:1][sessionId:str][x:i32][y:i32][z:i32][blockId:u16][action:u8]
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
	enc.writeUint8(data.action);
	return enc.getBytes();
}

export function decodeBlockEditBroadcast(buffer: Uint8Array): BlockEditData {
	return decodeBlockEditBroadcastFrom(new BinaryDecoder(buffer, 1));
}

export function decodeBlockEditBroadcastFrom(
	dec: BinaryDecoder,
): BlockEditData {
	return {
		sessionId: dec.readString(),
		x: dec.readInt32(),
		y: dec.readInt32(),
		z: dec.readInt32(),
		blockId: dec.readUint16(),
		action: dec.readUint8(),
	};
}

/**
 * S→C: the server rejected one of this client's block edits.
 * [type:1][x:i32][y:i32][z:i32][blockId:u16][action:u8][reason:u8]
 * blockId echoes the client's edit so a rejected Break can be restored.
 */
export function encodeBlockEditRejected(
	data: BlockEditRejectedData,
): Uint8Array {
	const enc = new BinaryEncoder(16);
	enc.writeUint8(MessageType.BlockEditRejected);
	enc.writeInt32(data.x);
	enc.writeInt32(data.y);
	enc.writeInt32(data.z);
	enc.writeUint16(data.blockId);
	enc.writeUint8(data.action);
	enc.writeUint8(data.reason);
	return enc.getBytes();
}

export function decodeBlockEditRejected(
	buffer: Uint8Array,
): BlockEditRejectedData {
	return decodeBlockEditRejectedFrom(new BinaryDecoder(buffer, 1));
}

export function decodeBlockEditRejectedFrom(
	dec: BinaryDecoder,
): BlockEditRejectedData {
	return {
		x: dec.readInt32(),
		y: dec.readInt32(),
		z: dec.readInt32(),
		blockId: dec.readUint16(),
		action: dec.readUint8(),
		reason: dec.readUint8(),
	};
}

export function encodeChatMessage(data: ChatMessageData): Uint8Array {
	const enc = new BinaryEncoder(256);
	enc.writeChatMessage(data);
	return enc.getBytes();
}

export function decodeChatMessage(buffer: Uint8Array): ChatMessageData {
	const dec = new BinaryDecoder(buffer, 1);
	return dec.readChatMessage();
}

/**
 * Simple hash for chunk cache validation.
 * Combines block data into a 32-bit stamp. Fast, no crypto overhead.
 */
export function hashChunk(
	blocks: Uint8Array,
	light: Uint8Array,
	palette?: number[],
): number {
	let h = 0x811c9dc5; // FNV offset basis

	// Sample blocks (check first 256 bytes + every 64th byte for large chunks)
	const step = blocks.length > 256 ? Math.floor(blocks.length / 64) : 1;
	for (let i = 0; i < blocks.length; i += step) {
		h ^= blocks[i] & 0xff;
		h = Math.imul(h, 0x01000193); // FNV prime
	}

	// Mix light data (sample every 128th byte)
	for (let i = 0; i < light.length; i += 128) {
		h ^= light[i] & 0xff;
		h = Math.imul(h, 0x01000193); // FNV prime
	}

	// Mix palette
	if (palette) {
		for (const p of palette) {
			h ^= p & 0xff;
			h = Math.imul(h, 0x01000193); // FNV prime
			h ^= (p >> 8) & 0xff;
			h = Math.imul(h, 0x01000193); // FNV prime
		}
	}

	return h >>> 0; // Convert to unsigned 32-bit
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

export function decodeWorldTime(buffer: Uint8Array): number {
	const dec = new BinaryDecoder(buffer, 1);
	return dec.readFloat32();
}

/**
 * World config — server → client on join.
 * Carries the authoritative world seed so the client's clip map matches
 * the server's terrain generation.
 * Format: [type:1][seedLength:u16][seedString...]
 */
export function encodeWorldConfig(seed: string): Uint8Array {
	const enc = new BinaryEncoder(256);
	enc.writeUint8(MessageType.WorldConfig);
	enc.writeString(seed);
	return enc.getBytes();
}

export function decodeWorldConfig(buffer: Uint8Array): string {
	const dec = new BinaryDecoder(buffer, 1);
	return dec.readString();
}

/**
 * Chunk data — server → client (response to chunk request).
 * Contains compressed voxel data for meshing on the client.
 * Format: [type:1][chunkX:i32][chunkY:i32][chunkZ:i32][hash:u32][flags:u8][blockData...][lightData...]
 * hash: CRC32-like stamp for cache validation
 * flags: bit0=isUniform, bit1=hasPalette
 * If isUniform: next 2 bytes = uniformBlockId, no block data
 * If hasPalette: next 2 bytes = paletteLength, then paletteLength*2 bytes palette, then packed data
 * Light data always follows block data (lightLength:u32 then bytes)
 */
export function encodeChunkData(data: {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	blocks: Uint8Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
	hash: number;
	version: number;
}): Uint8Array {
	const lightBytes = data.light.length;
	const headerSize = 1 + 12 + 4 + 4 + 1; // type + chunk coords + hash + version + flags
	const uniformSize = data.isUniform ? 2 : 0;
	const paletteSize = data.palette ? 2 + data.palette.length * 2 : 0;
	const totalSize =
		headerSize +
		uniformSize +
		paletteSize +
		data.blocks.length +
		4 +
		lightBytes;

	const enc = new BinaryEncoder(totalSize);
	enc.writeUint8(MessageType.ChunkData);
	enc.writeInt32(data.chunkX);
	enc.writeInt32(data.chunkY);
	enc.writeInt32(data.chunkZ);
	enc.writeUint32(data.hash);
	enc.writeUint32(data.version);

	// Flags
	let flags = 0;
	if (data.isUniform) flags |= 1;
	if (data.palette) flags |= 2;
	enc.writeUint8(flags);

	if (data.isUniform) {
		enc.writeUint16(data.uniformBlockId);
	} else if (data.palette) {
		enc.writeUint16(data.palette.length);
		for (const pid of data.palette) {
			enc.writeUint16(pid);
		}
		enc.writeBytes(data.blocks);
	} else {
		enc.writeBytes(data.blocks);
	}

	// Light data
	enc.writeUint32(lightBytes);
	enc.writeBytes(data.light);

	return enc.getBytes();
}

export function decodeChunkData(
	buffer: Uint8Array,
): RemoteChunkData & { hash: number } {
	const dec = new BinaryDecoder(buffer, 1);
	const chunkX = dec.readInt32();
	const chunkY = dec.readInt32();
	const chunkZ = dec.readInt32();
	const hash = dec.readUint32();
	const version = dec.readUint32();
	const flags = dec.readUint8();
	const isUniform = (flags & 1) !== 0;
	const hasPalette = (flags & 2) !== 0;

	let uniformBlockId = 0;
	let palette: Uint16Array | undefined;
	let blocks: Uint8Array;

	if (isUniform) {
		uniformBlockId = dec.readUint16();
		blocks = new Uint8Array(0);
	} else if (hasPalette) {
		const paletteLen = dec.readUint16();
		// readBytes copies into a fresh, zero-aligned buffer so the
		// Uint16Array view is always aligned regardless of wire offset.
		const paletteBytes = dec.readBytes(paletteLen * 2);
		palette = new Uint16Array(
			paletteBytes.buffer,
			paletteBytes.byteOffset,
			paletteLen,
		);
		// Packed nibble data: remaining before light
		// We need to know the packed size — it's derived from chunk volume
		const chunkVolume = 32 * 32 * 32; // CHUNK_SIZE^3
		const packedSize = Math.ceil(chunkVolume / 2);
		blocks = dec.readBytesView(packedSize);
	} else {
		// Dense format: full chunk volume
		const chunkVolume = 32 * 32 * 32;
		blocks = dec.readBytesView(chunkVolume);
	}

	// Light data
	const lightLen = dec.readUint32();
	const light = dec.readBytesView(lightLen);

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
		hash,
		version,
	};
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

export function decodeChunkUnchanged(buffer: Uint8Array): {
	cx: number;
	cy: number;
	cz: number;
	version: number;
} {
	const dec = new BinaryDecoder(buffer, 1);
	return {
		cx: dec.readInt32(),
		cy: dec.readInt32(),
		cz: dec.readInt32(),
		version: dec.readUint32(),
	};
}

/**
 * Chunk unchanged batch — server → client.
 * Format: [type:1][count:u16][cx:i32][cy:i32][cz:i32][version:u32] × count
 */
export function decodeChunkUnchangedBatch(buffer: Uint8Array): Array<{
	cx: number;
	cy: number;
	cz: number;
	version: number;
}> {
	const dec = new BinaryDecoder(buffer, 1);
	const count = Math.min(dec.readUint16(), 65535);
	const results = new Array(count);
	for (let i = 0; i < count; i++) {
		results[i] = {
			cx: dec.readInt32(),
			cy: dec.readInt32(),
			cz: dec.readInt32(),
			version: dec.readUint32(),
		};
	}
	return results;
}

// ---------------------------------------------------------------------------
// Chunk request batch — client → server, multiple coords in one message
// Format: [type:1][count:u16][cx:i32][cy:i32][cz:i32][lod:u8][cachedVersion:u32] × count
// ---------------------------------------------------------------------------

export function encodeChunkRequestBatch(
	requests: Array<{
		cx: number;
		cy: number;
		cz: number;
		lod: number;
		cachedVersion: number;
	}>,
): Uint8Array {
	const enc = new BinaryEncoder(3 + requests.length * 15);
	enc.writeUint8(MessageType.ChunkRequestBatch);
	enc.writeUint16(Math.min(requests.length, 65535));
	for (const r of requests) {
		enc.writeInt32(r.cx);
		enc.writeInt32(r.cy);
		enc.writeInt32(r.cz);
		enc.writeUint8(r.lod);
		enc.writeUint32(r.cachedVersion);
	}
	return enc.getBytes();
}

// ---------------------------------------------------------------------------
// Chunk data batch — server → client, multiple chunks in one message
// Format: [type:1][count:u16][(chunk entry)] × count
// Each entry: [cx:i32][cy:i32][cz:i32][hash:u32][flags:u8][blockData...][lightData...]
// (same inner format as encodeChunkData minus the type byte)
// ---------------------------------------------------------------------------

export function encodeChunkDataBatch(
	chunks: Array<{
		chunkX: number;
		chunkY: number;
		chunkZ: number;
		blocks: Uint8Array;
		light: Uint8Array;
		palette?: number[];
		isUniform: boolean;
		uniformBlockId: number;
		hash: number;
		version: number;
	}>,
): Uint8Array {
	const count = Math.min(chunks.length, 65535);
	const buf = new Uint8Array(encodeChunkDataBatchMeasure(chunks, count));
	let offset = 0;
	const view = new DataView(buf.buffer);

	buf[offset++] = MessageType.ChunkDataBatch;
	view.setUint16(offset, count, true);
	offset += 2;

	for (let i = 0; i < count; i++) {
		const c = chunks[i];
		view.setInt32(offset, c.chunkX, true);
		offset += 4;
		view.setInt32(offset, c.chunkY, true);
		offset += 4;
		view.setInt32(offset, c.chunkZ, true);
		offset += 4;
		view.setUint32(offset, c.hash, true);
		offset += 4;
		view.setUint32(offset, c.version, true);
		offset += 4;

		let flags = 0;
		if (c.isUniform) flags |= 1;
		if (c.palette) flags |= 2;
		buf[offset++] = flags;

		if (c.isUniform) {
			view.setUint16(offset, c.uniformBlockId, true);
			offset += 2;
		} else if (c.palette) {
			view.setUint16(offset, c.palette.length, true);
			offset += 2;
			for (let j = 0; j < c.palette.length; j++) {
				view.setUint16(offset, c.palette[j], true);
				offset += 2;
			}
			buf.set(c.blocks, offset);
			offset += c.blocks.length;
		} else {
			buf.set(c.blocks, offset);
			offset += c.blocks.length;
		}

		view.setUint32(offset, c.light.length, true);
		offset += 4;
		buf.set(c.light, offset);
		offset += c.light.length;
	}

	return buf;
}

function encodeChunkDataBatchMeasure(
	chunks: Array<{
		blocks: Uint8Array;
		light: Uint8Array;
		palette?: number[];
		isUniform: boolean;
	}>,
	count: number,
): number {
	let totalSize = 3;
	for (let i = 0; i < count; i++) {
		const c = chunks[i];
		totalSize += 21; // 12 (coords) + 4 (hash) + 4 (version) + 1 (flags)
		if (c.isUniform) {
			totalSize += 2;
		} else if (c.palette) {
			totalSize += 2 + c.palette.length * 2 + c.blocks.length;
		} else {
			totalSize += c.blocks.length;
		}
		totalSize += 4 + c.light.length;
	}
	return totalSize;
}

export function decodeChunkDataBatch(
	buffer: Uint8Array,
): Array<RemoteChunkData & { hash: number }> {
	const dec = new BinaryDecoder(buffer, 1);
	const count = dec.readUint16();
	const chunks: Array<RemoteChunkData & { hash: number }> = [];

	for (let i = 0; i < count; i++) {
		const chunkX = dec.readInt32();
		const chunkY = dec.readInt32();
		const chunkZ = dec.readInt32();
		const hash = dec.readUint32();
		const version = dec.readUint32();
		const flags = dec.readUint8();
		const isUniform = (flags & 1) !== 0;
		const hasPalette = (flags & 2) !== 0;

		let uniformBlockId = 0;
		let palette: Uint16Array | undefined;
		let blocks: Uint8Array;

		if (isUniform) {
			uniformBlockId = dec.readUint16();
			blocks = new Uint8Array(0);
		} else if (hasPalette) {
			const paletteLen = dec.readUint16();
			const paletteBytes = dec.readBytes(paletteLen * 2);
			palette = new Uint16Array(
				paletteBytes.buffer,
				paletteBytes.byteOffset,
				paletteLen,
			);
			const chunkVolume = 32 * 32 * 32;
			const packedSize = Math.ceil(chunkVolume / 2);
			blocks = dec.readBytesView(packedSize);
		} else {
			const chunkVolume = 32 * 32 * 32;
			blocks = dec.readBytesView(chunkVolume);
		}

		const lightLen = dec.readUint32();
		const light = dec.readBytesView(lightLen);

		chunks.push({
			kind: ChunkResultKind.Data,
			chunkX,
			chunkY,
			chunkZ,
			blocks,
			light,
			palette,
			isUniform,
			uniformBlockId,
			hash,
			version,
		});
	}

	return chunks;
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

export function decodeSpawnPosition(buffer: Uint8Array): {
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
} {
	const dec = new BinaryDecoder(buffer, 1);
	return {
		x: dec.readFloat32(),
		y: dec.readFloat32(),
		z: dec.readFloat32(),
		yaw: dec.readFloat32(),
		pitch: dec.readFloat32(),
	};
}
