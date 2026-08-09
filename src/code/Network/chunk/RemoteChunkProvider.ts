/**
 * RemoteChunkProvider — fetches chunk voxel data from the server
 * instead of generating it locally. Replaces the terrain worker
 * when in multiplayer mode.
 *
 * Caches chunk hashes and sends them with requests. If the server's chunk
 * hasn't changed, it responds with a short "unchanged" stamp instead of
 * re-sending all the data.
 */

import { LevelDbChunkStore } from "../../World/Storage/LevelDbChunkStore";
import {
	deserializeVoxelData,
	serializeVoxelData,
} from "../../World/Storage/VoxelSerializer";
import type { NetClient } from "../NetClient";
import {
	decodeChunkData,
	decodeChunkDataBatch,
	decodeChunkUnchanged,
	hashChunk,
} from "../protocol/encoder";
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
	hash: number;
}

type PendingChunk = {
	resolve: (data: RemoteChunkData) => void;
	reject: (err: Error) => void;
};

export class RemoteChunkProvider {
	private pending = new Map<string, PendingChunk>();
	private inFlight = new Map<string, Promise<RemoteChunkData>>();
	private chunkHashes = new Map<string, number>(); // Cached chunk hashes
	private static readonly CHUNK_SIZE = 32;
	private static readonly CHUNK_VOLUME = 32 * 32 * 32;
	private store: LevelDbChunkStore;

	constructor(private client: NetClient) {
		this.store = new LevelDbChunkStore(
			client.worldName || "default",
			"./saves",
		);
		// Initialize storage asynchronously
		void this.store.open();
		// Listen for chunk data responses
		this.client.addBinaryHandler((data: Uint8Array) => {
			if (data.byteLength < 1) return;

			if (data[0] === MessageType.ChunkData) {
				const chunk = decodeChunkData(data);
				const key = `${chunk.chunkX},${chunk.chunkY},${chunk.chunkZ}`;
				this.chunkHashes.set(key, chunk.hash);
				// Cache chunk locally
				this.saveChunkToLocal(
					chunk.chunkX,
					chunk.chunkY,
					chunk.chunkZ,
					chunk.blocks,
					chunk.light,
					chunk.palette,
					chunk.isUniform,
					chunk.uniformBlockId,
				);
				const pending = this.pending.get(key);
				if (pending) {
					this.pending.delete(key);
					pending.resolve(chunk);
				}
			} else if (data[0] === MessageType.ChunkDataBatch) {
				// Batch response — multiple chunks in one message
				const chunks = decodeChunkDataBatch(data);
				for (const chunk of chunks) {
					const key = `${chunk.chunkX},${chunk.chunkY},${chunk.chunkZ}`;
					this.chunkHashes.set(key, chunk.hash);
					// Cache chunk locally
					this.saveChunkToLocal(
						chunk.chunkX,
						chunk.chunkY,
						chunk.chunkZ,
						chunk.blocks,
						chunk.light,
						chunk.palette,
						chunk.isUniform,
						chunk.uniformBlockId,
					);

					const pending = this.pending.get(key);
					if (pending) {
						this.pending.delete(key);
						pending.resolve(chunk);
					}
				}
			} else if (data[0] === MessageType.ChunkUnchanged) {
				// Server says our cached chunk is still valid
				const { cx, cy, cz, hash } = decodeChunkUnchanged(data);
				const key = `${cx},${cy},${cz}`;

				// Resolve pending with a synthetic "unchanged" marker
				// The ChunkWorkerPool will see isUniform=false, blocks=empty, and
				// know to skip meshing since the data hasn't changed
				const pending = this.pending.get(key);
				if (pending) {
					this.pending.delete(key);
					pending.resolve({
						chunkX: cx,
						chunkY: cy,
						chunkZ: cz,
						blocks: new Uint8Array(0),
						light: new Uint8Array(0),
						isUniform: false,
						uniformBlockId: 0,
						hash,
					});
				}
			}
		});
	}

	/** Load chunk from local cache. Returns null if not cached. */
	async getCachedChunk(
		cx: number,
		cy: number,
		cz: number,
	): Promise<RemoteChunkData | null> {
		const blob = await this.store.readChunk(cx, cy, cz);
		if (!blob) return null;
		const deserialized = deserializeVoxelData(blob);
		const blocks =
			deserialized.blocks instanceof Uint8Array
				? deserialized.blocks
				: new Uint8Array(0);
		const light = deserialized.lightArray ?? new Uint8Array(0);
		const hash = hashChunk(
			blocks,
			light,
			deserialized.palette ? Array.from(deserialized.palette) : undefined,
		);
		const key = `${cx},${cy},${cz}`;
		this.chunkHashes.set(key, hash);
		return {
			chunkX: cx,
			chunkY: cy,
			chunkZ: cz,
			blocks,
			light,
			palette: deserialized.palette
				? Array.from(deserialized.palette)
				: undefined,
			isUniform: deserialized.isUniform ?? false,
			uniformBlockId: deserialized.uniformBlockId ?? 0,
			hash,
		};
	}

	/** Save chunk data to local OPFS cache (fire-and-forget). */
	private saveChunkToLocal(
		cx: number,
		cy: number,
		cz: number,
		blocks: Uint8Array,
		light: Uint8Array,
		palette: number[] | undefined,
		isUniform: boolean,
		uniformBlockId: number,
	): void {
		try {
			const blob = serializeVoxelData(
				blocks,
				palette ? Uint16Array.from(palette) : null,
				isUniform,
				uniformBlockId,
				light,
				false,
			);
			this.store.writeChunk(cx, cy, cz, blob);
		} catch {
			// Ignore cache write failures
		}
	}

	async requestChunk(
		cx: number,
		cy: number,
		cz: number,
		timeoutMs = 30000,
	): Promise<RemoteChunkData> {
		const key = `${cx},${cy},${cz}`;

		// Deduplicate: if a request for this chunk is already in flight, share it
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

			// Send request with cached hash (if we have one)
			const cachedHash = this.chunkHashes.get(key) ?? 0;
			this.sendRequest(cx, cy, cz, cachedHash);
		}).finally(() => {
			this.inFlight.delete(key);
		});

		this.inFlight.set(key, promise);
		return promise;
	}

	private sendRequest(
		cx: number,
		cy: number,
		cz: number,
		cachedHash: number,
	): void {
		// console.log(`[RemoteChunkProvider] sendRequest ${cx},${cy},${cz}`);
		this.client.sendChunkRequest(cx, cy, cz, 0, cachedHash);
	}

	/**
	 * Request multiple chunks in a single batch message.
	 * More efficient than individual requests — one round-trip for many chunks.
	 * Returns promises that resolve when the batch response arrives.
	 */
	requestChunkBatch(
		coords: Array<{ cx: number; cy: number; cz: number }>,
		timeoutMs = 30000,
	): Promise<RemoteChunkData>[] {
		const requests: Array<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedHash: number;
		}> = [];
		const results: Promise<RemoteChunkData>[] = [];

		for (const { cx, cy, cz } of coords) {
			const key = `${cx},${cy},${cz}`;

			// Skip if already in flight
			if (this.inFlight.has(key)) {
				results.push(this.inFlight.get(key)!);
				continue;
			}

			const promise = new Promise<RemoteChunkData>((resolve, reject) => {
				const timer = setTimeout(() => {
					this.pending.delete(key);
					reject(new Error(`Chunk request timeout: ${key}`));
				}, timeoutMs);

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

				requests.push({
					cx,
					cy,
					cz,
					lod: 0,
					cachedHash: this.chunkHashes.get(key) ?? 0,
				});
			}).finally(() => {
				this.inFlight.delete(key);
			});

			this.inFlight.set(key, promise);
			results.push(promise);
		}

		// Send all requests in one message
		if (requests.length > 0) {
			this.client.sendChunkRequestBatch(requests);
		}

		return results;
	}

	/**
	 * Decompress received chunk data into a flat Uint8Array block buffer.
	 */
	static decompressBlocks(chunk: RemoteChunkData): Uint8Array {
		if (chunk.isUniform) {
			const result = new Uint8Array(RemoteChunkProvider.CHUNK_VOLUME);
			result.fill(chunk.uniformBlockId);
			return result;
		}

		if (chunk.palette) {
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

		return chunk.blocks;
	}
}
