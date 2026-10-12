/**
 * Shared streaming priority, derived from where the player is and where the
 * camera is looking.
 *
 * PERF/RATIONALE: chunk work used to be ordered by coordinate distance alone.
 * That is wrong at the moment it matters most. A chunk 40 blocks dead ahead of
 * the camera is about to fill the screen; a chunk 30 blocks directly behind is
 * invisible and will stay invisible until the player turns. Distance ranks them
 * the wrong way round, so the visible chunk queues behind several far
 * decompressions and mesh uploads.
 *
 * Priority must be IDENTICAL at every stage — request, inflate, mesh, upload.
 * If each stage re-derived its own order they would disagree, and a chunk that
 * was downloaded first could still be meshed last.
 */

/** Everything priority depends on, sampled once per frame. */
export interface ChunkPriorityContext {
	playerX: number;
	playerY: number;
	playerZ: number;
	/** Camera forward, normalized. */
	forwardX: number;
	forwardY: number;
	forwardZ: number;
}

/**
 * Weights for the priority score. Lower priority value = scheduled sooner.
 *
 * `LOD_WEIGHT` must exceed the largest possible distance term by a wide margin,
 * or a far LOD0 chunk could outrank a near LOD5 one. At LOD6 (DISTANT_LOD_LEVEL)
 * and a 256-chunk radius the squared distance tops out near 3 * 256^2 ~= 196k,
 * so 4096 per LOD level leaves ample headroom.
 */
const LOD_WEIGHT = 4096;
const FORWARD_WEIGHT = 512;
const AGE_WEIGHT = 0.25;

/**
 * Maximum age that contributes to priority, ms.
 *
 * Without a cap, a chunk requested at the screen edge and never reached would
 * accumulate unbounded priority credit and eventually outrank everything in
 * front of the player. Five seconds is long enough to prevent starvation under
 * sustained pressure and short enough that a genuinely visible chunk still
 * wins.
 */
const MAX_AGE_CREDIT_MS = 5000;

/**
 * Priority score for one chunk. Lower is sooner.
 *
 * @param distanceSq Squared distance from the player.
 * @param forwardScore Projection onto the camera forward axis. Range is roughly
 *   [-distance, +distance], so this rewards what is in view and mildly
 *   penalises what is behind.
 * @param lod Desired LOD level.
 * @param ageMs How long the request has been outstanding.
 */
export function chunkPriority(
	distanceSq: number,
	forwardScore: number,
	lod: number,
	ageMs: number,
): number {
	return (
		distanceSq +
		lod * LOD_WEIGHT -
		forwardScore * FORWARD_WEIGHT -
		Math.min(ageMs, MAX_AGE_CREDIT_MS) * AGE_WEIGHT
	);
}

/** Sampled once per frame and reused by every consumer. */
const currentContext: ChunkPriorityContext = {
	playerX: 0,
	playerY: 0,
	playerZ: 0,
	forwardX: 0,
	forwardY: 0,
	forwardZ: 1,
};

/**
 * Replace the frame's context.
 *
 * Called from the frame loop, before any consumer asks. Passing a fresh object
 * each frame would allocate; the stored object is mutated instead.
 */
export function setChunkPriorityContext(
	playerX: number,
	playerY: number,
	playerZ: number,
	forwardX: number,
	forwardY: number,
	forwardZ: number,
): void {
	const ctx = currentContext;
	ctx.playerX = playerX;
	ctx.playerY = playerY;
	ctx.playerZ = playerZ;

	/*
	 * Normalize defensively. A zero-length forward would make every
	 * forwardScore zero, silently disabling the term; a non-unit vector would
	 * scale it by its length and let a lagging direction dominate.
	 */
	const lengthSq =
		forwardX * forwardX + forwardY * forwardY + forwardZ * forwardZ;

	if (lengthSq > 1e-8) {
		const inv = 1 / Math.sqrt(lengthSq);
		ctx.forwardX = forwardX * inv;
		ctx.forwardY = forwardY * inv;
		ctx.forwardZ = forwardZ * inv;
	} else {
		ctx.forwardX = 0;
		ctx.forwardY = 0;
		ctx.forwardZ = 1;
	}
}

export function getChunkPriorityContext(): ChunkPriorityContext {
	return currentContext;
}

/** Squared distance from the context's player position, in chunk units. */
export function chunkDistanceSq(cx: number, cy: number, cz: number): number {
	const ctx = currentContext;
	const dx = cx - ctx.playerX;
	const dy = cy - ctx.playerY;
	const dz = cz - ctx.playerZ;
	return dx * dx + dy * dy + dz * dz;
}

/**
 * Projection of the chunk's offset from the player onto the camera forward axis.
 *
 * Positive means ahead of the player, negative behind.
 */
export function chunkForwardScore(cx: number, cy: number, cz: number): number {
	const ctx = currentContext;
	const dx = cx - ctx.playerX;
	const dy = cy - ctx.playerY;
	const dz = cz - ctx.playerZ;
	return dx * ctx.forwardX + dy * ctx.forwardY + dz * ctx.forwardZ;
}

/** Full priority for a chunk, using the current frame's context. */
export function priorityForChunk(
	cx: number,
	cy: number,
	cz: number,
	lod: number,
	ageMs: number,
): number {
	return chunkPriority(
		chunkDistanceSq(cx, cy, cz),
		chunkForwardScore(cx, cy, cz),
		lod,
		ageMs,
	);
}
