/**
 * Cross-system cumulative counters for one frame.
 *
 * PERF/RATIONALE: the existing upload diagnostics were already strong
 * (`getPackedUploadStats`), but they measured one stage in isolation. The
 * failure this exists to diagnose is a chunk that is "late" for reasons that
 * have nothing to do with each other: fast networking behind a slow inflate,
 * or a fast inflate behind a backed-up mesh queue. A single per-stage number
 * cannot distinguish those, and the only way to tell them apart today is to
 * enable three separate profilers and correlate by hand.
 *
 * These counters are cumulative between resets, not per-frame. Per-frame
 * deltas are meaningless for work whose whole point is that it is deferred —
 * a chunk deferred four frames legitimately shows zero on the frames it did
 * nothing, which is exactly when a spike appears elsewhere.
 */
export interface FramePipelineStats {
	// --- Network ---
	networkBytesReceived: number;
	chunkResponses: number;
	/** Chunk inflates actually performed. Compare against budget defers. */
	inflateBytes: number;
	inflateMs: number;
	inflatePaced: number;

	// --- Cache ---
	cacheReadBytes: number;
	cacheWriteBytes: number;
	cacheWriteMs: number;

	// --- Meshing ---
	chunksMeshed: number;
	facesGenerated: number;
	meshBuildDeferred: number;

	// --- GPU ---
	faceUploadBytes: number;
	faceUploadCalls: number;
	gpuResourcesRetired: number;

	// --- Effects ---
	particleCount: number;
	collidingParticleCount: number;
	collisionQueries: number;
	particlesEmitted: number;

	// --- Entities ---
	remotePlayersRendered: number;
	remotePlayersCulled: number;

	// --- Streaming ---
	chunksRequested: number;
	chunksAbandoned: number;
}

function zero(): FramePipelineStats {
	return {
		networkBytesReceived: 0,
		chunkResponses: 0,
		inflateBytes: 0,
		inflateMs: 0,
		inflatePaced: 0,
		cacheReadBytes: 0,
		cacheWriteBytes: 0,
		cacheWriteMs: 0,
		chunksMeshed: 0,
		facesGenerated: 0,
		meshBuildDeferred: 0,
		faceUploadBytes: 0,
		faceUploadCalls: 0,
		gpuResourcesRetired: 0,
		particleCount: 0,
		collidingParticleCount: 0,
		collisionQueries: 0,
		particlesEmitted: 0,
		remotePlayersRendered: 0,
		remotePlayersCulled: 0,
		chunksRequested: 0,
		chunksAbandoned: 0,
	};
}

const stats = zero();

/**
 * Mutate one or more counters.
 *
 * Callers pass only what they measured. Taking the whole object would mean
 * every call site had to read, spread, and write back all 23 fields.
 */
export function notePipelineWork(update: Partial<FramePipelineStats>): void {
	const s = stats;

	if (update.networkBytesReceived !== undefined)
		s.networkBytesReceived += update.networkBytesReceived;
	if (update.chunkResponses !== undefined)
		s.chunkResponses += update.chunkResponses;
	if (update.inflateBytes !== undefined) s.inflateBytes += update.inflateBytes;
	if (update.inflateMs !== undefined) s.inflateMs += update.inflateMs;
	if (update.inflatePaced !== undefined) s.inflatePaced += update.inflatePaced;
	if (update.cacheReadBytes !== undefined)
		s.cacheReadBytes += update.cacheReadBytes;
	if (update.cacheWriteBytes !== undefined)
		s.cacheWriteBytes += update.cacheWriteBytes;
	if (update.cacheWriteMs !== undefined) s.cacheWriteMs += update.cacheWriteMs;
	if (update.chunksMeshed !== undefined) s.chunksMeshed += update.chunksMeshed;
	if (update.facesGenerated !== undefined)
		s.facesGenerated += update.facesGenerated;
	if (update.meshBuildDeferred !== undefined)
		s.meshBuildDeferred += update.meshBuildDeferred;
	if (update.faceUploadBytes !== undefined)
		s.faceUploadBytes += update.faceUploadBytes;
	if (update.faceUploadCalls !== undefined)
		s.faceUploadCalls += update.faceUploadCalls;
	if (update.gpuResourcesRetired !== undefined)
		s.gpuResourcesRetired += update.gpuResourcesRetired;
	if (update.particleCount !== undefined)
		s.particleCount += update.particleCount;
	if (update.collidingParticleCount !== undefined)
		s.collidingParticleCount += update.collidingParticleCount;
	if (update.collisionQueries !== undefined)
		s.collisionQueries += update.collisionQueries;
	if (update.particlesEmitted !== undefined)
		s.particlesEmitted += update.particlesEmitted;
	if (update.remotePlayersRendered !== undefined)
		s.remotePlayersRendered += update.remotePlayersRendered;
	if (update.remotePlayersCulled !== undefined)
		s.remotePlayersCulled += update.remotePlayersCulled;
	if (update.chunksRequested !== undefined)
		s.chunksRequested += update.chunksRequested;
	if (update.chunksAbandoned !== undefined)
		s.chunksAbandoned += update.chunksAbandoned;
}

/** Snapshot. Callers must not mutate the returned object. */
export function getPipelineStats(): Readonly<FramePipelineStats> {
	return stats;
}

export function resetPipelineStats(): void {
	Object.assign(stats, zero());
}
