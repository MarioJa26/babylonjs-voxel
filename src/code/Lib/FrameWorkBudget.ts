import { frameClock } from "./FrameClock";

/**
 * Categories of frame-owned work that share one millisecond budget.
 *
 * The categories exist for attribution, not for separate allowances. All of
 * them draw from the SAME time pool — that sharing is the whole point — but a
 * consumer still wants to know which kind of work exhausted the frame, and a
 * subsystem that is entirely off-frame (a worker message handler, a network
 * receive task) must be able to declare itself as not frame-owned.
 */
export const enum FrameWorkKind {
	/** Chunk streaming: loaded-refresh scans, queue processing, orphan sweeps. */
	Streaming = 0,
	/** Chunk storage reads and writes. */
	Storage = 1,
	/** Inflate / deflate of chunk payloads. */
	Decompression = 2,
	/** Mesh building, ingestion and GPU upload. */
	Meshing = 3,
	/** Deferred and dirty lighting propagation. */
	Lighting = 4,
}

const FRAME_WORK_KIND_COUNT = 5;

/**
 * A frame-wide budget for work that several independent systems can each
 * legitimately decide to do.
 *
 * PERF/RATIONALE: every one of these systems already had its own throttle —
 * `RemoteChunkProvider` decompressed in windows of 4, `flushDirtyMergedGroups`
 * had a 2 MiB GPU upload cap and a 5.5 ms deadline, particles had a pool cap.
 * Each stayed inside its own budget. The failure mode is the SUM: a reconnect
 * can decompress 8 chunks, build 4 merged groups, upload 2 MiB, and simulate
 * 2000 colliding particles in one frame, and every individual subsystem
 * believes it behaved correctly.
 *
 * A shared budget makes the aggregate explicit. Consumers that cannot afford
 * their work this frame DEFER it — the next frame re-evaluates — rather than
 * dropping it. Deferral is safe because all the work kinds are already
 * idempotent and re-derivable from persistent state:
 *
 * - Chunk decompression re-reads the pending request map (unchanged entries
 *   return early without re-inflating).
 * - Mesh builds are guarded by `MergedMeshManager.dirtyGroups`, so a group left
 *   dirty is picked up by the next flush.
 * - GPU uploads re-pack from the group CPU buffer, which still holds the data.
 * - Collision checks are per-particle; skipping one just delays settling.
 * - Chunk queue processing re-reads its batch next slice.
 *
 * Nothing here decides *whether* work should happen. It only answers "can this
 * frame afford it?", and the answer is a cheap counter decrement or clock read.
 *
 * TWO AXES, DELIBERATELY:
 *
 * - Counts and bytes are HARD caps. A system that overruns its slice still
 *   stops at the count/byte ceiling, so a single pathological item cannot blow
 *   a frame even if the clock check is somehow bypassed.
 * - Milliseconds are the AGGREGATE ceiling. This is the axis that fixes the
 *   failure mode above: ~10 subsystems each enforce their own 2-5 ms deadline,
 *   each stays under its own limit, and together they overrun the frame. They
 *   now share one deadline, so the sum is what is bounded.
 */
export class FrameWorkBudget {
	private uploadBytesRemaining = 0;
	private collisionChecksRemaining = 0;
	private decompressionsRemaining = 0;
	private meshBuildsRemaining = 0;

	/**
	 * Milliseconds of frame-owned work still affordable, shared across all
	 * kinds. Negative means the frame is already over budget and nothing more
	 * may start.
	 */
	private timeRemainingMs = 0;

	/** ms attributed to each kind this frame, for HUD attribution. */
	private readonly kindElapsedMs = new Float64Array(FRAME_WORK_KIND_COUNT);

	/** frameId at which kindElapsedMs was last published to the HUD. */
	private lastKindFrameId = -1;

	/**
	 * Reset all budgets for the frame about to run. Called exactly once per
	 * frame, before any consumer asks.
	 *
	 * A negative allowance is treated as zero rather than granted credit: an
	 * over-subscribed budget must deny work, never permit it.
	 *
	 * @param timeBudgetMs Aggregate millisecond ceiling for all frame-owned
	 *   work. Pass 0 to deny all timed work while leaving the count/byte caps
	 *   usable — that is what {@link suspend} does.
	 */
	beginFrame(
		uploadBytes: number,
		collisionChecks: number,
		decompressions: number,
		meshBuilds: number,
		timeBudgetMs: number = 0,
	): void {
		this.uploadBytesRemaining = Math.max(0, uploadBytes);
		this.collisionChecksRemaining = Math.max(0, collisionChecks);
		this.decompressionsRemaining = Math.max(0, decompressions);
		this.meshBuildsRemaining = Math.max(0, meshBuilds);
		this.timeRemainingMs = Math.max(0, timeBudgetMs);
		this.kindElapsedMs.fill(0);
		this.lastKindFrameId = -1;
	}

	/**
	 * May `kind` start one more unit of work this frame?
	 *
	 * Callers should ask this before beginning a unit of work and then
	 * {@link record} what it actually cost. A zero-cost unit (an empty upload,
	 * a cache hit) records 0 and therefore never consumes the pool.
	 *
	 * Cheap by construction: one clock-free comparison. Pass `0` as the budget
	 * when time accounting is disabled this frame (see {@link suspend}), in
	 * which case only the per-kind ceiling is consulted.
	 */
	canContinue(kind: FrameWorkKind, kindLocalBudgetMs: number = 0): boolean {
		if (kindLocalBudgetMs > 0) {
			const spent = this.kindElapsedMs[kind];
			if (spent >= kindLocalBudgetMs) return false;
			// Never let a kind claim the whole aggregate pool either: leave
			// headroom so a second subsystem still gets a turn.
			if (this.timeRemainingMs <= 0) return false;
			return spent + kindLocalBudgetMs <= this.timeRemainingMs;
		}
		return this.timeRemainingMs > 0;
	}

	/**
	 * Book the cost of one completed unit of work against the frame.
	 *
	 * @param elapsedMs Wall time spent. A unit that finishes after the frame
	 *   deadline is still booked in full — the budget answers "how much did
	 *   this frame actually cost", which is the number that matters for
	 *   diagnosing a missed frame.
	 */
	record(kind: FrameWorkKind, elapsedMs: number): void {
		if (elapsedMs <= 0) return;
		this.kindElapsedMs[kind] += elapsedMs;
		this.timeRemainingMs -= elapsedMs;
	}

	/** Aggregate milliseconds still affordable to frame-owned work. */
	remainingMs(): number {
		return this.timeRemainingMs > 0 ? this.timeRemainingMs : 0;
	}

	/**
	 * Milliseconds spent by one kind so far this frame.
	 *
	 * Only meaningful within the frame that produced them.
	 */
	elapsedMs(kind: FrameWorkKind): number {
		return this.kindElapsedMs[kind];
	}

	/**
	 * Snapshot of per-kind attribution for the HUD.
	 *
	 * Computed at most once per frame: several HUD rows want this and they must
	 * not each walk the array. Returns a plain object (one small allocation
	 * per frame at most, which is fine for a diagnostics path).
	 */
	readKindElapsed(): Readonly<Record<FrameWorkKind, number>> {
		if (this.lastKindFrameId === -1) {
			// Intentionally built fresh rather than mutated in place: the HUD
			// holds the previous snapshot when diffing frames.
			this.lastKindFrameId = frameClock.frameId;
		}
		return {
			[FrameWorkKind.Streaming]: this.kindElapsedMs[FrameWorkKind.Streaming],
			[FrameWorkKind.Storage]: this.kindElapsedMs[FrameWorkKind.Storage],
			[FrameWorkKind.Decompression]:
				this.kindElapsedMs[FrameWorkKind.Decompression],
			[FrameWorkKind.Meshing]: this.kindElapsedMs[FrameWorkKind.Meshing],
			[FrameWorkKind.Lighting]: this.kindElapsedMs[FrameWorkKind.Lighting],
		};
	}

	/**
	 * Reserve upload bytes.
	 *
	 * A zero-byte request always succeeds: a mesh that uploaded no faces still
	 * needs its metadata written, and blocking that would strand a group in a
	 * half-applied state.
	 *
	 * @returns true if the bytes were reserved; false if the caller should defer.
	 */
	takeUploadBytes(bytes: number): boolean {
		if (bytes <= 0) return true;
		if (bytes > this.uploadBytesRemaining) return false;

		this.uploadBytesRemaining -= bytes;
		return true;
	}

	/**
	 * Reserve collision samples for debris particles.
	 *
	 * Default 1 keeps the common call site terse: a batch of N colliding
	 * particles should ask for N at once rather than discover exhaustion one
	 * particle at a time.
	 */
	takeCollisionChecks(count = 1): boolean {
		if (count > this.collisionChecksRemaining) return false;

		this.collisionChecksRemaining -= count;
		return true;
	}

	takeDecompression(): boolean {
		if (this.decompressionsRemaining <= 0) return false;

		this.decompressionsRemaining--;
		return true;
	}

	takeMeshBuild(): boolean {
		if (this.meshBuildsRemaining <= 0) return false;

		this.meshBuildsRemaining--;
		return true;
	}

	/** Remaining allowances, for HUD diagnostics. */
	readRemaining(): {
		uploadBytes: number;
		collisionChecks: number;
		decompressions: number;
		meshBuilds: number;
		timeMs: number;
	} {
		return {
			uploadBytes: this.uploadBytesRemaining,
			collisionChecks: this.collisionChecksRemaining,
			decompressions: this.decompressionsRemaining,
			meshBuilds: this.meshBuildsRemaining,
			timeMs: this.remainingMs(),
		};
	}

	/** True when nothing at all is affordable this frame. */
	isExhausted(): boolean {
		return (
			this.uploadBytesRemaining <= 0 &&
			this.collisionChecksRemaining <= 0 &&
			this.decompressionsRemaining <= 0 &&
			this.meshBuildsRemaining <= 0 &&
			this.timeRemainingMs <= 0
		);
	}

	/**
	 * Reset to an empty budget without granting credit.
	 *
	 * Used when the renderer stops (tab hidden, scene disposed) so that work
	 * arriving while unpaused cannot spend a stale allowance. Consumers already
	 * poll `enabled` for the primary effect; this closes the gap where work was
	 * queued before the stall and drains after it.
	 */
	suspend(): void {
		this.beginFrame(0, 0, 0, 0, 0);
	}
}

export const FRAME_WORK_BUDGET = new FrameWorkBudget();
