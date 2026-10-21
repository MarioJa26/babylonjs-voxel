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
import { FRAME_WORK_BUDGET } from "../../Lib/FrameWorkBudget";
import { notePipelineWork } from "../../Lib/PipelineStats";
import type { Chunk } from "../../World/Chunk/Chunk";
import { packCoords } from "../../World/Chunk/DataStructures/ChunkCoords";
import {
	ChunkPipelineStage,
	noteChunkRequested,
	noteChunkStage,
	reapStaleLatencyTracks,
} from "../../World/Chunk/Loading/ChunkPipeline";
import { priorityForChunk } from "../../World/Chunk/Loading/ChunkPriority";
import {
	frameDeflated,
	inflateInto,
} from "../../World/Storage/BlobCompression";
import {
	type ChunkWrite,
	chunkKey,
	isCacheResetError,
	LevelDbChunkStore,
	packChunkKeyNumeric,
} from "../../World/Storage/LevelDbChunkStore";
import {
	deserializeVoxelDataShared,
	serializeVoxelData,
} from "../../World/Storage/VoxelSerializer";
import { mpLocalCacheName } from "../../World/WorldContext";
import type { NetClient } from "../NetClient";
import {
	BinaryDecoder,
	type DeflatedChunk,
	decodeChunkData,
	decodeChunkDataBatch,
	decodeChunkDataDeflatedBatchFrom,
	decodeChunkDataDeflatedFrom,
	decodeChunkUnchangedBatchInto,
	decodeChunkUnchangedInto,
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
	/**
	 * `NetClient.roomGeneration` at the moment this request was created.
	 *
	 * Distinguishes "the cache was reset" (`epoch`) from "the room was replaced"
	 * (`connectionGeneration`). Both are needed: a room swap can happen without
	 * a cache clear, and in that case epoch alone would let a stale in-flight
	 * result through.
	 */
	connectionGeneration: number;
	/** Exact cachedVersion sent with this request. */
	cachedVersion: number;
	/** True when the sent cachedVersion referenced a real local payload
	 * (chunkVersions had an entry), as opposed to a cache-miss sentinel 0. */
	hasCachedPayload: boolean;
};

type InflatedResult = ChunkWrite | null;
const DEFAULT_LOD = 0;

/** Wire shape of one chunk request. Structurally matches NetClient's ChunkRequest. */
type ChunkRequestEntry = {
	cx: number;
	cy: number;
	cz: number;
	lod: number;
	cachedVersion: number;
};

/** Below this batch size, priority ordering is not worth its overhead. */
const MIN_BATCH_TO_SORT = 8;

// See Lib/yieldToEventLoop.ts for the shared zero-delay event-loop yield
// (MessageChannel macrotask, no setTimeout(0) clamp).
import { yieldToEventLoop } from "../../Lib/yieldToEventLoop";

export class RemoteChunkProvider {
	private readonly pending = new Map<bigint, PendingChunk>();
	private readonly inFlight = new Map<bigint, Promise<RemoteChunkResult>>();

	private readonly chunkVersions = new Map<bigint, number>();

	private static readonly CHUNK_VERSIONS_MAX = 32768;
	private static readonly DEFAULT_TIMEOUT_MS = 30_000;
	private static readonly SWEEP_INTERVAL_MS = 1_000;
	private static readonly HEAP_COMPACT_MIN_SIZE = 64;
	private static readonly HEAP_COMPACT_GHOST_RATIO = 4;
	private static readonly VALIDATE_NETWORK_CHUNKS = false;

	private readonly store: LevelDbChunkStore;
	private readonly storeReady: Promise<boolean>;

	private epoch = 0;
	private budgetPacedInflates = 0;

	private sweepTimer: ReturnType<typeof setTimeout> | null = null;

	private readonly chunkDecoder = new BinaryDecoder(new Uint8Array(0));

	private readonly unchangedSingleScratch = {
		cx: 0,
		cy: 0,
		cz: 0,
		version: 0,
	};

	private readonly unchangedBatchScratch: Array<{
		cx: number;
		cy: number;
		cz: number;
		version: number;
	}> = [];

	private heapDeadlines: number[] = [];
	private heapKeys: bigint[] = [];

	private readonly windowSize = 4;

	private priorityScratch = new Float64Array(MIN_BATCH_TO_SORT);

	constructor(private readonly client: NetClient) {
		this.store = new LevelDbChunkStore(mpLocalCacheName(), "./saves");

		this.storeReady = this.store.open().then(
			() => true,
			(error: unknown) => {
				console.warn("[RemoteChunkProvider] local cache unavailable:", error);
				return false;
			},
		);

		this.client.addBinaryHandler((data) => {
			this.handleBinaryMessage(data);
		});
	}

	private noteChunkVersion(key: bigint, version: number): void {
		const versions = this.chunkVersions;

		if (versions.has(key)) {
			versions.delete(key);
		}

		versions.set(key, version);

		if (versions.size <= RemoteChunkProvider.CHUNK_VERSIONS_MAX) {
			return;
		}

		let toEvict = RemoteChunkProvider.CHUNK_VERSIONS_MAX >>> 2;

		for (const oldestKey of versions.keys()) {
			versions.delete(oldestKey);

			toEvict--;
			if (toEvict <= 0) break;
		}
	}

	private noteBudgetPaced(count: number): void {
		if (count <= 0) return;

		this.budgetPacedInflates += count;
		notePipelineWork({ inflatePaced: count });
	}

	private handleBinaryMessage(data: Uint8Array): void {
		if (data.byteLength === 0) return;

		const decoder = this.chunkDecoder;

		try {
			switch (data[0]) {
				case MessageType.ChunkData:
					this.handleChunkData(decodeChunkData(data, true));
					break;

				case MessageType.ChunkDataBatch:
					this.handleChunkDataBatch(decodeChunkDataBatch(data, true));
					break;

				case MessageType.ChunkDataDeflated:
					decoder.setBuffer(data);
					decoder.readUint8();

					void this.handleChunkDataDeflated(
						decodeChunkDataDeflatedFrom(decoder),
					);
					break;

				case MessageType.ChunkDataDeflatedBatch:
					decoder.setBuffer(data);
					decoder.readUint8();

					void this.handleChunkDataDeflatedBatch(
						decodeChunkDataDeflatedBatchFrom(decoder),
					);
					break;

				case MessageType.ChunkUnchanged:
					decoder.setBuffer(data);
					decoder.readUint8();

					decodeChunkUnchangedInto(decoder, this.unchangedSingleScratch);

					this.handleChunkUnchanged(this.unchangedSingleScratch);
					break;

				case MessageType.ChunkUnchangedBatch:
					decoder.setBuffer(data);
					decoder.readUint8();

					decodeChunkUnchangedBatchInto(decoder, this.unchangedBatchScratch);

					this.handleChunkUnchangedBatch(this.unchangedBatchScratch);
					break;
			}
		} catch (error) {
			console.warn("[RemoteChunkProvider] invalid chunk packet:", error);
		}
	}

	private handleChunkData(chunk: RemoteChunkData): void {
		const key = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
		const pending = this.getCurrentPending(key);

		if (pending === undefined) return;

		if (!this.acceptFreshVersion(key, chunk.version)) {
			this.rejectStaleResponse(
				key,
				pending,
				chunk.version,
				chunk.chunkX,
				chunk.chunkY,
				chunk.chunkZ,
			);
			return;
		}

		noteChunkStage(ChunkPipelineStage.Received);
		noteChunkStage(ChunkPipelineStage.Validated);

		if (!this.resolvePendingIfCurrent(key, pending, chunk)) {
			return;
		}

		this.persistChunk(chunk);
		this.clearSweepIfEmpty();
	}

	private handleChunkDataBatch(chunks: readonly RemoteChunkData[]): void {
		const count = chunks.length;
		if (count === 0) return;

		const writes = new Array<ChunkWrite>(count);
		const writtenKeys = new Array<bigint>(count);
		const writtenVersions = new Array<number>(count);

		let acceptedCount = 0;
		let writeCount = 0;

		for (let i = 0; i < count; i++) {
			const chunk = chunks[i];
			const key = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
			const pending = this.getCurrentPending(key);

			if (pending === undefined) continue;

			if (!this.acceptFreshVersion(key, chunk.version)) {
				this.rejectStaleResponse(
					key,
					pending,
					chunk.version,
					chunk.chunkX,
					chunk.chunkY,
					chunk.chunkZ,
				);
				continue;
			}

			acceptedCount++;

			if (!this.resolvePendingIfCurrent(key, pending, chunk)) {
				continue;
			}

			try {
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
			} catch (error) {
				console.warn(
					`[RemoteChunkProvider] failed to serialize chunk ${key}:`,
					error,
				);
			}
		}

		if (acceptedCount > 0) {
			noteChunkStage(ChunkPipelineStage.Received, acceptedCount);
			noteChunkStage(ChunkPipelineStage.Validated, acceptedCount);
		}

		this.clearSweepIfEmpty();

		if (writeCount === 0) return;

		writes.length = writeCount;
		writtenKeys.length = writeCount;
		writtenVersions.length = writeCount;

		const responseEpoch = this.epoch;
		const responseConnectionGeneration = this.client.connectionGeneration;

		void this.store.writeChunks(writes).then(
			() => {
				noteChunkStage(ChunkPipelineStage.Persisted, writeCount);

				if (
					this.epoch !== responseEpoch ||
					this.client.connectionGeneration !== responseConnectionGeneration
				) {
					return;
				}

				for (let i = 0; i < writeCount; i++) {
					const key = writtenKeys[i];
					const version = writtenVersions[i];
					const current = this.chunkVersions.get(key);

					if (current === undefined || version >= current) {
						this.noteChunkVersion(key, version);
					}
				}
			},
			(error: unknown) => {
				if (isCacheResetError(error)) return;

				console.warn("[RemoteChunkProvider] batch persistence failed:", error);
			},
		);
	}

	private async handleChunkDataDeflated(entry: DeflatedChunk): Promise<void> {
		const key = packCoords(entry.chunkX, entry.chunkY, entry.chunkZ);
		const pending = this.getCurrentPending(key);

		if (pending === undefined) return;

		if (!this.acceptFreshVersion(key, entry.version)) {
			this.rejectStaleResponse(
				key,
				pending,
				entry.version,
				entry.chunkX,
				entry.chunkY,
				entry.chunkZ,
			);
			return;
		}

		noteChunkStage(ChunkPipelineStage.Received);

		const inflateStartMs = performance.now();

		let blob: Uint8Array;

		try {
			blob = await inflateInto(entry.deflated, entry.origLen);
		} catch (error) {
			notePipelineWork({
				inflateBytes: entry.origLen,
				inflateMs: performance.now() - inflateStartMs,
				chunksAbandoned: 1,
			});

			console.warn(
				`[RemoteChunkProvider] failed to inflate chunk ${key}:`,
				error,
			);

			noteChunkStage(ChunkPipelineStage.Abandoned);

			this.rejectPendingIfCurrent(
				key,
				pending,
				new ChunkProtocolError("Chunk payload failed to decompress"),
			);
			return;
		}

		notePipelineWork({
			inflateBytes: entry.origLen,
			inflateMs: performance.now() - inflateStartMs,
			chunkResponses: 1,
		});

		if (!this.isPendingCurrent(key, pending)) {
			noteChunkStage(ChunkPipelineStage.Abandoned);
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

			noteChunkStage(ChunkPipelineStage.Abandoned);

			this.rejectPendingIfCurrent(
				key,
				pending,
				new ChunkProtocolError("Chunk payload failed validation"),
			);
			return;
		}

		noteChunkStage(ChunkPipelineStage.Validated);

		if (!this.resolvePendingIfCurrent(key, pending, chunk)) {
			return;
		}

		this.persistChunk(
			chunk,
			frameDeflated(entry.origLen, entry.deflated),
			true,
		);

		this.clearSweepIfEmpty();
	}

	private async handleChunkDataDeflatedBatch(
		entries: readonly DeflatedChunk[],
	): Promise<void> {
		const entryCount = entries.length;
		if (entryCount === 0) return;

		const sourceIndices = new Array<number>(entryCount);
		const keys = new Array<bigint>(entryCount);
		const pendingEntries = new Array<PendingChunk>(entryCount);

		let acceptedCount = 0;

		for (let sourceIndex = 0; sourceIndex < entryCount; sourceIndex++) {
			const entry = entries[sourceIndex];
			const key = packCoords(entry.chunkX, entry.chunkY, entry.chunkZ);
			const pending = this.getCurrentPending(key);

			if (pending === undefined) continue;

			if (!this.acceptFreshVersion(key, entry.version)) {
				this.rejectStaleResponse(
					key,
					pending,
					entry.version,
					entry.chunkX,
					entry.chunkY,
					entry.chunkZ,
				);
				continue;
			}

			sourceIndices[acceptedCount] = sourceIndex;
			keys[acceptedCount] = key;
			pendingEntries[acceptedCount] = pending;
			acceptedCount++;
		}

		if (acceptedCount === 0) {
			this.clearSweepIfEmpty();
			return;
		}

		sourceIndices.length = acceptedCount;
		keys.length = acceptedCount;
		pendingEntries.length = acceptedCount;

		noteChunkStage(ChunkPipelineStage.Received, acceptedCount);

		const writes = new Array<ChunkWrite>(acceptedCount);
		const successfulIndices = new Array<number>(acceptedCount);
		const tasks = new Array<Promise<InflatedResult>>(this.windowSize);

		let writeCount = 0;
		let budgetPacedEntries = 0;
		let yieldPerEntry = false;

		for (
			let windowStart = 0;
			windowStart < acceptedCount;
			windowStart += this.windowSize
		) {
			const windowEnd = Math.min(windowStart + this.windowSize, acceptedCount);
			const taskCount = windowEnd - windowStart;

			if (yieldPerEntry) {
				for (let i = windowStart; i < windowEnd; i++) {
					if (i !== windowStart) {
						await yieldToEventLoop();
					}

					FRAME_WORK_BUDGET.takeDecompression();
					budgetPacedEntries++;

					const write = await this.inflateAndValidateEntry(
						entries[sourceIndices[i]],
						keys[i],
						pendingEntries[i],
					);

					if (write === null) continue;

					writes[writeCount] = write;
					successfulIndices[writeCount] = i;
					writeCount++;
				}
			} else {
				tasks.length = taskCount;

				for (let offset = 0; offset < taskCount; offset++) {
					const acceptedIndex = windowStart + offset;

					tasks[offset] = this.inflateAndValidateEntry(
						entries[sourceIndices[acceptedIndex]],
						keys[acceptedIndex],
						pendingEntries[acceptedIndex],
					);
				}

				const windowResults = await Promise.all(tasks);

				for (let offset = 0; offset < taskCount; offset++) {
					const write = windowResults[offset];

					if (write === null) continue;

					writes[writeCount] = write;
					successfulIndices[writeCount] = windowStart + offset;
					writeCount++;
				}
			}

			if (windowEnd >= acceptedCount) break;

			await yieldToEventLoop();

			if (!yieldPerEntry && !FRAME_WORK_BUDGET.takeDecompression()) {
				yieldPerEntry = true;
			}
		}

		if (budgetPacedEntries > 0) {
			this.noteBudgetPaced(budgetPacedEntries);
		}

		this.clearSweepIfEmpty();

		if (writeCount === 0) return;

		writes.length = writeCount;
		successfulIndices.length = writeCount;

		const responseEpoch = this.epoch;
		const responseConnectionGeneration = this.client.connectionGeneration;

		void this.store.writeChunks(writes).then(
			() => {
				noteChunkStage(ChunkPipelineStage.Persisted, writeCount);

				if (
					this.epoch !== responseEpoch ||
					this.client.connectionGeneration !== responseConnectionGeneration
				) {
					return;
				}

				for (let i = 0; i < writeCount; i++) {
					const acceptedIndex = successfulIndices[i];
					const key = keys[acceptedIndex];
					const entry = entries[sourceIndices[acceptedIndex]];
					const current = this.chunkVersions.get(key);

					if (current === undefined || entry.version >= current) {
						this.noteChunkVersion(key, entry.version);
					}
				}
			},
			(error: unknown) => {
				if (isCacheResetError(error)) return;

				console.warn("[RemoteChunkProvider] batch persistence failed:", error);
			},
		);
	}

	private async inflateAndValidateEntry(
		entry: DeflatedChunk,
		key: bigint,
		expectedPending: PendingChunk,
	): Promise<InflatedResult> {
		const inflateStartMs = performance.now();

		let blob: Uint8Array;

		try {
			blob = await inflateInto(entry.deflated, entry.origLen);
		} catch (error) {
			notePipelineWork({
				inflateBytes: entry.origLen,
				inflateMs: performance.now() - inflateStartMs,
				chunksAbandoned: 1,
			});

			console.warn(
				`[RemoteChunkProvider] failed to inflate chunk ${key}:`,
				error,
			);

			noteChunkStage(ChunkPipelineStage.Abandoned);

			this.rejectPendingIfCurrent(
				key,
				expectedPending,
				new ChunkProtocolError("Chunk payload failed to decompress"),
			);

			return null;
		}

		notePipelineWork({
			inflateBytes: entry.origLen,
			inflateMs: performance.now() - inflateStartMs,
			chunkResponses: 1,
		});

		if (!this.isPendingCurrent(key, expectedPending)) {
			noteChunkStage(ChunkPipelineStage.Abandoned);
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

			noteChunkStage(ChunkPipelineStage.Abandoned);

			this.rejectPendingIfCurrent(
				key,
				expectedPending,
				new ChunkProtocolError("Chunk payload failed validation"),
			);

			return null;
		}

		noteChunkStage(ChunkPipelineStage.Validated);

		if (!this.resolvePendingIfCurrent(key, expectedPending, chunk)) {
			return null;
		}

		return {
			cx: entry.chunkX,
			cy: entry.chunkY,
			cz: entry.chunkZ,
			blob: frameDeflated(entry.origLen, entry.deflated),
			preCompressed: true,
		};
	}

	private getCurrentPending(key: bigint): PendingChunk | undefined {
		const pending = this.pending.get(key);

		if (
			pending === undefined ||
			pending.epoch !== this.epoch ||
			pending.connectionGeneration !== this.client.connectionGeneration
		) {
			return undefined;
		}

		return pending;
	}

	private isPendingCurrent(key: bigint, expected: PendingChunk): boolean {
		return (
			expected.epoch === this.epoch &&
			expected.connectionGeneration === this.client.connectionGeneration &&
			this.pending.get(key) === expected
		);
	}

	private resolvePendingIfCurrent(
		key: bigint,
		expected: PendingChunk,
		result: RemoteChunkResult,
	): boolean {
		if (!this.isPendingCurrent(key, expected)) {
			return false;
		}

		this.pending.delete(key);
		expected.resolve(result);
		return true;
	}

	private rejectPendingIfCurrent(
		key: bigint,
		expected: PendingChunk,
		error: Error,
	): boolean {
		if (!this.isPendingCurrent(key, expected)) {
			return false;
		}

		this.pending.delete(key);
		expected.reject(error);
		this.clearSweepIfEmpty();

		return true;
	}

	private rejectStaleResponse(
		key: bigint,
		expected: PendingChunk,
		incomingVersion: number,
		cx: number,
		cy: number,
		cz: number,
	): void {
		const currentVersion = this.chunkVersions.get(key);

		const rejected = this.rejectPendingIfCurrent(
			key,
			expected,
			new ChunkProtocolError(
				`Stale chunk response for ${key}: ` +
					`local version=${currentVersion ?? "none"}, ` +
					`received version=${incomingVersion}`,
			),
		);

		if (!rejected) return;

		this.chunkVersions.delete(key);
		this.evictChunk(cx, cy, cz);
	}

	private handleChunkUnchanged(entry: {
		cx: number;
		cy: number;
		cz: number;
		version: number;
	}): void {
		const outcome = this.processUnchangedEntry(entry);

		if (outcome === UnchangedOutcome.Ignored) {
			return;
		}

		if (outcome === UnchangedOutcome.Rejected) {
			this.evictChunk(entry.cx, entry.cy, entry.cz);
		}

		this.clearSweepIfEmpty();
	}

	private processUnchangedEntry(entry: {
		cx: number;
		cy: number;
		cz: number;
		version: number;
	}): UnchangedOutcome {
		const key = packCoords(entry.cx, entry.cy, entry.cz);
		const pending = this.getCurrentPending(key);

		if (pending === undefined) {
			return UnchangedOutcome.Ignored;
		}

		if (!pending.hasCachedPayload || entry.version !== pending.cachedVersion) {
			const rejected = this.rejectPendingIfCurrent(
				key,
				pending,
				new ChunkProtocolError(
					`Chunk unchanged version mismatch for ${key}: ` +
						`requested cachedVersion=${pending.cachedVersion}, ` +
						`received version=${entry.version}`,
				),
			);

			if (!rejected) {
				return UnchangedOutcome.Ignored;
			}

			this.chunkVersions.delete(key);
			return UnchangedOutcome.Rejected;
		}

		const resolved = this.resolvePendingIfCurrent(key, pending, {
			kind: ChunkResultKind.Unchanged,
			chunkX: entry.cx,
			chunkY: entry.cy,
			chunkZ: entry.cz,
			version: entry.version,
		});

		return resolved ? UnchangedOutcome.Resolved : UnchangedOutcome.Ignored;
	}

	private handleChunkUnchangedBatch(
		entries: readonly {
			cx: number;
			cy: number;
			cz: number;
			version: number;
		}[],
	): void {
		const count = entries.length;
		if (count === 0) return;

		let rejectedIndices: number[] | null = null;
		let removedAny = false;

		for (let i = 0; i < count; i++) {
			const outcome = this.processUnchangedEntry(entries[i]);

			if (outcome === UnchangedOutcome.Ignored) {
				continue;
			}

			removedAny = true;

			if (outcome === UnchangedOutcome.Rejected) {
				if (rejectedIndices === null) {
					rejectedIndices = [];
				}

				rejectedIndices.push(i);
			}
		}

		if (removedAny) {
			this.clearSweepIfEmpty();
		}

		if (rejectedIndices === null) return;

		const evictCoords = new Array<{
			cx: number;
			cy: number;
			cz: number;
		}>(rejectedIndices.length);

		for (let i = 0; i < rejectedIndices.length; i++) {
			const entry = entries[rejectedIndices[i]];

			evictCoords[i] = {
				cx: entry.cx,
				cy: entry.cy,
				cz: entry.cz,
			};
		}

		void this.store.deleteChunks(evictCoords).catch((error: unknown) => {
			if (isCacheResetError(error)) return;

			console.warn(
				"[RemoteChunkProvider] failed to evict invalid cache entries:",
				error,
			);
		});
	}

	private isStaleVersion(key: bigint, incomingVersion: number): boolean {
		const current = this.chunkVersions.get(key);

		return current !== undefined && incomingVersion < current;
	}

	private acceptFreshVersion(key: bigint, version: number): boolean {
		if (!this.isStaleVersion(key, version)) {
			return true;
		}

		if (DEBUG_ENABLED) {
			debugLog(
				`[RemoteChunkProvider] ignored stale chunk ${key} version=${version}`,
			);
		}

		return false;
	}

	private persistChunk(
		chunk: RemoteChunkData,
		blobOverride?: Uint8Array,
		preCompressed = false,
	): void {
		const key = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
		const responseEpoch = this.epoch;
		const responseConnectionGeneration = this.client.connectionGeneration;

		let blob: Uint8Array;

		try {
			blob =
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
		} catch (error) {
			console.warn(
				`[RemoteChunkProvider] chunk serialization failed for ${key}:`,
				error,
			);
			return;
		}

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
				if (
					this.epoch !== responseEpoch ||
					this.client.connectionGeneration !== responseConnectionGeneration
				) {
					return;
				}

				const current = this.chunkVersions.get(key);

				if (current === undefined || chunk.version >= current) {
					this.noteChunkVersion(key, chunk.version);
				}

				noteChunkStage(ChunkPipelineStage.Persisted);
			})
			.catch((error: unknown) => {
				if (isCacheResetError(error)) return;

				console.warn(
					`[RemoteChunkProvider] local chunk save failed for ${key}:`,
					error,
				);
			});
	}

	async clearCache(): Promise<void> {
		this.epoch++;
		this.chunkVersions.clear();

		if (this.sweepTimer !== null) {
			clearTimeout(this.sweepTimer);
			this.sweepTimer = null;
		}

		this.heapDeadlines.length = 0;
		this.heapKeys.length = 0;

		const reconnectError = new Error(
			"Chunk request cancelled because the connection was reset",
		);

		for (const entry of this.pending.values()) {
			entry.reject(reconnectError);
		}

		this.pending.clear();
		this.inFlight.clear();

		if (await this.storeReady) {
			try {
				await this.store.clear({
					discardPendingWrites: true,
				});
			} catch (error) {
				console.warn(
					"[RemoteChunkProvider] failed to clear local cache:",
					error,
				);
			}
		}
	}

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
				this.evictChunk(cx, cy, cz);
				return null;
			}

			const key = packCoords(cx, cy, cz);
			const current = this.chunkVersions.get(key);

			if (current !== undefined && resolved.version < current) {
				return null;
			}

			this.noteChunkVersion(key, resolved.version);

			return resolved;
		} catch (error) {
			console.warn(
				`[RemoteChunkProvider] cache read failed for ${cx},${cy},${cz}:`,
				error,
			);
			return null;
		}
	}

	async getCachedChunks(
		chunks: readonly Chunk[],
	): Promise<Map<Chunk, RemoteChunkData | null>> {
		const result = new Map<Chunk, RemoteChunkData | null>();
		const count = chunks.length;

		if (count === 0) return result;

		if (!(await this.storeReady)) {
			for (let i = 0; i < count; i++) {
				result.set(chunks[i], null);
			}
			return result;
		}

		const coords = new Array<{
			cx: number;
			cy: number;
			cz: number;
		}>(count);

		for (let i = 0; i < count; i++) {
			const chunk = chunks[i];

			coords[i] = {
				cx: chunk.chunkX,
				cy: chunk.chunkY,
				cz: chunk.chunkZ,
			};
		}

		let numericBlobs: Map<number, Uint8Array> | null = null;
		let stringBlobs: Map<string, Uint8Array> | null = null;

		try {
			const store = this.store as unknown as {
				readChunksNumeric?: (
					coords: readonly {
						cx: number;
						cy: number;
						cz: number;
					}[],
				) => Promise<Map<number, Uint8Array>>;
			};

			if (store.readChunksNumeric) {
				numericBlobs = await store.readChunksNumeric(coords);
			} else {
				stringBlobs = await this.store.readChunks(coords);
			}
		} catch (error) {
			console.warn("[RemoteChunkProvider] batch cache read failed:", error);

			for (let i = 0; i < count; i++) {
				result.set(chunks[i], null);
			}

			return result;
		}

		let corruptIndices: number[] | null = null;

		for (let i = 0; i < count; i++) {
			const chunk = chunks[i];
			const coord = coords[i];

			const blob = numericBlobs
				? numericBlobs.get(packChunkKeyNumeric(coord.cx, coord.cy, coord.cz))
				: stringBlobs!.get(chunkKey(coord.cx, coord.cy, coord.cz));

			if (blob === undefined) {
				result.set(chunk, null);
				continue;
			}

			const resolved = this.deserializeCached(
				blob,
				coord.cx,
				coord.cy,
				coord.cz,
			);

			if (resolved === null) {
				if (corruptIndices === null) {
					corruptIndices = [];
				}

				corruptIndices.push(i);
				result.set(chunk, null);
				continue;
			}

			const key = packCoords(coord.cx, coord.cy, coord.cz);
			const current = this.chunkVersions.get(key);

			if (current !== undefined && resolved.version < current) {
				result.set(chunk, null);
				continue;
			}

			if (DEBUG_ENABLED) {
				debugLog(
					`[RemoteChunkProvider] cache hit ${key} version=${resolved.version}`,
				);
			}

			this.noteChunkVersion(key, resolved.version);
			result.set(chunk, resolved);
		}

		if (corruptIndices !== null) {
			const corruptCoords = new Array<{
				cx: number;
				cy: number;
				cz: number;
			}>(corruptIndices.length);

			for (let i = 0; i < corruptIndices.length; i++) {
				corruptCoords[i] = coords[corruptIndices[i]];
			}

			void this.store.deleteChunks(corruptCoords).catch((error: unknown) => {
				if (isCacheResetError(error)) {
					return;
				}

				console.warn(
					"[RemoteChunkProvider] failed to evict corrupt cache entries:",
					error,
				);
			});
		}

		return result;
	}

	private deserializeCached(
		blob: Uint8Array,
		cx: number,
		cy: number,
		cz: number,
	): RemoteChunkData | null {
		let deserialized: ReturnType<typeof deserializeVoxelDataShared>;

		try {
			deserialized = deserializeVoxelDataShared(blob);
		} catch {
			return null;
		}

		const version = deserialized.version ?? 0;

		if (!Number.isInteger(version) || version < 0) {
			return null;
		}

		const light = deserialized.lightArray;

		if (!(light instanceof Uint8Array) || light.byteLength !== CHUNK_VOLUME) {
			return null;
		}

		const isUniform = deserialized.isUniform ?? false;
		const uniformBlockId = deserialized.uniformBlockId ?? 0;
		const palette = deserialized.palette ?? undefined;

		let blocks: Uint8Array | Uint16Array;

		if (isUniform) {
			if (
				!Number.isInteger(uniformBlockId) ||
				uniformBlockId < 0 ||
				uniformBlockId > 0xffff
			) {
				return null;
			}

			blocks = EMPTY_ENCODED_BLOCKS;
		} else if (palette !== undefined) {
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

			if (RemoteChunkProvider.VALIDATE_NETWORK_CHUNKS) {
				const paletteLength = palette.length;

				for (let i = 0; i < packed.length; i++) {
					const byte = packed[i];

					if ((byte & 0x0f) >= paletteLength || byte >>> 4 >= paletteLength) {
						return null;
					}
				}
			}

			blocks = packed;
		} else if (deserialized.blocks instanceof Uint16Array) {
			if (deserialized.blocks.length !== CHUNK_VOLUME) {
				return null;
			}

			blocks = deserialized.blocks;
		} else if (deserialized.blocks instanceof Uint8Array) {
			if (deserialized.blocks.byteLength !== CHUNK_VOLUME) {
				return null;
			}

			blocks = deserialized.blocks;
		} else {
			return null;
		}

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

		if (existing !== undefined) {
			return existing;
		}

		const cached = this.chunkVersions.get(key);
		const hasCachedPayload = cached !== undefined;
		const cachedVersion = cached ?? 0;
		const deadline = performance.now() + timeoutMs;
		const requestEpoch = this.epoch;
		const connectionGeneration = this.client.connectionGeneration;

		let promise!: Promise<RemoteChunkResult>;

		promise = new Promise<RemoteChunkResult>((resolve, reject) => {
			this.pending.set(key, {
				resolve,
				reject,
				deadline,
				epoch: requestEpoch,
				connectionGeneration,
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
		this.scheduleSweep();

		try {
			this.sendRequest(cx, cy, cz, cachedVersion);
		} catch (error) {
			const entry = this.removePending(key);

			entry?.reject(error instanceof Error ? error : new Error(String(error)));
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

		noteChunkStage(ChunkPipelineStage.Requested);
		notePipelineWork({ chunksRequested: 1 });
		noteChunkRequested(packCoords(cx, cy, cz), performance.now());

		const sent = this.client.sendChunkRequest(
			cx,
			cy,
			cz,
			DEFAULT_LOD,
			cachedVersion,
		);

		if (!sent) {
			throw new Error(
				`Chunk request send failed: not connected (${cx},${cy},${cz})`,
			);
		}
	}

	private sortRequestsByPriority(
		requests: ChunkRequestEntry[],
		createdKeys: bigint[],
	): void {
		const count = requests.length;
		if (count < MIN_BATCH_TO_SORT) return;

		if (this.priorityScratch.length < count) {
			this.priorityScratch = new Float64Array(count);
		}

		const scores = this.priorityScratch;

		for (let i = 0; i < count; i++) {
			const request = requests[i];

			scores[i] = priorityForChunk(
				request.cx,
				request.cy,
				request.cz,
				request.lod,
				0,
			);
		}

		for (let i = 1; i < count; i++) {
			const request = requests[i];
			const key = createdKeys[i];
			const score = scores[i];
			const isCacheHit = request.cachedVersion !== 0;

			let j = i - 1;

			while (j >= 0) {
				const previous = requests[j];
				const previousIsCacheHit = previous.cachedVersion !== 0;

				const shouldShift =
					(!previousIsCacheHit && isCacheHit) ||
					(previousIsCacheHit === isCacheHit && scores[j] > score);

				if (!shouldShift) break;

				requests[j + 1] = previous;
				createdKeys[j + 1] = createdKeys[j];
				scores[j + 1] = scores[j];
				j--;
			}

			requests[j + 1] = request;
			createdKeys[j + 1] = key;
			scores[j + 1] = score;
		}
	}

	requestChunkBatch(
		coords: readonly {
			cx: number;
			cy: number;
			cz: number;
		}[],
		timeoutMs = RemoteChunkProvider.DEFAULT_TIMEOUT_MS,
	): Promise<RemoteChunkResult>[] {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new RangeError("timeoutMs must be a positive finite number");
		}

		const count = coords.length;
		const results = new Array<Promise<RemoteChunkResult>>(count);

		if (count === 0) return results;

		let requests: ChunkRequestEntry[] | null = null;
		let createdKeys: bigint[] | null = null;
		let requestCount = 0;

		const deadline = performance.now() + timeoutMs;
		const requestEpoch = this.epoch;
		const connectionGeneration = this.client.connectionGeneration;

		for (let i = 0; i < count; i++) {
			const coord = coords[i];
			const key = packCoords(coord.cx, coord.cy, coord.cz);

			/*
			 * This also deduplicates repeated coordinates inside this same batch:
			 * the first occurrence inserts into inFlight before later entries are
			 * inspected.
			 */
			const existing = this.inFlight.get(key);

			if (existing !== undefined) {
				results[i] = existing;
				continue;
			}

			const cached = this.chunkVersions.get(key);
			const hasCachedPayload = cached !== undefined;
			const cachedVersion = cached ?? 0;

			let promise!: Promise<RemoteChunkResult>;

			promise = new Promise<RemoteChunkResult>((resolve, reject) => {
				this.pending.set(key, {
					resolve,
					reject,
					deadline,
					epoch: requestEpoch,
					connectionGeneration,
					cachedVersion,
					hasCachedPayload,
				});
			}).finally(() => {
				if (this.inFlight.get(key) === promise) {
					this.inFlight.delete(key);
				}
			});

			this.inFlight.set(key, promise);
			results[i] = promise;
			this.heapPush(deadline, key);

			if (requests === null) {
				requests = [];
				createdKeys = [];
			}

			requests.push({
				cx: coord.cx,
				cy: coord.cy,
				cz: coord.cz,
				lod: DEFAULT_LOD,
				cachedVersion,
			});
			createdKeys!.push(key);
			requestCount++;
		}

		if (requestCount === 0 || requests === null || createdKeys === null) {
			return results;
		}

		if (!this.client.isConnected) {
			const error = new Error("Chunk batch send failed: not connected");

			for (let i = 0; i < requestCount; i++) {
				this.removePending(createdKeys[i])?.reject(error);
			}

			return results;
		}

		this.scheduleSweep();
		this.sortRequestsByPriority(requests, createdKeys);

		/*
		 * sendChunkRequestBatch is the authoritative signal: it can fail
		 * between the isConnected check above and the actual send. Reject
		 * every pending entry it did not put on the wire.
		 */
		let sendError: Error | null = null;

		try {
			const sent = this.client.sendChunkRequestBatch(requests);

			if (!sent) {
				sendError = new Error("Chunk batch send failed: not connected");
			}
		} catch (error) {
			sendError = error instanceof Error ? error : new Error(String(error));
		}

		if (sendError !== null) {
			for (let i = 0; i < requestCount; i++) {
				this.removePending(createdKeys[i])?.reject(sendError);
			}
		}

		return results;
	}

	private evictChunk(cx: number, cy: number, cz: number): void {
		void this.store.deleteChunk(cx, cy, cz).catch((error: unknown) => {
			if (isCacheResetError(error)) return;

			console.warn(
				`[RemoteChunkProvider] failed to evict invalid cache entry ${cx},${cy},${cz}:`,
				error,
			);
		});
	}

	private removePending(key: bigint): PendingChunk | undefined {
		const entry = this.pending.get(key);

		if (entry === undefined) return undefined;

		this.pending.delete(key);
		this.clearSweepIfEmpty();

		return entry;
	}

	private heapPush(deadline: number, key: bigint): void {
		const deadlines = this.heapDeadlines;
		const keys = this.heapKeys;

		let index = deadlines.length;

		deadlines.push(deadline);
		keys.push(key);

		while (index > 0) {
			const parent = (index - 1) >>> 1;

			if (deadlines[parent] <= deadlines[index]) {
				break;
			}

			const parentDeadline = deadlines[parent];
			const parentKey = keys[parent];

			deadlines[parent] = deadlines[index];
			keys[parent] = keys[index];
			deadlines[index] = parentDeadline;
			keys[index] = parentKey;

			index = parent;
		}
	}

	private heapPop(): void {
		const deadlines = this.heapDeadlines;
		const keys = this.heapKeys;
		const last = deadlines.length - 1;

		if (last < 0) return;

		if (last === 0) {
			deadlines.pop();
			keys.pop();
			return;
		}

		const replacementDeadline = deadlines[last];
		const replacementKey = keys[last];

		deadlines.pop();
		keys.pop();

		deadlines[0] = replacementDeadline;
		keys[0] = replacementKey;

		const count = deadlines.length;
		let index = 0;

		for (;;) {
			const left = index * 2 + 1;

			if (left >= count) break;

			const right = left + 1;
			let smallest = left;

			if (right < count && deadlines[right] < deadlines[left]) {
				smallest = right;
			}

			if (deadlines[index] <= deadlines[smallest]) {
				break;
			}

			const deadline = deadlines[index];
			const key = keys[index];

			deadlines[index] = deadlines[smallest];
			keys[index] = keys[smallest];
			deadlines[smallest] = deadline;
			keys[smallest] = key;

			index = smallest;
		}
	}

	private compactHeapIfNeeded(): void {
		const heapSize = this.heapDeadlines.length;
		const pendingSize = this.pending.size;

		if (heapSize < pendingSize) {
			this.rebuildHeapFromPending();
			return;
		}

		if (
			heapSize <= RemoteChunkProvider.HEAP_COMPACT_MIN_SIZE ||
			heapSize <= pendingSize * RemoteChunkProvider.HEAP_COMPACT_GHOST_RATIO
		) {
			return;
		}

		this.rebuildHeapFromPending();
	}

	private rebuildHeapFromPending(): void {
		this.heapDeadlines.length = 0;
		this.heapKeys.length = 0;

		for (const [key, entry] of this.pending) {
			this.heapPush(entry.deadline, key);
		}
	}

	private scheduleSweep(): void {
		if (this.sweepTimer !== null) return;
		if (this.pending.size === 0) return;

		this.sweepTimer = setTimeout(() => {
			this.sweepTimer = null;
			this.sweepPending();
		}, RemoteChunkProvider.SWEEP_INTERVAL_MS);
	}

	private clearSweepIfEmpty(): void {
		if (this.pending.size !== 0) return;

		this.heapDeadlines.length = 0;
		this.heapKeys.length = 0;

		if (this.sweepTimer !== null) {
			clearTimeout(this.sweepTimer);
			this.sweepTimer = null;
		}
	}

	private sweepPending(): void {
		const now = performance.now();

		reapStaleLatencyTracks(now);

		const pending = this.pending;
		const deadlines = this.heapDeadlines;
		const keys = this.heapKeys;

		while (deadlines.length > 0 && deadlines[0] <= now) {
			const key = keys[0];
			const deadline = deadlines[0];

			this.heapPop();

			const entry = pending.get(key);

			if (entry === undefined || entry.deadline !== deadline) {
				continue;
			}

			pending.delete(key);

			entry.reject(new Error(`Chunk request timed out for ${key}`));
		}

		this.compactHeapIfNeeded();

		if (pending.size === 0) {
			this.clearSweepIfEmpty();
			return;
		}

		this.scheduleSweep();
	}
}
