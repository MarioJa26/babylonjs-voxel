/**
 * RemoteChunkProvider — fetches chunk voxel data from the server
 * instead of generating it locally. Replaces the terrain worker
 * when in multiplayer mode.
 *
 * Caches chunk hashes and sends them with requests. If the server's chunk
 * hasn't changed, it responds with a short "unchanged" stamp instead of
 * re-sending all the data.
 */

import type { Chunk } from "../../World/Chunk/Chunk";
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
	decodeChunkUnchangedBatch,
} from "../protocol/encoder";
import { MessageType } from "../protocol/messages";

export interface RemoteChunkData {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	blocks: Uint8Array;
	light: Uint8Array;
	palette?: Uint16Array;
	isUniform: boolean;
	uniformBlockId: number;
	version: number;
}

type PendingChunk = {
	resolve: (data: RemoteChunkData) => void;
	reject: (err: Error) => void;
};

export class RemoteChunkProvider {
	private pending = new Map<string, PendingChunk>();
	private inFlight = new Map<string, Promise<RemoteChunkData>>();
	private chunkVersions = new Map<string, number>();
	private static readonly CHUNK_SIZE = 32;
	private static readonly CHUNK_VOLUME = 32 * 32 * 32;
	private store: LevelDbChunkStore;
	private cacheCleared = false;

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
				const resolved: RemoteChunkData = {
					...chunk,
					palette: chunk.palette ? Uint16Array.from(chunk.palette) : undefined,
				};
				const key = `${resolved.chunkX},${resolved.chunkY},${resolved.chunkZ}`;
				console.log(
					`[RemoteChunkProvider] received chunk ${key} version=${resolved.version}`,
				);
				this.chunkVersions.set(key, resolved.version);
				void this.saveChunkToLocal(
					resolved.chunkX,
					resolved.chunkY,
					resolved.chunkZ,
					resolved.blocks,
					resolved.light,
					resolved.palette,
					resolved.isUniform,
					resolved.uniformBlockId,
					resolved.version,
				);
				const pending = this.pending.get(key);
				if (pending) {
					this.pending.delete(key);
					pending.resolve(resolved);
				}
			} else if (data[0] === MessageType.ChunkDataBatch) {
				const chunks = decodeChunkDataBatch(data);
				for (const chunk of chunks) {
					const resolved: RemoteChunkData = {
						...chunk,
						palette: chunk.palette
							? Uint16Array.from(chunk.palette)
							: undefined,
					};
					const key = `${resolved.chunkX},${resolved.chunkY},${resolved.chunkZ}`;
					console.log(
						`[RemoteChunkProvider] received batch chunk ${key} version=${resolved.version}`,
					);
					this.chunkVersions.set(key, resolved.version);
					void this.saveChunkToLocal(
						resolved.chunkX,
						resolved.chunkY,
						resolved.chunkZ,
						resolved.blocks,
						resolved.light,
						resolved.palette,
						resolved.isUniform,
						resolved.uniformBlockId,
						resolved.version,
					);

					const pending = this.pending.get(key);
					if (pending) {
						this.pending.delete(key);
						pending.resolve(resolved);
					}
				}
			} else if (data[0] === MessageType.ChunkUnchanged) {
				const { cx, cy, cz, version } = decodeChunkUnchanged(data);
				const key = `${cx},${cy},${cz}`;
				this.chunkVersions.set(key, version);

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
						version,
					});
				}
			} else if (data[0] === MessageType.ChunkUnchangedBatch) {
				const entries = decodeChunkUnchangedBatch(data);
				for (const { cx, cy, cz, version } of entries) {
					const key = `${cx},${cy},${cz}`;
					this.chunkVersions.set(key, version);

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
							version,
						});
					}
				}
			}
		});
	}

	/** Clear local cache on reconnect so stale chunks are re-fetched from server */
	async clearCache(): Promise<void> {
		this.chunkVersions.clear();
		try {
			await this.store.open();
			await this.store.clear();
		} catch {
			// Ignore clear failures
		}
	}

	/** Load chunk from local cache. Returns null if not cached. */
	async getCachedChunk(
		cx: number,
		cy: number,
		cz: number,
	): Promise<RemoteChunkData | null> {
		const blob = await this.store.readChunk(cx, cy, cz);
		if (!blob) return null;
		const versionStr = await this.store.getMeta(`v:${cx},${cy},${cz}`);
		const version = versionStr ? Number.parseInt(versionStr, 10) || 0 : 0;
		return this.deserializeCached(blob, cx, cy, cz, version);
	}

	/**
	 * Batched cache lookup for a set of chunks: single readChunks call (one
	 * IndexedDB transaction) instead of N sequential per-chunk awaits.
	 * PERF: skips hashChunk entirely — the hash is populated from server
	 * responses, never recomputed from the blob.
	 */
	async getCachedChunks(
		chunks: readonly Chunk[],
	): Promise<Map<Chunk, RemoteChunkData | null>> {
		const result = new Map<Chunk, RemoteChunkData | null>();
		if (chunks.length === 0) return result;

		const coords: Array<{ cx: number; cy: number; cz: number; key: string }> =
			new Array(chunks.length);
		for (let i = 0; i < chunks.length; i++) {
			const c = chunks[i];
			coords[i] = {
				cx: c.chunkX,
				cy: c.chunkY,
				cz: c.chunkZ,
				key: `${c.chunkX},${c.chunkY},${c.chunkZ}`,
			};
		}

		const blobs = await this.store.readChunks(coords);
		for (let i = 0; i < chunks.length; i++) {
			const c = chunks[i];
			const blob = blobs.get(coords[i].key);
			if (!blob) {
				result.set(c, null);
				continue;
			}
			const versionStr = await this.store.getMeta(
				`v:${c.chunkX},${c.chunkY},${c.chunkZ}`,
			);
			const version = versionStr ? Number.parseInt(versionStr, 10) || 0 : 0;
			console.log(
				`[RemoteChunkProvider] cache hit ${c.chunkX},${c.chunkY},${c.chunkZ} version=${version}`,
			);
			this.chunkVersions.set(coords[i].key, version);
			result.set(
				c,
				this.deserializeCached(blob, c.chunkX, c.chunkY, c.chunkZ, version),
			);
		}
		return result;
	}

	/** Zero-copy view conversion of a stored blob into RemoteChunkData. */
	private deserializeCached(
		blob: Uint8Array,
		cx: number,
		cy: number,
		cz: number,
		version: number,
	): RemoteChunkData {
		const deserialized = deserializeVoxelData(blob);
		return {
			chunkX: cx,
			chunkY: cy,
			chunkZ: cz,
			blocks:
				deserialized.blocks instanceof Uint8Array
					? deserialized.blocks
					: new Uint8Array(0),
			light: deserialized.lightArray ?? new Uint8Array(0),
			palette: deserialized.palette ?? undefined,
			isUniform: deserialized.isUniform ?? false,
			uniformBlockId: deserialized.uniformBlockId ?? 0,
			version,
		};
	}

	private async saveChunkToLocal(
		cx: number,
		cy: number,
		cz: number,
		blocks: Uint8Array,
		light: Uint8Array,
		palette: Uint16Array | undefined,
		isUniform: boolean,
		uniformBlockId: number,
		version: number,
	): Promise<void> {
		try {
			const blob = serializeVoxelData(
				blocks,
				palette ?? null,
				isUniform,
				uniformBlockId,
				light,
				false,
			);
			await this.store.writeChunk(cx, cy, cz, blob);
			await this.store.setMeta(`v:${cx},${cy},${cz}`, String(version));
			console.log(
				`[RemoteChunkProvider] saved ${cx},${cy},${cz} version=${version} to local cache`,
			);
		} catch (e) {
			console.warn(`[RemoteChunkProvider] saveChunkToLocal failed:`, e);
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

			const cachedVersion = this.chunkVersions.get(key) ?? 0;
			this.sendRequest(cx, cy, cz, cachedVersion);
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
		cachedVersion: number,
	): void {
		console.log(
			`[RemoteChunkProvider] requestChunk ${cx},${cy},${cz} cachedVersion=${cachedVersion}`,
		);
		this.client.sendChunkRequest(cx, cy, cz, 0, cachedVersion);
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
			cachedVersion: number;
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
					cachedVersion: this.chunkVersions.get(key) ?? 0,
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
