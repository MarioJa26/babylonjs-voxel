import { getChunkFast } from "@/code/World/Chunk/Runtime/ChunkRegistry";
import { frameProfiler } from "../../Lib/FrameProfiler";
import { yieldToEventLoop } from "../../Lib/yieldToEventLoop";
import { Chunk } from "../../World/Chunk/Chunk";
import {
	packCoords,
	unpackChunkCoords,
} from "../../World/Chunk/DataStructures/ChunkCoords";
import { ChunkResultKind } from "../protocol/messages";
import type {
	RemoteChunkProvider,
	RemoteChunkResult,
} from "./RemoteChunkProvider";
import {
	REMOTE_MAX_ATTEMPTS,
	REMOTE_PARK_SWEEP_MS,
	remoteParkDelayMs,
} from "./RemoteRetryPolicy";

export type RemotePumpHost = {
	registerChunk(chunk: Chunk): void;
	queueLocalTerrain(chunk: Chunk): void;
	schedulePump(): void;
};

type RemoteParkedRetry = {
	retryAtMs: number;
	tier: number;
};

type RemotePendingEntry = {
	chunk: Chunk;
	dispatchedAtMs: number;
	providerGeneration: number;
};

function assertNever(value: never): never {
	throw new Error("Unhandled remote chunk result kind");
}

const MAX_OUTSTANDING_REMOTE = 256;
const REMOTE_BATCH_SIZE = 32;
const REMOTE_PENDING_STALE_MS = 45_000;
const REMOTE_PENDING_REAP_INTERVAL_MS = 5_000;
const REMOTE_BACKPRESSURE_RETRY_MS = 100;

const dedupScratch = new Set<number>();
const queryChunks: Chunk[] = [];

export class RemoteGenerationPump {
	private remoteChunkProvider: RemoteChunkProvider | null = null;
	private remoteGenerationEnabled = false;
	private expectingRemoteProvider = false;

	/*
	 * Incremented whenever the provider changes. Every asynchronous operation
	 * captures this value so results from a previous provider or session cannot
	 * be applied to the current world.
	 */
	private providerGeneration = 0;

	private readonly remoteDeferredChunks = new Set<Chunk>();
	private readonly remoteNoBlobRetries = new Map<bigint, number>();

	private readonly remotePendingChunks = new Map<bigint, RemotePendingEntry>();

	private remoteTaskQueue: Chunk[] = [];
	private readonly remoteTaskQueueSet = new Set<Chunk>();

	/*
	 * Disposal removes a chunk from remoteTaskQueueSet in O(1). The next
	 * selection compacts the backing array rather than paying O(N) per disposal.
	 */
	private remoteQueueNeedsCompaction = false;

	private readonly remoteRetryCount = new Map<bigint, number>();
	private readonly remoteRetryParked = new Map<Chunk, RemoteParkedRetry>();

	/*
	 * Unlike the parked record, this survives release from the parked set.
	 * Therefore repeated complete retry cycles continue increasing backoff.
	 */
	private readonly remoteRetryTier = new Map<Chunk, number>();

	private remoteRetryParkTimer: ReturnType<typeof setTimeout> | null = null;
	private remotePumpScheduled = false;
	private remoteBackpressureTimer: ReturnType<typeof setTimeout> | null = null;
	private remotePendingReapTimer: ReturnType<typeof setTimeout> | null = null;

	private readonly pendingRemoteChunks = new Set<Chunk>();
	private pendingRemeshScheduled = false;

	/*
	 * Reused by selectColumnBatch(). Only one selection cycle can run at a time
	 * because remotePumpScheduled serializes pump cycles.
	 */
	private readonly remoteSelectionScratch = new Set<Chunk>();

	constructor(private readonly host: RemotePumpHost) {}

	isRemoteGenerationEnabled(): boolean {
		return this.remoteGenerationEnabled;
	}

	isActive(): boolean {
		return this.remoteGenerationEnabled && this.remoteChunkProvider !== null;
	}

	isExpectingProvider(): boolean {
		return this.expectingRemoteProvider;
	}

	isChunkInRemotePipeline(chunk: Chunk): boolean {
		return (
			this.remoteTaskQueueSet.has(chunk) ||
			this.remoteDeferredChunks.has(chunk) ||
			this.remoteRetryParked.has(chunk) ||
			this.remotePendingChunks.has(chunk.id)
		);
	}

	getRemotePipelineStats(): {
		enabled: boolean;
		taskQueueLength: number;
		pendingCount: number;
		pendingCap: number;
		parkedCount: number;
	} {
		return {
			enabled: this.remoteGenerationEnabled,
			taskQueueLength: this.remoteTaskQueueSet.size,
			pendingCount: this.remotePendingChunks.size,
			pendingCap: MAX_OUTSTANDING_REMOTE,
			parkedCount: this.remoteRetryParked.size,
		};
	}

	enqueueRemoteGeneration(chunk: Chunk, _deferLighting = true): void {
		if (!this.isLiveRemoteRequestChunk(chunk) || chunk.isLoaded) {
			return;
		}

		const key = chunk.id;

		if (
			this.remotePendingChunks.has(key) ||
			this.remoteTaskQueueSet.has(chunk) ||
			this.remoteRetryParked.has(chunk)
		) {
			return;
		}

		this.remoteTaskQueue.push(chunk);
		this.remoteTaskQueueSet.add(chunk);
		chunk.isTerrainScheduled = true;
	}

	deferChunkForRemote(chunk: Chunk): void {
		if (!chunk || chunk.isBoatChunk) return;

		this.remoteDeferredChunks.add(chunk);
		chunk.isTerrainScheduled = true;
	}

	private rearmDeferredRemoteChunk(
		chunk: Chunk,
		tier = this.remoteRetryTier.get(chunk) ?? 0,
	): void {
		if (!this.isLiveRemoteRequestChunk(chunk) || chunk.isLoaded) {
			this.clearChunkRetryState(chunk);
			chunk.isTerrainScheduled = false;
			return;
		}

		const nextTier = tier + 1;

		this.remoteRetryTier.set(chunk, nextTier);
		this.remoteRetryParked.set(chunk, {
			retryAtMs: performance.now() + remoteParkDelayMs(tier),
			tier: nextTier,
		});

		chunk.isTerrainScheduled = true;
		this.rearmDeferredRemoteChunkSweepTimer();
	}

	private sweepDeferredRemoteChunks(): void {
		if (this.remoteRetryParked.size === 0) return;

		const now = performance.now();
		let released = 0;

		for (const [chunk, parked] of this.remoteRetryParked) {
			if (now < parked.retryAtMs) continue;

			this.remoteRetryParked.delete(chunk);

			if (!this.isLiveRemoteRequestChunk(chunk) || chunk.isLoaded) {
				this.clearChunkRetryState(chunk);
				chunk.isTerrainScheduled = false;
				continue;
			}

			this.remoteDeferredChunks.delete(chunk);

			if (this.remotePendingChunks.size >= MAX_OUTSTANDING_REMOTE) {
				this.rearmDeferredRemoteChunk(chunk, parked.tier);
				continue;
			}

			this.enqueueRemoteGeneration(chunk);
			released++;
		}

		if (released > 0) {
			this.pumpRemoteGeneration();
		}

		if (this.remoteRetryParked.size > 0) {
			this.rearmDeferredRemoteChunkSweepTimer();
		}
	}

	private rearmDeferredRemoteChunkSweepTimer(): void {
		if (this.remoteRetryParkTimer !== null) return;

		this.remoteRetryParkTimer = setTimeout(() => {
			this.remoteRetryParkTimer = null;
			this.sweepDeferredRemoteChunks();
		}, REMOTE_PARK_SWEEP_MS);
	}

	private clearDeferredRemoteChunkRetries(): void {
		this.remoteRetryParked.clear();
		this.remoteRetryTier.clear();

		if (this.remoteRetryParkTimer !== null) {
			clearTimeout(this.remoteRetryParkTimer);
			this.remoteRetryParkTimer = null;
		}
	}

	private clearChunkRetryState(chunk: Chunk): void {
		this.remoteRetryParked.delete(chunk);
		this.remoteRetryTier.delete(chunk);
		this.remoteRetryCount.delete(chunk.id);
	}

	private reapStaleRemotePending(): void {
		const pending = this.remotePendingChunks;

		if (pending.size === 0) return;

		const nowMs = performance.now();
		let reaped = 0;

		for (const [key, entry] of pending) {
			if (nowMs - entry.dispatchedAtMs <= REMOTE_PENDING_STALE_MS) {
				continue;
			}

			if (
				this.handleRemoteGenError(
					new Error("Remote request stalled (no settlement)"),
					entry.chunk,
					key,
					entry,
					false,
				)
			) {
				reaped++;
			}
		}

		if (reaped > 0) {
			console.warn(
				`[RemoteGen] reaped ${reaped} remote request(s) stuck pending for >${REMOTE_PENDING_STALE_MS / 1000}s; retrying them.`,
			);

			this.pumpRemoteGeneration();
		}

		if (pending.size > 0) {
			this.scheduleRemotePendingReap();
		}
	}

	private scheduleRemotePendingReap(): void {
		if (this.remotePendingReapTimer !== null) return;

		this.remotePendingReapTimer = setTimeout(() => {
			this.remotePendingReapTimer = null;
			this.reapStaleRemotePending();
		}, REMOTE_PENDING_REAP_INTERVAL_MS);
	}

	private cancelRemotePendingReap(): void {
		if (this.remotePendingReapTimer === null) return;

		clearTimeout(this.remotePendingReapTimer);
		this.remotePendingReapTimer = null;
	}

	enableRemoteMode(): void {
		this.expectingRemoteProvider = true;
	}

	disableRemoteMode(): void {
		this.expectingRemoteProvider = false;

		for (const chunk of this.remoteDeferredChunks) {
			chunk.isTerrainScheduled = false;
		}

		this.remoteDeferredChunks.clear();
		this.clearDeferredRemoteChunkRetries();
	}

	hasRemoteChunksQueued(): boolean {
		return this.remoteTaskQueueSet.size > 0;
	}

	pumpRemoteGeneration(): void {
		const provider = this.remoteChunkProvider;

		if (provider === null || this.remotePumpScheduled) return;

		const available = MAX_OUTSTANDING_REMOTE - this.remotePendingChunks.size;

		if (available <= 0) {
			this.scheduleBackpressureRetry();
			return;
		}

		this.cancelBackpressureRetry();
		this.remotePumpScheduled = true;

		const toCheck = this.selectColumnBatch(
			Math.min(REMOTE_BATCH_SIZE, available),
		);

		if (toCheck.length === 0) {
			this.remotePumpScheduled = false;
			return;
		}

		let cacheRequest: unknown;

		try {
			cacheRequest = provider.getCachedChunks(toCheck);
		} catch {
			this.finishRemotePumpCycle(toCheck);
			return;
		}

		/*
		 * Cache warming is advisory. Both success and failure continue into the
		 * actual remote request cycle.
		 */
		void Promise.resolve(cacheRequest).then(
			() => this.finishRemotePumpCycle(toCheck),
			() => this.finishRemotePumpCycle(toCheck),
		);
	}

	private scheduleBackpressureRetry(): void {
		if (this.remoteBackpressureTimer !== null) return;

		this.remoteBackpressureTimer = setTimeout(() => {
			this.remoteBackpressureTimer = null;
			this.pumpRemoteGeneration();
		}, REMOTE_BACKPRESSURE_RETRY_MS);
	}

	private cancelBackpressureRetry(): void {
		if (this.remoteBackpressureTimer === null) return;

		clearTimeout(this.remoteBackpressureTimer);
		this.remoteBackpressureTimer = null;
	}

	private isLiveRemoteRequestChunk(chunk: Chunk | undefined): boolean {
		return (
			chunk !== undefined &&
			!chunk.isBoatChunk &&
			getChunkFast(chunk.chunkX, chunk.chunkY, chunk.chunkZ) === chunk
		);
	}

	private selectColumnBatch(maxCount: number): Chunk[] {
		const result: Chunk[] = [];

		if (maxCount <= 0 || this.remoteTaskQueue.length === 0) {
			return result;
		}

		const queue = this.remoteTaskQueue;
		const queueSet = this.remoteTaskQueueSet;
		const pending = this.remotePendingChunks;
		const selected = this.remoteSelectionScratch;

		selected.clear();

		let anchorX = 0;
		let anchorZ = 0;
		let hasAnchor = false;
		let write = 0;

		/*
		 * First pass:
		 * - clean invalid queue entries
		 * - choose the first eligible chunk as the anchor
		 * - prefer other chunks in the same X/Z column
		 * - compact non-selected survivors in place
		 */
		for (let read = 0; read < queue.length; read++) {
			const chunk = queue[read];

			if (!queueSet.has(chunk)) {
				continue;
			}

			if (!this.isLiveRemoteRequestChunk(chunk) || chunk.isLoaded) {
				queueSet.delete(chunk);
				chunk.isTerrainScheduled = false;
				continue;
			}

			if (pending.has(chunk.id)) {
				queueSet.delete(chunk);
				continue;
			}

			if (!hasAnchor) {
				hasAnchor = true;
				anchorX = chunk.chunkX;
				anchorZ = chunk.chunkZ;

				selected.add(chunk);
				result.push(chunk);
				continue;
			}

			if (
				result.length < maxCount &&
				chunk.chunkX === anchorX &&
				chunk.chunkZ === anchorZ
			) {
				selected.add(chunk);
				result.push(chunk);
				continue;
			}

			queue[write++] = chunk;
		}

		if (!hasAnchor) {
			queue.length = 0;
			this.remoteQueueNeedsCompaction = false;
			selected.clear();
			return result;
		}

		/*
		 * If the preferred column did not fill the batch, consume additional
		 * chunks from the compacted survivor prefix without disturbing the
		 * relative order of chunks that remain queued.
		 */
		if (result.length < maxCount && write > 0) {
			const additionalCount = Math.min(maxCount - result.length, write);

			for (let i = 0; i < additionalCount; i++) {
				const chunk = queue[i];
				selected.add(chunk);
				result.push(chunk);
			}

			if (additionalCount > 0) {
				let remainingWrite = 0;

				for (let read = additionalCount; read < write; read++) {
					queue[remainingWrite++] = queue[read];
				}

				write = remainingWrite;
			}
		}

		queue.length = write;

		for (let i = 0; i < result.length; i++) {
			queueSet.delete(result[i]);
		}

		this.remoteQueueNeedsCompaction = false;
		selected.clear();

		return result;
	}

	private finishRemotePumpCycle(toCheck: Chunk[]): void {
		this.remotePumpScheduled = false;

		if (this.remoteChunkProvider === null) {
			for (let i = 0; i < toCheck.length; i++) {
				toCheck[i].isTerrainScheduled = false;
			}
			return;
		}

		const available = MAX_OUTSTANDING_REMOTE - this.remotePendingChunks.size;

		if (available <= 0) {
			for (let i = 0; i < toCheck.length; i++) {
				this.requeueRemoteChunk(toCheck[i], false);
			}

			this.scheduleBackpressureRetry();
			return;
		}

		const toRequest: Chunk[] = [];

		for (let i = 0; i < toCheck.length; i++) {
			const chunk = toCheck[i];

			if (!this.isLiveRemoteRequestChunk(chunk) || chunk.isLoaded) {
				chunk.isTerrainScheduled = false;
				continue;
			}

			/*
			 * Count accepted requests rather than source-array positions. Invalid
			 * entries therefore do not consume remote capacity.
			 */
			if (toRequest.length >= available) {
				this.requeueRemoteChunk(chunk, false);
				continue;
			}

			chunk.isTerrainScheduled = true;
			toRequest.push(chunk);
		}

		this.dispatchRemoteRequests(toRequest);
		this.scheduleRemotePumpContinuation();
	}

	private requeueRemoteChunk(chunk: Chunk, front: boolean): boolean {
		if (!this.isLiveRemoteRequestChunk(chunk) || chunk.isLoaded) {
			chunk.isTerrainScheduled = false;
			return false;
		}

		const key = chunk.id;

		if (
			this.remotePendingChunks.has(key) ||
			this.remoteTaskQueueSet.has(chunk) ||
			this.remoteRetryParked.has(chunk)
		) {
			return false;
		}

		if (front) {
			this.remoteTaskQueue.unshift(chunk);
		} else {
			this.remoteTaskQueue.push(chunk);
		}

		this.remoteTaskQueueSet.add(chunk);
		chunk.isTerrainScheduled = true;
		return true;
	}

	private scheduleRemotePumpContinuation(): void {
		if (this.remoteTaskQueueSet.size === 0) return;
		if (this.remotePumpScheduled) return;

		this.remotePumpScheduled = true;

		void yieldToEventLoop().then(() => {
			this.remotePumpScheduled = false;

			frameProfiler.measureOffFrame("remotePump", () =>
				this.pumpRemoteGeneration(),
			);
		});
	}

	private dispatchRemoteRequests(toRequest: Chunk[]): void {
		const provider = this.remoteChunkProvider;

		if (provider === null || toRequest.length === 0) {
			return;
		}

		const generation = this.providerGeneration;
		const pending = this.remotePendingChunks;
		const dispatchedAtMs = performance.now();
		const available = MAX_OUTSTANDING_REMOTE - pending.size;

		if (available <= 0) {
			for (let i = 0; i < toRequest.length; i++) {
				this.requeueRemoteChunk(toRequest[i], false);
			}

			this.scheduleBackpressureRetry();
			return;
		}

		const coords: Array<{
			cx: number;
			cy: number;
			cz: number;
		}> = [];
		const chunks: Chunk[] = [];
		const keys: bigint[] = [];
		const entries: RemotePendingEntry[] = [];

		for (let i = 0; i < toRequest.length; i++) {
			const chunk = toRequest[i];

			if (!this.isLiveRemoteRequestChunk(chunk) || chunk.isLoaded) {
				chunk.isTerrainScheduled = false;
				continue;
			}

			const key = chunk.id;

			if (pending.has(key)) {
				chunk.isTerrainScheduled = false;
				continue;
			}

			if (chunks.length >= available) {
				this.requeueRemoteChunk(chunk, false);
				continue;
			}

			const entry: RemotePendingEntry = {
				chunk,
				dispatchedAtMs,
				providerGeneration: generation,
			};

			pending.set(key, entry);
			chunks.push(chunk);
			keys.push(key);
			entries.push(entry);
			coords.push({
				cx: chunk.chunkX,
				cy: chunk.chunkY,
				cz: chunk.chunkZ,
			});
		}

		if (chunks.length === 0) return;

		this.scheduleRemotePendingReap();

		if (chunks.length === 1) {
			let request: unknown;

			try {
				request = provider.requestChunk(
					coords[0].cx,
					coords[0].cy,
					coords[0].cz,
				);
			} catch (error) {
				this.handleRemoteGenError(
					this.normalizeError(error),
					chunks[0],
					keys[0],
					entries[0],
				);
				return;
			}

			if (!this.isPromiseLike<RemoteChunkResult>(request)) {
				this.handleRemoteGenError(
					new Error("Remote provider returned an invalid chunk promise"),
					chunks[0],
					keys[0],
					entries[0],
				);
				return;
			}

			void Promise.resolve(request).then(
				(result) => this.handleRemoteChunkData(result, keys[0], entries[0]),
				(error: unknown) =>
					this.handleRemoteGenError(
						this.normalizeError(error),
						chunks[0],
						keys[0],
						entries[0],
					),
			);

			return;
		}

		let promises: unknown;

		try {
			promises = provider.requestChunkBatch(coords);
		} catch (error) {
			const normalized = this.normalizeError(error);

			for (let i = 0; i < chunks.length; i++) {
				this.handleRemoteGenError(
					normalized,
					chunks[i],
					keys[i],
					entries[i],
					false,
				);
			}

			this.pumpRemoteGeneration();
			return;
		}

		if (!Array.isArray(promises)) {
			const error = new Error(
				"Remote provider returned an invalid batch response",
			);

			for (let i = 0; i < chunks.length; i++) {
				this.handleRemoteGenError(error, chunks[i], keys[i], entries[i], false);
			}

			this.pumpRemoteGeneration();
			return;
		}

		const requestCount = chunks.length;
		const promiseCount = promises.length;
		const matchedCount = Math.min(requestCount, promiseCount);

		for (let i = 0; i < matchedCount; i++) {
			const request = promises[i];

			if (!this.isPromiseLike<RemoteChunkResult>(request)) {
				this.handleRemoteGenError(
					new Error(
						`Remote provider returned an invalid promise ` +
							`at batch index ${i}`,
					),
					chunks[i],
					keys[i],
					entries[i],
					false,
				);
				continue;
			}

			void Promise.resolve(request).then(
				(result) => this.handleRemoteChunkData(result, keys[i], entries[i]),
				(error: unknown) =>
					this.handleRemoteGenError(
						this.normalizeError(error),
						chunks[i],
						keys[i],
						entries[i],
					),
			);
		}

		if (promiseCount < requestCount) {
			const error = new Error(
				`Remote provider returned ${promiseCount} promises ` +
					`for ${requestCount} chunk requests`,
			);

			for (let i = promiseCount; i < requestCount; i++) {
				this.handleRemoteGenError(error, chunks[i], keys[i], entries[i], false);
			}
		}

		/*
		 * Observe unmatched promises so an extra rejected provider promise does
		 * not create an unhandled rejection.
		 */
		for (let i = requestCount; i < promiseCount; i++) {
			const extra = promises[i];

			if (!this.isPromiseLike<RemoteChunkResult>(extra)) {
				console.warn(
					`[RemoteGen] Ignoring invalid extra batch promise at index ${i}`,
				);
				continue;
			}

			void Promise.resolve(extra).catch((error: unknown) => {
				console.warn(
					`[RemoteGen] Unmatched extra batch request ${i} failed:`,
					error,
				);
			});
		}

		if (pending.size < MAX_OUTSTANDING_REMOTE) {
			this.pumpRemoteGeneration();
		}
	}

	private normalizeError(error: unknown): Error {
		return error instanceof Error ? error : new Error(String(error));
	}

	private isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
		return (
			value !== null &&
			(typeof value === "object" || typeof value === "function") &&
			typeof (value as PromiseLike<T>).then === "function"
		);
	}

	private handleRemoteGenError(
		err: Error,
		chunk: Chunk,
		key: bigint,
		expectedEntry?: RemotePendingEntry,
		pumpAfter = true,
	): boolean {
		const currentEntry = this.remotePendingChunks.get(key);

		if (expectedEntry !== undefined && currentEntry !== expectedEntry) {
			return false;
		}

		if (
			expectedEntry !== undefined &&
			expectedEntry.providerGeneration !== this.providerGeneration
		) {
			if (currentEntry === expectedEntry) {
				this.remotePendingChunks.delete(key);
			}

			chunk.isTerrainScheduled = false;

			if (pumpAfter) this.pumpRemoteGeneration();
			return false;
		}

		if (currentEntry !== undefined) {
			this.remotePendingChunks.delete(key);
		}

		if (!this.isLiveRemoteRequestChunk(chunk)) {
			this.remoteRetryCount.delete(key);
			this.remoteRetryTier.delete(chunk);
			chunk.isTerrainScheduled = false;

			if (pumpAfter) this.pumpRemoteGeneration();
			return true;
		}

		chunk.isTerrainScheduled = false;

		const retries = (this.remoteRetryCount.get(key) ?? 0) + 1;

		if (retries >= REMOTE_MAX_ATTEMPTS) {
			this.remoteRetryCount.delete(key);

			console.error(
				`[RemoteGen] GIVING UP on ${key} after ` + `${retries} attempts:`,
				err,
			);

			if (!chunk.isLoaded) {
				this.remoteDeferredChunks.add(chunk);
				this.rearmDeferredRemoteChunk(chunk);
			}

			if (pumpAfter) this.pumpRemoteGeneration();
			return true;
		}

		this.remoteRetryCount.set(key, retries);

		console.warn(
			`[RemoteGen] request FAILED ${key} ` +
				`(attempt ${retries}/${REMOTE_MAX_ATTEMPTS}):`,
			err,
		);

		this.requeueRemoteChunk(chunk, false);

		if (pumpAfter) this.pumpRemoteGeneration();
		return true;
	}

	setRemoteChunkProvider(provider: RemoteChunkProvider | null): void {
		const previousProvider = this.remoteChunkProvider;

		/*
		 * Invalidate every asynchronous operation created by the preceding
		 * provider, including direct non-null to non-null switches.
		 */
		if (provider !== previousProvider) {
			this.providerGeneration++;
			this.cancelRemotePendingReap();
		}

		if (previousProvider !== null) {
			this.releaseRemoteScheduledFlags();
			this.remotePendingChunks.clear();
			this.remoteRetryCount.clear();
			this.remoteNoBlobRetries.clear();
		}

		this.remoteChunkProvider = provider;
		this.remoteGenerationEnabled = provider !== null;
		this.expectingRemoteProvider = provider !== null;
		this.remotePumpScheduled = false;

		this.cancelBackpressureRetry();

		if (provider !== null) {
			let flushed = 0;

			for (const chunk of this.remoteDeferredChunks) {
				this.remoteRetryParked.delete(chunk);
				this.enqueueRemoteGeneration(chunk);
				flushed++;
			}

			this.remoteDeferredChunks.clear();
			this.clearDeferredRemoteChunkRetries();

			let requeued = 0;

			for (const chunk of Chunk.chunkInstances.values()) {
				if (chunk.isBoatChunk) continue;

				if (!chunk.isLoaded && !chunk.hasVoxelData) {
					continue;
				}

				/*
				 * Loaded authoritative replacement requests are valid here, so
				 * enqueue directly instead of using enqueueRemoteGeneration().
				 */
				const key = chunk.id;

				if (
					!this.remotePendingChunks.has(key) &&
					!this.remoteTaskQueueSet.has(chunk)
				) {
					this.remoteTaskQueue.push(chunk);
					this.remoteTaskQueueSet.add(chunk);
					chunk.isTerrainScheduled = true;
					requeued++;
				}
			}

			if (flushed > 0 || requeued > 0) {
				this.pumpRemoteGeneration();
			}

			console.log(
				"[RemoteGen] setRemoteChunkProvider enabled=true " +
					`(requeued ${requeued} loaded chunks, ` +
					`flushed ${flushed} deferred)`,
			);

			return;
		}

		this.remoteDeferredChunks.clear();
		this.remoteTaskQueue.length = 0;
		this.remoteTaskQueueSet.clear();
		this.remoteQueueNeedsCompaction = false;
		this.remoteSelectionScratch.clear();

		this.clearDeferredRemoteChunkRetries();

		this.pendingRemoteChunks.clear();
		this.pendingRemeshScheduled = false;

		this.cancelRemotePendingReap();

		console.log("[RemoteGen] setRemoteChunkProvider enabled=false");
	}

	private releaseRemoteScheduledFlags(): void {
		for (const chunk of this.remoteDeferredChunks) {
			chunk.isTerrainScheduled = false;
		}

		for (const chunk of this.remoteTaskQueueSet) {
			chunk.isTerrainScheduled = false;
		}

		for (const entry of this.remotePendingChunks.values()) {
			entry.chunk.isTerrainScheduled = false;
		}

		for (const chunk of this.remoteRetryParked.keys()) {
			chunk.isTerrainScheduled = false;
		}
	}

	private handleRemoteChunkData(
		result: RemoteChunkResult,
		expectedKey: bigint,
		expectedEntry: RemotePendingEntry,
	): void {
		if (expectedEntry.providerGeneration !== this.providerGeneration) {
			return;
		}

		const resultKey = packCoords(result.chunkX, result.chunkY, result.chunkZ);

		if (resultKey !== expectedKey) {
			const got = unpackChunkCoords(resultKey);
			const want = unpackChunkCoords(expectedKey);

			this.handleRemoteGenError(
				new Error(
					"Remote provider returned coordinates for " +
						`${resultKey} (${got.x},${got.y},${got.z}) ` +
						`while request ${expectedKey} ` +
						`(${want.x},${want.y},${want.z}) was pending`,
				),
				expectedEntry.chunk,
				expectedKey,
				expectedEntry,
			);

			return;
		}

		if (this.remotePendingChunks.get(expectedKey) !== expectedEntry) {
			return;
		}

		this.remotePendingChunks.delete(expectedKey);
		this.remoteRetryCount.delete(expectedKey);

		const chunk = expectedEntry.chunk;

		if (
			!this.isLiveRemoteRequestChunk(chunk) ||
			chunk.chunkX !== result.chunkX ||
			chunk.chunkY !== result.chunkY ||
			chunk.chunkZ !== result.chunkZ
		) {
			chunk.isTerrainScheduled = false;
			this.pumpRemoteGeneration();
			return;
		}

		this.remoteRetryTier.delete(chunk);
		this.remoteRetryParked.delete(chunk);
		this.remoteDeferredChunks.delete(chunk);

		switch (result.kind) {
			case ChunkResultKind.Data: {
				this.remoteNoBlobRetries.delete(expectedKey);

				chunk.loadFromStorage(
					result.blocks,
					result.palette ?? null,
					result.isUniform,
					result.uniformBlockId,
					result.light,
					false,
				);

				chunk.isModified = true;
				this.queueRemoteChunkRemesh(chunk);
				this.pumpRemoteGeneration();
				return;
			}

			case ChunkResultKind.Unchanged: {
				if (chunk.hasVoxelData) {
					chunk.isLoaded = true;
					chunk.isModified = true;

					this.host.registerChunk(chunk);
					this.queueRemoteChunkRemesh(chunk);
					this.pumpRemoteGeneration();
					return;
				}

				const provider = this.remoteChunkProvider;
				const generation = this.providerGeneration;

				if (provider === null) {
					chunk.isTerrainScheduled = false;
					this.pumpRemoteGeneration();
					return;
				}

				let cachedRequest: unknown;

				try {
					cachedRequest = provider.getCachedChunk(
						chunk.chunkX,
						chunk.chunkY,
						chunk.chunkZ,
					);
				} catch (error) {
					if (
						generation !== this.providerGeneration ||
						provider !== this.remoteChunkProvider
					) {
						return;
					}

					console.warn(
						`[RemoteGen] cached-blob read threw for ${expectedKey}; ` +
							"re-requesting from server:",
						error,
					);

					this.requeueRemoteChunk(chunk, true);
					this.pumpRemoteGeneration();
					return;
				}

				if (
					!this.isPromiseLike<
						Awaited<ReturnType<RemoteChunkProvider["getCachedChunk"]>>
					>(cachedRequest)
				) {
					console.warn(
						`[RemoteGen] cached-blob reader returned an invalid promise ` +
							`for ${expectedKey}; re-requesting from server`,
					);

					this.requeueRemoteChunk(chunk, true);
					this.pumpRemoteGeneration();
					return;
				}

				void Promise.resolve(cachedRequest)
					.then((cached) => {
						if (
							generation !== this.providerGeneration ||
							provider !== this.remoteChunkProvider
						) {
							return;
						}

						if (!this.isLiveRemoteRequestChunk(chunk)) {
							chunk.isTerrainScheduled = false;
							return;
						}

						if (cached !== null && cached !== undefined) {
							chunk.loadFromStorage(
								cached.blocks,
								cached.palette ?? null,
								cached.isUniform,
								cached.uniformBlockId,
								cached.light,
								false,
							);

							chunk.isModified = true;
							this.remoteNoBlobRetries.delete(expectedKey);
							this.queueRemoteChunkRemesh(chunk);
							return;
						}

						const retries = this.remoteNoBlobRetries.get(expectedKey) ?? 0;

						if (result.version === 0) {
							this.remoteNoBlobRetries.delete(expectedKey);
							chunk.isTerrainScheduled = false;
							this.host.queueLocalTerrain(chunk);
							return;
						}

						if (retries < 1) {
							this.remoteNoBlobRetries.set(expectedKey, retries + 1);

							this.requeueRemoteChunk(chunk, true);
							return;
						}

						this.remoteNoBlobRetries.delete(expectedKey);
						chunk.isTerrainScheduled = false;
						this.host.queueLocalTerrain(chunk);
					})
					.catch((error: unknown) => {
						if (
							generation !== this.providerGeneration ||
							provider !== this.remoteChunkProvider
						) {
							return;
						}

						console.warn(
							`[RemoteGen] cached-blob read failed for ${expectedKey}; ` +
								"re-requesting from server:",
							error,
						);

						this.requeueRemoteChunk(chunk, true);
					})
					.finally(() => {
						if (
							generation === this.providerGeneration &&
							provider === this.remoteChunkProvider
						) {
							this.pumpRemoteGeneration();
						}
					});

				return;
			}

			default:
				assertNever(result);
		}
	}

	private flushPendingRemoteChunkRemesh(): void {
		this.pendingRemeshScheduled = false;

		const pending = this.pendingRemoteChunks;
		if (pending.size === 0) return;

		const chunks = queryChunks;
		const seen = dedupScratch;

		chunks.length = 0;
		seen.clear();

		for (const chunk of pending) {
			chunks.push(chunk);
		}

		pending.clear();

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];

			if (
				!this.isLiveRemoteRequestChunk(chunk) ||
				(!chunk.isLoaded && !chunk.hasVoxelData)
			) {
				continue;
			}

			this.scheduleRemeshOnce(chunk, true, true, seen);

			this.scheduleNeighborRemesh(chunk.getNeighbor(-1, 0, 0), seen);
			this.scheduleNeighborRemesh(chunk.getNeighbor(0, 0, -1), seen);
			this.scheduleNeighborRemesh(chunk.getNeighbor(0, -1, 0), seen);
			this.scheduleNeighborRemesh(chunk.getNeighbor(1, 0, 0), seen);
			this.scheduleNeighborRemesh(chunk.getNeighbor(0, 0, 1), seen);
			this.scheduleNeighborRemesh(chunk.getNeighbor(0, 1, 0), seen);
		}

		chunks.length = 0;
		seen.clear();

		this.host.schedulePump();
	}

	private scheduleRemeshOnce(
		chunk: Chunk,
		immediate: boolean,
		fullDetail: boolean,
		seen: Set<number>,
	): void {
		if (seen.has(chunk.numericId)) return;

		seen.add(chunk.numericId);
		chunk.scheduleRemesh(immediate, fullDetail);
	}

	private scheduleNeighborRemesh(
		chunk: Chunk | null | undefined,
		seen: Set<number>,
	): void {
		if (!chunk || seen.has(chunk.numericId)) return;

		seen.add(chunk.numericId);
		chunk.scheduleRemesh(true, chunk.lodLevel === 0);
	}

	private queueRemoteChunkRemesh(chunk: Chunk): void {
		this.pendingRemoteChunks.add(chunk);

		if (this.pendingRemeshScheduled) return;

		this.pendingRemeshScheduled = true;

		requestAnimationFrame(() => {
			this.flushPendingRemoteChunkRemesh();
		});
	}

	onChunkDisposed(chunk: Chunk, remoteKey: bigint): void {
		this.remoteDeferredChunks.delete(chunk);
		this.remoteRetryParked.delete(chunk);
		this.remoteRetryTier.delete(chunk);

		if (this.remoteTaskQueueSet.delete(chunk)) {
			this.remoteQueueNeedsCompaction = true;
		}

		const pendingEntry = this.remotePendingChunks.get(remoteKey);

		if (pendingEntry?.chunk === chunk) {
			this.remotePendingChunks.delete(remoteKey);
		}

		this.remoteRetryCount.delete(remoteKey);
		this.remoteNoBlobRetries.delete(remoteKey);
		this.pendingRemoteChunks.delete(chunk);

		chunk.isTerrainScheduled = false;

		if (this.pendingRemoteChunks.size === 0) {
			this.pendingRemeshScheduled = false;
		}

		/*
		 * Disposal may have released a pending slot. Continue immediately rather
		 * than waiting for the backpressure timer.
		 */
		if (
			this.remoteChunkProvider !== null &&
			this.remotePendingChunks.size < MAX_OUTSTANDING_REMOTE
		) {
			this.pumpRemoteGeneration();
		}
	}
}
