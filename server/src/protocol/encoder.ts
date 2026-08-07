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

	writeUint32(value: number): void {
		this.ensure(4);
		this.view.setUint32(this.offset, value, true);
		this.offset += 4;
	}

	writeString(str: string): void {
		const encoded = new TextEncoder().encode(str);
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

	writeChunkRequest(
		cx: number,
		cy: number,
		cz: number,
		lod: number,
		cachedHash = 0,
	): void {
		this.writeUint8(MessageType.ChunkRequest);
		this.writeInt32(cx);
		this.writeInt32(cy);
		this.writeInt32(cz);
		this.writeUint8(lod);
		this.writeUint32(cachedHash);
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

	readUint32(): number {
		const v = this.view.getUint32(this.offset, true);
		this.offset += 4;
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

	readChunkRequest(): {
		cx: number;
		cy: number;
		cz: number;
		lod: number;
		cachedHash: number;
	} {
		const cx = this.readInt32();
		const cy = this.readInt32();
		const cz = this.readInt32();
		const lod = this.readUint8();
		const cachedHash = this.readUint32();
		return { cx, cy, cz, lod, cachedHash };
	}

	readChunkRequestBatch(): Array<{
		cx: number;
		cy: number;
		cz: number;
		lod: number;
		cachedHash: number;
	}> {
		const count = this.readUint16();
		const requests: Array<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedHash: number;
		}> = [];
		for (let i = 0; i < count; i++) {
			requests.push({
				cx: this.readInt32(),
				cy: this.readInt32(),
				cz: this.readInt32(),
				lod: this.readUint8(),
				cachedHash: this.readUint32(),
			});
		}
		return requests;
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
	const mix = (v: number) => {
		h ^= v & 0xff;
		h = Math.imul(h, 0x01000193); // FNV prime
	};

	// Sample blocks (check first 256 bytes + every 64th byte for large chunks)
	const step = blocks.length > 256 ? Math.floor(blocks.length / 64) : 1;
	for (let i = 0; i < blocks.length; i += step) {
		mix(blocks[i]);
	}

	// Mix light data (sample every 128th byte)
	for (let i = 0; i < light.length; i += 128) {
		mix(light[i]);
	}

	// Mix palette
	if (palette) {
		for (const p of palette) {
			mix(p & 0xff);
			mix((p >> 8) & 0xff);
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
	const dec = new BinaryDecoder(buffer.subarray(1));
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
}): Uint8Array {
	const lightBytes = data.light.length;
	const headerSize = 1 + 12 + 4 + 1; // type + chunk coords + hash + flags
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

export function decodeChunkData(buffer: Uint8Array): {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	blocks: Uint8Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
	hash: number;
} {
	const dec = new BinaryDecoder(buffer.subarray(1));
	const chunkX = dec.readInt32();
	const chunkY = dec.readInt32();
	const chunkZ = dec.readInt32();
	const hash = dec.readUint32();
	const flags = dec.readUint8();
	const isUniform = (flags & 1) !== 0;
	const hasPalette = (flags & 2) !== 0;

	let uniformBlockId = 0;
	let palette: number[] | undefined;
	let blocks: Uint8Array;

	if (isUniform) {
		uniformBlockId = dec.readUint16();
		blocks = new Uint8Array(0);
	} else if (hasPalette) {
		const paletteLen = dec.readUint16();
		palette = [];
		for (let i = 0; i < paletteLen; i++) {
			palette.push(dec.readUint16());
		}
		// Packed nibble data: remaining before light
		// We need to know the packed size — it's derived from chunk volume
		const chunkVolume = 32 * 32 * 32; // CHUNK_SIZE^3
		const packedSize = Math.ceil(chunkVolume / 2);
		blocks = new Uint8Array(packedSize);
		for (let i = 0; i < packedSize; i++) {
			blocks[i] = dec.readUint8();
		}
	} else {
		// Dense format: full chunk volume
		const chunkVolume = 32 * 32 * 32;
		blocks = new Uint8Array(chunkVolume);
		for (let i = 0; i < chunkVolume; i++) {
			blocks[i] = dec.readUint8();
		}
	}

	// Light data
	const lightLen = dec.readUint32();
	const light = new Uint8Array(lightLen);
	for (let i = 0; i < lightLen; i++) {
		light[i] = dec.readUint8();
	}

	return {
		chunkX,
		chunkY,
		chunkZ,
		blocks,
		light,
		palette,
		isUniform,
		uniformBlockId,
		hash,
	};
}

/**
 * Chunk unchanged — server → client (chunk hasn't changed since client's cached version).
 * Format: [type:1][chunkX:i32][chunkY:i32][chunkZ:i32][hash:u32]
 */
export function encodeChunkUnchanged(
	cx: number,
	cy: number,
	cz: number,
	hash: number,
): Uint8Array {
	const enc = new BinaryEncoder(17);
	enc.writeUint8(MessageType.ChunkUnchanged);
	enc.writeInt32(cx);
	enc.writeInt32(cy);
	enc.writeInt32(cz);
	enc.writeUint32(hash);
	return enc.getBytes();
}

export function decodeChunkUnchanged(buffer: Uint8Array): {
	cx: number;
	cy: number;
	cz: number;
	hash: number;
} {
	const dec = new BinaryDecoder(buffer.subarray(1));
	return {
		cx: dec.readInt32(),
		cy: dec.readInt32(),
		cz: dec.readInt32(),
		hash: dec.readUint32(),
	};
}

// ---------------------------------------------------------------------------
// Chunk request batch — client → server, multiple coords in one message
// Format: [type:1][count:u16][cx:i32][cy:i32][cz:i32][lod:u8][cachedHash:u32] × count
// ---------------------------------------------------------------------------

export function encodeChunkRequestBatch(
	requests: Array<{
		cx: number;
		cy: number;
		cz: number;
		lod: number;
		cachedHash: number;
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
		enc.writeUint32(r.cachedHash);
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
	}>,
): Uint8Array {
	// Calculate total size
	let totalSize = 3; // type + count
	for (const c of chunks) {
		totalSize += 12 + 4 + 1; // coords + hash + flags
		if (c.isUniform) {
			totalSize += 2;
		} else if (c.palette) {
			totalSize += 2 + c.palette.length * 2 + c.blocks.length;
		} else {
			totalSize += c.blocks.length;
		}
		totalSize += 4 + c.light.length;
	}

	const enc = new BinaryEncoder(totalSize);
	enc.writeUint8(MessageType.ChunkDataBatch);
	enc.writeUint16(Math.min(chunks.length, 65535));

	for (const c of chunks) {
		enc.writeInt32(c.chunkX);
		enc.writeInt32(c.chunkY);
		enc.writeInt32(c.chunkZ);
		enc.writeUint32(c.hash);

		let flags = 0;
		if (c.isUniform) flags |= 1;
		if (c.palette) flags |= 2;
		enc.writeUint8(flags);

		if (c.isUniform) {
			enc.writeUint16(c.uniformBlockId);
		} else if (c.palette) {
			enc.writeUint16(c.palette.length);
			for (const pid of c.palette) {
				enc.writeUint16(pid);
			}
			enc.writeBytes(c.blocks);
		} else {
			enc.writeBytes(c.blocks);
		}

		enc.writeUint32(c.light.length);
		enc.writeBytes(c.light);
	}

	return enc.getBytes();
}

export function decodeChunkDataBatch(buffer: Uint8Array): Array<{
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	blocks: Uint8Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
	hash: number;
}> {
	const dec = new BinaryDecoder(buffer.subarray(1));
	const count = dec.readUint16();
	const chunks: Array<{
		chunkX: number;
		chunkY: number;
		chunkZ: number;
		blocks: Uint8Array;
		light: Uint8Array;
		palette?: number[];
		isUniform: boolean;
		uniformBlockId: number;
		hash: number;
	}> = [];

	for (let i = 0; i < count; i++) {
		const chunkX = dec.readInt32();
		const chunkY = dec.readInt32();
		const chunkZ = dec.readInt32();
		const hash = dec.readUint32();
		const flags = dec.readUint8();
		const isUniform = (flags & 1) !== 0;
		const hasPalette = (flags & 2) !== 0;

		let uniformBlockId = 0;
		let palette: number[] | undefined;
		let blocks: Uint8Array;

		if (isUniform) {
			uniformBlockId = dec.readUint16();
			blocks = new Uint8Array(0);
		} else if (hasPalette) {
			const paletteLen = dec.readUint16();
			palette = [];
			for (let j = 0; j < paletteLen; j++) {
				palette.push(dec.readUint16());
			}
			const chunkVolume = 32 * 32 * 32;
			const packedSize = Math.ceil(chunkVolume / 2);
			blocks = new Uint8Array(packedSize);
			for (let j = 0; j < packedSize; j++) {
				blocks[j] = dec.readUint8();
			}
		} else {
			const chunkVolume = 32 * 32 * 32;
			blocks = new Uint8Array(chunkVolume);
			for (let j = 0; j < chunkVolume; j++) {
				blocks[j] = dec.readUint8();
			}
		}

		const lightLen = dec.readUint32();
		const light = new Uint8Array(lightLen);
		for (let j = 0; j < lightLen; j++) {
			light[j] = dec.readUint8();
		}

		chunks.push({
			chunkX,
			chunkY,
			chunkZ,
			blocks,
			light,
			palette,
			isUniform,
			uniformBlockId,
			hash,
		});
	}

	return chunks;
}
