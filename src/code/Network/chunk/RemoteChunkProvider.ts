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
	frameDeflated,
	inflateInto,
} from "../../World/Storage/BlobCompression";
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
	type DeflatedChunk,
	decodeChunkData,
	decodeChunkDataBatch,
	decodeChunkDataDeflated,
	decodeChunkDataDeflatedBatch,
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
type InflatableEntry = {
	entry: DeflatedChunk;
	key: bigint;
};

type InflatedResult = {
	write: ChunkWrite;
	key: bigint;
	version: number;
};

/**
 * Yield control back to the event loop without paying the minimum delay
 * `setTimeout(fn, 0)` incurs in browsers — first call is ~1ms, and per the
 * HTML spec, timers nested 5+ deep get clamped to a 4ms floor. A batch with
 * many inflate windows can hit that clamp on every window boundary, adding
 * real latency to something that's meant to be a cheap "let the browser
 * breathe" checkpoint.
 *
 * A MessageChannel round trip dispatches as an ordinary macrotask with no
 * such floor, so this stays close to true zero-delay regardless of nesting.
 * Shared module-level channel: concurrent callers (e.g. two chunk batches
 * decoding at once) coalesce onto the same port and get flushed together,
 * which is strictly less overhead than one channel per call site.
 */
let yieldPort: MessagePort | null = null;
let yieldResolvers: Array<() => void> = [];

function yieldToEventLoop(): Promise<void> {
	if (typeof MessageChannel === "undefined") {
		return new Promise((resolve) => setTimeout(resolve, 0));
	}
	return new Promise((resolve) => {
		if (yieldPort === null) {
			const channel = new MessageChannel();
			channel.port1.onmessage = () => {
				const resolvers = yieldResolvers;
				yieldResolvers = [];
				for (let i = 0; i < resolvers.length; i++) resolvers[i]();
			};
			yieldPort = channel.port2;
		}
		yieldResolvers.push(resolve);
		yieldPort.postMessage(null);
	});
}

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
	private static readonly HEAP_COMPACT_MIN_SIZE = 64;
	private static readonly HEAP_COMPACT_GHOST_RATIO = 4;

	/**
	 * Binary min-heap (SoA: parallel arrays, not an array of {deadline,key}
	 * objects) of pending-request deadlines backing the sweep timer, with
	 * lazy deletion. Full design rationale lives on heapPush/heapPop/
	 * sweepPending near the bottom of this class — short version: this
	 * replaces an O(n) rescan of `pending` on every single insert/remove
	 * with O(log n) inserts and O(1) removes.
	 */
	private heapDeadlines: number[] = [];
	private heapKeys: bigint[] = [];

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
				case MessageType.ChunkDataDeflated:
					void this.handleChunkDataDeflated(decodeChunkDataDeflated(data));
					break;
				case MessageType.ChunkDataDeflatedBatch:
					void this.handleChunkDataDeflatedBatch(
						decodeChunkDataDeflatedBatch(data),
					);
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
		this.clearSweepIfEmpty();
	}

	private handleChunkDataBatch(chunks: readonly RemoteChunkData[]): void {
		const len = chunks.length;
		if (len === 0) return;

		const writes = new Array<ChunkWrite>(len);
		// SoA instead of an array of {key, version} objects: avoids one
		// small object allocation per written chunk on this hot per-packet
		// path (this runs once for every incoming chunk batch).
		const writtenKeys = new Array<bigint>(len);
		const writtenVersions = new Array<number>(len);

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

			writtenKeys[writeCount] = key;
			writtenVersions[writeCount] = chunk.version;

			writeCount++;
		}

		this.clearSweepIfEmpty();

		if (writeCount === 0) return;

		writes.length = writeCount;
		writtenKeys.length = writeCount;
		writtenVersions.length = writeCount;

		const responseEpoch = this.epoch;

		void this.store
			.writeChunks(writes)
			.then(() => {
				if (this.epoch !== responseEpoch) return;

				for (let i = 0; i < writeCount; i++) {
					const key = writtenKeys[i];
					const version = writtenVersions[i];
					const current = versions.get(key);

					if (current === undefined || version >= current) {
						versions.set(key, version);
					}
				}
			})
			.catch((error) => {
				if (isCacheResetError(error)) return;
				console.warn("[RemoteChunkProvider] batch persistence failed:", error);
			});
	}

	/**
	 * Handle a deflated single-chunk response: inflate the serialized blob,
	 * validate it through the same path as cache reads, then resolve + persist.
	 * The inflated blob is stored directly — the store re-compresses it for
	 * IndexedDB — so the decode→reserialize round trip of the legacy message
	 * is skipped and the blob bytes are byte-identical to the server's.
	 */
	private async handleChunkDataDeflated(entry: DeflatedChunk): Promise<void> {
		const key = packCoords(entry.chunkX, entry.chunkY, entry.chunkZ);
		if (this.isStaleVersion(key, entry.version)) {
			if (DEBUG_ENABLED) {
				debugLog(
					`[RemoteChunkProvider] ignored stale chunk ${key} version=${entry.version}`,
				);
			}
			return;
		}

		let blob: Uint8Array;
		try {
			blob = await inflateInto(entry.deflated, entry.origLen);
		} catch (error) {
			console.warn(
				`[RemoteChunkProvider] failed to inflate chunk ${key}:`,
				error,
			);
			this.rejectPendingRequest(
				key,
				new ChunkProtocolError("Chunk payload failed to decompress"),
			);
			return;
		}

		const chunk = this.deserializeCached(
			blob,
			entry.chunkX,
			entry.chunkY,
			entry.chunkZ,
		);
		if (chunk === null) {
			console.warn(
				`[RemoteChunkProvider] corrupt deflated chunk ${key} (dropped)`,
			);
			this.rejectPendingRequest(
				key,
				new ChunkProtocolError("Chunk payload failed validation"),
			);
			return;
		}

		// A response is only honored (version recorded, data persisted) when
		// it resolves a current pending request; anything unmatched is
		// dropped — it is unsolicited or late-connection data.
		if (!this.resolvePending(key, chunk)) return;
		this.persistChunk(
			chunk,
			frameDeflated(entry.origLen, entry.deflated),
			true,
		);
		this.clearSweepIfEmpty();
	}

	private readonly windowSize = 4;

	private async handleChunkDataDeflatedBatch(
		entries: readonly DeflatedChunk[],
	): Promise<void> {
		const entryCount = entries.length;

		if (entryCount === 0) {
			return;
		}

		const versions = this.chunkVersions;

		/*
		 * Preallocate for the worst case where every entry passes the stale check.
		 * Only indices below inflatableCount are initialized.
		 */
		const inflatable = new Array<InflatableEntry>(entryCount);
		let inflatableCount = 0;

		for (let i = 0; i < entryCount; i++) {
			const entry = entries[i];
			const key = packCoords(entry.chunkX, entry.chunkY, entry.chunkZ);

			const currentVersion = versions.get(key);

			if (currentVersion !== undefined && entry.version < currentVersion) {
				if (DEBUG_ENABLED) {
					debugLog(
						`[RemoteChunkProvider] ignored stale batch chunk ` +
							`${key} version=${entry.version}`,
					);
				}

				continue;
			}

			inflatable[inflatableCount++] = {
				entry,
				key,
			};
		}

		if (inflatableCount === 0) {
			this.clearSweepIfEmpty();
			return;
		}

		const windowSize = this.windowSize;

		/*
		 * At most one successful write can be produced per inflatable entry.
		 * Dense indexed writes avoid repeated push-based capacity growth.
		 */
		const writes = new Array<ChunkWrite>(inflatableCount);
		// SoA instead of an array of {key, version} objects — same reasoning
		// as handleChunkDataBatch above.
		const writtenKeys = new Array<bigint>(inflatableCount);
		const writtenVersions = new Array<number>(inflatableCount);

		let writeCount = 0;

		for (
			let windowStart = 0;
			windowStart < inflatableCount;
			windowStart += windowSize
		) {
			const windowEnd = Math.min(windowStart + windowSize, inflatableCount);

			const taskCount = windowEnd - windowStart;
			const tasks = new Array<Promise<InflatedResult | null>>(taskCount);

			for (let i = windowStart; i < windowEnd; i++) {
				const { entry, key } = inflatable[i];
				// Calling the method directly — rather than building and
				// immediately invoking a per-iteration async arrow closure —
				// avoids allocating a fresh function object for every chunk
				// in the batch. The method reference is fixed on the
				// prototype; only the returned Promise is allocated, which
				// was unavoidable either way.
				tasks[i - windowStart] = this.inflateAndValidateEntry(entry, key);
			}

			const results = await Promise.all(tasks);

			for (let i = 0; i < results.length; i++) {
				const result = results[i];

				if (result === null) {
					continue;
				}

				writes[writeCount] = result.write;
				writtenKeys[writeCount] = result.key;
				writtenVersions[writeCount] = result.version;

				writeCount++;
			}

			/*
			 * Promise completion yields only to the microtask queue.
			 * yieldToEventLoop() creates a real task-boundary between
			 * inflate windows without the setTimeout(fn, 0) clamp — see its
			 * doc comment for why that matters for a batch with many windows.
			 */
			if (windowEnd < inflatableCount) {
				await yieldToEventLoop();
			}
		}

		this.clearSweepIfEmpty();

		if (writeCount === 0) {
			return;
		}

		/*
		 * Remove unused preallocated slots before passing the arrays to storage.
		 * This does not copy the arrays.
		 */
		writes.length = writeCount;
		writtenKeys.length = writeCount;
		writtenVersions.length = writeCount;

		const responseEpoch = this.epoch;

		void this.store
			.writeChunks(writes)
			.then(() => {
				if (this.epoch !== responseEpoch) {
					return;
				}

				for (let i = 0; i < writeCount; i++) {
					const key = writtenKeys[i];
					const version = writtenVersions[i];
					const currentVersion = versions.get(key);

					if (currentVersion === undefined || version >= currentVersion) {
						versions.set(key, version);
					}
				}
			})
			.catch((error) => {
				if (isCacheResetError(error)) {
					return;
				}

				console.warn("[RemoteChunkProvider] batch persistence failed:", error);
			});
	}

	/**
	 * Inflate + validate one deflated chunk entry and (on success) resolve
	 * its pending request. Extracted out of the window loop above into a
	 * real method — called directly instead of via an inline async arrow
	 * IIFE — so no per-chunk closure object is allocated on this hot path.
	 */
	private async inflateAndValidateEntry(
		entry: DeflatedChunk,
		key: bigint,
	): Promise<InflatedResult | null> {
		let blob: Uint8Array;

		try {
			blob = await inflateInto(entry.deflated, entry.origLen);
		} catch (error) {
			console.warn(
				`[RemoteChunkProvider] failed to inflate chunk ${key}:`,
				error,
			);

			this.rejectPendingRequest(
				key,
				new ChunkProtocolError("Chunk payload failed to decompress"),
			);

			return null;
		}

		const chunk = this.deserializeCached(
			blob,
			entry.chunkX,
			entry.chunkY,
			entry.chunkZ,
		);

		if (chunk === null) {
			console.warn(
				`[RemoteChunkProvider] corrupt deflated chunk ${key} (dropped)`,
			);

			this.rejectPendingRequest(
				key,
				new ChunkProtocolError("Chunk payload failed validation"),
			);

			return null;
		}

		if (!this.resolvePending(key, chunk)) {
			return null;
		}

		return {
			write: {
				cx: chunk.chunkX,
				cy: chunk.chunkY,
				cz: chunk.chunkZ,
				blob: frameDeflated(entry.origLen, entry.deflated),
				preCompressed: true,
			},
			key,
			version: chunk.version,
		};
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
		this.clearSweepIfEmpty();
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
			this.clearSweepIfEmpty();
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

	private persistChunk(
		chunk: RemoteChunkData,
		blobOverride?: Uint8Array,
		preCompressed = false,
	): void {
		const key = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
		const responseEpoch = this.epoch;
		try {
			const blob =
				blobOverride ??
				serializeVoxelData(
					chunk.blocks,
					chunk.palette ?? null,
					chunk.isUniform,
					chunk.uniformBlockId,
					chunk.light,
					false,
					chunk.version,
				);
			void this.store
				.writeChunk(
					chunk.chunkX,
					chunk.chunkY,
					chunk.chunkZ,
					blob,
					undefined,
					preCompressed,
				)
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

		this.heapDeadlines.length = 0;
		this.heapKeys.length = 0;

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
	VALIDATE_NETWORK_CHUNKS = false;
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
			if (this.VALIDATE_NETWORK_CHUNKS)
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
		this.heapPush(deadline, key);
		this.scheduleSweepAt(deadline);

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
			// All entries created in this call share the same `deadline`,
			// so a single heapPush per entry plus one scheduleSweepAt below
			// (instead of a full pending-map rescan) is enough.
			this.heapPush(deadline, key);

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

		this.scheduleSweepAt(deadline);

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
	 * Reject the pending request for `key` (e.g. a corrupt or undecompressible
	 * payload). Terminal like a timeout — the caller will retry on demand.
	 */
	private rejectPendingRequest(key: bigint, error: Error): void {
		const entry = this.removePending(key);
		if (entry) entry.reject(error);
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
	 * Delete a pending entry. O(1): unlike the old scheduleSweep-based
	 * implementation this does not rescan `pending` to find the next sweep
	 * deadline on every removal — see the heap doc comments below for why
	 * that scan is no longer necessary.
	 */
	private removePending(key: bigint): PendingChunk | undefined {
		const entry = this.pending.get(key);
		if (entry === undefined) return undefined;
		this.pending.delete(key);
		this.clearSweepIfEmpty();
		return entry;
	}

	// ---------------------------------------------------------------------
	// Sweep timer: lazy-deletion binary min-heap over (deadline, key) pairs.
	//
	// The old implementation rescanned every entry in `pending` on every
	// single insert or removal to find the new earliest deadline — O(n) per
	// mutation, which is O(n^2) over a streaming burst with hundreds of
	// concurrent chunk requests churning in and out.
	//
	// Instead: heapPush is O(log n) on insert; removePending is O(1) and
	// does NOT touch the heap at all. A heap entry left behind by a
	// resolved/removed request becomes a "ghost" — harmless, because
	// sweepPending only rejects a popped entry when `pending` still holds
	// that exact key with a matching deadline (a key can be re-requested
	// with a fresh deadline after resolving, so a plain key match isn't
	// enough). Every ghost is bounded: it gets popped and discarded within
	// timeoutMs of being pushed regardless of what else happens, and
	// compactHeapIfNeeded rebuilds early if ghosts start to dominate.
	// ---------------------------------------------------------------------

	private heapPush(deadline: number, key: bigint): void {
		const deadlines = this.heapDeadlines;
		const keys = this.heapKeys;

		let i = deadlines.length;
		deadlines.push(deadline);
		keys.push(key);

		while (i > 0) {
			const parent = (i - 1) >>> 1;
			if (deadlines[parent] <= deadlines[i]) break;

			const pd = deadlines[parent];
			const pk = keys[parent];
			deadlines[parent] = deadlines[i];
			keys[parent] = keys[i];
			deadlines[i] = pd;
			keys[i] = pk;

			i = parent;
		}
	}

	/** Removes the heap's minimum entry. Caller must have already read it. */
	private heapPop(): void {
		const deadlines = this.heapDeadlines;
		const keys = this.heapKeys;
		const last = deadlines.length - 1;

		deadlines[0] = deadlines[last];
		keys[0] = keys[last];
		deadlines.pop();
		keys.pop();

		const n = deadlines.length;
		let i = 0;

		while (true) {
			const l = i * 2 + 1;
			const r = i * 2 + 2;
			let smallest = i;

			if (l < n && deadlines[l] < deadlines[smallest]) smallest = l;
			if (r < n && deadlines[r] < deadlines[smallest]) smallest = r;
			if (smallest === i) break;

			const sd = deadlines[smallest];
			const sk = keys[smallest];
			deadlines[smallest] = deadlines[i];
			keys[smallest] = keys[i];
			deadlines[i] = sd;
			keys[i] = sk;

			i = smallest;
		}
	}

	/**
	 * Rebuild the heap from only the live `pending` set once ghost entries
	 * clearly dominate it. Keeps steady-state heap size O(pending.size)
	 * instead of O(requests issued in the last timeoutMs), which matters
	 * under sustained high-throughput streaming with a long timeoutMs.
	 * Cheap to skip: only runs from sweepPending, and only actually
	 * rebuilds past a minimum size threshold.
	 */
	private compactHeapIfNeeded(): void {
		const heapSize = this.heapDeadlines.length;
		const pendingSize = this.pending.size;

		if (
			heapSize <= RemoteChunkProvider.HEAP_COMPACT_MIN_SIZE ||
			heapSize <= pendingSize * RemoteChunkProvider.HEAP_COMPACT_GHOST_RATIO
		) {
			return;
		}

		this.heapDeadlines.length = 0;
		this.heapKeys.length = 0;

		for (const [key, entry] of this.pending) {
			this.heapPush(entry.deadline, key);
		}
	}

	/**
	 * Ensure the sweep timer fires at or before `deadline`. No-op if a
	 * timer already scheduled for an earlier-or-equal time exists. Same
	 * coalescing behavior as the old scheduleSweep, just without the O(n)
	 * scan to discover `deadline` — every caller already knows it, since
	 * it's the deadline of the entry/batch it just inserted.
	 */
	private scheduleSweepAt(deadline: number): void {
		if (this.sweepTimer !== null && deadline >= this.nextSweepDeadline) {
			return;
		}

		if (this.sweepTimer !== null) {
			clearTimeout(this.sweepTimer);
		}

		this.nextSweepDeadline = deadline;

		const now = performance.now();
		const delay = deadline <= now ? 0 : deadline - now;

		this.sweepTimer = setTimeout(() => {
			this.sweepTimer = null;
			this.nextSweepDeadline = Number.POSITIVE_INFINITY;
			this.sweepPending();
		}, delay);
	}

	/**
	 * If no pending requests remain, cancel the timer and drop the heap
	 * outright — anything left in it is necessarily a ghost. Called after
	 * every removal-only code path; insertions always (re)schedule
	 * explicitly via scheduleSweepAt, so no separate "insert" branch is
	 * needed here.
	 */
	private clearSweepIfEmpty(): void {
		if (this.pending.size !== 0) return;

		this.heapDeadlines.length = 0;
		this.heapKeys.length = 0;

		if (this.sweepTimer !== null) {
			clearTimeout(this.sweepTimer);
			this.sweepTimer = null;
		}

		this.nextSweepDeadline = Number.POSITIVE_INFINITY;
	}

	/**
	 * Pop and reject every pending entry whose deadline has elapsed, then
	 * reschedule for the next real deadline. A popped heap entry only
	 * rejects something if `pending` still has that exact key AND its
	 * stored deadline still matches this heap entry's — without that
	 * match check, a stale ghost could reject a newer, still-live request
	 * for the same key.
	 */
	private sweepPending(): void {
		const now = performance.now();
		const pending = this.pending;
		const deadlines = this.heapDeadlines;
		const keys = this.heapKeys;

		while (deadlines.length > 0 && deadlines[0] <= now) {
			const key = keys[0];
			const deadline = deadlines[0];
			this.heapPop();

			const entry = pending.get(key);
			if (entry !== undefined && entry.deadline === deadline) {
				pending.delete(key);
				entry.reject(new Error(`Chunk request timeout: ${key}`));
			}
		}

		this.compactHeapIfNeeded();

		if (pending.size === 0) {
			this.clearSweepIfEmpty();
			return;
		}

		if (this.heapDeadlines.length > 0) {
			this.scheduleSweepAt(this.heapDeadlines[0]);
		}
	}
}
