/**
 * Binary encoder/decoder for b102 multiplayer protocol.
 *
 * All integers are little-endian. Uses DataView for cross-platform correctness.
 */
import {
	type BlockEditData,
	type ChatMessageData,
	MessageType,
	type PlayerJoinData,
	type PlayerLeaveData,
	type PlayerStateData,
} from "./messages";

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
		if (this.offset + needed <= this.buffer.byteLength) return;
		let newCap = this.buffer.byteLength * 2;
		while (newCap < this.offset + needed) newCap *= 2;
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

	writeString(str: string): void {
		const encoded = new TextEncoder().encode(str);
		this.writeUint16(encoded.byteLength);
		this.ensure(encoded.byteLength);
		this.buffer.set(encoded, this.offset);
		this.offset += encoded.byteLength;
	}

	writePlayerState(data: PlayerStateData): void {
		this.writeUint8(MessageType.PlayerState);
		this.writeString(data.sessionId);
		this.writeFloat32(data.x);
		this.writeFloat32(data.y);
		this.writeFloat32(data.z);
		this.writeUint8(data.yaw);
		this.writeUint8(data.pitch);
		this.writeUint8(data.animation);
	}

	writeBlockEdit(data: BlockEditData): void {
		this.writeUint8(MessageType.BlockEdit);
		this.writeString(data.sessionId);
		this.writeInt32(data.x);
		this.writeInt32(data.y);
		this.writeInt32(data.z);
		this.writeUint16(data.blockId);
		this.writeUint8(data.action);
	}

	writeChunkRequest(cx: number, cz: number, lod: number): void {
		this.writeUint8(MessageType.ChunkRequest);
		this.writeInt32(cx);
		this.writeInt32(cz);
		this.writeUint8(lod);
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

	constructor(private buffer: Uint8Array) {
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

	readString(): string {
		const len = this.readUint16();
		const start = this.offset;
		this.offset += len;
		return new TextDecoder().decode(this.buffer.subarray(start, this.offset));
	}

	readPlayerState(): PlayerStateData {
		const sessionId = this.readString();
		const x = this.readFloat32();
		const y = this.readFloat32();
		const z = this.readFloat32();
		const yaw = this.readUint8();
		const pitch = this.readUint8();
		const animation = this.readUint8();
		return { sessionId, x, y, z, yaw, pitch, animation };
	}

	readBlockEdit(): BlockEditData {
		const sessionId = this.readString();
		const x = this.readInt32();
		const y = this.readInt32();
		const z = this.readInt32();
		const blockId = this.readUint16();
		const action = this.readUint8();
		return { sessionId, x, y, z, blockId, action };
	}

	readChunkRequest(): { cx: number; cz: number; lod: number } {
		const cx = this.readInt32();
		const cz = this.readInt32();
		const lod = this.readUint8();
		return { cx, cz, lod };
	}
}

// Batch encoding for server → client broadcasts
export function encodePlayerStateBatch(states: PlayerStateData[]): Uint8Array {
	const enc = new BinaryEncoder(2 + states.length * 20);
	enc.writeUint8(MessageType.PlayerStateBatch);
	enc.writeUint8(Math.min(states.length, 255));
	for (const s of states) {
		enc.writeString(s.sessionId);
		enc.writeFloat32(s.x);
		enc.writeFloat32(s.y);
		enc.writeFloat32(s.z);
		enc.writeUint8(s.yaw);
		enc.writeUint8(s.pitch);
		enc.writeUint8(s.animation);
	}
	return enc.getBytes();
}

export function decodePlayerStateBatch(buffer: Uint8Array): PlayerStateData[] {
	const dec = new BinaryDecoder(buffer.subarray(1)); // skip type byte
	const count = dec.readUint8();
	const states: PlayerStateData[] = [];
	for (let i = 0; i < count; i++) {
		states.push(dec.readPlayerState());
	}
	return states;
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
	const dec = new BinaryDecoder(buffer.subarray(1)); // skip type byte
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

export function encodePlayerJoin(data: PlayerJoinData): Uint8Array {
	const enc = new BinaryEncoder(64);
	enc.writeUint8(MessageType.PlayerJoin);
	enc.writeString(data.sessionId);
	enc.writeString(data.name);
	return enc.getBytes();
}

export function decodePlayerJoin(buffer: Uint8Array): PlayerJoinData {
	const dec = new BinaryDecoder(buffer.subarray(1));
	return {
		sessionId: dec.readString(),
		name: dec.readString(),
	};
}

export function encodePlayerLeave(data: PlayerLeaveData): Uint8Array {
	const enc = new BinaryEncoder(64);
	enc.writeUint8(MessageType.PlayerLeave);
	enc.writeString(data.sessionId);
	return enc.getBytes();
}

export function decodePlayerLeave(buffer: Uint8Array): PlayerLeaveData {
	const dec = new BinaryDecoder(buffer.subarray(1));
	return { sessionId: dec.readString() };
}

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
	const dec = new BinaryDecoder(buffer.subarray(1));
	return dec.readBlockEdit();
}

export function encodeChatMessage(data: ChatMessageData): Uint8Array {
	const enc = new BinaryEncoder(256);
	enc.writeUint8(MessageType.ChatMessage);
	enc.writeString(data.sessionId);
	enc.writeString(data.name);
	enc.writeString(data.message);
	return enc.getBytes();
}

export function decodeChatMessage(buffer: Uint8Array): ChatMessageData {
	const dec = new BinaryDecoder(buffer.subarray(1));
	return {
		sessionId: dec.readString(),
		name: dec.readString(),
		message: dec.readString(),
	};
}
