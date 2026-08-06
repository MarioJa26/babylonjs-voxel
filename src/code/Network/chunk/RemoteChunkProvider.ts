/**
 * RemoteChunkProvider — fetches chunk voxel data from the server
 * instead of generating it locally. Replaces the terrain worker
 * when in multiplayer mode.
 */
import { decodeChunkData } from "../protocol/encoder";
import type { NetClient } from "../NetClient";
import { MessageType } from "../protocol/messages";

export interface RemoteChunkData {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	blocks: Uint8Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
}

type PendingChunk = {
	resolve: (data: RemoteChunkData) => void;
	reject: (err: Error) => void;
};

export class RemoteChunkProvider {
	private pending = new Map<string, PendingChunk>();
	private inFlight = new Map<string, Promise<RemoteChunkData>>();
	private requestQueue: string[] = [];
	private processing = false;
	private static readonly CHUNK_SIZE = 32;
	private static readonly CHUNK_VOLUME = 32 * 32 * 32;

	constructor(private client: NetClient) {
		// Listen for chunk data responses
		this.client.addBinaryHandler((data: Uint8Array) => {
			if (data.byteLength < 1 || data[0] !== MessageType.ChunkData) return;
			console.log(`[RemoteGen] RX chunk data msg, ${data.byteLength} bytes`);
			const chunk = decodeChunkData(data);
			const key = `${chunk.chunkX},${chunk.chunkY},${chunk.chunkZ}`;
			const pending = this.pending.get(key);
			console.log(
				`[RemoteGen] RX decoded ${key} pending=${pending !== undefined}`,
			);
			if (pending) {
				this.pending.delete(key);
				pending.resolve(chunk);
			}
		});
	}

	async requestChunk(
		cx: number,
		cy: number,
		cz: number,
		timeoutMs = 30000,
	): Promise<RemoteChunkData> {
		const key = `${cx},${cy},${cz}`;

		// Deduplicate: if a request for this chunk is already in flight, share it
		// instead of issuing a second request (avoids duplicate wire messages and
		// torn/overlapping responses during join).
		const existing = this.inFlight.get(key);
		if (existing) return existing;

		const promise = new Promise<RemoteChunkData>((resolve, reject) => {
			// Set timeout
			const timer = setTimeout(() => {
				this.pending.delete(key);
				reject(new Error(`Chunk request timeout: ${key}`));
			}, timeoutMs);

			// Store pending
			this.pending.set(key, {
				resolve: (data) => {
					clearTimeout(timer);
					resolve(data);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});

			// Send request
			this.sendRequest(cx, cy, cz);
		}).finally(() => {
			this.inFlight.delete(key);
		});

		this.inFlight.set(key, promise);
		return promise;
	}

	private sendRequest(cx: number, cy: number, cz: number): void {
		this.client.sendChunkRequest(cx, cy, cz, 0);
	}

	/**
	 * Decompress received chunk data into a flat Uint8Array block buffer.
	 */
	static decompressBlocks(chunk: RemoteChunkData): Uint8Array {
		if (chunk.isUniform) {
			// Uniform chunk — fill with single block ID
			const result = new Uint8Array(RemoteChunkProvider.CHUNK_VOLUME);
			result.fill(chunk.uniformBlockId);
			return result;
		}

		if (chunk.palette) {
			// Palette-compressed — unpack nibbles. Matches the client's canonical
			// storage format (even index = low nibble, odd index = high nibble),
			// the same convention used by Chunk.getBlock and the voxel mesher.
			const result = new Uint8Array(RemoteChunkProvider.CHUNK_VOLUME);
			const packed = chunk.blocks;
			for (let i = 0; i < RemoteChunkProvider.CHUNK_VOLUME; i++) {
				const packedIdx = i >> 1;
				const nibble =
					i % 2 === 0 ? packed[packedIdx] & 0xf : packed[packedIdx] >> 4;
				result[i] = chunk.palette[nibble] ?? 0;
			}
			return result;
		}

		// Dense format — direct copy
		return chunk.blocks;
	}
}
