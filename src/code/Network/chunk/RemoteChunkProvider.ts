/**
 * RemoteChunkProvider — fetches chunk voxel data from the server
 * instead of generating it locally. Replaces the terrain worker
 * when in multiplayer mode.
 *
 * Caches chunk hashes and sends them with requests. If the server's chunk
 * hasn't changed, it responds with a short "unchanged" stamp instead of
 * re-sending all the data.
 */

import { debugLog } from "../../Lib/debugLog";
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
	deadline: number;
};

// Shared read-only empty arrays: unchanged-stamp responses and malformed
// blobs both produce "no data" chunks — one allocation instead of 2-4
// per chunk. Consumers never write into blocks/light.
const EMPTY_BLOCKS = new Uint8Array(0);
const EMPTY_LIGHT = new Uint8Array(0);

export class RemoteChunkProvider {
	private pending = new Map<string, PendingChunk>();
	private inFlight = new Map<string, Promise<RemoteChunkData>>();
	private chunkVersions = new Map<string, number>();
	private static readonly CHUNK_VOLUME = 32 * 32 * 32;
	private store: LevelDbChunkStore;
	// Single sweep timer for batch chunk request timeouts. Instead of
	// creating one setTimeout per chunk (100 chunks = 100 timers), a single
	// timer fires periodically and rejects all timed-out entries at once.
	private sweepTimer: ReturnType<typeof setTimeout> | null = null;
	private static readonly SWEEP_INTERVAL_MS = 5000;
	private static readonly DEFAULT_TIMEOUT_MS = 30000;

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
				const resolved: RemoteChunkData = { ...chunk };
				const key = `${resolved.chunkX},${resolved.chunkY},${resolved.chunkZ}`;
				debugLog(
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
					const resolved: RemoteChunkData = { ...chunk };
					const key = `${resolved.chunkX},${resolved.chunkY},${resolved.chunkZ}`;
					debugLog(
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
						blocks: EMPTY_BLOCKS,
						light: EMPTY_LIGHT,
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
							blocks: EMPTY_BLOCKS,
							light: EMPTY_LIGHT,
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
		if (this.sweepTimer) {
			clearTimeout(this.sweepTimer);
			this.sweepTimer = null;
		}
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
		return this.deserializeCached(blob, cx, cy, cz);
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
			const resolved = this.deserializeCached(
				blob,
				c.chunkX,
				c.chunkY,
				c.chunkZ,
			);
			debugLog(
				`[RemoteChunkProvider] cache hit ${c.chunkX},${c.chunkY},${c.chunkZ} version=${resolved.version}`,
			);
			this.chunkVersions.set(coords[i].key, resolved.version);
			result.set(c, resolved);
		}
		return result;
	}

	/** Zero-copy view conversion of a stored blob into RemoteChunkData. */
	private deserializeCached(
		blob: Uint8Array,
		cx: number,
		cy: number,
		cz: number,
	): RemoteChunkData {
		const deserialized = deserializeVoxelData(blob);
		return {
			chunkX: cx,
			chunkY: cy,
			chunkZ: cz,
			blocks:
				deserialized.blocks instanceof Uint8Array
					? deserialized.blocks
					: EMPTY_BLOCKS,
			light: deserialized.lightArray ?? EMPTY_LIGHT,
			palette: deserialized.palette ?? undefined,
			isUniform: deserialized.isUniform ?? false,
			uniformBlockId: deserialized.uniformBlockId ?? 0,
			version: deserialized.version ?? 0,
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
				version,
			);
			await this.store.writeChunk(cx, cy, cz, blob);
			debugLog(
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
		timeoutMs = RemoteChunkProvider.DEFAULT_TIMEOUT_MS,
	): Promise<RemoteChunkData> {
		const key = `${cx},${cy},${cz}`;

		// Deduplicate: if a request for this chunk is already in flight, share it
		const existing = this.inFlight.get(key);
		if (existing) return existing;

		const promise = new Promise<RemoteChunkData>((resolve, reject) => {
			this.pending.set(key, {
				resolve,
				reject,
				deadline: performance.now() + timeoutMs,
			});
			this.ensureSweepRunning();

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
		debugLog(
			`[RemoteChunkProvider] requestChunk ${cx},${cy},${cz} cachedVersion=${cachedVersion}`,
		);
		this.client.sendChunkRequest(cx, cy, cz, 0, cachedVersion);
	}

	/**
	 * Request multiple chunks in a single batch message.
	 * More efficient than individual requests — one round-trip for many chunks.
	 * Returns promises that resolve when the batch response arrives.
	 * Uses a single sweep timer for all timeouts instead of one per chunk.
	 */
	requestChunkBatch(
		coords: Array<{ cx: number; cy: number; cz: number }>,
		timeoutMs = RemoteChunkProvider.DEFAULT_TIMEOUT_MS,
	): Promise<RemoteChunkData>[] {
		const requests: Array<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedVersion: number;
		}> = [];
		const results: Promise<RemoteChunkData>[] = [];
		const now = performance.now();
		const deadline = now + timeoutMs;

		for (const { cx, cy, cz } of coords) {
			const key = `${cx},${cy},${cz}`;

			// Skip if already in flight
			if (this.inFlight.has(key)) {
				results.push(this.inFlight.get(key)!);
				continue;
			}

			const promise = new Promise<RemoteChunkData>((resolve, reject) => {
				this.pending.set(key, {
					resolve,
					reject,
					deadline,
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
			this.ensureSweepRunning();
			this.client.sendChunkRequestBatch(requests);
		}

		return results;
	}

	/**
	 * Ensure the sweep timer is running. It fires periodically to reject
	 * all timed-out pending chunk requests in one pass, instead of one
	 * setTimeout per chunk.
	 */
	private ensureSweepRunning(): void {
		if (this.sweepTimer) return;
		this.sweepTimer = setTimeout(() => {
			this.sweepTimer = null;
			this.sweepPending();
		}, RemoteChunkProvider.SWEEP_INTERVAL_MS);
	}

	/** Reject all pending entries whose deadline has passed. */
	private sweepPending(): void {
		const now = performance.now();
		for (const [key, entry] of this.pending) {
			if (now >= entry.deadline) {
				this.pending.delete(key);
				entry.reject(new Error(`Chunk request timeout: ${key}`));
			}
		}
		// Keep the sweep alive as long as there are pending requests.
		if (this.pending.size > 0) {
			this.ensureSweepRunning();
		}
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
			const len = RemoteChunkProvider.CHUNK_VOLUME;
			// Step by 2: read one byte, extract both nibbles. Bitwise & 1
			// instead of modulo for parity check. Palette indices from the
			// encoder are always valid — no ?? 0 fallback needed.
			for (let i = 0; i < len; i += 2) {
				const byte = packed[i >> 1];
				result[i] = chunk.palette[byte & 0x0f];
				result[i + 1] = chunk.palette[byte >> 4];
			}
			return result;
		}

		return chunk.blocks;
	}
}
