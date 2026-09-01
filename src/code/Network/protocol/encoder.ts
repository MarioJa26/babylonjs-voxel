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
	type PlayerJoinData,
	type PlayerLeaveData,
	type PlayerSkinData,
	type PlayerStateBatchEntry,
	type PlayerStateData,
} from "./messages";

// Module-level scratch encoders: writeString/readString allocate a fresh
// TextEncoder/TextDecoder per call otherwise. The encode/decode calls are
// synchronous, so a single shared instance per direction is safe.
const _textEncoder = new TextEncoder();
const _textDecoder = new TextDecoder();

const PLAYER_STATE_BATCH_ENTRY_BYTES = 16; // index:u8 + x/y/z:f32 + yaw/pitch/anim:u8
const BLOCK_EDIT_ENTRY_BYTES = 16; // x/y/z:i32 + blockId:u16 + blockState:u8 + action:u8
const CHUNK_REQUEST_ENTRY_BYTES = 17; // cx/cy/cz:i32 + lod:u8 + cachedVersion:u32
const MOB_UPDATE_ENTRY_BYTES = 15; // mobId:u16 + x/y/z:f32 + yaw:u8
const CHUNK_VOLUME = 32 * 32 * 32; // Chunk.SIZE^3 — light arrays are this size

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
		this.writeUint8(data.blockState);
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
		const count = Math.min(requests.length, 65535);
		this.writeUint8(MessageType.ChunkRequestBatch);
		this.writeUint16(count);

		for (let i = 0; i < count; i++) {
			const r = requests[i];
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

// PERF: reused scratch encoder for the small single-event encode helpers below
// (player join/leave, mob spawn/despawn, item spawn/despawn). Each helper resets
// and writes into it, then returns getBytes() (a subarray view) which the caller
// consumes synchronously via broadcastBytes/sendBytes — so the buffer is never
// aliased across live messages. This avoids one BinaryEncoder + backing Uint8Array
// allocation per spawn/despawn/join/leave event (the benchmark's GC pressure).
const _singleEventEncoder = new BinaryEncoder(64);

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
		const start = this.offset;
		const end = start + len;
		if (end > this.buffer.byteLength) {
			throw new RangeError("readBytesViewSAB: out of bounds");
		}
		const sab = new SharedArrayBuffer(capacity);
		new Uint8Array(sab).set(this.buffer.subarray(start, end));
		this.offset = end;
		return new Uint8Array(sab);
	}

	readString(): string {
		const len = this.readUint16();
		const start = this.offset;
		this.offset += len;
		return _textDecoder.decode(this.buffer.subarray(start, this.offset));
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

	/**
	 * C→S: decode into a caller-owned object instead of allocating a fresh
	 * one per message. Returns the target for chaining.
	 */
	readBlockEditInto(target: BlockEditData): BlockEditData {
		target.x = this.readInt32();
		target.y = this.readInt32();
		target.z = this.readInt32();
		target.blockId = this.readUint16();
		target.blockState = this.readUint8();
		target.action = this.readUint8();
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
		target.cx = this.readInt32();
		target.cy = this.readInt32();
		target.cz = this.readInt32();
		target.lod = this.readUint8();
		target.cachedVersion = this.readUint32();
		return target;
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
	const count = Math.min(states.length, 255);

	enc.writeUint8(MessageType.PlayerStateBatch);
	enc.writeUint8(count);

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

export function encodePlayerStateBatch(
	states: PlayerStateBatchEntry[],
): Uint8Array {
	const count = Math.min(states.length, 255);
	const enc = new BinaryEncoder(2 + count * PLAYER_STATE_BATCH_ENTRY_BYTES);
	writePlayerStateBatch(enc, states);
	return enc.getBytes();
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
	const count = Math.min(edits.length, 65535);
	const enc = new BinaryEncoder(3 + count * BLOCK_EDIT_ENTRY_BYTES);

	enc.writeUint8(MessageType.BlockEditBatch);
	enc.writeUint16(count);

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

export function decodeBlockEditBatch(buffer: Uint8Array): BlockEditData[] {
	const dec = new BinaryDecoder(buffer, 1);
	const count = dec.readUint16();
	const edits = new Array<BlockEditData>(count);

	for (let i = 0; i < count; i++) {
		edits[i] = {
			sessionId: "", // filled in by caller
			x: dec.readInt32(),
			y: dec.readInt32(),
			z: dec.readInt32(),
			blockId: dec.readUint16(),
			blockState: dec.readUint8(),
			action: dec.readUint8(),
		};
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
	const enc = _singleEventEncoder;
	enc.reset();
	enc.writeUint8(MessageType.PlayerJoin);
	enc.writeUint8(data.index);
	enc.writeString(data.sessionId);
	enc.writeString(data.name);
	return enc.getBytes();
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
	return enc.getBytes();
}

export function decodePlayerLeave(buffer: Uint8Array): number {
	return buffer[1];
}

/**
 * C→S: upload this client's avatar skin.
 * [type:1][len:u16][png bytes]
 * Sent once after joining; the server validates and relays it to others.
 */
export function encodeSkinUpload(png: Uint8Array): Uint8Array {
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
	const enc = new BinaryEncoder(4 + data.png.byteLength);
	enc.writeUint8(MessageType.PlayerSkin);
	enc.writeUint8(data.index);
	enc.writeUint16(data.png.byteLength);
	enc.writeBytes(data.png);
	return enc.getBytes();
}

export function decodePlayerSkinInto(
	dec: BinaryDecoder,
	target: PlayerSkinData,
): typeof target {
	target.index = dec.readUint8();
	const len = dec.readUint16();
	target.png = dec.readBytes(len);
	return target;
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

export function decodeChatMessageInto(
	dec: BinaryDecoder,
	target: ChatMessageData,
): typeof target {
	return dec.readChatMessageInto(target);
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

/**
 * Chunk data — server → client (response to chunk request).
 * Contains compressed voxel data for meshing on the client.
 * Format: [type:1][chunkX:i32][chunkY:i32][chunkZ:i32][version:u32][flags:u8][blockData...][lightData...]
 * flags: bit0=isUniform, bit1=hasPalette, bit2=denseBlocksAreU16
 * If isUniform: next 2 bytes = uniformBlockId, no block data
 * If hasPalette: next 2 bytes = paletteLength, then paletteLength*2 bytes palette, then packed data
 * Light data always follows block data (lightLength:u32 then bytes)
 */
export function encodeChunkData(data: {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	blocks: Uint8Array | Uint16Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
	version: number;
}): Uint8Array {
	const lightBytes = data.light.length;
	const headerSize = 1 + 12 + 4 + 1; // type + chunk coords + version + flags
	const uniformSize = data.isUniform ? 2 : 0;
	const paletteSize = data.palette ? 2 + data.palette.length * 2 : 0;
	const denseU16 =
		!data.isUniform && !data.palette && data.blocks instanceof Uint16Array;
	const totalSize =
		headerSize +
		uniformSize +
		paletteSize +
		data.blocks.byteLength +
		4 +
		lightBytes;

	const enc = new BinaryEncoder(totalSize);
	enc.writeUint8(MessageType.ChunkData);
	enc.writeInt32(data.chunkX);
	enc.writeInt32(data.chunkY);
	enc.writeInt32(data.chunkZ);
	enc.writeUint32(data.version);

	// Flags
	let flags = 0;
	if (data.isUniform) flags |= 1;
	if (data.palette) flags |= 2;
	if (denseU16) flags |= 4;
	enc.writeUint8(flags);

	if (data.isUniform) {
		enc.writeUint16(data.uniformBlockId);
	} else if (data.palette) {
		enc.writeUint16(data.palette.length);
		for (let i = 0; i < data.palette.length; i++) {
			enc.writeUint16(data.palette[i]);
		}
		enc.writeBytes(data.blocks as Uint8Array);
	} else {
		const b = data.blocks;
		enc.writeBytes(
			b instanceof Uint16Array
				? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
				: b,
		);
	}

	// Light data
	enc.writeUint32(lightBytes);
	enc.writeBytes(data.light);

	return enc.getBytes();
}

export function decodeChunkData(
	buffer: Uint8Array,
	allocSAB = false,
): RemoteChunkData {
	return decodeChunkDataEntry(new BinaryDecoder(buffer, 1), allocSAB);
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
	const isUniform = (flags & 1) !== 0;
	const hasPalette = (flags & 2) !== 0;
	const denseU16 = (flags & 4) !== 0;

	let uniformBlockId = 0;
	let palette: Uint16Array | undefined;
	let blocks: Uint8Array | Uint16Array;

	if (isUniform) {
		uniformBlockId = dec.readUint16();
		blocks = new Uint8Array(0);
	} else if (hasPalette) {
		const paletteLen = dec.readUint16();
		const paletteBytes = allocSAB
			? dec.readBytesViewSAB(paletteLen * 2)
			: dec.readBytes(paletteLen * 2);

		palette = new Uint16Array(
			paletteBytes.buffer,
			paletteBytes.byteOffset,
			paletteLen,
		);

		const packedSize = Math.ceil(CHUNK_VOLUME / 2);
		blocks = allocSAB
			? dec.readBytesViewSAB(packedSize)
			: dec.readBytesView(packedSize);
	} else if (denseU16) {
		const byteLen = CHUNK_VOLUME * 2;
		const raw = allocSAB
			? dec.readBytesViewSAB(byteLen)
			: dec.readBytesView(byteLen);
		blocks = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength >>> 1);
	} else {
		blocks = allocSAB
			? dec.readBytesViewSAB(CHUNK_VOLUME)
			: dec.readBytesView(CHUNK_VOLUME);
	}

	const lightLen = dec.readUint32();
	const light = allocSAB
		? dec.readBytesViewSAB(lightLen, CHUNK_VOLUME)
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

export function encodeChunkRequestBatch(
	requests: Array<{
		cx: number;
		cy: number;
		cz: number;
		lod: number;
		cachedVersion: number;
	}>,
): Uint8Array {
	const count = Math.min(requests.length, 65535);
	const enc = new BinaryEncoder(3 + count * CHUNK_REQUEST_ENTRY_BYTES);

	enc.writeUint8(MessageType.ChunkRequestBatch);
	enc.writeUint16(count);

	for (let i = 0; i < count; i++) {
		const r = requests[i];
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
// Each entry: [cx:i32][cy:i32][cz:i32][version:u32][flags:u8][blockData...][lightData...]
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
		totalSize += 17; // 12 (coords) + 4 (version) + 1 (flags)
		if (c.isUniform) {
			totalSize += 2;
		} else if (c.palette) {
			totalSize += 2 + c.palette.length * 2 + c.blocks.byteLength;
		} else {
			totalSize += c.blocks.byteLength;
		}
		totalSize += 4 + c.light.length;
	}
	return totalSize;
}

export function decodeChunkDataBatch(
	buffer: Uint8Array,
	allocSAB = false,
): Array<RemoteChunkData> {
	const dec = new BinaryDecoder(buffer, 1);
	const count = dec.readUint16();
	const chunks = new Array<RemoteChunkData>(count);

	for (let i = 0; i < count; i++) {
		chunks[i] = decodeChunkDataEntry(dec, allocSAB);
	}

	return chunks;
}

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

export function decodeChunkDataDeflated(buffer: Uint8Array): DeflatedChunk {
	const dec = new BinaryDecoder(buffer, 1);
	return decodeChunkDataDeflatedFrom(dec);
}

export function decodeChunkDataDeflatedFrom(dec: BinaryDecoder): DeflatedChunk {
	const chunkX = dec.readInt32();
	const chunkY = dec.readInt32();
	const chunkZ = dec.readInt32();
	const version = dec.readUint32();
	const len = dec.readUint32();
	const origLen = dec.readUint32();
	return {
		chunkX,
		chunkY,
		chunkZ,
		version,
		origLen,
		deflated: dec.readBytes(len),
	};
}

export function decodeChunkDataDeflatedInto(
	dec: BinaryDecoder,
	target: DeflatedChunk,
): DeflatedChunk {
	target.chunkX = dec.readInt32();
	target.chunkY = dec.readInt32();
	target.chunkZ = dec.readInt32();
	target.version = dec.readUint32();
	const len = dec.readUint32();
	target.origLen = dec.readUint32();
	target.deflated = dec.readBytes(len);
	return target;
}

function decodeDeflatedChunkEntry(dec: BinaryDecoder): DeflatedChunk {
	const chunkX = dec.readInt32();
	const chunkY = dec.readInt32();
	const chunkZ = dec.readInt32();
	const version = dec.readUint32();
	const len = dec.readUint32();
	const origLen = dec.readUint32();

	return {
		chunkX,
		chunkY,
		chunkZ,
		version,
		origLen,
		deflated: dec.readBytes(len),
	};
}

export function decodeDeflatedChunkEntryFrom(
	dec: BinaryDecoder,
): DeflatedChunk {
	return decodeDeflatedChunkEntry(dec);
}

export function decodeDeflatedChunkEntryInto(
	dec: BinaryDecoder,
	target: DeflatedChunk,
): DeflatedChunk {
	target.chunkX = dec.readInt32();
	target.chunkY = dec.readInt32();
	target.chunkZ = dec.readInt32();
	target.version = dec.readUint32();
	const len = dec.readUint32();
	target.origLen = dec.readUint32();
	target.deflated = dec.readBytes(len);
	return target;
}

/** Decode a batch of deflated chunks. */
export function decodeChunkDataDeflatedBatch(
	buffer: Uint8Array,
): DeflatedChunk[] {
	const dec = new BinaryDecoder(buffer, 1);
	return decodeChunkDataDeflatedBatchFrom(dec);
}

export function decodeChunkDataDeflatedBatchFrom(
	dec: BinaryDecoder,
): DeflatedChunk[] {
	const count = dec.readUint16();
	const chunks = new Array<DeflatedChunk>(count);

	for (let i = 0; i < count; i++) {
		chunks[i] = decodeDeflatedChunkEntry(dec);
	}

	return chunks;
}

/**
 * Decode a deflated chunk batch into a reusable pre-allocated array.
 * Reuses entry objects to avoid per-chunk allocation on the hot path.
 */
export function decodeChunkDataDeflatedBatchInto(
	dec: BinaryDecoder,
	target: DeflatedChunk[],
): number {
	const count = dec.readUint16();
	for (let i = 0; i < count; i++) {
		let entry = target[i];
		if (!entry) {
			entry = {
				chunkX: 0,
				chunkY: 0,
				chunkZ: 0,
				version: 0,
				origLen: 0,
				deflated: new Uint8Array(0),
			};
			target[i] = entry;
		}
		decodeDeflatedChunkEntryInto(dec, entry);
	}
	target.length = count;
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

export function decodeSpawnPosition(buffer: Uint8Array): {
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
} {
	const dec = new BinaryDecoder(buffer, 1);
	return decodeSpawnPositionFrom(dec);
}

export function decodeSpawnPositionFrom(dec: BinaryDecoder): {
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
} {
	return {
		x: dec.readFloat32(),
		y: dec.readFloat32(),
		z: dec.readFloat32(),
		yaw: dec.readFloat32(),
		pitch: dec.readFloat32(),
	};
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

	return enc.getBytes();
}

export function decodeMobSpawn(buffer: Uint8Array): {
	mobId: number;
	mobType: number;
	x: number;
	y: number;
	z: number;
	yaw: number;
} {
	const dec = new BinaryDecoder(buffer, 1);
	return decodeMobSpawnFrom(dec);
}

export function decodeMobSpawnFrom(dec: BinaryDecoder): {
	mobId: number;
	mobType: number;
	x: number;
	y: number;
	z: number;
	yaw: number;
} {
	return {
		mobId: dec.readUint16(),
		mobType: dec.readUint8(),
		x: dec.readFloat32(),
		y: dec.readFloat32(),
		z: dec.readFloat32(),
		yaw: dec.readUint8(),
	};
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
	return enc.getBytes();
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
//   [type:1][x:f32][y:f32][z:f32][vx:f32][vy:f32][vz:f32]

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
	const enc = new BinaryEncoder(1 + 2 + 2 + 4 * 7);
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
	return enc.getBytes();
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
	return enc.getBytes();
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
	return enc.getBytes();
}

export function decodeItemPickupRejectedInto(
	dec: BinaryDecoder,
	target: ItemPickupRejectedData,
): typeof target {
	target.id = dec.readUint32();
	target.reason = dec.readUint8();
	return target;
}
