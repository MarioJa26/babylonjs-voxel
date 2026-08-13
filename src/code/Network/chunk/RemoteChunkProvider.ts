/**
 * RemoteChunkProvider — fetches chunk voxel data from the server
 * instead of generating it locally. Replaces the terrain worker
 * when in multiplayer mode.
 *
 * Caches chunk hashes and sends them with requests. If the server's chunk
 * hasn't changed, it responds with a short "unchanged" stamp instead of
 * re-sending all the data.
 *
 * Response handling invariants:
 * - A response is only honored when it resolves a pending request created
 *   in the current epoch (see clearCache). Responses that cannot be
 *   associated with a current pending request are dropped.
 * - The epoch does NOT identify packets: chunk packets carry no request or
 *   connection identifier, so a late packet can still match a pending
 *   request by coordinates alone. Packet provenance (old-connection data)
 *   is guaranteed by NetClient, which discards every message delivered by
 *   a room that is no longer the current one. The epoch only protects
 *   pending-request cleanup and post-clear persistence callbacks.
 * - chunkVersions only ever records a version for which a local payload
 *   was actually persisted (data responses) or confirmed (cache reads).
 *   "unchanged" stamps never write the map, so a nonzero cachedVersion
 *   always implies a usable local blob exists.
 */

import { DEBUG_ENABLED, debugLog } from "../../Lib/debugLog";
import type { Chunk } from "../../World/Chunk/Chunk";
import {
	type ChunkWrite,
	LevelDbChunkStore,
} from "../../World/Storage/LevelDbChunkStore";
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

const CHUNK_VOLUME = 32 * 32 * 32;
/** Nibble-packed block payload size for palette chunks (CHUNK_VOLUME / 2). */
const PACKED_BLOCK_SIZE = CHUNK_VOLUME >>> 1;
const MAX_LIGHT_BYTES = 65536;
/** Sentinel for uniform chunks: their single block ID lives in uniformBlockId. */
const EMPTY_ENCODED_BLOCKS = new Uint8Array(0);

export interface RemoteChunkBase {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	version: number;
}

export interface RemoteChunkData extends RemoteChunkBase {
	kind: "data";
	/** Encoded block payload: nibble-packed (palette), dense u8, or dense u16. */
	blocks: Uint8Array | Uint16Array;
	light: Uint8Array;
	palette?: Uint16Array;
	isUniform: boolean;
	uniformBlockId: number;
}

export interface RemoteChunkUnchanged extends RemoteChunkBase {
	kind: "unchanged";
}

export type RemoteChunkResult = RemoteChunkData | RemoteChunkUnchanged;

type PendingChunk = {
	resolve: (result: RemoteChunkResult) => void;
	reject: (error: Error) => void;
	deadline: number;
	epoch: number;
};

export class RemoteChunkProvider {
	private pending = new Map<string, PendingChunk>();
	private inFlight = new Map<string, Promise<RemoteChunkResult>>();
	private chunkVersions = new Map<string, number>();
	private store: LevelDbChunkStore;
	/** Resolves true when the local cache store is usable, false on failure. */
	private readonly storeReady: Promise<boolean>;
	// Connection generation counter. Incremented on clearCache(); pending
	// requests created before the increment can no longer be resolved by
	// (potentially stale) late responses.
	private epoch = 0;
	// Single nearest-deadline sweep timer for batch chunk request timeouts.
	// Instead of one setTimeout per chunk, one timer fires at the earliest
	// pending deadline and rejects everything that has expired.
	private sweepTimer: ReturnType<typeof setTimeout> | null = null;
	private nextSweepDeadline = Number.POSITIVE_INFINITY;
	private static readonly DEFAULT_TIMEOUT_MS = 30000;

	constructor(private readonly client: NetClient) {
		this.store = new LevelDbChunkStore(
			client.worldName || "default",
			"./saves",
		);
		// The rejection is observed here and converted into readiness state,
		// so an opening failure can never become an unhandled rejection.
		this.storeReady = this.store.open().then(
			() => true,
			(error) => {
				console.warn("[RemoteChunkProvider] local cache unavailable:", error);
				return false;
			},
		);
		this.client.addBinaryHandler((data) => this.handleBinaryMessage(data));
	}

	private handleBinaryMessage(data: Uint8Array): void {
		if (data.byteLength === 0) return;
		try {
			switch (data[0]) {
				case MessageType.ChunkData:
					this.handleChunkData(decodeChunkData(data));
					break;
				case MessageType.ChunkDataBatch:
					this.handleChunkDataBatch(decodeChunkDataBatch(data));
					break;
				case MessageType.ChunkUnchanged:
					this.handleChunkUnchanged(decodeChunkUnchanged(data));
					break;
				case MessageType.ChunkUnchangedBatch:
					this.handleChunkUnchangedBatch(decodeChunkUnchangedBatch(data));
					break;
			}
		} catch (error) {
			console.warn("[RemoteChunkProvider] invalid chunk packet:", error);
		}
	}

	private handleChunkData(chunk: RemoteChunkData): void {
		const key = RemoteChunkProvider.makeKey(
			chunk.chunkX,
			chunk.chunkY,
			chunk.chunkZ,
		);
		if (this.isStaleVersion(key, chunk.version)) {
			if (DEBUG_ENABLED) {
				debugLog(
					`[RemoteChunkProvider] ignored stale chunk ${key} version=${chunk.version}`,
				);
			}
			return;
		}
		// A response is only honored (version recorded, data persisted) when
		// it resolves a current pending request; anything unmatched is
		// dropped — it is unsolicited or late-connection data.
		if (!this.resolvePending(key, chunk)) return;
		this.persistChunk(chunk);
		this.scheduleSweep();
	}

	private handleChunkDataBatch(chunks: readonly RemoteChunkData[]): void {
		if (chunks.length === 0) return;
		const writes = new Array<ChunkWrite>(chunks.length);
		const written: Array<{ key: string; version: number }> = new Array(
			chunks.length,
		);
		let writeCount = 0;

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const key = RemoteChunkProvider.makeKey(
				chunk.chunkX,
				chunk.chunkY,
				chunk.chunkZ,
			);
			if (this.isStaleVersion(key, chunk.version)) {
				if (DEBUG_ENABLED) {
					debugLog(
						`[RemoteChunkProvider] ignored stale batch chunk ${key} version=${chunk.version}`,
					);
				}
				continue;
			}
			if (!this.resolvePending(key, chunk)) continue;
			writes[writeCount] = {
				cx: chunk.chunkX,
				cy: chunk.chunkY,
				cz: chunk.chunkZ,
				blob: serializeVoxelData(
					chunk.blocks,
					chunk.palette ?? null,
					chunk.isUniform,
					chunk.uniformBlockId,
					chunk.light,
					false,
					chunk.version,
				),
			};
			written[writeCount] = { key, version: chunk.version };
			writeCount++;
		}

		this.scheduleSweep();

		if (writeCount === 0) return;
		writes.length = writeCount;
		written.length = writeCount;
		// One detached persistence operation per network batch — a single
		// serialization loop and a single write-chain entry with one final
		// store flush, instead of one detached promise per chunk.
		const responseEpoch = this.epoch;
		void this.store
			.writeChunks(writes)
			.then(() => {
				// Same persistence boundary as persistChunk: the chain only
				// resolves after every transaction it started has settled.
				if (this.epoch !== responseEpoch) return;
				for (let i = 0; i < written.length; i++) {
					const { key, version } = written[i];
					const current = this.chunkVersions.get(key);
					if (current === undefined || version >= current) {
						this.chunkVersions.set(key, version);
					}
				}
			})
			.catch((error) => {
				console.warn("[RemoteChunkProvider] batch persistence failed:", error);
			});
	}

	private handleChunkUnchanged(entry: {
		cx: number;
		cy: number;
		cz: number;
		version: number;
	}): void {
		const key = RemoteChunkProvider.makeKey(entry.cx, entry.cy, entry.cz);
		if (this.isStaleVersion(key, entry.version)) {
			if (DEBUG_ENABLED) {
				debugLog(
					`[RemoteChunkProvider] ignored stale unchanged stamp ${key} version=${entry.version}`,
				);
			}
			return;
		}
		// An unchanged stamp is protocol confirmation, not voxel data: it
		// resolves the request but never writes chunkVersions (the map only
		// tracks versions with a known local payload) and is never persisted.
		this.resolvePending(key, {
			kind: "unchanged",
			chunkX: entry.cx,
			chunkY: entry.cy,
			chunkZ: entry.cz,
			version: entry.version,
		});
		this.scheduleSweep();
	}

	private handleChunkUnchangedBatch(
		entries: readonly { cx: number; cy: number; cz: number; version: number }[],
	): void {
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const key = RemoteChunkProvider.makeKey(entry.cx, entry.cy, entry.cz);
			if (this.isStaleVersion(key, entry.version)) {
				if (DEBUG_ENABLED) {
					debugLog(
						`[RemoteChunkProvider] ignored stale unchanged stamp ${key} version=${entry.version}`,
					);
				}
				continue;
			}
			this.resolvePending(key, {
				kind: "unchanged",
				chunkX: entry.cx,
				chunkY: entry.cy,
				chunkZ: entry.cz,
				version: entry.version,
			});
		}
		this.scheduleSweep();
	}

	/** Returns false if the response cannot resolve a current pending request. */
	private resolvePending(key: string, result: RemoteChunkResult): boolean {
		const entry = this.pending.get(key);
		if (!entry || entry.epoch !== this.epoch) return false;
		this.pending.delete(key);
		entry.resolve(result);
		return true;
	}

	/** True when an incoming version is older than the one we already hold. */
	private isStaleVersion(key: string, incomingVersion: number): boolean {
		const current = this.chunkVersions.get(key);
		return current !== undefined && incomingVersion < current;
	}

	private persistChunk(chunk: RemoteChunkData): void {
		const key = RemoteChunkProvider.makeKey(
			chunk.chunkX,
			chunk.chunkY,
			chunk.chunkZ,
		);
		const responseEpoch = this.epoch;
		try {
			const blob = serializeVoxelData(
				chunk.blocks,
				chunk.palette ?? null,
				chunk.isUniform,
				chunk.uniformBlockId,
				chunk.light,
				false,
				chunk.version,
			);
			void this.store
				.writeChunk(chunk.chunkX, chunk.chunkY, chunk.chunkZ, blob)
				.then(() => {
					// The store's write chain resolves only after the write's
					// transactions settled, so this is the persistence
					// boundary. The epoch check drops version recording for
					// writes that raced a clearCache (which also wiped them).
					if (this.epoch !== responseEpoch) return;
					const current = this.chunkVersions.get(key);
					if (current === undefined || chunk.version >= current) {
						this.chunkVersions.set(key, chunk.version);
					}
				})
				.catch((error) => {
					console.warn(
						`[RemoteChunkProvider] local chunk save failed for ${key}:`,
						error,
					);
				});
		} catch (error) {
			console.warn("[RemoteChunkProvider] chunk serialization failed:", error);
		}
	}

	/**
	 * Clear local cache on reconnect so stale chunks are re-fetched from
	 * the server. Pending requests are rejected (they belong to the dead
	 * connection) and the epoch is bumped so those stale pending entries
	 * can no longer be resolved, and persistence callbacks that raced the
	 * clear cannot record versions (their writes are wiped too). The store
	 * is wiped — queued after any in-flight writes via its write chain.
	 */
	async clearCache(): Promise<void> {
		this.epoch++;
		this.chunkVersions.clear();

		if (this.sweepTimer !== null) {
			clearTimeout(this.sweepTimer);
			this.sweepTimer = null;
			this.nextSweepDeadline = Number.POSITIVE_INFINITY;
		}

		const reconnectError = new Error(
			"Chunk request cancelled because the connection was reset",
		);
		for (const entry of this.pending.values()) {
			entry.reject(reconnectError);
		}
		this.pending.clear();
		this.inFlight.clear();

		// Only wipe the store if it initialized; network request state above
		// is reset regardless.
		if (await this.storeReady) {
			try {
				await this.store.clear();
			} catch (error) {
				console.warn(
					"[RemoteChunkProvider] failed to clear local cache:",
					error,
				);
			}
		}
	}

	/** Load chunk from local cache. Returns null if not cached. */
	async getCachedChunk(
		cx: number,
		cy: number,
		cz: number,
	): Promise<RemoteChunkData | null> {
		if (!(await this.storeReady)) return null;
		try {
			const blob = await this.store.readChunk(cx, cy, cz);
			if (!blob) return null;
			return this.deserializeCached(blob, cx, cy, cz);
		} catch (error) {
			console.warn(
				`[RemoteChunkProvider] cache read failed for ${cx},${cy},${cz}:`,
				error,
			);
			return null;
		}
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
		if (!(await this.storeReady)) {
			// Unusable store is a complete miss: every requested chunk is
			// re-fetched from the server, never silently treated as cached.
			for (let i = 0; i < chunks.length; i++) {
				result.set(chunks[i], null);
			}
			return result;
		}

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

		let blobs: Map<string, Uint8Array>;
		try {
			blobs = await this.store.readChunks(coords);
		} catch (error) {
			console.warn("[RemoteChunkProvider] batch cache read failed:", error);
			for (let i = 0; i < chunks.length; i++) {
				result.set(chunks[i], null);
			}
			return result;
		}
		for (let i = 0; i < chunks.length; i++) {
			const c = chunks[i];
			const key = coords[i].key;
			const blob = blobs.get(key);
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
			// A corrupt blob or one older than the in-memory version is a
			// miss: the caller re-requests from the server instead of using
			// (or re-recording) stale data.
			if (resolved === null || this.isStaleVersion(key, resolved.version)) {
				result.set(c, null);
				continue;
			}
			if (DEBUG_ENABLED) {
				debugLog(
					`[RemoteChunkProvider] cache hit ${key} version=${resolved.version}`,
				);
			}
			this.chunkVersions.set(key, resolved.version);
			result.set(c, resolved);
		}
		return result;
	}

	/**
	 * Deserialize a stored blob into payload data, validating every field
	 * according to the chunk's storage representation. Returns null for
	 * malformed/corrupt blobs so they are never mistaken for valid data.
	 */
	private deserializeCached(
		blob: Uint8Array,
		cx: number,
		cy: number,
		cz: number,
	): RemoteChunkData | null {
		const deserialized = deserializeVoxelData(blob);

		const version = deserialized.version ?? 0;
		if (!Number.isInteger(version) || version < 0) return null;

		const light = deserialized.lightArray;
		if (!(light instanceof Uint8Array) || light.byteLength > MAX_LIGHT_BYTES) {
			return null;
		}

		const isUniform = deserialized.isUniform ?? false;
		const uniformBlockId = deserialized.uniformBlockId ?? 0;
		const palette = deserialized.palette ?? undefined;

		let blocks: Uint8Array | Uint16Array | null = null;
		if (isUniform) {
			if (
				!Number.isInteger(uniformBlockId) ||
				uniformBlockId < 0 ||
				uniformBlockId > 0xffff
			) {
				return null;
			}
			blocks = EMPTY_ENCODED_BLOCKS;
		} else if (palette) {
			// Nibble packing addresses at most 16 palette entries.
			if (
				!(palette instanceof Uint16Array) ||
				palette.length < 1 ||
				palette.length > 16
			) {
				return null;
			}
			if (
				!(deserialized.blocks instanceof Uint8Array) ||
				deserialized.blocks.byteLength !== PACKED_BLOCK_SIZE
			) {
				return null;
			}
			blocks = deserialized.blocks;
		} else if (deserialized.blocks instanceof Uint16Array) {
			// Dense 16-bit block storage.
			if (deserialized.blocks.length !== CHUNK_VOLUME) return null;
			blocks = deserialized.blocks;
		} else if (deserialized.blocks instanceof Uint8Array) {
			// Dense 8-bit block storage.
			if (deserialized.blocks.byteLength !== CHUNK_VOLUME) return null;
			blocks = deserialized.blocks;
		} else {
			return null;
		}

		if (blocks === null) return null;

		return {
			kind: "data",
			chunkX: cx,
			chunkY: cy,
			chunkZ: cz,
			blocks,
			light,
			palette,
			isUniform,
			uniformBlockId,
			version,
		};
	}

	async requestChunk(
		cx: number,
		cy: number,
		cz: number,
		timeoutMs = RemoteChunkProvider.DEFAULT_TIMEOUT_MS,
	): Promise<RemoteChunkResult> {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new RangeError("timeoutMs must be a positive finite number");
		}

		const key = RemoteChunkProvider.makeKey(cx, cy, cz);

		// Deduplicate: if a request for this chunk is already in flight, share it
		const existing = this.inFlight.get(key);
		if (existing !== undefined) return existing;

		let rejectRequest!: (error: Error) => void;
		let promise!: Promise<RemoteChunkResult>;
		promise = new Promise<RemoteChunkResult>((resolve, reject) => {
			rejectRequest = reject;
			this.pending.set(key, {
				resolve,
				reject,
				deadline: performance.now() + timeoutMs,
				epoch: this.epoch,
			});
		}).finally(() => {
			// Identity check: a stale rejection's finally can run after
			// clearCache() replaced this entry with a new request for the
			// same key — never delete a request that is not ours.
			if (this.inFlight.get(key) === promise) {
				this.inFlight.delete(key);
			}
		});

		this.inFlight.set(key, promise);
		this.scheduleSweep();

		try {
			this.sendRequest(cx, cy, cz, this.chunkVersions.get(key) ?? 0);
		} catch (error) {
			// Synchronous send failure: drop the pending entry and surface
			// the error to the caller instead of leaking it until a timeout.
			this.removePending(key);
			rejectRequest(error instanceof Error ? error : new Error(String(error)));
		}

		return promise;
	}

	private sendRequest(
		cx: number,
		cy: number,
		cz: number,
		cachedVersion: number,
	): void {
		if (DEBUG_ENABLED) {
			debugLog(
				`[RemoteChunkProvider] requestChunk ${cx},${cy},${cz} cachedVersion=${cachedVersion}`,
			);
		}
		this.client.sendChunkRequest(cx, cy, cz, 0, cachedVersion);
	}

	/**
	 * Request multiple chunks in a single batch message.
	 * More efficient than individual requests — one round-trip for many chunks.
	 * Returns promises that resolve when the batch response arrives.
	 * Uses a single nearest-deadline sweep timer for all timeouts.
	 */
	requestChunkBatch(
		coords: readonly { cx: number; cy: number; cz: number }[],
		timeoutMs = RemoteChunkProvider.DEFAULT_TIMEOUT_MS,
	): Promise<RemoteChunkResult>[] {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new RangeError("timeoutMs must be a positive finite number");
		}

		const results = new Array<Promise<RemoteChunkResult>>(coords.length);
		const requests: Array<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedVersion: number;
		}> = new Array(coords.length);
		const createdKeys: string[] = new Array(coords.length);
		let requestCount = 0;
		let createdCount = 0;
		const deadline = performance.now() + timeoutMs;

		for (let i = 0; i < coords.length; i++) {
			const { cx, cy, cz } = coords[i];
			const key = RemoteChunkProvider.makeKey(cx, cy, cz);

			// Skip if already in flight — share the existing promise
			const existing = this.inFlight.get(key);
			if (existing !== undefined) {
				results[i] = existing;
				continue;
			}

			let promise!: Promise<RemoteChunkResult>;
			promise = new Promise<RemoteChunkResult>((resolve, reject) => {
				this.pending.set(key, {
					resolve,
					reject,
					deadline,
					epoch: this.epoch,
				});

				requests[requestCount++] = {
					cx,
					cy,
					cz,
					lod: 0,
					cachedVersion: this.chunkVersions.get(key) ?? 0,
				};
			}).finally(() => {
				// Identity check: never delete a newer request for the same
				// key that replaced ours after clearCache().
				if (this.inFlight.get(key) === promise) {
					this.inFlight.delete(key);
				}
			});

			this.inFlight.set(key, promise);
			results[i] = promise;
			createdKeys[createdCount++] = key;
		}

		requests.length = requestCount;

		// Send all requests in one message
		if (requestCount > 0) {
			this.scheduleSweep();
			try {
				this.client.sendChunkRequestBatch(requests);
			} catch (error) {
				// Synchronous send failure: reject only the requests created
				// by THIS call (never pre-existing in-flight requests).
				const sendError =
					error instanceof Error ? error : new Error(String(error));
				for (let i = 0; i < createdCount; i++) {
					const entry = this.removePending(createdKeys[i]);
					if (entry) entry.reject(sendError);
				}
			}
		}

		return results;
	}

	/**
	 * Delete a pending entry and re-schedule the sweep: after any removal
	 * the earliest deadline can only move later (or the map can become
	 * empty), so the nearest-deadline timer must stay synchronized.
	 */
	private removePending(key: string): PendingChunk | undefined {
		const entry = this.pending.get(key);
		if (entry === undefined) return undefined;
		this.pending.delete(key);
		this.scheduleSweep();
		return entry;
	}

	/**
	 * Schedule the single sweep timer for the earliest pending deadline.
	 * Insertions and removals both call this; the timer is canceled when no
	 * requests remain.
	 */
	private scheduleSweep(): void {
		let earliest = Number.POSITIVE_INFINITY;
		for (const entry of this.pending.values()) {
			if (entry.deadline < earliest) {
				earliest = entry.deadline;
			}
		}

		if (earliest === Number.POSITIVE_INFINITY) {
			if (this.sweepTimer !== null) {
				clearTimeout(this.sweepTimer);
				this.sweepTimer = null;
			}
			this.nextSweepDeadline = earliest;
			return;
		}

		if (this.sweepTimer !== null && earliest >= this.nextSweepDeadline) {
			return;
		}

		if (this.sweepTimer !== null) {
			clearTimeout(this.sweepTimer);
		}

		this.nextSweepDeadline = earliest;
		const delay = Math.max(0, earliest - performance.now());
		this.sweepTimer = setTimeout(() => {
			this.sweepTimer = null;
			this.nextSweepDeadline = Number.POSITIVE_INFINITY;
			this.sweepPending();
		}, delay);
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
		this.scheduleSweep();
	}

	private static makeKey(cx: number, cy: number, cz: number): string {
		return `${cx},${cy},${cz}`;
	}
}
