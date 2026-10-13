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
 * Reused percentile storage.
 *
 * Percentile queries use the engine's native TypedArray sort implementation,
 * which is substantially faster than a JavaScript insertion sort when the
 * ring approaches capacity.
 */
const percentileScratch = new Float64Array(LATENCY_CAPACITY);

let latencyCount = 0;
let latencyHead = 0;

/** Chunks that reached Validated and have not reached a terminal stage. */
let inFlight = 0;

/**
 * Chunks awaiting their first mesh, keyed by packed coordinates and holding
 * the wall-clock time at which the current request was sent.
 *
 * Entries are maintained in request-time order. Restarting an existing
 * request deletes and reinserts its key so stale reaping can stop at the first
 * live request.
 */
const requestedAt = new Map<bigint, number>();

/**
 * Record that `count` chunks entered `stage`.
 *
 * @param count Number of chunks entering the stage. A merged-group operation
 * may pass its member count to keep counters comparable with per-chunk stages.
 */
export function noteChunkStage(stage: ChunkPipelineStage, count = 1): void {
	if (
		count <= 0 ||
		!Number.isFinite(count) ||
		stage < 0 ||
		stage >= STAGE_COUNT
	) {
		return;
	}

	/*
	 * Stage counts represent whole chunks. Normal callers already pass
	 * integers, but truncating protects the counters from accidental fractions.
	 */
	count = Math.trunc(count);

	if (count <= 0) {
		return;
	}

	counts[stage] += count;

	switch (stage) {
		case ChunkPipelineStage.Validated:
			inFlight += count;
			break;

		case ChunkPipelineStage.Renderable:
		case ChunkPipelineStage.Abandoned:
			/*
			 * Avoid exposing a negative in-flight count if duplicate terminal
			 * notifications arrive. Correct callers are unaffected.
			 */
			inFlight = Math.max(0, inFlight - count);
			break;
	}
}

/**
 * Begin or restart latency tracking for one chunk.
 *
 * Map iteration follows insertion order. Deleting before setting moves a
 * restarted request to the end, preserving the ordering used by stale reaping.
 */
export function noteChunkRequested(key: bigint, nowMs: number): void {
	if (!Number.isFinite(nowMs)) {
		return;
	}

	/*
	 * Map.delete() is safe when the key is absent, so a separate has() lookup
	 * would only duplicate hash-table work.
	 */
	requestedAt.delete(key);
	requestedAt.set(key, nowMs);
}

/** Record one completed request-to-mesh latency sample, in milliseconds. */
export function noteChunkRendered(ms: number): void {
	if (!Number.isFinite(ms) || ms < 0) {
		return;
	}

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
	if (!Number.isFinite(nowMs)) {
		requestedAt.delete(key);
		return -1;
	}

	const startedAt = requestedAt.get(key);

	if (startedAt === undefined) {
		return -1;
	}

	requestedAt.delete(key);

	const elapsedMs = nowMs - startedAt;

	if (
		elapsedMs < 0 ||
		elapsedMs > MAX_TRACKED_AGE_MS ||
		!Number.isFinite(elapsedMs)
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
	if (!Number.isFinite(nowMs) || requestedAt.size === 0) {
		return 0;
	}

	const staleBefore = nowMs - MAX_TRACKED_AGE_MS;
	let reaped = 0;

	/*
	 * Deleting the current Map entry during iteration is defined and advances
	 * iteration to the following entry.
	 */
	for (const [key, startedAt] of requestedAt) {
		if (startedAt >= staleBefore) {
			break;
		}

		requestedAt.delete(key);
		reaped++;
	}

	return reaped;
}

/**
 * Copy the active latency ring into `destination`.
 *
 * Values are written in oldest-to-newest order. Sorting callers may ignore
 * this order, but sharing one copy implementation avoids duplicate ring logic.
 *
 * @returns Number of copied samples.
 */
function copyLatencyRingTo(destination: Float64Array | number[]): number {
	const count = latencyCount;

	if (count === 0) {
		return 0;
	}

	let sourceIndex = latencyHead - count;

	if (sourceIndex < 0) {
		sourceIndex += LATENCY_CAPACITY;
	}

	const firstLength = Math.min(count, LATENCY_CAPACITY - sourceIndex);

	let destinationIndex = 0;
	const firstEnd = sourceIndex + firstLength;

	while (sourceIndex < firstEnd) {
		destination[destinationIndex++] = latencyRing[sourceIndex++];
	}

	sourceIndex = 0;

	while (destinationIndex < count) {
		destination[destinationIndex++] = latencyRing[sourceIndex++];
	}

	return count;
}

/**
 * Copy the latency ring into a normal array in oldest-to-newest order.
 */
function copyLatencySamples(): number[] {
	const samples = new Array<number>(latencyCount);
	copyLatencyRingTo(samples);
	return samples;
}

export function getChunkPipelineStats(): ChunkPipelineStats {
	/*
	 * Public snapshots own their arrays so callers cannot mutate internal
	 * counters or observe future updates through shared views.
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
	 * The ring itself does not need clearing. latencyCount defines its active
	 * range, and future writes overwrite old samples before exposure.
	 */
	latencyCount = 0;
	latencyHead = 0;
	inFlight = 0;

	requestedAt.clear();
}

/**
 * Percentiles over the current latency ring.
 *
 * This preserves the original percentile index convention:
 *
 *     floor(percentile * sampleCount)
 *
 * clamped to the final sample.
 */
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

	copyLatencyRingTo(percentileScratch);

	/*
	 * subarray() creates only a lightweight view, not a data copy. Native
	 * TypedArray sorting is normally much faster than a JavaScript O(n²)
	 * insertion sort at the 256-sample capacity.
	 */
	percentileScratch.subarray(0, count).sort();

	const lastIndex = count - 1;

	const p50Index = Math.min(lastIndex, Math.floor(count * 0.5));

	const p90Index = Math.min(lastIndex, Math.floor(count * 0.9));

	const p99Index = Math.min(lastIndex, Math.floor(count * 0.99));

	return {
		p50: percentileScratch[p50Index],
		p90: percentileScratch[p90Index],
		p99: percentileScratch[p99Index],
		max: percentileScratch[lastIndex],
	};
}

export { STAGE_NAMES as CHUNK_PIPELINE_STAGE_NAMES };
