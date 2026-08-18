/**
 * RemoteChunkProvider — fetches chunk voxel data from the server
 * instead of generating it locally. Replaces the terrain worker
 * when in multiplayer mode.
 *
 * Caches chunk versions and sends them with requests. If the server's chunk
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
 * - An "unchanged" stamp is only honored when its version exactly matches
 *   the cachedVersion sent with the request. Anything else is a protocol
 *   violation: the pending request is rejected, the cached version is
 *   forgotten, and the local blob is evicted, so the caller's retry
 *   re-fetches full data with cachedVersion 0.
 * - chunkVersions only ever records a version for which a local payload
 *   was actually persisted (data responses) or confirmed (cache reads).
 *   "unchanged" stamps never write the map, so a nonzero cachedVersion
 *   always implies a usable local blob exists.
 */

import { DEBUG_ENABLED, debugLog } from "../../Lib/debugLog";
import type { Chunk } from "../../World/Chunk/Chunk";
import { packCoords } from "../../World/Chunk/DataStructures/ChunkCoords";
import {
	type ChunkWrite,
	chunkKey,
	isCacheResetError,
	LevelDbChunkStore,
} from "../../World/Storage/LevelDbChunkStore";
import {
	deserializeVoxelDataShared,
	serializeVoxelData,
} from "../../World/Storage/VoxelSerializer";
import { mpLocalCacheName } from "../../World/WorldContext";
import type { NetClient } from "../NetClient";
import {
	decodeChunkData,
	decodeChunkDataBatch,
	decodeChunkUnchanged,
	decodeChunkUnchangedBatch,
} from "../protocol/encoder";
import { ChunkResultKind, MessageType } from "../protocol/messages";

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
	kind: ChunkResultKind.Data;
	/** Encoded block payload: nibble-packed (palette), dense u8, or dense u16. */
	blocks: Uint8Array | Uint16Array;
	light: Uint8Array;
	palette?: Uint16Array;
	isUniform: boolean;
	uniformBlockId: number;
}

export interface RemoteChunkUnchanged extends RemoteChunkBase {
	kind: ChunkResultKind.Unchanged;
}

export type RemoteChunkResult = RemoteChunkData | RemoteChunkUnchanged;

/** A server response that violates the chunk protocol (e.g. an unchanged
 * stamp whose version does not match the requested cachedVersion). */
export class ChunkProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChunkProtocolError";
	}
}

/** Result of processing one unchanged stamp against the pending map. */
enum UnchangedOutcome {
	/** No pending request (or a stale-epoch one) — stamp dropped. */
	Ignored,
	/** Stamp matched the requested cachedVersion — request resolved. */
	Resolved,
	/** Stamp violated the protocol — request rejected and cache evicted. */
	Rejected,
}

type PendingChunk = {
	resolve: (result: RemoteChunkResult) => void;
	reject: (error: Error) => void;
	deadline: number;
	epoch: number;
	/** Exact cachedVersion sent with this request. */
	cachedVersion: number;
	/** True when the sent cachedVersion referenced a real local payload
	 * (chunkVersions had an entry), as opposed to a cache-miss sentinel 0. */
	hasCachedPayload: boolean;
};

export class RemoteChunkProvider {
	private pending = new Map<bigint, PendingChunk>();
	private inFlight = new Map<bigint, Promise<RemoteChunkResult>>();
	private chunkVersions = new Map<bigint, number>();
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
		// Ephemeral per-session cache name (not the server worldName) so the
		// connect-time clear() is instant and the DB never accumulates server
		// chunks across sessions.
		this.store = new LevelDbChunkStore(mpLocalCacheName(), "./saves");
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
					this.handleChunkData(decodeChunkData(data, true));
					break;
				case MessageType.ChunkDataBatch:
					this.handleChunkDataBatch(decodeChunkDataBatch(data, true));
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
		const key = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
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
		const len = chunks.length;
		if (len === 0) return;

		const writes = new Array<ChunkWrite>(len);
		const written: Array<{ key: bigint; version: number }> = new Array(len);

		let writeCount = 0;
		const versions = this.chunkVersions;

		for (let i = 0; i < len; i++) {
			const chunk = chunks[i];
			const key = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);

			const currentVersion = versions.get(key);
			if (currentVersion !== undefined && chunk.version < currentVersion) {
				if (DEBUG_ENABLED) {
					debugLog(
						`[RemoteChunkProvider] ignored stale batch chunk ${key} version=${chunk.version}`,
					);
				}
				continue;
			}

			if (!this.resolvePending(key, chunk)) {
				continue;
			}

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

			written[writeCount] = {
				key,
				version: chunk.version,
			};

			writeCount++;
		}

		this.scheduleSweep();

		if (writeCount === 0) return;

		writes.length = writeCount;
		written.length = writeCount;

		const responseEpoch = this.epoch;

		void this.store
			.writeChunks(writes)
			.then(() => {
				if (this.epoch !== responseEpoch) return;

				for (let i = 0; i < writeCount; i++) {
					const entry = written[i];
					const current = versions.get(entry.key);

					if (current === undefined || entry.version >= current) {
						versions.set(entry.key, entry.version);
					}
				}
			})
			.catch((error) => {
				if (isCacheResetError(error)) return;
				console.warn("[RemoteChunkProvider] batch persistence failed:", error);
			});
	}

	private handleChunkUnchanged(entry: {
		cx: number;
		cy: number;
		cz: number;
		version: number;
	}): void {
		const outcome = this.processUnchangedEntry(entry);
		if (outcome === UnchangedOutcome.Ignored) return;
		if (outcome === UnchangedOutcome.Rejected) {
			this.evictChunk(entry.cx, entry.cy, entry.cz);
		}
		this.scheduleSweep();
	}

	/**
	 * An unchanged stamp asserts "your cached copy is current": it is only
	 * honored when its version exactly matches the cachedVersion sent with
	 * the request. On a mismatch (protocol violation/corruption) the pending
	 * request is rejected as a terminal failure — never resolved, never left
	 * to time out, never retried in place (without a request ID, an
	 * automatic resend could be answered by a late response to the original
	 * request). The cached version is forgotten and the local blob evicted,
	 * so the caller's retry path re-fetches full data with cachedVersion 0.
	 */
	private processUnchangedEntry(entry: {
		cx: number;
		cy: number;
		cz: number;
		version: number;
	}): UnchangedOutcome {
		const key = packCoords(entry.cx, entry.cy, entry.cz);
		const pending = this.pending.get(key);

		if (pending === undefined || pending.epoch !== this.epoch) {
			return UnchangedOutcome.Ignored;
		}

		this.pending.delete(key);

		if (!pending.hasCachedPayload || entry.version !== pending.cachedVersion) {
			this.chunkVersions.delete(key);

			pending.reject(
				new ChunkProtocolError(
					`Chunk unchanged version mismatch for ${key}: ` +
						`requested cachedVersion=${pending.cachedVersion}, ` +
						`received version=${entry.version}`,
				),
			);

			return UnchangedOutcome.Rejected;
		}

		pending.resolve({
			kind: ChunkResultKind.Unchanged,
			chunkX: entry.cx,
			chunkY: entry.cy,
			chunkZ: entry.cz,
			version: entry.version,
		});

		return UnchangedOutcome.Resolved;
	}

	private handleChunkUnchangedBatch(
		entries: readonly {
			cx: number;
			cy: number;
			cz: number;
			version: number;
		}[],
	): void {
		const len = entries.length;
		if (len === 0) return;

		let evictCoords: Array<{ cx: number; cy: number; cz: number }> | null =
			null;
		let evictCount = 0;
		let removedAny = false;

		for (let i = 0; i < len; i++) {
			const entry = entries[i];
			const outcome = this.processUnchangedEntry(entry);

			if (outcome === UnchangedOutcome.Ignored) {
				continue;
			}

			removedAny = true;

			if (outcome === UnchangedOutcome.Rejected) {
				if (evictCoords === null) {
					evictCoords = new Array(len);
				}

				evictCoords[evictCount++] = {
					cx: entry.cx,
					cy: entry.cy,
					cz: entry.cz,
				};
			}
		}

		if (removedAny) {
			this.scheduleSweep();
		}

		if (evictCoords !== null && evictCount > 0) {
			evictCoords.length = evictCount;

			this.store.deleteChunks(evictCoords).catch((error) => {
				if (isCacheResetError(error)) return;
				console.warn(
					"[RemoteChunkProvider] failed to evict invalid cache entries:",
					error,
				);
			});
		}
	}

	/** Returns false if the response cannot resolve a current pending request. */
	private resolvePending(key: bigint, result: RemoteChunkResult): boolean {
		const entry = this.pending.get(key);
		if (!entry) {
			// Response arrived but no pending entry — either already
			// timed out/swept, or unsolicited data. Log periodically
			// to avoid spam.
			return false;
		}
		if (entry.epoch !== this.epoch) {
			console.warn(
				`[RemoteChunkProvider] epoch mismatch ${key}: ` +
					`response epoch=${entry.epoch} current=${this.epoch} (dropped)`,
			);
			this.pending.delete(key);
			return false;
		}
		this.pending.delete(key);
		entry.resolve(result);
		return true;
	}

	/** True when an incoming version is older than the one we already hold. */
	private isStaleVersion(key: bigint, incomingVersion: number): boolean {
		const current = this.chunkVersions.get(key);
		return current !== undefined && incomingVersion < current;
	}

	private persistChunk(chunk: RemoteChunkData): void {
		const key = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
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
					if (isCacheResetError(error)) return;
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

		const pending = this.pending;

		for (const entry of pending.values()) {
			entry.reject(reconnectError);
		}

		pending.clear();
		this.inFlight.clear();

		if (await this.storeReady) {
			try {
				await this.store.clear({ discardPendingWrites: true });
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
			const resolved = this.deserializeCached(blob, cx, cy, cz);
			if (resolved === null) {
				// Corrupt blob: evict so it is not re-read and re-scanned
				// on every miss, and cannot repopulate the version map.
				this.evictChunk(cx, cy, cz);
			}
			return resolved;
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
	 * PERF: deserializes the blob directly — no content hashing on read.
	 */
	async getCachedChunks(
		chunks: readonly Chunk[],
	): Promise<Map<Chunk, RemoteChunkData | null>> {
		const result = new Map<Chunk, RemoteChunkData | null>();
		const len = chunks.length;

		if (len === 0) return result;

		if (!(await this.storeReady)) {
			for (let i = 0; i < len; i++) {
				result.set(chunks[i], null);
			}
			return result;
		}

		const coords: Array<{ cx: number; cy: number; cz: number }> = new Array(
			len,
		);
		const keys: Array<bigint> = new Array(len);

		for (let i = 0; i < len; i++) {
			const c = chunks[i];
			coords[i] = {
				cx: c.chunkX,
				cy: c.chunkY,
				cz: c.chunkZ,
			};
			keys[i] = packCoords(c.chunkX, c.chunkY, c.chunkZ);
		}

		let blobs: Map<string, Uint8Array>;

		try {
			blobs = await this.store.readChunks(coords);
		} catch (error) {
			console.warn("[RemoteChunkProvider] batch cache read failed:", error);

			for (let i = 0; i < len; i++) {
				result.set(chunks[i], null);
			}

			return result;
		}

		const corruptCoords: Array<{ cx: number; cy: number; cz: number }> = [];
		const versions = this.chunkVersions;

		for (let i = 0; i < len; i++) {
			const c = chunks[i];
			const coord = coords[i];
			const key = keys[i];
			const blob = blobs.get(chunkKey(coord.cx, coord.cy, coord.cz));

			if (blob === undefined) {
				result.set(c, null);
				continue;
			}

			const resolved = this.deserializeCached(
				blob,
				c.chunkX,
				c.chunkY,
				c.chunkZ,
			);

			if (resolved === null) {
				corruptCoords.push({
					cx: c.chunkX,
					cy: c.chunkY,
					cz: c.chunkZ,
				});
				result.set(c, null);
				continue;
			}

			const currentVersion = versions.get(key);
			if (currentVersion !== undefined && resolved.version < currentVersion) {
				result.set(c, null);
				continue;
			}

			if (DEBUG_ENABLED) {
				debugLog(
					`[RemoteChunkProvider] cache hit ${key} version=${resolved.version}`,
				);
			}

			versions.set(key, resolved.version);
			result.set(c, resolved);
		}

		if (corruptCoords.length > 0) {
			this.store.deleteChunks(corruptCoords).catch((error) => {
				if (isCacheResetError(error)) return;
				console.warn(
					"[RemoteChunkProvider] failed to evict corrupt cache entries:",
					error,
				);
			});
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
		const deserialized = deserializeVoxelDataShared(blob);

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
			const packed = deserialized.blocks;
			if (
				!(packed instanceof Uint8Array) ||
				packed.byteLength !== PACKED_BLOCK_SIZE
			) {
				return null;
			}
			// Strict per-byte validation: every nibble must be a valid
			// palette index. An out-of-range nibble would otherwise read
			// undefined from the palette, which typed arrays coerce to 0 —
			// silent corruption turning into air blocks. Allocation-free
			// scan of PACKED_BLOCK_SIZE bytes.
			const paletteLength = palette.length;
			for (let i = 0; i < packed.length; i++) {
				const byte = packed[i];
				const low = byte & 0x0f;
				const high = byte >>> 4;
				if (low >= paletteLength || high >= paletteLength) {
					return null;
				}
			}
			blocks = packed;
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
			kind: ChunkResultKind.Data,
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

		const key = packCoords(cx, cy, cz);

		const existing = this.inFlight.get(key);
		if (existing !== undefined) return existing;

		const cached = this.chunkVersions.get(key);
		const hasCachedPayload = cached !== undefined;
		const cachedVersion = cached ?? 0;
		const deadline = performance.now() + timeoutMs;
		const requestEpoch = this.epoch;

		let rejectRequest!: (error: Error) => void;
		let promise!: Promise<RemoteChunkResult>;

		promise = new Promise<RemoteChunkResult>((resolve, reject) => {
			rejectRequest = reject;

			this.pending.set(key, {
				resolve,
				reject,
				deadline,
				epoch: requestEpoch,
				cachedVersion,
				hasCachedPayload,
			});
		}).finally(() => {
			if (this.inFlight.get(key) === promise) {
				this.inFlight.delete(key);
			}
		});

		this.inFlight.set(key, promise);
		this.scheduleSweep();

		try {
			this.sendRequest(cx, cy, cz, cachedVersion);
		} catch (error) {
			const entry = this.removePending(key);
			if (entry) {
				rejectRequest(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}

		return promise;
	}

	private sendRequest(
		cx: number,
		cy: number,
		cz: number,
		cachedVersion: number,
	): void {
		if (!this.client.isConnected) {
			throw new Error(
				`Chunk request send failed: not connected (${cx},${cy},${cz})`,
			);
		}
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

		const len = coords.length;
		const results = new Array<Promise<RemoteChunkResult>>(len);

		if (len === 0) {
			return results;
		}

		const requests: Array<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedVersion: number;
		}> = new Array(len);

		const createdKeys: bigint[] = new Array(len);
		let requestCount = 0;
		let createdCount = 0;

		const deadline = performance.now() + timeoutMs;
		const requestEpoch = this.epoch;
		const inFlight = this.inFlight;
		const pending = this.pending;
		const versions = this.chunkVersions;

		for (let i = 0; i < len; i++) {
			const coord = coords[i];
			const cx = coord.cx;
			const cy = coord.cy;
			const cz = coord.cz;
			const key = packCoords(cx, cy, cz);

			const existing = inFlight.get(key);
			if (existing !== undefined) {
				results[i] = existing;
				continue;
			}

			const cached = versions.get(key);
			const hasCachedPayload = cached !== undefined;
			const cachedVersion = cached ?? 0;

			let promise!: Promise<RemoteChunkResult>;

			promise = new Promise<RemoteChunkResult>((resolve, reject) => {
				pending.set(key, {
					resolve,
					reject,
					deadline,
					epoch: requestEpoch,
					cachedVersion,
					hasCachedPayload,
				});
			}).finally(() => {
				if (inFlight.get(key) === promise) {
					inFlight.delete(key);
				}
			});

			inFlight.set(key, promise);
			results[i] = promise;

			requests[requestCount++] = {
				cx,
				cy,
				cz,
				lod: 0,
				cachedVersion,
			};

			createdKeys[createdCount++] = key;
		}

		if (requestCount === 0) {
			return results;
		}

		requests.length = requestCount;

		if (!this.client.isConnected) {
			console.warn(
				`[RemoteChunkProvider] batch send ABORTED (not connected): ${createdCount} new entries`,
			);

			const sendError = new Error("Chunk batch send failed: not connected");

			for (let i = 0; i < createdCount; i++) {
				const entry = this.removePending(createdKeys[i]);
				if (entry) entry.reject(sendError);
			}

			return results;
		}

		this.scheduleSweep();

		try {
			this.client.sendChunkRequestBatch(requests);
		} catch (error) {
			const sendError =
				error instanceof Error ? error : new Error(String(error));

			for (let i = 0; i < createdCount; i++) {
				const entry = this.removePending(createdKeys[i]);
				if (entry) entry.reject(sendError);
			}
		}

		return results;
	}

	/**
	 * Evict a local blob the client can no longer trust (protocol
	 * violation or corruption). Serialized through the store write chain.
	 */
	private evictChunk(cx: number, cy: number, cz: number): void {
		void this.store.deleteChunk(cx, cy, cz).catch((error) => {
			if (isCacheResetError(error)) return;
			console.warn(
				`[RemoteChunkProvider] failed to evict invalid cache entry ${cx},${cy},${cz}:`,
				error,
			);
		});
	}

	/**
	 * Delete a pending entry and re-schedule the sweep: after any removal
	 * the earliest deadline can only move later (or the map can become
	 * empty), so the nearest-deadline timer must stay synchronized.
	 */
	private removePending(key: bigint): PendingChunk | undefined {
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
		const pending = this.pending;

		if (pending.size === 0) {
			if (this.sweepTimer !== null) {
				clearTimeout(this.sweepTimer);
				this.sweepTimer = null;
			}

			this.nextSweepDeadline = Number.POSITIVE_INFINITY;
			return;
		}

		let earliest = Number.POSITIVE_INFINITY;

		for (const entry of pending.values()) {
			const deadline = entry.deadline;
			if (deadline < earliest) {
				earliest = deadline;
			}
		}

		if (this.sweepTimer !== null && earliest >= this.nextSweepDeadline) {
			return;
		}

		if (this.sweepTimer !== null) {
			clearTimeout(this.sweepTimer);
		}

		this.nextSweepDeadline = earliest;

		const delay =
			earliest <= performance.now() ? 0 : earliest - performance.now();

		this.sweepTimer = setTimeout(() => {
			this.sweepTimer = null;
			this.nextSweepDeadline = Number.POSITIVE_INFINITY;
			this.sweepPending();
		}, delay);
	}

	/** Reject all pending entries whose deadline has passed. */
	private sweepPending(): void {
		const now = performance.now();
		const pending = this.pending;

		for (const [key, entry] of pending) {
			if (now >= entry.deadline) {
				pending.delete(key);
				entry.reject(new Error(`Chunk request timeout: ${key}`));
			}
		}

		this.scheduleSweep();
	}
}
