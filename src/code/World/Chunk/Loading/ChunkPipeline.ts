/**
 * Explicit lifecycle for a chunk travelling from the network to the screen.
 *
 * Stages are counted rather than awaited. Nothing blocks on a transition.
 */
export const enum ChunkPipelineStage {
	/** Request sent, response outstanding. */
	Requested = 0,

	/** Bytes arrived from the socket. */
	Received = 1,

	/** Inflate finished and the payload passed structural validation. */
	Validated = 2,

	/** A merged group was dirtied for this chunk. */
	Meshing = 3,

	/** Face ranges were written to the arena. */
	UploadQueued = 4,

	/** The packed mesh is resident and drawable. */
	Renderable = 5,

	/** The serialized blob was committed to the local cache. */
	Persisted = 6,

	/** Dropped without completing: timeout, cancellation, or supersession. */
	Abandoned = 7,
}

const STAGE_COUNT = 8;

/** Human-readable stage names, indexed by ChunkPipelineStage. */
const STAGE_NAMES = [
	"Requested",
	"Received",
	"Validated",
	"Meshing",
	"UploadQueued",
	"Renderable",
	"Persisted",
	"Abandoned",
] as const;

export interface ChunkPipelineStats {
	/** Cumulative stage entries since the last reset. */
	counts: readonly number[];

	/** Chunks past validation but not yet renderable or abandoned. */
	inFlight: number;

	/** End-to-end latency samples in milliseconds, oldest first. */
	latencySamples: number[];
}

export interface ChunkLatencyPercentiles {
	p50: number;
	p90: number;
	p99: number;
	max: number;
}

/*
 * Latency is retained as a bounded distribution rather than a running mean,
 * because a mean hides the queue tail this instrumentation is intended to
 * expose.
 */
const LATENCY_CAPACITY = 256;
const MAX_TRACKED_AGE_MS = 60_000;

const counts = new Int32Array(STAGE_COUNT);
const latencyRing = new Float64Array(LATENCY_CAPACITY);

/*
 * Reused percentile scratch storage.
 *
 * JavaScript execution is synchronous within this function, so reusing this
 * module-private buffer is safe. It avoids allocating a Float64Array on every
 * percentile query.
 */
const percentileScratch = new Float64Array(LATENCY_CAPACITY);

let latencyCount = 0;
let latencyHead = 0;

/** Chunks that reached Validated and have not reached a terminal stage. */
let inFlight = 0;

/**
 * Chunks awaiting their first mesh, keyed by packed coordinates and holding
 * the wall-clock time at which the current request was sent.
 */
const requestedAt = new Map<bigint, number>();

/**
 * Record that `count` chunks entered `stage`.
 *
 * @param count Number of chunks entering the stage. A merged-group operation
 * may pass its member count to keep counters comparable with per-chunk stages.
 */
export function noteChunkStage(stage: ChunkPipelineStage, count = 1): void {
	if (count <= 0) return;

	counts[stage] += count;

	if (stage === ChunkPipelineStage.Validated) {
		inFlight += count;
		return;
	}

	if (
		stage === ChunkPipelineStage.Renderable ||
		stage === ChunkPipelineStage.Abandoned
	) {
		inFlight -= count;
	}
}

/**
 * Begin or restart latency tracking for one chunk.
 *
 * Deleting an existing entry before setting it is important: Map iteration is
 * insertion ordered, and stale-request reaping stops at the first live entry.
 * A plain set on an existing key would update its timestamp without moving it
 * to the end, invalidating that ordering assumption.
 */
export function noteChunkRequested(key: bigint, nowMs: number): void {
	if (requestedAt.has(key)) {
		requestedAt.delete(key);
	}

	requestedAt.set(key, nowMs);
}

/** Record one completed request-to-mesh latency sample, in milliseconds. */
export function noteChunkRendered(ms: number): void {
	if (!Number.isFinite(ms) || ms < 0) return;

	latencyRing[latencyHead] = ms;

	latencyHead++;
	if (latencyHead === LATENCY_CAPACITY) {
		latencyHead = 0;
	}

	if (latencyCount < LATENCY_CAPACITY) {
		latencyCount++;
	}
}

/**
 * Complete latency tracking for a chunk that reached the mesh stage.
 *
 * @returns Measured latency in milliseconds, or -1 if no valid tracked request
 * exists.
 */
export function completeChunkLatency(key: bigint, nowMs: number): number {
	const startedAt = requestedAt.get(key);

	if (startedAt === undefined) {
		return -1;
	}

	requestedAt.delete(key);

	const elapsedMs = nowMs - startedAt;

	if (
		!Number.isFinite(elapsedMs) ||
		elapsedMs < 0 ||
		elapsedMs > MAX_TRACKED_AGE_MS
	) {
		return -1;
	}

	return elapsedMs;
}

/** Forget an outstanding request-to-mesh pairing. */
export function forgetChunkRequest(key: bigint): void {
	requestedAt.delete(key);
}

/**
 * Drop tracked requests whose sampling window has passed.
 *
 * Entries are maintained in request-time order by noteChunkRequested, allowing
 * this loop to stop at the first live request rather than scan the entire map.
 */
export function reapStaleLatencyTracks(nowMs: number): number {
	let reaped = 0;

	for (const [key, startedAt] of requestedAt) {
		if (nowMs - startedAt <= MAX_TRACKED_AGE_MS) {
			break;
		}

		requestedAt.delete(key);
		reaped++;
	}

	return reaped;
}

/**
 * Copy the ring into a normal array in oldest-to-newest order.
 *
 * The copy is split at the physical end of the ring to avoid a modulo operation
 * for every sample.
 */
function copyLatencySamples(): number[] {
	const count = latencyCount;
	const samples = new Array<number>(count);

	if (count === 0) {
		return samples;
	}

	let sourceIndex = latencyHead - count;

	if (sourceIndex < 0) {
		sourceIndex += LATENCY_CAPACITY;
	}

	const firstLength = Math.min(count, LATENCY_CAPACITY - sourceIndex);

	let destinationIndex = 0;
	const firstEnd = sourceIndex + firstLength;

	while (sourceIndex < firstEnd) {
		samples[destinationIndex++] = latencyRing[sourceIndex++];
	}

	sourceIndex = 0;

	while (destinationIndex < count) {
		samples[destinationIndex++] = latencyRing[sourceIndex++];
	}

	return samples;
}

/**
 * Copy the ring into the reusable percentile scratch buffer.
 *
 * Ordering does not matter because the populated range is sorted afterward.
 */
function copyLatencyToPercentileScratch(): void {
	const count = latencyCount;
	let sourceIndex = latencyHead - count;

	if (sourceIndex < 0) {
		sourceIndex += LATENCY_CAPACITY;
	}

	const firstLength = Math.min(count, LATENCY_CAPACITY - sourceIndex);

	let destinationIndex = 0;
	const firstEnd = sourceIndex + firstLength;

	while (sourceIndex < firstEnd) {
		percentileScratch[destinationIndex++] = latencyRing[sourceIndex++];
	}

	sourceIndex = 0;

	while (destinationIndex < count) {
		percentileScratch[destinationIndex++] = latencyRing[sourceIndex++];
	}
}

/**
 * Sort the active prefix of percentileScratch in place.
 *
 * The ring holds at most 256 entries, so insertion sort is competitive here
 * and avoids allocating the temporary TypedArray view required by
 * `percentileScratch.subarray(0, count).sort()`.
 */
function sortPercentileScratch(count: number): void {
	for (let i = 1; i < count; i++) {
		const value = percentileScratch[i];
		let j = i - 1;

		while (j >= 0 && percentileScratch[j] > value) {
			percentileScratch[j + 1] = percentileScratch[j];
			j--;
		}

		percentileScratch[j + 1] = value;
	}
}

export function getChunkPipelineStats(): ChunkPipelineStats {
	/*
	 * A public snapshot must own its arrays so callers cannot mutate internal
	 * counters or observe future updates through a shared typed-array view.
	 */
	const countSnapshot = new Array<number>(STAGE_COUNT);

	for (let i = 0; i < STAGE_COUNT; i++) {
		countSnapshot[i] = counts[i];
	}

	return {
		counts: countSnapshot,
		inFlight,
		latencySamples: copyLatencySamples(),
	};
}

export function resetChunkPipelineStats(): void {
	counts.fill(0);

	/*
	 * latencyRing does not need clearing. latencyCount defines the active
	 * entries, and subsequent writes overwrite old values before exposure.
	 */
	latencyCount = 0;
	latencyHead = 0;
	inFlight = 0;

	requestedAt.clear();
}

/** Percentiles over the current latency ring. */
export function getChunkLatencyPercentiles(): ChunkLatencyPercentiles {
	const count = latencyCount;

	if (count === 0) {
		return {
			p50: 0,
			p90: 0,
			p99: 0,
			max: 0,
		};
	}

	copyLatencyToPercentileScratch();
	sortPercentileScratch(count);

	const lastIndex = count - 1;

	const p50Index = Math.min(lastIndex, Math.floor(0.5 * count));
	const p90Index = Math.min(lastIndex, Math.floor(0.9 * count));
	const p99Index = Math.min(lastIndex, Math.floor(0.99 * count));

	return {
		p50: percentileScratch[p50Index],
		p90: percentileScratch[p90Index],
		p99: percentileScratch[p99Index],
		max: percentileScratch[lastIndex],
	};
}

export { STAGE_NAMES as CHUNK_PIPELINE_STAGE_NAMES };
